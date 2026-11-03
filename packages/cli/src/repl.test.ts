import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repl } from './repl.js';
import { fakeFactory, type FakeFactory } from './testing.js';
import type { CredentialStore } from './credentials.js';
import type { Provider } from './testing-oidc.js';

const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const memory = (): CredentialStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};

type Setup = { openBrowser?: (url: string) => Promise<void>; provider?: Provider; storedRaw?: string; cloudflaredFiles?: string[]; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; stored?: boolean; factory?: (f: FakeFactory) => void; login?: 'ok' | 'fail' };

async function run(lines: string[], s: Setup = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-repl-'));
  const configFile = join(dir, 'config.json');
  const cfDir = join(dir, 'cloudflared');
  await mkdir(cfDir);
  for (const n of s.cloudflaredFiles ?? []) await writeFile(join(cfDir, n), 'cached');
  if (s.config) await writeFile(configFile, JSON.stringify(s.config));
  const token = jwt();
  const f = fakeFactory(token);
  s.factory?.(f);
  const store = memory();
  if (s.stored) store.data.set('https://f.example.com', token);
  if (s.storedRaw) store.data.set('https://f.example.com', s.storedRaw);
  const cloudflaredCalls: string[][] = [];
  const cloudflared = async (args: string[]) => {
    cloudflaredCalls.push(args);
    if (args[1] === 'login') return { code: s.login === 'fail' ? 1 : 0, stdout: '' };
    return args[1] === 'token' && s.login !== 'fail' && loggedIn ? { code: 0, stdout: token } : { code: 1, stdout: '' };
  };
  let loggedIn = Boolean(s.stored);
  const wrapped = async (args: string[], interactive: boolean) => {
    const r = await cloudflared(args);
    if (args[1] === 'login' && r.code === 0) loggedIn = true;
    return r;
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = repl({ version: 'test', store, input, output, env: s.env ?? {}, configFile, cloudflared: wrapped, cloudflaredDir: cfDir, fetch: f.fetch, sleep: async () => {}, intervalMs: 0, timeoutMs: 3000, isTTY: false, openBrowser: s.openBrowser ?? s.provider?.openBrowser });
  for (const l of lines) input.write(l + '\n');
  input.end();
  await done;
  const cfFiles = async () => (await readdir(cfDir)).sort();
  const saved = async () => JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
  return { f, text, store, saved, cloudflaredCalls, cfDir, token, cfFiles, configFile };
}

describe('§6.17 CL8 opens with nothing set up', () => {
  it('CL1 shows the splash with no address and no sign-in, and offers /config and /login', async () => {
    const { text, f } = await run(['/exit']);
    assert.match(text, /Agent Factory CLI test/);
    assert.match(text, /Factory\s+not set/);
    assert.match(text, /Signed in\s+no/);
    assert.match(text, /\/config.*to set your factory address, then .*\/login.*to sign in/);
    assert.equal(f.seen.length, 0, 'nothing was contacted');
  });

  it('CL1 typing before setup says what to do instead of failing', async () => {
    const { text } = await run(['how much have we spent?', '/connect donna', '/whoami', '/exit']);
    assert.match(text, /No factory is set up yet\. Type \/config/);
    assert.match(text, /Sign in first/);
    assert.match(text, /Not signed in/);
  });

  it('CL1 with an address but no sign-in it opens signed out, and a stored sign-in is picked up without a browser', async () => {
    const out = await run(['/exit'], { config: { instance: 'https://f.example.com' } });
    assert.match(out.text, /Factory\s+https:\/\/f\.example\.com/);
    assert.match(out.text, /Signed in\s+no/);
    assert.ok(!out.cloudflaredCalls.some((c) => c[1] === 'login'), 'startup never opens the browser');

    const signed = await run(['/exit'], { config: { instance: 'https://f.example.com' }, stored: true });
    assert.match(signed.text, /Signed in\s+access:dale@example\.com \(admin\)/);
    assert.match(signed.text, /Ask the Factory Manager anything/);
  });
});

describe('§6.17 CL8 /config', () => {
  it('CL8 direct forms set the address, theme and manager, and save them for the next run', async () => {
    const { text, saved } = await run(['/config address f.example.com', '/config theme dark', '/config manager chief-of-staff', '/exit']);
    assert.match(text, /Factory address set to https:\/\/f\.example\.com/);
    assert.match(text, /Theme set to dark/);
    assert.match(text, /Manager agent set to chief-of-staff/);
    assert.deepEqual(await saved(), { instance: 'https://f.example.com', theme: 'dark', manager: 'chief-of-staff' });
  });

  it('CL8 bare /config walks the settings and Enter keeps each one', async () => {
    const { saved } = await run(['/config', 'f.example.com', '', '', '/exit']);
    assert.deepEqual(await saved(), { instance: 'https://f.example.com' });
  });

  it('CL8 refuses a bad value without changing anything', async () => {
    const { text, saved } = await run(['/config theme neon', '/config address http://remote.example.com', '/config manager "bad id"', '/config nope', '/exit'], { config: { theme: 'light' } });
    assert.match(text, /theme must be one of: auto, dark, light, mono/);
    assert.match(text, /must be https/);
    assert.match(text, /Not changed/);
    assert.match(text, /Unknown setting/);
    assert.deepEqual(await saved(), { theme: 'light' });
  });

  it('CL8 changing the address signs the person out of the old factory', async () => {
    const { text, store } = await run(['/config address other.example.com', '/whoami', '/exit'], { config: { instance: 'https://f.example.com' }, stored: true });
    assert.equal(store.data.has('https://f.example.com'), false);
    assert.match(text, /Factory address set to https:\/\/other\.example\.com/);
    assert.match(text, /Not signed in/);
  });

  it('CL8 FACTORY_URL wins and /config says so rather than pretending to change it', async () => {
    const { text, saved } = await run(['/config address other.example.com', '/exit'], { env: { FACTORY_URL: 'https://f.example.com' }, config: { instance: 'https://saved.example.com' } });
    assert.match(text, /FACTORY_URL is set/);
    assert.match(text, /\(FACTORY_URL\)/);
    assert.deepEqual(await saved(), { instance: 'https://saved.example.com' });
  });
});

describe('§6.17 CL1 /login', () => {
  it('CL1 a failed sign-in is reported and leaves the person signed out', async () => {
    const { text } = await run(['/login', '/exit'], { config: { instance: 'https://f.example.com' }, login: 'fail' });
    assert.match(text, /Sign-in failed/);
    assert.match(text, /Signed in\s+no/);
  });

  it('CL1 signed in, /login offers sign out, and signing out forgets the sign-in in the store and in cloudflared', async () => {
    const { text, store, cfFiles } = await run(['/login', '1', 'what is up', '/exit'], {
      config: { instance: 'https://f.example.com' },
      stored: true,
      cloudflaredFiles: ['f.example.com-abc123-token', 'other.example.com-abc123-token'],
    });
    assert.match(text, /Signed in as access:dale@example\.com/);
    assert.match(text, /1\) Sign out/);
    assert.match(text, /Signed out\./);
    assert.equal(store.data.has('https://f.example.com'), false);
    assert.deepEqual(await cfFiles(), ['other.example.com-abc123-token'], "this factory's cached token is gone, another's is not");
    assert.match(text, /You are not signed in\. Type \/login\./);
  });

  it('CL1 changing the address removes the old factory\'s sign-in everywhere', async () => {
    const { store, cfFiles } = await run(['/config address other.example.com', '/exit'], { config: { instance: 'https://f.example.com' }, stored: true, cloudflaredFiles: ['f.example.com-abc123-token'] });
    assert.equal(store.data.has('https://f.example.com'), false);
    assert.deepEqual(await cfFiles(), []);
  });

  it('CL1 sign out clears the token cloudflared cached for that host only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-'));
    await writeFile(join(dir, 'f.example.com-aud1-token'), 'x');
    await writeFile(join(dir, 'other.example.com-aud1-token'), 'y');
    await writeFile(join(dir, 'f.example.com-notes.txt'), 'z');
    const { clearCloudflaredTokens } = await import('./credentials.js');
    assert.equal(await clearCloudflaredTokens('https://f.example.com', dir), 1);
    assert.deepEqual((await readdir(dir)).sort(), ['f.example.com-notes.txt', 'other.example.com-aud1-token']);
  });

  it('CL1 an expired sign-in mid-conversation signs the person out and says how to recover', async () => {
    const { text } = await run(['hello', '/exit'], {
      config: { instance: 'https://f.example.com' },
      stored: true,
      factory: (f) => f.agents.set('factory-manager', () => { f.token = 'rotated'; return JSON.stringify({ type: 'message', text: 'x' }); }),
    });
    assert.match(text, /sign-in expired or was refused\. \/login/);
  });
});

