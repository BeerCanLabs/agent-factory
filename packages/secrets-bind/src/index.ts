import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SecretProvider = {
  name: string;
  get(secretName: string): Promise<string | undefined>;
  /**
   * Write (create or replace) a secret value. Optional: read-only sources (env, file) have none.
   * Used by the Keymaster to persist OAuth grants (§6.11 K2/K3). Never logs or echoes the value.
   */
  put?(secretName: string, value: string): Promise<void>;
  /**
   * Whether a secret with this name has a non-empty value, without returning it (§6.11 K5.2). Optional: providers
   * without it are asked with `get`, and the value is discarded. See `secretPresent`.
   */
  has?(secretName: string): Promise<boolean>;
  /**
   * Every secret name this provider holds a current value for, from metadata in one call (never values). Optional:
   * lets a caller checking many secrets ask once instead of once per secret (GAP-056).
   */
  present?(): Promise<Set<string>>;
};

/**
 * True when any provider holds a non-empty value for `name`. Never returns, logs, or keeps the value: providers that
 * can answer without reading it (`has`) do; for the others the value from `get` is dropped immediately.
 */
export async function secretPresent(name: string, providers: SecretProvider[]): Promise<boolean> {
  for (const p of providers) {
    try {
      if (p.has ? await p.has(name) : (await p.get(name)) !== undefined) return true;
    } catch {
      // an unreachable backend is not evidence of presence; try the next one
    }
  }
  return false;
}

export class SecretWriteNotImplementedError extends Error {
  constructor(provider: string) {
    super(`secret provider "${provider}" does not implement writes yet`);
    this.name = 'SecretWriteNotImplementedError';
  }
}

export type WritableSecretProvider = SecretProvider & { put: NonNullable<SecretProvider['put']> };

/** The first provider that can write secrets, or undefined when none is configured. */
export function writableProvider(providers: SecretProvider[]): WritableSecretProvider | undefined {
  return providers.find((p) => typeof p.put === 'function') as WritableSecretProvider | undefined;
}

export type BindResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; missing: string[] };

/** Process env / IAM-injected env. Factory never stores values. */
export function envProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  return {
    name: 'env',
    async get(secretName) {
      const v = env[secretName];
      return v === undefined || v === '' ? undefined : v;
    },
    async has(secretName) {
      return Boolean(env[secretName]);
    },
  };
}

/** Gitignored KEY=value file. Still BYO — not a factory vault. */
export function fileProvider(filePath: string): SecretProvider {
  return {
    name: 'file',
    async get(secretName) {
      if (!existsSync(filePath)) return undefined;
      const map = parseEnvFile(readFileSync(filePath, 'utf8'));
      const v = map[secretName];
      return v === undefined || v === '' ? undefined : v;
    },
    async has(secretName) {
      return existsSync(filePath) && Boolean(parseEnvFile(readFileSync(filePath, 'utf8'))[secretName]);
    },
  };
}

/**
 * Generic HTTP secrets backend (Vault / AWS SM proxy / GCP SM proxy).
 * GET {baseUrl}/{name} with optional bearer. Response JSON `{ value }` or raw text.
 */
export function httpProvider(baseUrl: string, token?: string): SecretProvider {
  return {
    name: 'http',
    async get(secretName) {
      const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(secretName)}`;
      try {
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) return undefined;
        const text = await res.text();
        try {
          const json = JSON.parse(text) as { value?: string; SecretString?: string };
          return json.value ?? json.SecretString ?? undefined;
        } catch {
          return text || undefined;
        }
      } catch {
        return undefined;
      }
    },
    async put() {
      throw new SecretWriteNotImplementedError('http');
    },
  };
}

/** `input` is written to the CLI's stdin (so secret values never appear in argv or the process list). */
export type AwsCli = (args: string[], input?: string) => Promise<string>;

function spawnAwsCli(args: string[], input?: string): Promise<string> {
  const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
  // Node connects a child's stdin with a socket, and Linux refuses to reopen a socket via /dev/stdin (ENXIO),
  // so the CLI's `file:///dev/stdin` fails. When there is input, `cat` hands the CLI a real pipe instead.
  const [cmd, argv] = input === undefined
    ? ['aws', [...args, ...region]]
    : ['sh', ['-c', 'cat | aws "$@"', 'sh', ...args, ...region]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.split('\n').find((l) => l.trim()) || `exit ${code}`))));
    child.stdin.end(input ?? '');
  });
}

/**
 * AWS Secrets Manager under a name prefix (e.g. `factory/prod/`). The same prefix the ECS task
 * definition's `secrets` block reads from, so pre-flight checks exactly what the task will receive.
 */
