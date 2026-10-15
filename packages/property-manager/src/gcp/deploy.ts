import type { BuildSkill, DeployProvider, SourceRef } from '../runtime.js';
import { buildAgentImage } from './cloudbuild.js';
import { provisionAgentServiceAccount } from './iam.js';
import { registerAgentJob } from './cloudrun.js';

export function gcpDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, source: SourceRef, skills?: BuildSkill[]): Promise<string> {
      return buildAgentImage(agentId, source, { skills });
    },

    async provisionIdentity(agentId: string, secrets: string[]): Promise<{ identity: string; executionIdentity?: string }> {
      const saEmail = await provisionAgentServiceAccount(agentId, secrets);
      return { identity: saEmail };
    },

    async registerCompute(
      agentId: string,
      imageUri: string,
      secrets: string[],
      identity: string,
      _executionIdentity?: string,
      memoryPrefix?: string,
      launchEnv?: Record<string, string>,
    ): Promise<void> {
      await registerAgentJob(agentId, imageUri, secrets, identity, memoryPrefix ?? agentId, launchEnv);
    },
  };
}