describe('S13 /login through the factory login page', () => {
  const loopback = (codeOf = 'c1') => async (url: string) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://f.example.com/login');
    void fetch(`http://127.0.0.1:${u.searchParams.get('cli_port')}/callback?code=${codeOf}&state=${u.searchParams.get('cli_state')}`);
  };
  const factory = (f: FakeFactory) => {
    f.routes.set('POST /api/v1/auth/cli/token', () => ({ status: 200, body: { secret: 'fk_test_secret', key: { id: 'k1', deviceFamily: 'cli' } } }));
    f.acceptBearer = (v) => v === 'Bearer fk_test_secret';
  };

  it('S13 AC1 /login with no address asks for one, opens the factory login page, and stores the cli key; nothing is discovered first', async () => {
    const { text, store, saved, f } = await run(['/login', 'f.example.com', '/exit'], { openBrowser: loopback(), factory });
    assert.match(text, /No factory address is set\. Factory address:/);
    assert.match(text, /Signed in as access:dale@example\.com/);
    assert.equal(store.data.get('https://f.example.com'), 'fk1:fk_test_secret');
    assert.equal((await saved()).auth, 'factory');
    assert.ok(!f.seen.some((x) => x.path.startsWith('/.well-known')), 'no pre-credential fetch');
  });

  it('S13 "different user" signs out, then signs in again through the login page', async () => {
    const { text, store } = await run(['/login', '/login', '2', '/exit'], { config: { instance: 'https://f.example.com' }, openBrowser: loopback(), factory });
    assert.match(text, /2\) Sign in as a different user/);
    assert.match(text, /sign out of your identity provider there first/);
    assert.equal(store.data.get('https://f.example.com'), 'fk1:fk_test_secret');
  });

  it('S13 a refused key exchange is reported and stores nothing', async () => {
    const { text, store } = await run(['/login', '/exit'], { config: { instance: 'https://f.example.com' }, openBrowser: loopback(), factory: (f) => f.routes.set('POST /api/v1/auth/cli/token', () => ({ status: 400, body: { error: 'invalid_grant' } })) });
    assert.match(text, /Sign-in failed: the factory refused the sign-in \(HTTP 400\)/);
    assert.equal(store.data.has('https://f.example.com'), false);
  });
});

