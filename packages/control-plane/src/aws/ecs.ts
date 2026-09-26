import { ECSClient, RegisterTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { SecretsManagerClient, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";

const ecsClient = new ECSClient({});
const smClient = new SecretsManagerClient({});

export async function resolveSecretArn(secretNameOrArn: string, fallbackArn?: string): Promise<string> {
  if (secretNameOrArn.startsWith("arn:aws:")) {
    return secretNameOrArn;
  }
  const prefix = process.env.FACTORY_SECRETS_AWS_PREFIX || "factory/prod/";
  const secretId = secretNameOrArn.startsWith(prefix) ? secretNameOrArn : `${prefix}${secretNameOrArn}`;
  try {
    const res = await smClient.send(new DescribeSecretCommand({ SecretId: secretId }));
    if (res.ARN) return res.ARN;
  } catch {
    try {
      const res = await smClient.send(new DescribeSecretCommand({ SecretId: secretNameOrArn }));
      if (res.ARN) return res.ARN;
    } catch {}
  }
  const region = process.env.AWS_REGION || "us-east-1";
  const parsedAccount = fallbackArn?.startsWith("arn:aws:") ? fallbackArn.split(":")[4] : undefined;
  const accountId = process.env.AWS_ACCOUNT_ID || process.env.BCL_AWS_ACCOUNT_ID || parsedAccount;
  if (!accountId) throw new Error('AWS_ACCOUNT_ID environment variable is required');
  return `arn:aws:secretsmanager:${region}:${accountId}:secret:${prefix}${secretNameOrArn}`;
}

/**
 * Registers an ECS Fargate Task Definition for a Factory agent.
 * 
 * @param agentId - The unique identifier for the agent
 * @param imageUri - The container image URI
 * @param secrets - Array of AWS Secrets Manager secret names or ARNs
 * @param taskRoleArn - ARN for the task role
 * @param execRoleArn - ARN for the task execution role
 */
export async function registerAgentTaskDefinition(
  agentId: string,
  imageUri: string,
  secrets: string[],
  taskRoleArn: string,
  execRoleArn: string
) {
  const resolvedSecrets = await Promise.all(
    secrets.map(async (secretNameOrArn, i) => {
      const arn = await resolveSecretArn(secretNameOrArn, taskRoleArn);
      const namePart = secretNameOrArn.startsWith("arn:aws:")
        ? (secretNameOrArn.split(':').pop() || `SECRET_${i}`)
        : secretNameOrArn;
      const envName = namePart.replace(/^.*[\/:]/, '').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
      
      return {
        name: envName,
        valueFrom: arn,
      };
    })
  );

  const command = new RegisterTaskDefinitionCommand({
    family: `agent-${agentId}`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256", // default minimal cpu
    memory: "512", // default minimal memory
    taskRoleArn,
    executionRoleArn: execRoleArn,
    containerDefinitions: [
      {
        name: `agent-container`,
        image: imageUri,
        essential: true,
        secrets: resolvedSecrets,
        environment: [
          {
            name: "FACTORY_MIND_BUCKET",
            value: process.env.FACTORY_MIND_BUCKET || "agent-factory-mind-prod-924cfefd",
          },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/ecs/factory-prod`,
            "awslogs-region": process.env.AWS_REGION || "us-east-1",
            "awslogs-stream-prefix": `agent-${agentId}`,
          },
        },
      },
    ],
  });

  const response = await ecsClient.send(command);
  return response.taskDefinition;
}
