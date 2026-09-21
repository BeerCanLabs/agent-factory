/**
 * GCP Cloud Run Jobs orchestration for dynamic agent registration.
 * Equivalent to packages/control-plane/src/aws/ecs.ts.
 *
 * The Factory Control Plane calls registerAgentJob() after a successful
 * Cloud Build to register the agent as a Cloud Run Job that can be
 * invoked on-demand (scale to zero).
 */

import { JobsClient, protos } from '@google-cloud/run';

type Job = protos.google.cloud.run.v2.IJob;
type EnvVar = protos.google.cloud.run.v2.IEnvVar;

/**
 * Creates or updates a Cloud Run Job for a dynamically-built Factory agent.
 * Equivalent to ECS RegisterTaskDefinition.
 *
 * @param agentId      - Unique agent identifier.
 * @param imageUri     - Full container image URI from Artifact Registry.
 * @param secrets      - List of Secret Manager secret names to inject as env vars.
 * @param serviceAccountEmail - The agent's dedicated GCP Service Account email.
 */
export async function registerAgentJob(
  agentId: string,
  imageUri: string,
  secrets: string[],
  serviceAccountEmail: string,
): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const region = process.env.FACTORY_GCP_REGION;
  if (!region) throw new Error('FACTORY_GCP_REGION environment variable is not set');

  const client = new JobsClient();
  const parent = `projects/${projectId}/locations/${region}`;
  const jobName = `factory-agent-${agentId}`;
  const mindBucketUri = process.env.MEMORY_STORE_URI ?? `gcs://${projectId}-mind`;

  // Base environment variables — same as the AWS ECS container_definitions env block
  const baseEnv: EnvVar[] = [
    { name: 'AGENT_ID',         value: agentId },
    { name: 'MEMORY_DIR',       value: '/tmp/mind' },
    { name: 'MEMORY_PREFIX',    value: agentId },
    { name: 'MEMORY_STORE_URI', value: mindBucketUri },
  ];

  // Secret environment variables from Secret Manager
  const secretEnv: EnvVar[] = secrets.map((secretName) => ({
    name: secretName.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase(),
    valueSource: {
      secretKeyRef: {
        secret:  secretName,
        version: 'latest',
      },
    },
  }));

  const job: Job = {
    labels: {
      'factory-component': 'agent',
      'factory-agent-id': agentId,
    },
    template: {
      template: {
        serviceAccount: serviceAccountEmail,
        maxRetries: 0,
        timeout: { seconds: 3600 }, // 1-hour max; matches AWS task pattern
        containers: [
          {
            image: imageUri,
            name: 'worker',
            resources: {
              limits: {
                cpu:    '1000m',
                memory: '512Mi',
              },
            },
            env: [...baseEnv, ...secretEnv],
          },
        ],
      },
    },
  };

  console.log(`[gcp/cloudrun] Registering Cloud Run Job ${jobName} with image ${imageUri}`);

  try {
    // Try to create; fall back to update if the job already exists (idempotent)
    const [operation] = await client.createJob({ parent, jobId: jobName, job });
    await operation.promise();
    console.log(`[gcp/cloudrun] Job ${jobName} created.`);
  } catch (err: unknown) {
    // gRPC status 6 = ALREADY_EXISTS
    const code = (err as { code?: number }).code;
    if (code === 6) {
      console.log(`[gcp/cloudrun] Job ${jobName} exists; updating...`);
      const fullName = `${parent}/jobs/${jobName}`;
      const [operation] = await client.updateJob({ job: { name: fullName, ...job } });
      await operation.promise();
      console.log(`[gcp/cloudrun] Job ${jobName} updated.`);
    } else {
      throw err;
    }
  }

  return jobName;
}
