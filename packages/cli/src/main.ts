#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FactoryClient } from './client.js';
import { loadConfig, normalizeInstance, saveConfig } from './config.js';
import { AccessSession, NeedsLoginError, defaultStore } from './credentials.js';
import { repl } from './repl.js';

const version = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `factory ${version}

  factory login <address>   point the CLI at your factory and sign in
  factory logout            forget the sign-in
  factory whoami            show who you are signed in as
  factory                   talk to the Factory Manager
  factory --manager <id>    use a manager agent with another id (default: factory-manager)
`;

async function resolveInstance(): Promise<string> {
  const env = process.env.FACTORY_URL?.trim();
  const instance = env ? normalizeInstance(env) : (await loadConfig()).instance;
  if (!instance) throw new Error('no factory chosen. Run: factory login <address>');
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
    await saveConfig({ instance });
    process.stdout.write(`Signed in to ${instance}.\n`);
    return 0;
  }

  const instance = await resolveInstance();
  const session = new AccessSession(instance, defaultStore());
  if (cmd === 'logout') {
    await session.logout();
    process.stdout.write(`Signed out of ${instance}.\n`);
    return 0;
  }

  const client = new FactoryClient({ baseUrl: instance, credential: (refresh) => session.token(refresh) });
  if (cmd === 'whoami') {
    const me = await client.whoami();
    process.stdout.write(`${me.actor} (${me.roles.join(', ') || 'no role'}) at ${instance}\n`);
    return 0;
  }

  const m = argv.indexOf('--manager');
  const managerAgent = m >= 0 && argv[m + 1] ? argv[m + 1] : process.env.FACTORY_MANAGER_AGENT || 'factory-manager';
  if (cmd && !cmd.startsWith('--')) throw new Error(`unknown command "${cmd}". factory --help lists them.`);
  await repl({ client, instance, managerAgent, version });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof NeedsLoginError || err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
