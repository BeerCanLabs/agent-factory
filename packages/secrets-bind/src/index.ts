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
    async has(secretName) {
      // Metadata only (DescribeSecret): the value is never fetched, so this works for secrets the caller may write
      // but never read (gateway-held keys, §6.11 K5). Present means a current version exists and it is not deleted.
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

export type GcpCli = (args: string[]) => Promise<string>;

/**
 * GCP Secret Manager provider. Reads secret versions via gcloud CLI (or injected cli runner)
 * under the configured GCP project ID.
 */
export function gcpSecretManagerProvider(projectId: string, cli?: GcpCli): SecretProvider {
  const run: GcpCli =
    cli ??
    (async (args) => {
      const { stdout } = await execFileAsync('gcloud', ['secrets', 'versions', 'access', 'latest', ...args], { encoding: 'utf8' });
      return stdout;
    });
  return {
    name: 'gcp-sm',
    async get(secretName) {
      try {
        const out = await run(['--secret', secretName, '--project', projectId]);
        const value = out.replace(/\r?\n$/, '');
        return value || undefined;
      } catch {
        return undefined;
      }
    },
    async put() {
      throw new SecretWriteNotImplementedError('gcp-sm');
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
  if (env.FACTORY_SECRETS_GCP_PROJECT) providers.push(gcpSecretManagerProvider(env.FACTORY_SECRETS_GCP_PROJECT));
  if (env.FACTORY_SECRETS_HTTP_URL) {
    providers.push(httpProvider(env.FACTORY_SECRETS_HTTP_URL, env.FACTORY_SECRETS_HTTP_TOKEN));
  }
  return providers;
}
