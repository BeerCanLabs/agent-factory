import type { DeployProvider } from '../runtime.js';
import { buildAgentImage } from './cloudbuild.js';
import { provisionAgentServiceAccount } from './iam.js';
import { registerAgentJob } from './cloudrun.js';

export function gcpDeployProvider(): DeployProvider {
  return {
    async buildImage(agentId: string, sourceRef: string): Promise<string> {
      return buildAgentImage(agentId, sourceRef);
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
    ): Promise<void> {
      await registerAgentJob(agentId, imageUri, secrets, identity);
    },
  };
}
