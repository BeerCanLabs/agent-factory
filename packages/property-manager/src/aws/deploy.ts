import type { BuildSkill, DeployProvider, PurgeComputeResult, SourceRef } from '../runtime.js';
import { buildAgentImage, buildSkillsImage } from './codebuild.js';
import { deleteAgentRoles, listAgentTaskRoleIds, provisionAgentRoles, reconcileAgentTaskRole, retireAgentTaskRole } from './iam.js';
import { deregisterAgentTaskDefinitions, registerAgentTaskDefinition } from './ecs.js';
import { deleteAgentEcrImages } from './ecr.js';

export function awsDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, source: SourceRef, skills?: BuildSkill[]): Promise<string> {
      return buildAgentImage(agentId, source, { skills });
    },

    async buildSkillsImage(agentId: string, base: { image: string; commit: string }, skills: BuildSkill[]): Promise<string> {
      return buildSkillsImage(agentId, base, skills);
    },

    async provisionIdentity(agentId: string, secrets: string[], opts?: { memoryPrefix?: string }): Promise<{ identity: string; executionIdentity?: string }> {
      const { taskRoleArn, executionRoleArn } = await provisionAgentRoles(agentId, secrets, { memoryPrefix: opts?.memoryPrefix });
      return { identity: taskRoleArn, executionIdentity: executionRoleArn };
    },

    reconcileIdentity: (agentId: string, opts: { memoryPrefix?: string; narrow?: boolean }) => reconcileAgentTaskRole(agentId, opts),
    listIdentities: listAgentTaskRoleIds,
    retireIdentity: retireAgentTaskRole,

    async provisionHelperCompute(computeId: string, imageUri: string): Promise<void> {
      const { taskRoleArn, executionRoleArn } = await provisionAgentRoles(computeId, [], { memory: false });
      await registerAgentTaskDefinition(computeId, imageUri, [], taskRoleArn, executionRoleArn, computeId, { FACTORY_MEMORY: 'false' });
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

    async purgeCompute(agentId: string): Promise<PurgeComputeResult> {
      const deletedRoles = await deleteAgentRoles(agentId);
      const deregisteredTaskDefinitions = await deregisterAgentTaskDefinitions(agentId);
      const deletedImageTags = await deleteAgentEcrImages(agentId);
      return {
        deletedRoles,
        deregisteredTaskDefinitions,
        deletedImageTags,
      };
    },
  };
}