export function awsSecretsManagerProvider(prefix: string, cli?: AwsCli): SecretProvider {
  const run: AwsCli = cli ?? spawnAwsCli;
  return {
    name: 'aws-sm',
    async put(secretName, value) {
      const id = `${prefix}${secretName}`;
      // The value goes over stdin (`file:///dev/stdin`), never argv.
      try {
        await run(['secretsmanager', 'put-secret-value', '--secret-id', id, '--secret-string', 'file:///dev/stdin'], value);
      } catch (err) {
        if (!/ResourceNotFoundException/.test(err instanceof Error ? err.message : String(err))) throw err;
        await run(['secretsmanager', 'create-secret', '--name', id, '--secret-string', 'file:///dev/stdin'], value);
      }
    },
    async present() {
      // One ListSecrets call (metadata only, never values) for every secret under the prefix that has a current
      // version; secrets scheduled for deletion are not listed. Cheaper than a DescribeSecret per name.
      const out = await run([
        'secretsmanager',
        'list-secrets',
        '--filters',
        `Key=name,Values=${prefix}`,
        '--query',
        "SecretList[?contains(values(SecretVersionsToStages || `{}`)[], 'AWSCURRENT')].Name",
        '--output',
        'json',
      ]);
      const names = JSON.parse(out || '[]') as string[];
      return new Set(names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)));
    },
    async has(secretName) {
      // Metadata only (DescribeSecret): the value is never fetched, so this works for secrets the caller may write
      // but never read (gatekeeper-held keys, §6.11 K5). Present means a current version exists and it is not deleted.
      try {
        const out = await run([
          'secretsmanager',
          'describe-secret',
          '--secret-id',
          `${prefix}${secretName}`,
          '--query',
          "[DeletedDate == null, contains(values(VersionIdsToStages || `{}`)[], 'AWSCURRENT')]",
          '--output',
          'json',
        ]);
        const [live, current] = JSON.parse(out) as [boolean, boolean];
        return live === true && current === true;
      } catch {
        return false;
      }
    },
    async get(secretName) {
      try {
        const out = await run([
          'secretsmanager',
          'get-secret-value',
          '--secret-id',
          `${prefix}${secretName}`,
          '--query',
          'SecretString',
          '--output',
          'text',
        ]);
        const value = out.replace(/\n$/, '');
        return value && value !== 'None' ? value : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export type GcpCli = (args: string[], input?: string) => Promise<string>;

export type GcpSecretManagerOptions = {
  prefix?: string;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string>;
};

let cachedGcpToken: { token: string; expiresAt: number } | undefined;

/**
 * Fetches an OAuth2 access token for GCP REST APIs:
 * 1. GOOGLE_OAUTH_ACCESS_TOKEN env var (if set)
 * 2. Cloud Run / GCE Metadata Server (cached until 60s before expiry)
 * 3. Local `gcloud auth print-access-token` fallback for workstation development
 */
export async function getGcpAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  }
  if (cachedGcpToken && Date.now() < cachedGcpToken.expiresAt - 60_000) {
    return cachedGcpToken.token;
  }
  try {
    const res = await fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      if (data.access_token) {
        cachedGcpToken = {
          token: data.access_token,
          expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
        };
        return data.access_token;
      }
    }
  } catch {
    // Fall back to gcloud CLI when outside GCE/Cloud Run metadata environment
  }
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  return stdout.trim();
}

/**
 * Maps a logical secret name (which may contain `/` for Keymaster grants like `connections/donna/google`)
 * to a valid GCP Secret Manager secret ID (`[a-zA-Z0-9_-]`).
 */
export function toGcpSecretId(prefix: string, secretName: string): string {
  return `${prefix}${secretName.replace(/\//g, '---')}`;
}

export function fromGcpSecretId(prefix: string, gcpSecretId: string): string | undefined {
  if (!gcpSecretId.startsWith(prefix)) return undefined;
  return gcpSecretId.slice(prefix.length).replace(/---/g, '/');
}

/**
 * GCP Secret Manager provider under an optional name prefix (e.g. `factory-prod-`).
 * Uses native GCP Secret Manager REST API in production (no `gcloud` binary required in containers, GAP-023),
 * or an injected `cli` runner for unit tests.
 */
