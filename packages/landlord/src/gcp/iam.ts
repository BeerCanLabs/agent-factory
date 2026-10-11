/**
 * GCP IAM provisioning for dynamic Factory agents.
 * Equivalent to packages/control-plane/src/aws/iam.ts.
 *
 * Creates a dedicated Service Account for a dynamically-deployed agent,
 * then grants it:
 * - storage.objectAdmin on the mind bucket (scoped to its own prefix)
 * - secretmanager.secretAccessor on each of the agent's required secrets
 *
 * This is the zero-trust model: each agent can only access its own data.
 */

import { IAMCredentialsClient } from '@google-cloud/iam-credentials';
import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/iam',
  ],
});

async function getAuthClient() {
  return auth.getClient();
}

/**
 * Provisions a dedicated GCP Service Account for a dynamically-deployed agent.
 * Equivalent to AWS provisionAgentRoles().
 *
 * In GCP, there is no separation between "task role" and "execution role" —
 * there is a single Service Account that the Cloud Run Job runs as.
 * The SA gets access to the agent's mind prefix and its required secrets.
 *
 * @param agentId  - Unique agent identifier.
 * @param secrets  - List of Secret Manager secret names the agent requires.
 * @returns        - The new Service Account's email address.
 */
export async function provisionAgentServiceAccount(
  agentId: string,
  secrets: string[],
): Promise<string> {
  const projectId = process.env.FACTORY_GCP_PROJECT;
  if (!projectId) throw new Error('FACTORY_GCP_PROJECT environment variable is not set');

  const mindBucket = process.env.FACTORY_MIND_BUCKET ?? `factory-prod-mind-${projectId}`;
  const saAccountId = `factory-agent-${agentId}`.slice(0, 30); // SA IDs max 30 chars
  const saEmail = `${saAccountId}@${projectId}.iam.gserviceaccount.com`;

  const client = await getAuthClient();

  // 1. Create the Service Account
  console.log(`[gcp/iam] Creating Service Account ${saEmail}`);
  try {
    await (client as unknown as { request: Function }).request({
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
    console.log(`[gcp/iam] Service Account ${saEmail} created.`);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 409) {
      console.log(`[gcp/iam] Service Account ${saEmail} already exists; continuing.`);
    } else {
      throw err;
    }
  }

  // 2. Grant storage.objectAdmin on the mind bucket scoped to the agent's prefix
  // GCS IAM conditions use CEL expressions for prefix-scoped access
  console.log(`[gcp/iam] Granting mind bucket access to ${saEmail}`);
  await setStorageBucketIamBinding(client, mindBucket, saEmail, agentId);

  // 3. Grant secretmanager.secretAccessor on each required secret
  for (const secretName of secrets) {
    console.log(`[gcp/iam] Granting Secret Manager access for ${secretName} to ${saEmail}`);
    await grantSecretAccess(client, projectId, secretName, saEmail);
  }

  return saEmail;
}

/**
 * Adds a prefix-scoped IAM binding on a GCS bucket for the given SA.
 * Mimics the Terraform google_storage_bucket_iam_member with a CEL condition.
 */
async function setStorageBucketIamBinding(
  client: Awaited<ReturnType<typeof getAuthClient>>,
  bucket: string,
  saEmail: string,
  agentId: string,
): Promise<void> {
  const requestClient = client as unknown as { request: Function };

  // Get current policy
  const { data: currentPolicy } = await requestClient.request({
    url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
    method: 'GET',
  });

  const newBinding = {
    role: 'roles/storage.objectAdmin',
    members: [`serviceAccount:${saEmail}`],
    condition: {
      title: `own-mind-prefix-${agentId}`,
      description: `Agent ${agentId} can only access its own mind prefix`,
      expression: `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${agentId}/")`,
    },
  };

  // Append the new binding to the policy
  const updatedPolicy = {
    ...currentPolicy,
    version: 3, // Required for IAM conditions
    bindings: [...(currentPolicy.bindings ?? []), newBinding],
  };

  await requestClient.request({
    url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
    method: 'PUT',
    data: updatedPolicy,
  });
}

/**
 * Grants secretmanager.secretAccessor on a specific Secret Manager secret to a SA.
 */
async function grantSecretAccess(
  client: Awaited<ReturnType<typeof getAuthClient>>,
  projectId: string,
  secretName: string,
  saEmail: string,
): Promise<void> {
  const requestClient = client as unknown as { request: Function };
  const secretResource = `projects/${projectId}/secrets/${secretName}`;

  // Get current IAM policy for this secret
  let currentPolicy: { version?: number; bindings?: Array<{ role: string; members: string[] }> } = { bindings: [] };
  try {
    const { data } = await requestClient.request({
      url: `https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy`,
      method: 'GET',
    });
    currentPolicy = data;
  } catch {
    // Secret may not exist yet; skip silently (will fail at deploy time if truly missing)
    console.warn(`[gcp/iam] Could not get IAM policy for secret ${secretName}; skipping binding.`);
    return;
  }

  // Check if already bound
  const existingBinding = currentPolicy.bindings?.find((b) => b.role === 'roles/secretmanager.secretAccessor');
  const member = `serviceAccount:${saEmail}`;
  if (existingBinding?.members?.includes(member)) {
    console.log(`[gcp/iam] ${saEmail} already has secretAccessor on ${secretName}; skipping.`);
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

  await requestClient.request({
    url: `https://secretmanager.googleapis.com/v1/${secretResource}:setIamPolicy`,
    method: 'POST',
    data: { policy: updatedPolicy },
  });

  console.log(`[gcp/iam] Granted secretAccessor on ${secretName} to ${saEmail}.`);
}
