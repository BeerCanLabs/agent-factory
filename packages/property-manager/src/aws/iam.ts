import {
  IAMClient,
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { agentContainerSecrets } from "./gatekeeper-held.js";

/** The task role's mind policy. Scoped to the agent's own prefix in the factory's one mind bucket (§6.6, E6). */
export const MIND_POLICY = "MindPersistenceAccess";
/**
 * E5, M1 (GAP-249): agents never call a model provider themselves; every model call goes through the gatekeeper-egress,
 * which meters and ledgers it. These grants used to give agent task roles direct Bedrock access and are revoked on
 * every deploy and at control-plane start: the inline policy aws/iam.ts used to write, and the managed policy that was
 * attached to agent task roles by hand on 2026-09-24.
 */
export const DIRECT_MODEL_INLINE_POLICIES = ["BedrockConverseAccess"];
export const DIRECT_MODEL_MANAGED_POLICIES = ["AgentBedrockModelInvocation", "AmazonBedrockFullAccess", "AmazonBedrockLimitedAccess"];

const isNoSuchEntity = (err: any) =>
  err?.name === "NoSuchEntityException" || err?.name === "NoSuchEntity" || err?.Code === "NoSuchEntity";

/**
 * An agent's mind prefix as a key prefix: no wildcard, no `..` segment, no leading or trailing slash, so a policy built
 * from it names exactly one agent's keys.
 */
export function checkMindPrefix(prefix: string): string {
  if (!prefix || /[*?$\s]/.test(prefix) || prefix.startsWith("/") || prefix.endsWith("/") || prefix.split("/").includes("..") || prefix.split("/").includes("")) {
    throw new Error(`invalid mind prefix ${JSON.stringify(prefix)}: the task role would not be scoped to one agent`);
  }
  return prefix;
}

/** The mind bucket's name: from FACTORY_MIND_BUCKET (bare name or s3:// URI). Never a wildcard. */
export function mindBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.FACTORY_MIND_BUCKET ?? "").replace(/^s3:\/\//, "").replace(/\/.*$/, "");
  if (!raw || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw)) {
    throw new Error("FACTORY_MIND_BUCKET must name the mind bucket to scope an agent task role to its own prefix");
  }
  return raw;
}

/** The task role's mind policy: read, write and delete under `<bucket>/<prefix>/`, and list only that prefix. */
export function mindPolicyDocument(bucket: string, prefix: string): string {
  checkMindPrefix(prefix);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OwnMindObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`],
      },
      {
        Sid: "ListOwnMindOnly",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [prefix, `${prefix}/`, `${prefix}/*`] } },
      },
    ],
  });
}

/** Removes every direct model-provider grant from a task role. Absent grants are fine; any other failure throws. */
async function revokeDirectModelAccess(client: IAMClient, roleName: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of DIRECT_MODEL_INLINE_POLICIES) {
    try {
      await client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
      removed.push(name);
    } catch (err: any) {
      if (!isNoSuchEntity(err)) throw err;
    }
  }
  let marker: string | undefined;
  do {
    const page = await client.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
    for (const p of page.AttachedPolicies ?? []) {
      if (!p.PolicyName || !p.PolicyArn || !DIRECT_MODEL_MANAGED_POLICIES.includes(p.PolicyName)) continue;
      try {
        await client.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: p.PolicyArn }));
        removed.push(p.PolicyName);
      } catch (err: any) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return removed;
}

/** Sets the task role's mind access: its own prefix only, or none (a helper's role). */
async function setMindAccess(client: IAMClient, roleName: string, memory: { prefix: string } | false): Promise<void> {
  if (memory === false) {
    try {
      await client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: MIND_POLICY }));
    } catch (err: any) {
      if (!isNoSuchEntity(err)) throw err;
    }
    return;
  }
  // PutRolePolicy replaces the whole document, so an older bucket-wide grant under this name is gone once it returns.
  await client.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: MIND_POLICY, PolicyDocument: mindPolicyDocument(mindBucketName(), memory.prefix) }),
  );
}

/**
 * GAP-249 migration: brings an existing agent's task role to the current grants (its own mind prefix, no direct model
 * access) without redeploying it. The control plane runs this for every registered agent when it starts, so a deploy
 * of this change re-scopes all existing roles. A role that does not exist (the agent was never deployed on ECS, or is
 * a landing-zone agent with its own Terraform role) is skipped. Idempotent.
 */
export async function reconcileAgentTaskRole(
  agentId: string,
  opts: { memoryPrefix?: string; memory?: boolean } = {},
): Promise<{ role: string; skipped?: "no-role"; revoked: string[] }> {
  const client = new IAMClient({});
  const role = `AgentTaskRole-${agentId}`;
  try {
    await client.send(new GetRoleCommand({ RoleName: role }));
  } catch (err: any) {
    if (isNoSuchEntity(err)) return { role, skipped: "no-role", revoked: [] };
    throw err;
  }
  await setMindAccess(client, role, opts.memory === false ? false : { prefix: opts.memoryPrefix ?? agentId });
  const revoked = await revokeDirectModelAccess(client, role);
  return { role, revoked };
}

