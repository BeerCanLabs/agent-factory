#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FactoryClient } from './client.js';
import { loadConfig, normalizeInstance, saveConfig } from './config.js';
import { AccessSession, defaultStore } from './credentials.js';
import { repl } from './repl.js';

const version = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `factory ${version}

  factory                   open the CLI (set up and sign in from inside: /config, /login)
  factory login <address>   shortcut: point the CLI at your factory and sign in
  factory logout            forget the sign-in
  factory whoami            show who you are signed in as
  factory --manager <id>    use a manager agent with another id for this run
`;

/** The address in use: FACTORY_URL, else the saved one. */
async function instanceInUse(): Promise<string> {
  const env = process.env.FACTORY_URL?.trim();
  const instance = env ? normalizeInstance(env) : (await loadConfig()).instance;
  if (!instance) throw new Error('no factory chosen. Run `factory` and use /config, or: factory login <address>');
  return instance;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(`${version}\n`); return 0; }

  if (cmd === 'login') {
    if (!arg) throw new Error('usage: factory login <address>');
    const instance = normalizeInstance(arg);
    await new AccessSession(instance, defaultStore()).login();
    await saveConfig({ ...(await loadConfig()), instance });
    process.stdout.write(`Signed in to ${instance}.\n`);
    return 0;
  }

  if (cmd === 'logout') {
    const instance = await instanceInUse();
    await new AccessSession(instance, defaultStore()).logout();
    process.stdout.write(`Signed out of ${instance}.\n`);
    return 0;
  }

  if (cmd === 'whoami') {
    const instance = await instanceInUse();
    const session = new AccessSession(instance, defaultStore());
    const me = await new FactoryClient({ baseUrl: instance, credential: (refresh) => session.token(refresh) }).whoami();
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
