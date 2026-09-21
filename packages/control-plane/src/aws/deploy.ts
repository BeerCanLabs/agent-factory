import type { DeployProvider } from '../runtime.js';
import { buildAgentImage } from './codebuild.js';
import { provisionAgentRoles } from './iam.js';
import { registerAgentTaskDefinition } from './ecs.js';

export function awsDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, sourceRef: string): Promise<string> {
      return buildAgentImage(agentId, sourceRef);
    },

    async provisionIdentity(agentId: string, secrets: string[]): Promise<{ identity: string; executionIdentity?: string }> {
      const { taskRoleArn, executionRoleArn } = await provisionAgentRoles(agentId, secrets);
      return { identity: taskRoleArn, executionIdentity: executionRoleArn };
    },

    async registerCompute(
      agentId: string,
      imageUri: string,
      secrets: string[],
      identity: string,
      executionIdentity?: string,
    ): Promise<void> {
      await registerAgentTaskDefinition(agentId, imageUri, secrets, identity, executionIdentity ?? identity);
    },
  };
}