describe('§6.17 CL5 the terminal conversation once signed in', () => {
  const signedIn = { config: { instance: 'https://f.example.com' }, stored: true };

  it('CL5 talks to the manager, is connected to an agent on its say-so, then to that agent directly, then back', async () => {
    const { f, text } = await run(['talk to donna', 'hello donna', '/manager', '/exit'], {
      ...signedIn,
      factory: (f) => {
        f.agents.set('factory-manager', () => JSON.stringify({ type: 'connect', agent: 'donna', text: 'Connecting you.' }));
        f.agents.set('donna', (i) => `donna heard: ${i.content}`);
      },
    });
    assert.match(text, /Connecting you\./);
    assert.match(text, /donna> /);
    assert.match(text, /donna heard: hello donna/);
    assert.match(text, /Back with the Factory Manager/);
    assert.deepEqual(f.seen.find((s) => s.path === '/api/v1/agents/donna/conversation')?.body, { content: 'hello donna' });
  });

  it('CL5 /connect goes straight to an agent, and a refusal is worded for the person', async () => {
    const { text } = await run(['/connect nobody', 'hi', '/bogus', '/exit'], signedIn);
    assert.match(text, /no agent called nobody/);
    assert.match(text, /manager> /, 'an unknown agent returns the person to the manager');
    assert.match(text, /Unknown command/);
  });

  it('CL2 says plainly when no Factory Manager has been admitted, and /connect still works', async () => {
    const { text } = await run(['how much have we spent?', '/connect donna', 'hi', '/exit'], { ...signedIn, factory: (f) => f.agents.set('donna', () => 'hello from donna') });
    assert.match(text, /no Factory Manager on this factory/);
    assert.match(text, /hello from donna/);
  });

  it('CL8 the configured manager agent is the one spoken to', async () => {
    const { f } = await run(['hi', '/exit'], { ...signedIn, config: { ...signedIn.config, manager: 'chief' }, factory: (f) => f.agents.set('chief', () => JSON.stringify({ type: 'message', text: 'at your service' })) });
    assert.ok(f.seen.some((s) => s.path === '/api/v1/agents/chief/conversation'));
  });

  it('CL4 a line typed ahead cannot answer a confirmation', async () => {
    const { f } = await run(['pause donna', 'y', '/exit'], {
      ...signedIn,
      factory: (f) => {
        f.routes.set('POST /api/v1/agents/donna/pause', () => ({ status: 200, body: { ok: true } }));
        f.agents.set('factory-manager', (i) => JSON.stringify((i as any).toolResults ? { type: 'message', text: 'ok' } : { type: 'tool_calls', calls: [{ id: '1', name: 'pause_agent', arguments: { id: 'donna' } }] }));
      },
    });
    assert.ok(!f.seen.some((s) => s.path.endsWith('/pause')), 'the "y" was typed before the question, so it is not an answer');
  });

  it('CL5 /connect and the manager id accept only agent ids', async () => {
    const { text, f } = await run(['/connect ..', '/connect a/b', '/exit'], signedIn);
    assert.match(text, /Usage: \/connect <agent id>/);
    assert.equal(f.seen.filter((x) => x.path.includes('/conversation')).length, 0);
  });
});

