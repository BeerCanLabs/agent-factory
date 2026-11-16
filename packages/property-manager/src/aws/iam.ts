import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IAMClient,
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import { agentContainerSecrets } from "./gatekeeper-held.js";
import { checkMindPrefix, MindPrefixRefusedError } from "../mind-prefix.js";

export { checkMindPrefix };

/** The task role's mind policy. Scoped to the agent's own prefix in the factory's one mind bucket (§6.6, E6). */
export const MIND_POLICY = "MindPersistenceAccess";
/** E5, M1 (GAP-263): model calls go through the gatekeeper-egress. Direct Bedrock grants, revoked on deploy and at start. */
export const DIRECT_MODEL_INLINE_POLICIES = ["BedrockConverseAccess"];
export const DIRECT_MODEL_MANAGED_POLICIES = ["AgentBedrockModelInvocation", "AmazonBedrockFullAccess", "AmazonBedrockLimitedAccess"];

const isNoSuchEntity = (err: any) =>
  err?.name === "NoSuchEntityException" || err?.name === "NoSuchEntity" || err?.Code === "NoSuchEntity";

/** The mind bucket's name: from FACTORY_MIND_BUCKET (bare name or s3:// URI). Never a wildcard. */
export function mindBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.FACTORY_MIND_BUCKET ?? "").replace(/^s3:\/\//, "").replace(/\/.*$/, "");
  if (!raw || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw)) {
    throw new Error("FACTORY_MIND_BUCKET must name the mind bucket to scope an agent task role to its own prefix");
  }
  return raw;
}

/** Objects under `<bucket>/<prefix>/`; listing `<prefix>/` only (the bare prefix would also list `<prefix>-backups/`). */
export function mindPolicyDocument(bucket: string, prefix: string): string {
  checkMindPrefix(prefix);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OwnMindObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`],
      },
      {
        Sid: "ListOwnMindOnly",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}/`, `${prefix}/*`] } },
      },
    ],
  });
}

/** liveMindPrefix: MEMORY_PREFIX of the ACTIVE `agent-<id>` task definition. prefixHasObjects: key names only. */
export type MindProbe = {
  liveMindPrefix(agentId: string): Promise<{ found: boolean; prefix?: string }>;
  prefixHasObjects(bucket: string, prefix: string): Promise<boolean>;
};

const execFileAsync = promisify(execFile);

export const awsMindProbe = (ecs: ECSClient = new ECSClient({})): MindProbe => ({
  async liveMindPrefix(agentId) {
    try {
      const r = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: `agent-${agentId}` }));
      const env = (r.taskDefinition?.containerDefinitions ?? []).flatMap((c) => c.environment ?? []);
      const prefix = env.find((e) => e.name === "MEMORY_PREFIX")?.value;
      return { found: true, ...(prefix ? { prefix } : {}) };
    } catch (err: any) {
      if (err?.name === "ClientException" && /unable to describe task definition/i.test(String(err?.message))) return { found: false };
      throw err;
    }
  },
  async prefixHasObjects(bucket, prefix) {
    const { stdout } = await execFileAsync(
      "aws",
      ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", `${checkMindPrefix(prefix)}/`, "--max-keys", "1", "--query", "KeyCount", "--output", "text"],
      { encoding: "utf8", timeout: 30_000 },
    );
    return Number(stdout.trim()) > 0;
  },
});

/** GAP-263: a prefix is the agent's if its live task definition uses it; otherwise it must hold no data. */
export async function assertMindPrefixOwned(agentId: string, bucket: string, prefix: string, probe: MindProbe): Promise<void> {
  checkMindPrefix(prefix);
  const live = await probe.liveMindPrefix(agentId);
  if (live.found && live.prefix === prefix) return;
  if (await probe.prefixHasObjects(bucket, prefix)) {
    throw new MindPrefixRefusedError(
      `mind prefix ${JSON.stringify(prefix)} already holds data that ${agentId} does not own (its task definition uses ${live.prefix ? JSON.stringify(live.prefix) : "no prefix"}); refusing to grant it`,
    );
  }
}

/** Absent grants are fine; any other failure throws. */
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


async function setMindAccess(client: IAMClient, roleName: string, memory: { bucket: string; prefix: string } | false): Promise<void> {
  if (memory === false) {
    try {
      await client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: MIND_POLICY }));
    } catch (err: any) {
      if (!isNoSuchEntity(err)) throw err;
    }
    return;
  }
  await client.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: MIND_POLICY, PolicyDocument: mindPolicyDocument(memory.bucket, memory.prefix) }),
  );
}

export async function provisionAgentRoles(
  agentId: string,
  secrets: string[],
  /** E1.4 (#295): `memory: false` (a helper's role) gets no mind access. GAP-263: else only its own prefix. */
  opts: { memory?: boolean; memoryPrefix?: string; probe?: MindProbe } = {},
): Promise<{ taskRoleArn: string; executionRoleArn: string }> {
  const client = new IAMClient({});
  // GAP-263: checked before anything is written.
  const mind = opts.memory === false ? false : { bucket: mindBucketName(), prefix: checkMindPrefix(opts.memoryPrefix || agentId) };
  if (mind) await assertMindPrefixOwned(agentId, mind.bucket, mind.prefix, opts.probe ?? awsMindProbe());

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

  // 1b. Own mind prefix only (GAP-263). A failure throws rather than leave a wider grant.
  await setMindAccess(client, taskRoleName, mind);

  // 1c. No direct model access (E5, M1, GAP-263).
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
