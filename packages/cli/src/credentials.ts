/**
 * Sign-in (§6.17 CL1, A1, A2): the person's Cloudflare Access assertion, obtained through the proxy's browser flow
 * (`cloudflared access login`) and kept in the macOS Keychain. The CLI holds no FACTORY_TOKEN and nothing it makes up.
 */
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CredentialStore {
  get(instance: string): Promise<string | undefined>;
  set(instance: string, token: string): Promise<void>;
  delete(instance: string): Promise<void>;
}

const SERVICE = 'com.beercanlabs.factory-cli';

const run = (cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') return reject(err);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The macOS Keychain, through `security`. The secret goes to `security -i` on stdin, never on the command line, where
 * other users' `ps` would show it.
 */
export class KeychainStore implements CredentialStore {
  constructor(private readonly exec: typeof run = run) {}

  async get(instance: string): Promise<string | undefined> {
    const r = await this.exec('security', ['find-generic-password', '-s', SERVICE, '-a', instance, '-w']);
    const token = r.stdout.trim();
    return r.code === 0 && token ? token : undefined;
  }

  async set(instance: string, token: string): Promise<void> {
    if (/[\r\n]/.test(token)) throw new Error('refusing to store a malformed credential');
    const r = await this.exec('security', ['-i'], `add-generic-password -U -s ${q(SERVICE)} -a ${q(instance)} -w ${q(token)}\n`);
    if (r.code !== 0) throw new Error('could not save the sign-in to the macOS Keychain');
  }

  async delete(instance: string): Promise<void> {
    await this.exec('security', ['delete-generic-password', '-s', SERVICE, '-a', instance]);
  }
}

/** For machines without a Keychain (development, Linux). A file readable by its owner only. */
export class FileStore implements CredentialStore {
  constructor(private readonly path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'factory-cli', 'credentials.json')) {}

  private async all(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async get(instance: string): Promise<string | undefined> {
    return (await this.all())[instance];
  }

  async set(instance: string, token: string): Promise<void> {
    const all = await this.all();
    all[instance] = token;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(all), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async delete(instance: string): Promise<void> {
    const all = await this.all();
    delete all[instance];
    if (Object.keys(all).length === 0) await rm(this.path, { force: true });
    else await writeFile(this.path, JSON.stringify(all), { mode: 0o600 });
  }
}

export function defaultStore(platform = process.platform): CredentialStore {
  return platform === 'darwin' ? new KeychainStore() : new FileStore();
}

/** Seconds since the epoch at which the assertion expires, read from its payload (not verified: the factory verifies). */
export function expiryOf(token: string): number | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

export const isFresh = (token: string, now = Date.now(), skewSeconds = 60): boolean => {
  const exp = expiryOf(token);
  return exp !== undefined && exp * 1000 - now > skewSeconds * 1000;
};

/** Runs `cloudflared`, the proxy's own client. `interactive` hands it the terminal (the browser sign-in prints a link). */
export type Cloudflared = (args: string[], interactive: boolean) => Promise<{ code: number; stdout: string }>;

export const runCloudflared: Cloudflared = (args, interactive) =>
  interactive
    ? new Promise((resolve, reject) => {
        const child = spawn('cloudflared', args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, stdout: '' }));
      })
    : run('cloudflared', args);

export class NeedsLoginError extends Error {
  constructor(instance: string) {
    super(`not signed in to ${instance}. Run: factory login ${instance}`);
    this.name = 'NeedsLoginError';
  }
}

export class AccessSession {
  constructor(
    private readonly instance: string,
    private readonly store: CredentialStore,
    private readonly cloudflared: Cloudflared = runCloudflared,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  /** The assertion to send. `refresh` skips the stored one and asks the proxy's client for a new one (silently). */
  async token(refresh = false): Promise<string> {
    const given = this.env.FACTORY_CLI_ACCESS_TOKEN?.trim();
    if (given) return given;
    if (!refresh) {
      const stored = await this.store.get(this.instance);
      if (stored && isFresh(stored, this.now())) return stored;
    }
    const fetched = await this.fetchToken();
    if (fetched) {
      await this.store.set(this.instance, fetched);
      return fetched;
    }
    throw new NeedsLoginError(this.instance);
  }

  private async fetchToken(): Promise<string | undefined> {
    try {
      const r = await this.cloudflared(['access', 'token', `-app=${this.instance}`], false);
      const t = r.stdout.trim();
      return r.code === 0 && isFresh(t, this.now()) ? t : undefined;
    } catch {
      return undefined;
    }
  }

  /** The browser sign-in. `cloudflared` opens the proxy's login page and keeps its own session; we keep a copy of the assertion. */
  async login(): Promise<void> {
    let r;
    try {
      r = await this.cloudflared(['access', 'login', this.instance], true);
    } catch {
      throw new Error('cloudflared is not installed. Install it with: brew install cloudflared');
    }
    if (r.code !== 0) throw new Error('the sign-in did not complete');
    const fetched = await this.fetchToken();
    if (!fetched) throw new Error('signed in, but could not read the sign-in back from cloudflared');
    await this.store.set(this.instance, fetched);
  }

  async logout(): Promise<void> {
    await this.store.delete(this.instance);
  }
}
