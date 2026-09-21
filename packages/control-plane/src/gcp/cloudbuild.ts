/**
 * GCP Cloud Build orchestration for dynamic agent image builds.
 * Equivalent to packages/control-plane/src/aws/codebuild.ts.
 *
 * The Factory Control Plane calls buildAgentImage() when
 * POST /api/v1/registry/agents/<id>/deploy is invoked for a GCP agent.
 *
 * Cloud Build pulls the repo, runs docker build, and pushes to Artifact Registry.
 */

import { CloudBuildClient, protos } from '@google-cloud/cloudbuild';

type Build = protos.google.devtools.cloudbuild.v1.IBuild;

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

/**
 * Triggers a Cloud Build job to build a Docker image from the given repository URL
 * and push it to the Artifact Registry. Polls until completion.
 *
 * @param agentId  - Unique agent ID; used as the Docker image tag.
 * @param repoUrl  - Git repository URL to clone and build from.
 * @returns        - Full image URI (artifact-registry-repo:agentId).
 */
export async function buildAgentImage(agentId: string, repoUrl: string): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const arRepo = process.env.FACTORY_ARTIFACT_REGISTRY;
  if (!arRepo) throw new Error('FACTORY_ARTIFACT_REGISTRY environment variable is not set');

  const imageUri = `${arRepo}:${agentId}`;
  const client = new CloudBuildClient();

  // Inline build definition — equivalent to the CodeBuild buildspec.
  // We clone the repo in the first step, then build and push.
  const build: Build = {
    source: {
      gitSource: {
        url: repoUrl,
        dir: '.',
        revision: 'refs/heads/main',
      },
    },
    steps: [
      {
        // Step 1: Build the Docker image
        name: 'gcr.io/cloud-builders/docker',
        args: ['build', '-t', imageUri, '.'],
        id: 'build',
      },
      {
        // Step 2: Push to Artifact Registry
        name: 'gcr.io/cloud-builders/docker',
        args: ['push', imageUri],
        id: 'push',
        waitFor: ['build'],
      },
    ],
    images: [imageUri],
    substitutions: {
      _AGENT_ID: agentId,
      _ARTIFACT_REGISTRY: arRepo,
    },
    options: {
      logging: 'CLOUD_LOGGING_ONLY' as const,
    },
  };

  console.log(`[gcp/cloudbuild] Starting Cloud Build for agent ${agentId} from ${repoUrl}`);

  const [operation] = await client.createBuild({ projectId, build });

  // The operation metadata contains the build ID
  const metadata = operation.metadata as protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;
  const buildId = metadata?.build?.id;
  if (!buildId) {
    throw new Error('Cloud Build did not return a build ID');
  }

  console.log(`[gcp/cloudbuild] Build started: ${buildId}`);

  // Poll until terminal status
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const [currentBuild] = await client.getBuild({ projectId, id: buildId });
    const status = currentBuild.status as string | undefined;

    console.log(`[gcp/cloudbuild] Build ${buildId} status: ${status}`);

    if (status === 'SUCCESS') {
      console.log(`[gcp/cloudbuild] Build succeeded. Image: ${imageUri}`);
      return imageUri;
    }

    if (status && TERMINAL_STATUSES.has(status) && status !== 'SUCCESS') {
      throw new Error(`Cloud Build failed with status: ${status}`);
    }

    // Status is QUEUED or WORKING — keep polling
  }
}
