#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FactoryClient } from './client.js';
import { loadConfig, normalizeInstance, parseAuth, parseManager, parseTheme, saveConfig, type CliConfig } from './config.js';
import { defaultStore, forgetSignIn } from './credentials.js';
import { discoverAuth } from './discover.js';
import { knownMethod, makeSession } from './methods.js';
import { repl } from './repl.js';
import { commandHelp } from './commands.js';
import { isCommand, runCommand } from './runner.js';
import { createInterface } from 'node:readline/promises';

const version = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `factory ${version}

  factory                         open the CLI (set up and sign in from inside: /config, /login)
  factory login <address>         shortcut: point the CLI at your factory and sign in
  factory logout                  forget the sign-in
  factory whoami                  show who you are signed in as
  factory config get              show the settings
  factory config set <key> <value>  keys: address, auth (auto|cloudflare-access|oidc), theme, manager
  factory --manager <id>          use a manager agent with another id for this run
  factory --version

Any command from the conversation also runs on its own, for scripts: factory spend --json, factory runs donna --active,
factory budget donna 5 daily --yes. A command that changes state asks first on a terminal and needs --yes anywhere else.

${commandHelp()}
`;

/** The address in use: FACTORY_URL, else the saved one. */
async function instanceInUse(): Promise<string> {
  const env = process.env.FACTORY_URL?.trim();
  const instance = env ? normalizeInstance(env) : (await loadConfig()).instance;
  if (!instance) throw new Error('no factory chosen. Run `factory` and use /config, or: factory login <address>');
  return instance;
}

async function setConfig(key: string, value: string): Promise<string> {
  const store = defaultStore();
  const config: CliConfig = await loadConfig();
  if (key === 'address') {
    const next = normalizeInstance(value);
    if (config.instance && config.instance !== next) {
      // A sign-in belongs to one factory (CL8): moving to another address signs out of the old one, and forgets how it signed in.
      await forgetSignIn(config.instance, store);
      delete config.auth;
    }
    config.instance = next;
  } else if (key === 'auth') {
    const method = parseAuth(value);
    if (method) config.auth = method;
    else delete config.auth;
  } else if (key === 'theme') config.theme = parseTheme(value);
  else if (key === 'manager') config.manager = parseManager(value);
  else throw new Error('unknown setting. Keys: address, auth, theme, manager');
  await saveConfig(config);
  return `${key} set.`;
}

/** Writes, and returns once the data has been handed on. A pipe takes it in pieces; exiting before then cuts the output off. */
const writeAll = (stream: NodeJS.WriteStream, text: string): Promise<void> => new Promise((resolve) => void stream.write(text, () => resolve()));

/** `factory <command> ...` outside the conversation (§6.17 CL11): output on stdout, anything else on stderr, a failure exits 1. */
async function runOneCommand(argv: string[]): Promise<number> {
  const instance = await instanceInUse();
  const store = defaultStore();
  const kind = await knownMethod(instance, (await loadConfig()).auth, store);
  if (!kind) throw new Error(`not signed in to ${instance}. Run: factory login ${instance}`);
  const session = makeSession(kind, instance, { store });
  const client = new FactoryClient({ baseUrl: instance, credential: (refresh) => session.credential(refresh) });
  const me = await client.whoami();
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY); // the question is on stderr, so it must be seen
  const io = {
    note: (t: string) => void process.stderr.write(`${t}\n`),
    confirm: async (q: string) => {
      if (!tty) {
        process.stderr.write(`${q.split('\n')[0]}\nThis changes the factory; add --yes to run it from a script.\n`);
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
  // The script's own arguments, exactly: a note that contains quotes or --yes is one argument, not more words (CL4).
  const out = await runCommand({ client, roles: me.roles, actor: me.actor, argv, io });
  await writeAll(out.ok ? process.stdout : process.stderr, `${out.output}\n`);
  return out.ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { await writeAll(process.stdout, USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v') { await writeAll(process.stdout, `${version}\n`); return 0; }

  if (cmd === 'config') {
    if (arg === 'get') {
      const c = await loadConfig();
      await writeAll(process.stdout, `address  ${c.instance ?? '(not set)'}\nauth     ${c.auth ?? 'auto'}\ntheme    ${c.theme ?? 'auto'}\nmanager  ${c.manager ?? 'factory-manager'}\n`);
      return 0;
    }
    if (arg === 'set') {
      if (!argv[2] || argv[3] === undefined) throw new Error('usage: factory config set <key> <value>');
      await writeAll(process.stdout, `${await setConfig(argv[2], argv.slice(3).join(' '))}\n`);
      return 0;
    }
    throw new Error('usage: factory config get | factory config set <key> <value>');
  }

  if (cmd === 'login') {
    if (!arg) throw new Error('usage: factory login <address>');
    const instance = normalizeInstance(arg);
    const store = defaultStore();
    const saved = await loadConfig();
    // The factory may not be askable (a proxy that does not redirect, a network blip): the installer's saved hint stands in.
    const found = await discoverAuth(instance).catch((err: unknown) => {
      if (saved.instance === instance && saved.auth === 'cloudflare-access') return { type: 'cloudflare-access' } as const;
      throw err;
    });
    await makeSession(found.type, instance, { store, say: (t) => void process.stdout.write(`${t}\n`) }, found.type === 'oidc' ? found : undefined).login();
    // A sign-in belongs to one factory (CL8): the old address is signed out once the new one is signed in.
    if (saved.instance && saved.instance !== instance) await forgetSignIn(saved.instance, store);
    await saveConfig({ ...saved, instance, auth: found.type });
    await writeAll(process.stdout, `Signed in to ${instance}.\n`);
    return 0;
  }

  if (cmd === 'logout' || cmd === 'whoami') {
    const instance = await instanceInUse();
    const store = defaultStore();
    const kind = await knownMethod(instance, (await loadConfig()).auth, store);
    if (!kind) {
      if (cmd === 'logout') { await writeAll(process.stdout, `Not signed in to ${instance}.\n`); return 0; }
      throw new Error(`not signed in to ${instance}. Run: factory login ${instance}`);
    }
    const session = makeSession(kind, instance, { store });
    if (cmd === 'logout') {
      await session.logout();
      await writeAll(process.stdout, `Signed out of ${instance}.\n`);
      return 0;
    }
    const me = await new FactoryClient({ baseUrl: instance, credential: (refresh) => session.credential(refresh) }).whoami();
    await writeAll(process.stdout, `${me.actor} (${me.roles.join(', ') || 'no role'}) at ${instance}\n`);
    return 0;
  }

  if (cmd && isCommand(cmd)) return await runOneCommand(argv);

  const m = argv.indexOf('--manager');
  const stray = argv.filter((_, i) => m < 0 || (i !== m && i !== m + 1));
  if (stray.length) throw new Error(`unknown command "${stray[0]}". factory --help lists them.`);
  if (m >= 0 && !argv[m + 1]) throw new Error('usage: factory --manager <agent id>');
  await repl({ version, store: defaultStore(), managerOverride: m >= 0 ? argv[m + 1] : undefined });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
