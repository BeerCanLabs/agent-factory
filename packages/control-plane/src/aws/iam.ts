import {
  IAMClient,
  CreateRoleCommand,
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
  const createTaskRoleResponse = await client.send(
    new CreateRoleCommand({
      RoleName: taskRoleName,
      AssumeRolePolicyDocument: assumeRolePolicyDocument,
      Description: `Task Role for Agent ${agentId}`,
    })
  );

  const taskRoleArn = createTaskRoleResponse.Role?.Arn as string;

  // 2. Create Execution Role
  const createExecutionRoleResponse = await client.send(
    new CreateRoleCommand({
      RoleName: executionRoleName,
      AssumeRolePolicyDocument: assumeRolePolicyDocument,
      Description: `Execution Role for Agent ${agentId}`,
    })
  );

  const executionRoleArn = createExecutionRoleResponse.Role?.Arn as string;

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
          Resource: secrets,
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
