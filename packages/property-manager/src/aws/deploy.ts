import type { BuildSkill, DeployProvider, SourceRef } from '../runtime.js';
import { buildAgentImage, buildSkillsImage } from './codebuild.js';
import { provisionAgentRoles } from './iam.js';
import { registerAgentTaskDefinition } from './ecs.js';

export function awsDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, source: SourceRef, skills?: BuildSkill[]): Promise<string> {
      return buildAgentImage(agentId, source, { skills });
    },

    async buildSkillsImage(agentId: string, base: { image: string; commit: string }, skills: BuildSkill[]): Promise<string> {
      return buildSkillsImage(agentId, base, skills);
    },

    async provisionIdentity(agentId: string, secrets: string[]): Promise<{ identity: string; executionIdentity?: string }> {
      const { taskRoleArn, executionRoleArn } = await provisionAgentRoles(agentId, secrets);
      return { identity: taskRoleArn, executionIdentity: executionRoleArn };
    },

    async provisionHelperCompute(computeId: string, imageUri: string): Promise<void> {
      const { taskRoleArn, executionRoleArn } = await provisionAgentRoles(computeId, [], { memory: false });
      await registerAgentTaskDefinition(computeId, imageUri, [], taskRoleArn, executionRoleArn, computeId);
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
