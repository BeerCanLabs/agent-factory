import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The instance a person points the CLI at (§6.17 CL1). No credential is kept here. */
export type CliConfig = { instance?: string };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'factory-cli', 'config.json');
}

/** A factory is reached over https. Plain http is allowed only for a machine's own loopback (compose bring-up). */
export function normalizeInstance(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a factory address`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('a factory address must be https (http is allowed only for localhost)');
  }
  if (url.username || url.password) throw new Error('a factory address must not contain a username or password');
  return url.origin;
}

export async function loadConfig(path = configPath()): Promise<CliConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CliConfig;
    return typeof parsed.instance === 'string' ? { instance: parsed.instance } : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config: CliConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
