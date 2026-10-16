/**
 * GCP Cloud Run Jobs orchestration for dynamic agent registration.
 * Equivalent to packages/property-manager/src/aws/ecs.ts.
 */

import { JobsClient, protos } from '@google-cloud/run';
import { toGcpSecretId } from '@beercanlabs/factory-secrets-bind';
import { agentContainerSecrets, secretName } from '../aws/gatekeeper-held.js';

type Job = protos.google.cloud.run.v2.IJob;
type EnvVar = protos.google.cloud.run.v2.IEnvVar;

export function resolveGcpSecretId(secretNameOrResource: string, env: NodeJS.ProcessEnv = process.env): string {
  if (secretNameOrResource.startsWith('projects/')) {
    const parts = secretNameOrResource.split('/');
    const idx = parts.indexOf('secrets');
    return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : secretNameOrResource;
  }
  const prefix = env.FACTORY_SECRETS_GCP_PREFIX ?? '';
  return toGcpSecretId(prefix, secretNameOrResource);
}

/**
 * The container's non-secret environment on GCP: where the mind lives (`gcs://<mindBucket>`),
 * plus launch settings named by the Landlord (SK4: where the skills manifest is).
 * `launchEnv` may not replace the fixed mind settings.
 */
export function agentEnvironment(
  mindBucket: string,
  memoryPrefix: string,
  launchEnv: Record<string, string> = {},
): Array<{ name: string; value: string }> {
  const storeUri = mindBucket.startsWith('gcs://') || mindBucket.startsWith('gs://') ? mindBucket : `gcs://${mindBucket}`;
  const bucketName = mindBucket.replace(/^gcs:\/\/|^gs:\/\//, '');
  const fixed = [
    { name: 'FACTORY_MIND_BUCKET', value: bucketName },
    { name: 'MEMORY_STORE_URI', value: storeUri },
    { name: 'MEMORY_PREFIX', value: memoryPrefix },
    { name: 'MEMORY_DIR', value: '/tmp/mind' },
  ];
  const taken = new Set(fixed.map((e) => e.name));
  return [
    ...fixed,
    ...Object.entries(launchEnv)
      .filter(([name]) => !taken.has(name))
      .map(([name, value]) => ({ name, value })),
  ];
}

/**
 * Creates or updates a Cloud Run Job for a dynamically-built Factory agent.
 * Equivalent to ECS RegisterTaskDefinition.
 */
export async function registerAgentJob(
  agentId: string,
  imageUri: string,
  secrets: string[],
  serviceAccountEmail: string,
  memoryPrefix: string = agentId,
  launchEnv: Record<string, string> = {},
  opts: { client?: Pick<JobsClient, 'createJob' | 'updateJob'> } = {},
): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const region = process.env.FACTORY_GCP_REGION;
  if (!region) throw new Error('FACTORY_GCP_REGION environment variable is not set');

  const client = opts.client ?? new JobsClient();
  const parent = `projects/${projectId}/locations/${region}`;
  const jobName = `factory-agent-${agentId}`;
  const mindBucket =
    process.env.FACTORY_MIND_BUCKET ?? process.env.MEMORY_STORE_URI ?? `factory-prod-mind-${projectId}`;

  const baseEnv: EnvVar[] = [
    { name: 'AGENT_ID', value: agentId },
    ...agentEnvironment(mindBucket, memoryPrefix, launchEnv),
  ];

  // S1: gatekeeper-held secrets are injected at egress by gatekeeper-egress, never into the container.
  const secretEnv: EnvVar[] = agentContainerSecrets(secrets ?? []).map((rawSecret) => {
    const bare = secretName(rawSecret);
    return {
      name: bare.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase(),
      valueSource: {
        secretKeyRef: {
          secret: resolveGcpSecretId(rawSecret),
          version: 'latest',
        },
      },
    };
  });

  const vpcNetwork = process.env.FACTORY_GCP_VPC_NETWORK;
  const agentsSubnet = process.env.FACTORY_GCP_AGENTS_SUBNET;

  const job: Job = {
    labels: {
      'factory-component': 'agent',
      'factory-agent-id': agentId,
    },
    template: {
      template: {
        serviceAccount: serviceAccountEmail,
        maxRetries: 0,
        timeout: { seconds: 3600 },
        ...(vpcNetwork && agentsSubnet
          ? {
              vpcAccess: {
                networkInterfaces: [
                  {
                    network: vpcNetwork,
                    subnetwork: agentsSubnet,
                  },
                ],
                egress: 'ALL_TRAFFIC' as const,
              },
            }
          : {}),
        containers: [
          {
            image: imageUri,
            name: 'worker',
            resources: {
              limits: {
                cpu: '1000m',
                memory: '512Mi',
              },
            },
            env: [...baseEnv, ...secretEnv],
          },
        ],
      },
    },
  };

  try {
    const [operation] = await client.createJob({ parent, jobId: jobName, job });
    await operation.promise();
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 6) {
      const fullName = `${parent}/jobs/${jobName}`;
      const [operation] = await client.updateJob({ job: { name: fullName, ...job } });
      await operation.promise();
    } else {
      throw err;
    }
  }

  return jobName;
}
