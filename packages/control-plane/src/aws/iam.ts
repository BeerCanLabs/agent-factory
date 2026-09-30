import {
  IAMClient,
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { agentContainerSecrets } from "./gatekeeper-held.js";

export async function provisionAgentRoles(
  agentId: string,
  secrets: string[]
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

  // 1b. Attach S3 Mind Bucket Persistence Policy to Task Role
  const persistencePolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ],
        Resource: [
          "arn:aws:s3:::agent-factory-mind-*",
          "arn:aws:s3:::agent-factory-mind-*/*"
        ],
      },
    ],
  });

  try {
    await client.send(
      new PutRolePolicyCommand({
        RoleName: taskRoleName,
        PolicyName: "MindPersistenceAccess",
        PolicyDocument: persistencePolicyDocument,
      })
    );
  } catch (err: any) {
    console.warn(`[iam] Failed to attach MindPersistenceAccess to ${taskRoleName}:`, err);
  }

  // 1c. Attach Bedrock Converse Policy to Task Role
  const bedrockPolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
        ],
        Resource: "*",
      },
    ],
  });

  try {
    await client.send(
      new PutRolePolicyCommand({
        RoleName: taskRoleName,
        PolicyName: "BedrockConverseAccess",
        PolicyDocument: bedrockPolicyDocument,
      })
    );
  } catch (err: any) {
    console.warn(`[iam] Failed to attach BedrockConverseAccess to ${taskRoleName}:`, err);
  }

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