describe('§6.17 CL8 settings and environment', () => {
  it('CL8 the settings file is private even when it already existed with wider rights', async () => {
    const { configFile } = await run(['/config theme dark', '/exit'], { config: { theme: 'light' } });
    const { chmod, stat } = await import('node:fs/promises');
    await chmod(configFile, 0o644);
    assert.equal((await stat(configFile)).mode & 0o777, 0o644);
    const again = await run(['/config theme dark', '/exit'], { config: { theme: 'light' } });
    assert.equal((await stat(again.configFile)).mode & 0o777, 0o600);
  });

  it('CL8 a bad FACTORY_URL is reported and never replaced by the saved address', async () => {
    const { text } = await run(['/whoami', '/exit'], { env: { FACTORY_URL: 'http://remote.example.com' }, config: { instance: 'https://saved.example.com' } });
    assert.match(text, /FACTORY_URL is set but is not a usable address/);
    assert.match(text, /Factory\s+not set/);
  });
});

describe('§6.17 CL9 OIDC through the terminal', () => {

  it('CL8 /config auth sets or clears the method; a bad value changes nothing; a new address forgets the method', async () => {
    const { text, saved } = await run(['/config auth oidc', '/config auth nope', '/exit'], { config: { instance: 'https://f.example.com' } });
    assert.match(text, /Sign-in method set to oidc/);
    assert.match(text, /auth must be one of: auto, cloudflare-access, oidc/);
    assert.equal((await saved()).auth, 'oidc');
    const cleared = await run(['/config auth auto', '/exit'], { config: { instance: 'https://f.example.com', auth: 'oidc' } });
    assert.equal((await cleared.saved()).auth, undefined);
    const moved = await run(['/config address other.example.com', '/exit'], { config: { instance: 'https://f.example.com', auth: 'oidc' } });
    assert.equal((await moved.saved()).auth, undefined, 'how the old address signed in says nothing about the new one');
  });

  it('CL9 the splash names how this factory signs people in once it is known', async () => {
    const { text } = await run(['/exit'], { config: { instance: 'https://f.example.com', auth: 'cloudflare-access' } });
    assert.match(text, /Sign-in\s+Cloudflare Access/);
  });
});

