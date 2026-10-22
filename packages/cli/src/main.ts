#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FactoryClient } from './client.js';
import { loadConfig, normalizeInstance, parseAuth, parseManager, parseTheme, saveConfig, type CliConfig } from './config.js';
import { defaultStore, forgetSignIn } from './credentials.js';
import { discoverAuth } from './discover.js';
import { knownMethod, makeSession } from './methods.js';
import { repl } from './repl.js';

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

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(`${version}\n`); return 0; }

  if (cmd === 'config') {
    if (arg === 'get') {
      const c = await loadConfig();
      process.stdout.write(`address  ${c.instance ?? '(not set)'}\nauth     ${c.auth ?? 'auto'}\ntheme    ${c.theme ?? 'auto'}\nmanager  ${c.manager ?? 'factory-manager'}\n`);
      return 0;
    }
    if (arg === 'set') {
      if (!argv[2] || argv[3] === undefined) throw new Error('usage: factory config set <key> <value>');
      process.stdout.write(`${await setConfig(argv[2], argv.slice(3).join(' '))}\n`);
      return 0;
    }
    throw new Error('usage: factory config get | factory config set <key> <value>');
  }

  if (cmd === 'login') {
    if (!arg) throw new Error('usage: factory login <address>');
    const instance = normalizeInstance(arg);
    const store = defaultStore();
    const saved = await loadConfig();
    const found = await discoverAuth(instance);
    await makeSession(found.type, instance, { store, say: (t) => process.stdout.write(`${t}\n`) }, found.type === 'oidc' ? found : undefined).login();
    // A sign-in belongs to one factory (CL8): the old address is signed out once the new one is signed in.
    if (saved.instance && saved.instance !== instance) await forgetSignIn(saved.instance, store);
    await saveConfig({ ...saved, instance, auth: found.type });
    process.stdout.write(`Signed in to ${instance}.\n`);
    return 0;
  }

  if (cmd === 'logout' || cmd === 'whoami') {
    const instance = await instanceInUse();
    const store = defaultStore();
    const kind = await knownMethod(instance, (await loadConfig()).auth, store);
    if (!kind) {
      if (cmd === 'logout') { process.stdout.write(`Not signed in to ${instance}.\n`); return 0; }
      throw new Error(`not signed in to ${instance}. Run: factory login ${instance}`);
    }
    const session = makeSession(kind, instance, { store });
    if (cmd === 'logout') {
      await session.logout();
      process.stdout.write(`Signed out of ${instance}.\n`);
      return 0;
    }
    const me = await new FactoryClient({ baseUrl: instance, credential: (refresh) => session.credential(refresh) }).whoami();
    process.stdout.write(`${me.actor} (${me.roles.join(', ') || 'no role'}) at ${instance}\n`);
    return 0;
  }

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
