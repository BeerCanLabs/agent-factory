import type { AgentRecord } from '@beercanlabs/factory-registrar';

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
};

export type GitHubReleaseInfo = {
  tagName: string;
  version: string;
  commitSha?: string;
  body: string;
  publishedAt: string;
};

export type UpdateCheckResult = {
  updateAvailable: boolean;
  installedVersion: string;
  offeredVersion?: string;
  offeredCommit?: string;
  releaseNotes?: string;
  publishedAt?: string;
  lastCheckedAt: string;
};

/**
 * Parses a semantic version tag (e.g. "v1.2.0" or "1.2.0") into major, minor, patch.
 */
export function parseSemVer(val?: string | null): SemVer | null {
  if (!val) return null;
  const m = val.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

/**
 * Returns true if version A is strictly newer than version B according to SemVer.
 * If either is unparseable, defaults to comparing against fallback '0.1.0'.
 */
export function isNewerVersion(newerCandidate?: string | null, currentBaseline?: string | null): boolean {
  const newer = parseSemVer(newerCandidate);
  if (!newer) return false;
  const current = parseSemVer(currentBaseline) ?? { major: 0, minor: 1, patch: 0 };

  if (newer.major > current.major) return true;
  if (newer.major < current.major) return false;
  if (newer.minor > current.minor) return true;
  if (newer.minor < current.minor) return false;
  return newer.patch > current.patch;
}

/**
 * Extracts owner and repo name from GitHub URLs or "owner/repo" strings.
 */
export function extractGitHubRepo(repoUrl?: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim();
  // Match https://github.com/owner/repo(.git)? or git@github.com:owner/repo(.git)?
  const urlMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }
  // Match owner/repo
  const slugMatch = trimmed.match(/^([^/]+)\/([^/.]+)$/);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2] };
  }
  return null;
}

/**
 * Fetches the latest published release for a GitHub repository using the GitHub REST API.
 */
export async function fetchLatestRelease(
  repoUrl: string,
  token?: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<GitHubReleaseInfo | null> {
  const parsed = extractGitHubRepo(repoUrl);
  if (!parsed) return null;

  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agent-factory-update-checker',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      if (res.status === 404) return null; // No releases published yet
      console.warn(`[updates] GitHub releases check failed for ${parsed.owner}/${parsed.repo}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      tag_name?: string;
      target_commitish?: string;
      body?: string;
      published_at?: string;
    };
    if (!data.tag_name) return null;

    const parsedVersion = parseSemVer(data.tag_name);
    const version = parsedVersion ? `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}` : data.tag_name.replace(/^v/, '');

    return {
      tagName: data.tag_name,
      version,
      commitSha: data.target_commitish,
      body: data.body ?? '',
      publishedAt: data.published_at ?? new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[updates] Network error checking releases for ${parsed.owner}/${parsed.repo}:`, err);
    return null;
  }
}

/**
 * Checks for updates on a specific AgentRecord against GitHub releases.
 */
export async function checkAgentUpdate(
  agent: Pick<AgentRecord, 'id' | 'repo' | 'installedVersion' | 'deployedCommit'>,
  token?: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<UpdateCheckResult> {
  const now = new Date().toISOString();
  const installedVersion = agent.installedVersion ?? '0.1.0';

  if (!agent.repo) {
    return {
      updateAvailable: false,
      installedVersion,
      lastCheckedAt: now,
    };
  }

  const release = await fetchLatestRelease(agent.repo, token, fetchFn);
  if (!release) {
    return {
      updateAvailable: false,
      installedVersion,
      lastCheckedAt: now,
    };
  }

  const updateAvailable = isNewerVersion(release.version, installedVersion);

  return {
    updateAvailable,
    installedVersion,
    offeredVersion: release.version,
    offeredCommit: release.commitSha,
    releaseNotes: release.body,
    publishedAt: release.publishedAt,
    lastCheckedAt: now,
  };
}
