import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAgentId } from './ids.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const THEMES = ['auto', 'dark', 'light', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];

/** The CLI's own settings (§6.17 CL1, CL8). No credential is kept here, and none of it is sent to the factory. */
export type CliConfig = { instance?: string; theme?: ThemeName; manager?: string };

export const DEFAULT_MANAGER = 'factory-manager';

export function parseTheme(raw: string): ThemeName {
  const t = raw.trim().toLowerCase();
  if ((THEMES as readonly string[]).includes(t)) return t as ThemeName;
  throw new Error(`theme must be one of: ${THEMES.join(', ')}`);
}

export function parseAgentId(raw: string): string {
  const id = raw.trim();
  if (!isAgentId(id)) throw new Error('an agent id is letters, digits, . _ - (at most 64 characters)');
  return id;
}
export const parseManager = parseAgentId;

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
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const out: CliConfig = {};
    if (typeof parsed.instance === 'string') {
      try {
        out.instance = normalizeInstance(parsed.instance);
      } catch {
        /* a hand-edited address that is not valid is ignored */
      }
    }
    if (typeof parsed.theme === 'string' && (THEMES as readonly string[]).includes(parsed.theme)) out.theme = parsed.theme as ThemeName;
    if (isAgentId(parsed.manager)) out.manager = parsed.manager;
    return out;
  } catch {
    return {};
  }
}

export async function saveConfig(config: CliConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600); // `mode` only applies when the file is created

}