export function gcpSecretManagerProvider(
  projectId: string,
  cli?: GcpCli,
  options?: GcpSecretManagerOptions,
): SecretProvider {
  const prefix = options?.prefix ?? '';
  const fetchFn = options?.fetch ?? fetch;
  const tokenFn = options?.getAccessToken ?? (() => getGcpAccessToken(fetchFn));
  const baseUrl = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;

  if (cli) {
    return {
      name: 'gcp-sm',
      async get(secretName) {
        const id = toGcpSecretId(prefix, secretName);
        try {
          const out = await cli(['--secret', id, '--project', projectId]);
          const value = out.replace(/\r?\n$/, '');
          return value || undefined;
        } catch {
          return undefined;
        }
      },
      async put(secretName, value) {
        const id = toGcpSecretId(prefix, secretName);
        try {
          await cli(['versions', 'add', id, '--project', projectId, '--data-file=-'], value);
        } catch (err) {
          if (!/NOT_FOUND|not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
          await cli(['create', id, '--project', projectId, '--replication-policy=automatic']);
          await cli(['versions', 'add', id, '--project', projectId, '--data-file=-'], value);
        }
      },
      async has(secretName) {
        const id = toGcpSecretId(prefix, secretName);
        try {
          const out = await cli(['versions', 'list', id, '--project', projectId, '--filter=state=ENABLED', '--limit=1', '--format=json']);
          const versions = JSON.parse(out || '[]') as unknown[];
          return Array.isArray(versions) && versions.length > 0;
        } catch {
          return false;
        }
      },
      async present() {
        const out = await cli([
          'list',
          '--project',
          projectId,
          ...(prefix ? [`--filter=name:${prefix}`] : []),
          '--format=json',
        ]);
        const items = JSON.parse(out || '[]') as Array<{ name?: string } | string>;
        const result = new Set<string>();
        for (const item of items) {
          const rawName = typeof item === 'string' ? item : item.name ?? '';
          const shortName = rawName.split('/').pop() ?? '';
          const decoded = fromGcpSecretId(prefix, shortName);
          if (decoded) result.add(decoded);
        }
        return result;
      },
    };
  }

  return {
    name: 'gcp-sm',
    async get(secretName) {
      const id = toGcpSecretId(prefix, secretName);
      try {
        const token = await tokenFn();
        const res = await fetchFn(`${baseUrl}/secrets/${encodeURIComponent(id)}/versions/latest:access`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return undefined;
        const json = (await res.json()) as { payload?: { data?: string } };
        if (!json.payload?.data) return undefined;
        const value = Buffer.from(json.payload.data, 'base64').toString('utf8').replace(/\r?\n$/, '');
        return value || undefined;
      } catch {
        return undefined;
      }
    },
    async put(secretName, value) {
      const id = toGcpSecretId(prefix, secretName);
      const token = await tokenFn();
      const addVersion = () =>
        fetchFn(`${baseUrl}/secrets/${encodeURIComponent(id)}:addVersion`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
        });

      let res = await addVersion();
      if (res.status === 404) {
        const createRes = await fetchFn(`${baseUrl}/secrets?secretId=${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ replication: { automatic: {} } }),
        });
        if (!createRes.ok && createRes.status !== 409) {
          throw new Error(`GCP Secret Manager create failed (${createRes.status})`);
        }
        res = await addVersion();
      }
      if (!res.ok) {
        throw new Error(`GCP Secret Manager addVersion failed (${res.status})`);
      }
    },
    async has(secretName) {
      const id = toGcpSecretId(prefix, secretName);
      try {
        const token = await tokenFn();
        const res = await fetchFn(
          `${baseUrl}/secrets/${encodeURIComponent(id)}/versions?filter=state:ENABLED&pageSize=1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return false;
        const json = (await res.json()) as { versions?: Array<{ state?: string }> };
        return Array.isArray(json.versions) && json.versions.length > 0;
      } catch {
        return false;
      }
    },
    async present() {
      const token = await tokenFn();
      const result = new Set<string>();
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ pageSize: '500' });
        if (prefix) params.set('filter', `name:${prefix}`);
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetchFn(`${baseUrl}/secrets?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`GCP Secret Manager list failed (${res.status})`);
        const json = (await res.json()) as { secrets?: Array<{ name?: string }>; nextPageToken?: string };
        for (const s of json.secrets ?? []) {
          const shortName = (s.name ?? '').split('/').pop() ?? '';
          const decoded = fromGcpSecretId(prefix, shortName);
          if (decoded) result.add(decoded);
        }
        pageToken = json.nextPageToken;
      } while (pageToken);
      return result;
    },
  };
}


export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export async function bindSecrets(
  requires: string[],
  providers: SecretProvider[],
): Promise<BindResult> {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of requires) {
    let value: string | undefined;
    for (const provider of providers) {
      value = await provider.get(name);
      if (value !== undefined) break;
    }
    if (value === undefined) missing.push(name);
    else env[name] = value;
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, env };
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): SecretProvider[] {
  const providers: SecretProvider[] = [envProvider(env)];
  if (env.FACTORY_SECRETS_FILE) providers.push(fileProvider(env.FACTORY_SECRETS_FILE));
  if (env.FACTORY_SECRETS_AWS_PREFIX) providers.push(awsSecretsManagerProvider(env.FACTORY_SECRETS_AWS_PREFIX));
  if (env.FACTORY_SECRETS_GCP_PROJECT) {
    providers.push(
      gcpSecretManagerProvider(env.FACTORY_SECRETS_GCP_PROJECT, undefined, {
        prefix: env.FACTORY_SECRETS_GCP_PREFIX ?? '',
      }),
    );
  }
  if (env.FACTORY_SECRETS_HTTP_URL) {
    providers.push(httpProvider(env.FACTORY_SECRETS_HTTP_URL, env.FACTORY_SECRETS_HTTP_TOKEN));
  }
  return providers;
}

