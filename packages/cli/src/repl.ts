/**
 * The terminal conversation (§6.17 CL1, CL2, CL5, CL8). It opens with nothing configured and nobody signed in; setup
 * (`/config`, `/login`) is part of the conversation and can be run at any time.
 */
import { createInterface } from 'node:readline';
import { AuthRequiredError, ConversationRefused, FactoryClient } from './client.js';
import { talk, renderReply, stripControl, type Io } from './conversation.js';
import { ManagerSession } from './manager.js';
import { NeedsLoginError, forgetSignIn, type Cloudflared, type CredentialStore } from './credentials.js';
import { discoverAuth, type Discovered } from './discover.js';
import { knownMethod, makeSession } from './methods.js';
import type { OidcConfig } from './oidc.js';
import type { Session } from './session.js';
import { DEFAULT_MANAGER, THEMES, configPath, loadConfig, normalizeInstance, parseAuth, parseManager, parseTheme, saveConfig, type CliConfig } from './config.js';
import { isAgentId } from './ids.js';
import { splash } from './splash.js';
import { commandHelp, findCommand } from './commands.js';
import { runCommand } from './runner.js';
import { styleFor, type Style } from './theme.js';

const BASIC_HELP = [
  'Talk to the Factory Manager in plain words: costs, agents, budgets, approvals.',
  'It can also connect you to an agent so you talk to it directly.',
  '',
  '  /login             sign in, sign out, or sign in as a different user',
  '  /config            factory address, theme, manager agent',
  '  /connect <agent>   talk to an agent directly',
  '  /manager           go back to the Factory Manager',
  '  /whoami            who you are signed in as',
  '  /help              this text',
  '  /exit              leave',
  '',
  'Direct forms: /config address <url>, /config theme <auto|dark|light|mono>, /config manager <agent>, /config auth <auto|cloudflare-access|oidc>.',
].join('\n');

/** Commands work with no Factory Manager at all, and for anyone whose roles allow them (add --json for raw output). */
export const HELP = `${BASIC_HELP}\n\nCommands (no manager needed; they show only what your roles allow):\n${commandHelp()}`;

/** Lines from the terminal, queued so none is lost between questions, and `null` once input has closed. */
export type Lines = {
  /** `fresh` drops anything typed ahead first, so a line typed before the question cannot answer it. */
  ask(prompt: string, opts?: { fresh?: boolean }): Promise<string | null>;
  close(): void;
};

