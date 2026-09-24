import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";

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

  // 2. Create Execution Role
  let executionRoleArn = "";
  try {
    const createExecutionRoleResponse = await client.send(
      new CreateRoleCommand({
        RoleName: executionRoleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        Description: `Execution Role for Agent ${agentId}`,
      })
    );
    executionRoleArn = createExecutionRoleResponse.Role?.Arn as string;
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

  // 4. Attach Secrets Manager permissions to Execution Role if there are secrets
  if (secrets && secrets.length > 0) {
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
  }

  return {
    taskRoleArn,
    executionRoleArn,
  };
}
