import { AdmissionRefusedError, type DeployProvider, type SourceRef } from '../runtime.js';
import { provisionAgentServiceAccount } from './iam.js';
import { registerAgentJob } from './cloudrun.js';

export function gcpDeployProvider(): DeployProvider {
  return {
    /**
     * Not implemented: the Cloud Build admission build does not yet run the agent's tests (L3), so this provider
     * admits nothing. `buildAgentImage` in ./cloudbuild.ts builds the pinned commit but is not an admission gate.
     */
    async buildImage(agentId: string, source: SourceRef): Promise<string> {
      throw new AdmissionRefusedError(
        'not_supported',
        `GCP admission build for ${agentId}@${source.commit} is not implemented: Cloud Build does not run the agent's tests yet`,
      );
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