export async function provisionAgentRoles(
  agentId: string,
  secrets: string[],
  /**
   * E1.4 (#295): `memory: false` (a helper's role) gets no mind-bucket access, and loses any it had.
   * `memoryPrefix` (GAP-249): the agent's mind prefix (AgentRecord.memoryPrefix, default the agent id); the task role
   * can reach only that prefix, never another agent's.
   */
  opts: { memory?: boolean; memoryPrefix?: string } = {},
): Promise<{ taskRoleArn: string; executionRoleArn: string }> {
  const client = new IAMClient({});

  const assumeRolePolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
        Action: "sts:AssumeRole",
      },
    ],
  });

  const taskRoleName = `AgentTaskRole-${agentId}`;
  const executionRoleName = `AgentExecutionRole-${agentId}`;

  // 1. Create Task Role
  let taskRoleArn = "";
  try {
    const createTaskRoleResponse = await client.send(
      new CreateRoleCommand({
        RoleName: taskRoleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        Description: `Task Role for Agent ${agentId}`,
      })
    );
    taskRoleArn = createTaskRoleResponse.Role?.Arn as string;
  } catch (err: any) {
    if (err.name === "EntityAlreadyExistsException" || err.name === "EntityAlreadyExists" || err.Code === "EntityAlreadyExists") {
      const getRoleRes = await client.send(new GetRoleCommand({ RoleName: taskRoleName }));
      taskRoleArn = getRoleRes.Role?.Arn as string;
    } else {
      throw err;
    }
  }

  // 1b. The task role reaches only this agent's own mind prefix (GAP-249). A failure throws: a deploy must not leave a
  // role with an older, wider grant in place.
  await setMindAccess(client, taskRoleName, opts.memory === false ? false : { prefix: opts.memoryPrefix ?? agentId });

  // 1c. No direct model access (E5, M1, GAP-249): model calls go through the gatekeeper-egress. Removes any grant an
  // earlier version of this file, or a hand change, gave the role.
  await revokeDirectModelAccess(client, taskRoleName);

  // 2. Create Execution Role
  let executionRoleArn = "";
  // A role created just now has no inline policies, so there is no SecretsAccess to revoke below.
  let executionRoleCreated = false;
  try {
    const createExecutionRoleResponse = await client.send(
      new CreateRoleCommand({
        RoleName: executionRoleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        Description: `Execution Role for Agent ${agentId}`,
      })
    );
    executionRoleArn = createExecutionRoleResponse.Role?.Arn as string;
    executionRoleCreated = true;
  } catch (err: any) {
    if (err.name === "EntityAlreadyExistsException" || err.name === "EntityAlreadyExists" || err.Code === "EntityAlreadyExists") {
      const getRoleRes = await client.send(new GetRoleCommand({ RoleName: executionRoleName }));
      executionRoleArn = getRoleRes.Role?.Arn as string;
    } else {
      throw err;
    }
  }

  // 3. Attach ECR permissions to Execution Role
  const ecrPolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource: "*",
      },
    ],
  });

  await client.send(
    new PutRolePolicyCommand({
      RoleName: executionRoleName,
      PolicyName: "ECRAccess",
      PolicyDocument: ecrPolicyDocument,
    })
  );

  // 4. Attach Secrets Manager permissions to Execution Role if there are secrets. Gatekeeper-held secrets are
  // never injected into the container (S1), so the agent's execution role is never granted them.
  secrets = agentContainerSecrets(secrets ?? []);
  if (secrets.length > 0) {
    const secretsPolicyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: secrets.map(s => {
            if (s.startsWith("arn:aws:")) return s;
            return `arn:aws:secretsmanager:*:*:secret:factory/*/${s}*`;
          }),
        },
      ],
    });

    await client.send(
      new PutRolePolicyCommand({
        RoleName: executionRoleName,
        PolicyName: "SecretsAccess",
        PolicyDocument: secretsPolicyDocument,
      })
    );
  } else if (!executionRoleCreated) {
    // A redeploy that no longer injects any secret (e.g. its last one became gatekeeper-held) revokes the old grant.
    try {
      await client.send(new DeleteRolePolicyCommand({ RoleName: executionRoleName, PolicyName: "SecretsAccess" }));
    } catch (err: any) {
      if (err.name !== "NoSuchEntityException" && err.name !== "NoSuchEntity" && err.Code !== "NoSuchEntity") throw err;
    }
  }

  return {
    taskRoleArn,
    executionRoleArn,
  };
}
