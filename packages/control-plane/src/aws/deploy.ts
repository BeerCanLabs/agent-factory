import type { BuildSkill, DeployProvider, SourceRef } from '../runtime.js';
import { buildAgentImage } from './codebuild.js';
import { provisionAgentRoles } from './iam.js';
import { registerAgentTaskDefinition } from './ecs.js';

export function awsDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, source: SourceRef, skills?: BuildSkill[]): Promise<string> {
      return buildAgentImage(agentId, source, { skills });
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
      memoryPrefix?: string,
      launchEnv?: Record<string, string>,
    ): Promise<void> {
      await registerAgentTaskDefinition(agentId, imageUri, secrets, identity, executionIdentity ?? identity, memoryPrefix ?? agentId, launchEnv);
    },
  };
}
