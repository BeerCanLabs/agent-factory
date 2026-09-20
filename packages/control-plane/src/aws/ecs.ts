import { ECSClient, RegisterTaskDefinitionCommand } from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({});

/**
 * Registers an ECS Fargate Task Definition for a Factory agent.
 * 
 * @param agentId - The unique identifier for the agent
 * @param imageUri - The container image URI
 * @param secrets - Array of AWS Secrets Manager ARNs
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
        secrets: secrets.map((secretArn, i) => {
          // Attempt to generate a safe environment variable name from the secret ARN
          const namePart = secretArn.split(':').pop() || `SECRET_${i}`;
          const envName = namePart.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
          
          return {
            name: envName,
            valueFrom: secretArn,
          };
        }),
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
