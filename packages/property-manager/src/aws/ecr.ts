function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * TSK-341 (GAP-250): Deletes ECR image tags matching the agent's builds.
 * Tags follow imageTagFor: <agentId>-<commit12> or <agentId>-<commit12>-<skillsHash12>.
 * Strict regex ensures purging `ada` NEVER deletes tags for `ada-helper`.
 */
export async function deleteAgentEcrImages(
  agentId: string,
  opts?: {
    ecrRepoUri?: string;
    exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  }
): Promise<string[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(agentId)) {
    throw new Error(`Invalid agent ID for ECR image deletion: ${agentId}`);
  }
  const ecrRepoUri = opts?.ecrRepoUri ?? process.env.FACTORY_ECR_REPO_URI;
  if (!ecrRepoUri || !ecrRepoUri.trim()) {
    return [];
  }
  const exec = opts?.exec ?? (async (file: string, args: string[]) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    return promisify(execFile)(file, args, { encoding: 'utf8', timeout: 30_000 });
  });

  const slash = ecrRepoUri.lastIndexOf('/');
  const repositoryName = slash >= 0 ? ecrRepoUri.slice(slash + 1) : ecrRepoUri;

  let registryId: string | undefined;
  if (slash >= 0) {
    const host = ecrRepoUri.slice(0, slash);
    const m = host.match(/^([0-9]{12})\.dkr\.ecr\./);
    if (m) registryId = m[1];
  }

  const listArgs = [
    'ecr',
    'list-images',
    '--repository-name',
    repositoryName,
    '--filter',
    'tagStatus=TAGGED',
    '--output',
    'json',
  ];
  if (registryId) {
    listArgs.push('--registry-id', registryId);
  }
  const region = process.env.AWS_REGION;
  if (region) {
    listArgs.push('--region', region);
  }

  let listOutput: string;
  try {
    const res = await exec('aws', listArgs);
    listOutput = res.stdout;
  } catch (err: any) {
    if (/RepositoryNotFoundException/i.test(err?.message ?? '') || /RepositoryNotFoundException/i.test(err?.stderr ?? '')) {
      return [];
    }
    throw err;
  }

  let parsed: { imageIds?: Array<{ imageTag?: string }> } = {};
  try {
    parsed = JSON.parse(listOutput);
  } catch {
    return [];
  }

  const tagPattern = new RegExp(`^${escapeRegExp(agentId)}-[0-9a-f]{12}(?:-[0-9a-f]{12})?$`);
  const matchingTags = (parsed.imageIds ?? [])
    .map((img) => img.imageTag)
    .filter((t): t is string => typeof t === 'string' && tagPattern.test(t));

  if (matchingTags.length === 0) {
    return [];
  }

  const deletedTags: string[] = [];
  const CHUNK_SIZE = 100;
  for (let i = 0; i < matchingTags.length; i += CHUNK_SIZE) {
    const chunk = matchingTags.slice(i, i + CHUNK_SIZE);
    const deleteArgs = [
      'ecr',
      'batch-delete-image',
      '--repository-name',
      repositoryName,
      '--image-ids',
      ...chunk.map((tag) => `imageTag=${tag}`),
      '--output',
      'json',
    ];
    if (registryId) {
      deleteArgs.push('--registry-id', registryId);
    }
    if (region) {
      deleteArgs.push('--region', region);
    }
    try {
      const res = await exec('aws', deleteArgs);
      const delParsed = JSON.parse(res.stdout);
      const delList = (delParsed.imageIds ?? []).map((img: any) => img.imageTag).filter(Boolean);
      deletedTags.push(...delList);
    } catch (err: any) {
      if (/RepositoryNotFoundException/i.test(err?.message ?? '') || /RepositoryNotFoundException/i.test(err?.stderr ?? '')) {
        break;
      }
      throw err;
    }
  }

  return deletedTags;
}