export function lineReader(input: NodeJS.ReadableStream, out: NodeJS.WritableStream): Lines {
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (l) => (waiting.shift() ?? ((x) => queue.push(x as string)))(l));
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  return {
    ask: (prompt, opts) => {
      if (opts?.fresh) queue.length = 0;
      out.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

export function terminalIo(lines: Lines, out: NodeJS.WritableStream, style: () => Style, isTTY: boolean): Io {
  let timer: NodeJS.Timeout | undefined;
  return {
    say: (t) => out.write(`${t}\n`),
    note: (t) => out.write(`${style().dim(stripControl(t))}\n`),
    confirm: async (q) => /^y(es)?$/i.test(((await lines.ask(`${q} [y/N] `, { fresh: true })) ?? '').trim()),
    busy: (on) => {
      if (on && !timer && isTTY) {
        let n = 0;
        timer = setInterval(() => out.write(`\r${'.'.repeat((n++ % 3) + 1)}  `), 400);
      } else if (!on && timer) {
        clearInterval(timer);
        timer = undefined;
        out.write('\r    \r');
      }
    },
  };
}

export type ReplOptions = {
  version: string;
  store: CredentialStore;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  /** Where the CLI's settings live. */
  configFile?: string;
  /** A manager agent id for this run only (`--manager`). */
  managerOverride?: string;
  cloudflared?: Cloudflared;
  cloudflaredDir?: string;
  /** Finds out how the factory signs people in (§6.17 CL9). */
  discover?: (instance: string) => Promise<Discovered>;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  isTTY?: boolean;
};

type Me = { actor: string; roles: string[] };

class App {
  config: CliConfig = {};
  instanceFromEnv = false;
  envProblem?: string;
  /** Why the last attempt to read who is signed in failed, when it was not a refusal. */
  private lastError?: unknown;
  me?: Me;
  agent?: string;
  private session?: Session;
  /** What the factory said about signing in, when this run has asked. */
  private oidc?: OidcConfig;
  private client?: FactoryClient;
  private manager?: ManagerSession;
  style: Style;
  readonly io: Io;
  readonly lines: Lines;
  private readonly env: NodeJS.ProcessEnv;
  private readonly file: string;
  private readonly isTTY: boolean;

  constructor(
    private readonly o: ReplOptions,
    private readonly out: NodeJS.WritableStream,
  ) {
    this.env = o.env ?? process.env;
    this.file = o.configFile ?? configPath(this.env);
    this.isTTY = o.isTTY ?? Boolean((out as NodeJS.WriteStream).isTTY);
    this.style = styleFor(undefined, { isTTY: this.isTTY, env: this.env });
    this.lines = lineReader(o.input ?? process.stdin, out);
    this.io = terminalIo(this.lines, out, () => this.style, this.isTTY);
  }

  get instance(): string | undefined {
    return this.config.instance;
  }

  get managerAgent(): string {
    const given = this.o.managerOverride || this.env.FACTORY_MANAGER_AGENT?.trim();
    return isAgentId(given) ? given : this.config.manager || DEFAULT_MANAGER;
  }

  async load(): Promise<void> {
    this.config = await loadConfig(this.file);
    const fromEnv = this.env.FACTORY_URL?.trim();
    if (fromEnv) {
      // FACTORY_URL wins. A bad one is never quietly replaced by the saved address: confirmed changes would land on the wrong factory.
      try {
        this.config.instance = normalizeInstance(fromEnv);
        this.instanceFromEnv = true;
      } catch (err) {
        this.config.instance = undefined;
        this.envProblem = `FACTORY_URL is set but is not a usable address (${err instanceof Error ? err.message : String(err)}). Unset it or fix it.`;
      }
    }
    this.applyTheme();
    // An earlier version kept only an Access assertion and no hint; use it rather than make the person sign in again.
    if (this.instance && !this.config.auth) this.config.auth = await knownMethod(this.instance, undefined, this.o.store, this.env);
    this.connect();
    await this.refreshMe();
  }

  private applyTheme(): void {
    this.style = styleFor(this.config.theme, { isTTY: this.isTTY, env: this.env });
  }

  /** (Re)builds the session, client and manager for the current address. Nothing is contacted. */
  private connect(): void {
    this.me = undefined;
    this.manager = undefined;
    this.agent = undefined;
    if (!this.instance) {
      this.session = undefined;
      this.client = undefined;
      return;
    }
    this.session = this.config.auth ? this.buildSession(this.config.auth) : undefined;
    this.client = new FactoryClient({
      baseUrl: this.instance,
      credential: (r) => (this.session ? this.session.credential(r) : Promise.reject(new NeedsLoginError(this.instance!))),
      fetch: this.o.fetch,
      sleep: this.o.sleep,
    });
  }

  private buildSession(kind: NonNullable<CliConfig['auth']>): Session {
    return makeSession(
      kind,
      this.instance!,
      { store: this.o.store, fetch: this.o.fetch, say: (t) => this.io.say(t), openBrowser: this.o.openBrowser, cloudflared: this.o.cloudflared, cloudflaredDir: this.o.cloudflaredDir, env: this.env, signInTimeoutMs: this.o.timeoutMs },
      this.oidc,
    );
  }

  /** Who is signed in, if anyone, asked of the factory. Never opens a browser. */
  async refreshMe(): Promise<void> {
    this.me = undefined;
    this.manager = undefined;
    this.lastError = undefined;
    if (!this.client) return;
    try {
      this.me = await this.client.whoami();
      this.manager = new ManagerSession({
        client: this.client,
        agent: this.managerAgent,
        roles: this.me.roles,
        actor: this.me.actor,
        io: this.io,
        version: this.o.version,
        intervalMs: this.o.intervalMs,
        timeoutMs: this.o.timeoutMs,
      });
    } catch (err) {
      this.me = undefined;
      this.lastError = err;
    }
  }

  showSplash(): void {
    if (this.envProblem) this.out.write(`${this.style.bad(this.envProblem)}\n`);
    this.out.write(`${splash({ version: this.o.version, config: { ...this.config, manager: this.managerAgent }, instanceFromEnv: this.instanceFromEnv, me: this.me, signIn: this.session?.describe() }, this.style)}\n`);
  }

  prompt(): string {
    const s = this.style;
    if (!this.me) return s.accent('factory> ');
    return s.accent(`${this.agent ?? 'manager'}> `);
  }

  // /config -------------------------------------------------------------------------------------------------------

  private async save(): Promise<void> {
    const { instance, theme, manager, auth } = this.config;
    const persisted: CliConfig = { ...(this.instanceFromEnv ? {} : instance ? { instance } : {}), ...(theme ? { theme } : {}), ...(manager ? { manager } : {}), ...(auth ? { auth } : {}) };
    // An address that came from FACTORY_URL is not ours to write; keep the one already saved.
    if (this.instanceFromEnv) {
      const saved = await loadConfig(this.file);
      if (saved.instance) persisted.instance = saved.instance;
    }
    await saveConfig(persisted, this.file);
  }

  async setAddress(raw: string): Promise<void> {
    if (this.instanceFromEnv) {
      this.io.say('FACTORY_URL is set in your environment and overrides the address. Unset it to change the address here.');
      return;
    }
    const next = normalizeInstance(raw);
    if (next === this.instance) {
      this.io.say(`The factory address is already ${next}.`);
      return;
    }
    // A sign-in belongs to one factory, so the old one goes, and so does what we knew about how it signs people in.
    if (this.instance) await forgetSignIn(this.instance, this.o.store, this.o.cloudflaredDir);
    this.config.instance = next;
    this.config.auth = undefined;
    this.oidc = undefined;
    await this.save();
    this.connect();
    this.io.say(`Factory address set to ${next}. Use /login to sign in.`);
  }

  async setTheme(raw: string): Promise<void> {
    this.config.theme = parseTheme(raw);
    await this.save();
    this.applyTheme();
    this.io.say(`Theme set to ${this.config.theme}.`);
  }

  async setAuth(raw: string): Promise<void> {
    this.config.auth = parseAuth(raw);
    this.oidc = undefined;
    await this.save();
    this.connect();
    await this.refreshMe();
    this.io.say(this.config.auth ? `Sign-in method set to ${this.config.auth}.` : 'The sign-in method will be found out at the next /login.');
  }

  async setManager(raw: string): Promise<void> {
    this.config.manager = parseManager(raw);
    await this.save();
    await this.refreshMe();
    this.io.say(`Manager agent set to ${this.config.manager}.`);
  }

  async configure(args: string): Promise<void> {
    const [key, ...rest] = args.split(/\s+/).filter(Boolean);
    const value = rest.join(' ');
    try {
      if (key === 'address' || key === 'url') return await this.requireValue(value, 'address', (v) => this.setAddress(v));
      if (key === 'theme') return await this.requireValue(value, 'theme', (v) => this.setTheme(v));
      if (key === 'manager') return await this.requireValue(value, 'manager', (v) => this.setManager(v));
      if (key === 'auth') return await this.requireValue(value, 'auth', (v) => this.setAuth(v));
      if (key) {
        this.io.say('Unknown setting. /config address <url>, /config theme <name>, /config manager <agent>, /config auth <method>.');
        return;
      }
      this.io.say(`${this.style.bold('Settings')}  (Enter keeps the current value)`);
      const addr = await this.lines.ask(`  Factory address [${this.instance ?? 'not set'}]: `);
      if (addr === null) return;
      if (addr.trim()) await this.setAddress(addr);
      const theme = await this.lines.ask(`  Theme (${THEMES.join('/')}) [${this.config.theme ?? 'auto'}]: `);
      if (theme === null) return;
      if (theme.trim()) await this.setTheme(theme);
      const mgr = await this.lines.ask(`  Manager agent [${this.managerAgent}]: `);
      if (mgr === null) return;
      if (mgr.trim()) await this.setManager(mgr);
    } catch (err) {
      this.io.say(`${this.style.bad('Not changed:')} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async requireValue(value: string, what: string, set: (v: string) => Promise<void>): Promise<void> {
    if (!value) this.io.say(`Give a value: /config ${what} <value>.`);
    else await set(value);
  }

  // /login --------------------------------------------------------------------------------------------------------

  async login(): Promise<void> {
    if (!this.instance) {
      const addr = await this.lines.ask('No factory address is set. Factory address: ');
      if (!addr?.trim()) return;
      try {
        await this.setAddress(addr);
      } catch (err) {
        this.io.say(`${this.style.bad('Not changed:')} ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!this.instance) return;
    }
    if (this.me) {
      this.io.say(`Signed in as ${this.me.actor} (${this.me.roles.join(', ') || 'no role'}) at ${this.instance}.`);
      const choice = ((await this.lines.ask('  1) Sign out   2) Sign in as a different user   3) Cancel [3]: ')) ?? '3').trim();
      if (choice === '1') {
        if (await this.signOut()) this.io.say('Signed out.');
      } else if (choice === '2') {
        if (!(await this.signOut())) return;
        this.io.say('Signed out. If the browser signs you straight back in as the same person, sign out of your identity provider there first.');
        await this.signIn({ differentUser: true });
      }
      return;
    }
    await this.signIn();
  }

  /** Asks the factory how it signs people in, and builds the session for it. A factory that cannot be asked keeps the saved hint. */
  private async chooseMethod(): Promise<boolean> {
    const find = this.o.discover ?? ((i: string) => discoverAuth(i, this.o.fetch));
    try {
      const found = await find(this.instance!);
      this.oidc = found.type === 'oidc' ? found : undefined;
      if (this.config.auth !== found.type) {
        this.config.auth = found.type;
        await this.save();
      }
      this.session = this.buildSession(found.type);
      return true;
    } catch (err) {
      if (this.session) return true; // could not ask; use what is known
      this.io.say(`${this.style.bad('Could not find out how to sign in:')} ${stripControl(err instanceof Error ? err.message : String(err))}`);
      return false;
    }
  }

  private async signOut(): Promise<boolean> {
    let ok = true;
    try {
      await this.session?.logout();
    } catch (err) {
      ok = false;
      this.io.say(`${this.style.bad('Could not remove the saved sign-in:')} ${stripControl(err instanceof Error ? err.message : String(err))}`);
    }
    this.me = undefined;
    this.manager = undefined;
    this.agent = undefined;
    if (this.env.FACTORY_CLI_ACCESS_TOKEN?.trim()) this.io.say('FACTORY_CLI_ACCESS_TOKEN is set in your environment, so the next request still uses it. Unset it to be signed out.');
    return ok;
  }

  private async signIn(opts: { differentUser?: boolean } = {}): Promise<void> {
    try {
      if (!(await this.chooseMethod())) return;
      this.io.say(`Signing in to ${this.instance} with ${this.session!.describe()} ...`);
      await this.session!.login(opts);
      await this.refreshMe();
      if (this.me) this.io.say(`${this.style.good('Signed in')} as ${this.me.actor} (${this.me.roles.join(', ') || 'no role'}).`);
      else if (this.lastError instanceof AuthRequiredError || this.lastError instanceof NeedsLoginError) this.io.say(`${this.style.bad('Signed in, but the factory did not accept it.')} Check the address with /config.`);
      else this.io.say(`${this.style.bad('Signed in, but could not reach the factory:')} ${stripControl(this.lastError instanceof Error ? this.lastError.message : 'unknown error')}. Try /login again.`);
    } catch (err) {
      this.io.say(`${this.style.bad('Sign-in failed:')} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // commands ------------------------------------------------------------------------------------------------------

  /** One of the person's own commands (CL11). Needs a sign-in, not a manager. */
  async command(line: string): Promise<void> {
    if (!this.me || !this.client) {
      this.io.say(this.instance ? 'You are not signed in. Type /login.' : 'No factory is set up yet. Type /config to set the address, then /login.');
      return;
    }
    try {
      const out = await runCommand({ client: this.client, roles: this.me.roles, actor: this.me.actor, line, io: this.io });
      this.io.say(out.output);
    } catch (err) {
      if (err instanceof NeedsLoginError || err instanceof AuthRequiredError) return this.expired();
      this.io.say(stripControl(`Error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // conversation --------------------------------------------------------------------------------------------------

  private expired(): void {
    this.me = undefined;
    this.manager = undefined;
    this.agent = undefined;
    this.io.say('Your sign-in expired or was refused. /login to sign in again.');
  }

  async say(line: string): Promise<void> {
    if (!this.me || !this.client) {
      this.io.say(this.instance ? 'You are not signed in. Type /login.' : 'No factory is set up yet. Type /config to set the address, then /login.');
      return;
    }
    try {
      if (this.agent) {
        const reply = await talk(this.client, this.agent, { content: line }, this.io, { intervalMs: this.o.intervalMs, timeoutMs: this.o.timeoutMs });
        this.io.say(renderReply(reply));
        return;
      }
      const outcome = await this.manager!.ask(line);
      if (outcome.kind === 'connect') {
        this.agent = outcome.agent;
        this.io.say(`Connected to ${this.agent}. /manager to go back.`); // an id passes isAgentId, so it holds no control characters
      }
    } catch (err) {
      if (err instanceof NeedsLoginError || err instanceof AuthRequiredError) return this.expired();
      if (err instanceof ConversationRefused && !this.agent && [402, 403, 404].includes(err.status)) {
        const why =
          err.status === 404
            ? `There is no Factory Manager on this factory (no agent called ${this.managerAgent}). An admin has to admit it; see docs/CLI.md.`
            : err.status === 402
              ? 'The Factory Manager is over its budget, so it cannot answer.'
              : `${err.message}`;
        this.io.say(`${why}\nYou can still use commands (/agents, /spend, /status, /approvals ... /help lists them) and /connect <agent>.`);
        return;
      }
      this.io.say(stripControl(err instanceof ConversationRefused ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`));
      if (err instanceof ConversationRefused && this.agent && err.status === 404) this.agent = undefined;
    }
  }
}

export async function repl(o: ReplOptions): Promise<void> {
  const out = o.output ?? process.stdout;
  const app = new App(o, out);
  await app.load();
  app.showSplash();
  try {
    for (;;) {
      const raw = await app.lines.ask(app.prompt());
      if (raw === null) break; // input closed
      const line = raw.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') app.io.say(HELP);
      else if (line === '/login') await app.login();
      else if (line === '/config' || line.startsWith('/config ')) await app.configure(line.slice('/config'.length));
      else if (line === '/whoami') app.io.say(app.me ? `${app.me.actor} (${app.me.roles.join(', ') || 'no role'}) at ${app.instance}` : 'Not signed in. Type /login.');
      else if (line === '/manager') {
        app.agent = undefined;
        app.io.say('Back with the Factory Manager.');
      } else if (/^\/connect\b/.test(line)) {
        const m = line.match(/^\/connect\s+(\S+)$/);
        if (!app.me) app.io.say('Sign in first: /login.');
        else if (!m || !isAgentId(m[1])) app.io.say('Usage: /connect <agent id>');
        else {
          app.agent = m[1];
          app.io.say(`Connected to ${app.agent}. /manager to go back.`);
        }
      } else if (line.startsWith('/') && findCommand(line.slice(1).split(/\s+/)[0])) await app.command(line);
      else if (line.startsWith('/')) app.io.say('Unknown command. /help lists them.');
      else await app.say(line);
    }
  } finally {
    app.lines.close();
  }
}