describe('§6.17 CL11 commands in the conversation, with no manager needed', () => {
  const signedIn = { config: { instance: 'https://f.example.com', auth: 'cloudflare-access' as const }, stored: true };
  const withAgents = (roles: string[] = ['admin']) => (f: FakeFactory) => {
    f.roles = roles;
    f.routes.set('GET /api/v1/agents', () => ({ status: 200, body: [{ id: 'donna', state: 'SLEEPING' }, { id: 'rosie', state: 'WORKING' }] }));
    f.routes.set('GET /api/v1/spend', () => ({ status: 200, body: { totalUsd: 12.5, apiKey: 'sk-live-1' } }));
    f.routes.set('POST /api/v1/agents/donna/pause', () => ({ status: 200, body: { ok: true } }));
  };

  it('CL11 /agents and /spend work with no Factory Manager on the factory, and show the factory\'s own figures', async () => {
    const { text } = await run(['/agents', '/spend', '/exit'], { ...signedIn, factory: withAgents() });
    assert.match(text, /ID\s+STATE\ndonna\s+SLEEPING\nrosie\s+WORKING/);
    assert.match(text, /totalUsd\s+12\.5/);
    assert.match(text, /apiKey\s+\[hidden\]/);
    assert.doesNotMatch(text, /sk-live/);
  });

  it('CL11 --json gives the raw answer in the conversation too', async () => {
    const { text } = await run(['/spend --json', '/exit'], { ...signedIn, factory: withAgents() });
    assert.match(text, /"totalUsd": 12\.5/);
  });

  it('CL3 a viewer can read but is told their roles do not allow a change, and nothing is sent', async () => {
    const { text, f } = await run(['/agents', '/budget donna 5 daily', '/pause donna', '/exit'], { ...signedIn, factory: withAgents(['viewer']) });
    assert.match(text, /donna\s+SLEEPING/);
    assert.equal((text.match(/Your roles do not allow/g) ?? []).length, 1, 'a viewer may pause (the factory decides for owners), not set a budget');
    assert.ok(!f.seen.some((s) => s.method === 'PUT'));
  });

  it('CL4 a command that changes state asks, and a line typed ahead cannot answer it', async () => {
    const { f, text } = await run(['/pause donna', 'y', '/exit'], { ...signedIn, factory: withAgents() });
    assert.match(text, /Run: pause_agent \{"id":"donna"\}/);
    assert.match(text, /Not run\./);
    assert.ok(!f.seen.some((s) => s.path.endsWith('/pause')));
    const yes = await run(['/pause donna --yes', '/exit'], { ...signedIn, factory: withAgents() });
    assert.ok(yes.f.seen.some((s) => s.path.endsWith('/pause')));
    assert.match(yes.text, /Done: the kill-switch/);
  });

  it('CL11 when the manager cannot answer, free text says why and points at the commands', async () => {
    const none = await run(['how much have we spent?', '/exit'], { ...signedIn, factory: withAgents() });
    assert.match(none.text, /no Factory Manager on this factory/);
    assert.match(none.text, /\/agents, \/spend, \/status, \/approvals/);

    const viewer = await run(['how much have we spent?', '/exit'], {
      ...signedIn,
      factory: (f) => {
        withAgents(['viewer'])(f);
        f.routes.set('POST /api/v1/agents/factory-manager/conversation', () => ({ status: 403, body: { error: 'forbidden', required: 'operator' } }));
      },
    });
    assert.match(viewer.text, /needs operator/);
    assert.match(viewer.text, /You can still use commands/);

    const broke = await run(['hi', '/exit'], { ...signedIn, factory: (f) => f.routes.set('POST /api/v1/agents/factory-manager/conversation', () => ({ status: 402, body: { error: 'budget_exceeded' } })) });
    assert.match(broke.text, /over its budget/);
    assert.match(broke.text, /You can still use commands/);
  });

  it('CL11 commands need a sign-in and say so, and /help lists them', async () => {
    const out = await run(['/agents', '/help', '/exit'], { config: { instance: 'https://f.example.com' } });
    assert.match(out.text, /You are not signed in\. Type \/login\./);
    assert.match(out.text, /Commands \(no manager needed/);
    assert.match(out.text, /\/budget <agent> <amount> daily\|monthly/);
    const unset = await run(['/agents', '/exit']);
    assert.match(unset.text, /No factory is set up yet/);
  });

  it('CL11 an unknown slash command is still unknown', async () => {
    const { text } = await run(['/frobnicate', '/exit'], { ...signedIn, factory: withAgents() });
    assert.match(text, /Unknown command/);
  });
});
