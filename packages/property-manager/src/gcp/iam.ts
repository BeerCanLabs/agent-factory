/**
 * GCP IAM provisioning for dynamic Factory agents.
 * Equivalent to packages/property-manager/src/aws/iam.ts.
 */

import { GoogleAuth } from 'google-auth-library';
import { agentContainerSecrets } from '../aws/gatekeeper-held.js';
import { resolveGcpSecretId } from './cloudrun.js';

const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/iam',
  ],
});

export type GcpIamRequestClient = {
  request(opts: { url: string; method: string; data?: unknown }): Promise<{ data?: any }>;
};

async function getAuthClient(): Promise<GcpIamRequestClient> {
  return (await auth.getClient()) as unknown as GcpIamRequestClient;
}

/**
 * Provisions a dedicated GCP Service Account for a dynamically-deployed agent
 * and grants it:
 * - roles/storage.objectAdmin on the mind bucket (scoped to its own prefix)
 * - roles/secretmanager.secretAccessor on each non-gatekeeper-held container secret (S1)
 */
export async function provisionAgentServiceAccount(
  agentId: string,
  secrets: string[],
  opts: { client?: GcpIamRequestClient } = {},
): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const mindBucket = (process.env.FACTORY_MIND_BUCKET ?? `factory-prod-mind-${projectId}`).replace(
    /^gcs:\/\/|^gs:\/\//,
    '',
  );
  const saAccountId = `factory-agent-${agentId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 30)
    .replace(/-+$/, '');
  const saEmail = `${saAccountId}@${projectId}.iam.gserviceaccount.com`;

  const client = opts.client ?? (await getAuthClient());

  try {
    await client.request({
      url: `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`,
      method: 'POST',
      data: {
        accountId: saAccountId,
        serviceAccount: {
          displayName: `Factory Agent: ${agentId}`,
          description: `Dynamically provisioned SA for agent ${agentId}`,
        },
      },
    });
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number }; code?: number }).response?.status ?? (err as { code?: number }).code;
    if (status !== 409) {
      throw err;
    }
  }

  await setStorageBucketIamBinding(client, mindBucket, saEmail, agentId);

  // S1: gatekeeper-held secrets are never injected into the container, so the agent SA is never granted them.
  const containerSecrets = agentContainerSecrets(secrets ?? []);
  for (const rawSecret of containerSecrets) {
    const secretId = resolveGcpSecretId(rawSecret);
    await grantSecretAccess(client, projectId, secretId, saEmail);
  }

  return saEmail;
}

async function setStorageBucketIamBinding(
  client: GcpIamRequestClient,
  bucket: string,
  saEmail: string,
  agentId: string,
): Promise<void> {
  const { data: currentPolicy } = await client.request({
    url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
    method: 'GET',
  });

  const condTitle = `own-mind-prefix-${agentId}`;
  const newBinding = {
    role: 'roles/storage.objectAdmin',
    members: [`serviceAccount:${saEmail}`],
    condition: {
      title: condTitle,
      description: `Agent ${agentId} can only access its own mind prefix`,
      expression: `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${agentId}/")`,
    },
  };

  const existingBindings = (currentPolicy?.bindings ?? []).filter(
    (b: { condition?: { title?: string } }) => b.condition?.title !== condTitle,
  );

  const updatedPolicy = {
    ...currentPolicy,
    version: 3,
    bindings: [...existingBindings, newBinding],
  };

  await client.request({
    url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
    method: 'PUT',
    data: updatedPolicy,
  });
}

async function grantSecretAccess(
  client: GcpIamRequestClient,
  projectId: string,
  secretName: string,
  saEmail: string,
): Promise<void> {
  const secretResource = `projects/${projectId}/secrets/${secretName}`;

  let currentPolicy: { version?: number; bindings?: Array<{ role: string; members: string[] }> } = {
    bindings: [],
  };
  try {
    const { data } = await client.request({
      url: `https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy`,
      method: 'GET',
    });
    if (data) currentPolicy = data;
  } catch {
    return;
  }

  const existingBinding = currentPolicy.bindings?.find(
    (b) => b.role === 'roles/secretmanager.secretAccessor',
  );
  const member = `serviceAccount:${saEmail}`;
  if (existingBinding?.members?.includes(member)) {
    return;
  }

  const updatedPolicy = {
    version: 1,
    bindings: [
      ...(currentPolicy.bindings ?? []).filter((b) => b.role !== 'roles/secretmanager.secretAccessor'),
      {
        role: 'roles/secretmanager.secretAccessor',
        members: [...(existingBinding?.members ?? []), member],
      },
    ],
  };

  await client.request({
    url: `https://secretmanager.googleapis.com/v1/${secretResource}:setIamPolicy`,
    method: 'POST',
    data: { policy: updatedPolicy },
  });
}
