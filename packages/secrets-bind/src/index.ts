import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SecretProvider = {
  name: string;
  get(secretName: string): Promise<string | undefined>;
};

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
  };
}

export type AwsCli = (args: string[]) => Promise<string>;

/**
 * AWS Secrets Manager under a name prefix (e.g. `factory/prod/`). The same prefix the ECS task
 * definition's `secrets` block reads from, so pre-flight checks exactly what the task will receive.
 */
export function awsSecretsManagerProvider(prefix: string, cli?: AwsCli): SecretProvider {
  const run: AwsCli =
    cli ??
    (async (args) => {
      const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
      const { stdout } = await execFileAsync('aws', [...args, ...region], { encoding: 'utf8' });
      return stdout;
    });
  return {
    name: 'aws-sm',
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
