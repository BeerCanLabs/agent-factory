import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repl } from './repl.js';
import { fakeFactory, type FakeFactory } from './testing.js';
import type { CredentialStore } from './credentials.js';
import { fakeProvider, type Provider } from './testing-oidc.js';
import type { Discovered } from './discover.js';

const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const memory = (): CredentialStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};

type Setup = { discover?: (instance: string) => Promise<Discovered>; provider?: Provider; storedRaw?: string; cloudflaredFiles?: string[]; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; stored?: boolean; factory?: (f: FakeFactory) => void; login?: 'ok' | 'fail' };

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
  const done = repl({ version: 'test', store, input, output, env: s.env ?? {}, configFile, cloudflared: wrapped, cloudflaredDir: cfDir, fetch: f.fetch, sleep: async () => {}, intervalMs: 0, timeoutMs: 3000, isTTY: false, discover: s.discover, openBrowser: s.provider?.openBrowser });
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
  it('CL1 /login with no address asks for one, then signs in through the proxy flow', async () => {
    const { text, store, cloudflaredCalls } = await run(['/login', 'f.example.com', '/whoami', '/exit']);
    assert.match(text, /No factory address is set\. Factory address:/);
    assert.match(text, /Signed in as access:dale@example\.com \(admin\)/);
    assert.deepEqual(cloudflaredCalls[0], ['access', 'login', 'https://f.example.com']);
    assert.ok(store.data.get('https://f.example.com'));
    assert.match(text, /access:dale@example\.com \(admin\) at https:\/\/f\.example\.com/);
  });

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

  it('CL1 "different user" signs out, then signs in again through the browser', async () => {
    const { text, cloudflaredCalls, store } = await run(['/login', '2', '/exit'], { config: { instance: 'https://f.example.com' }, stored: true });
    assert.match(text, /sign out of your identity provider there first/);
    assert.ok(cloudflaredCalls.some((c) => c[1] === 'login'));
    assert.ok(store.data.get('https://f.example.com'), 'signed in again');
    assert.match(text, /Signed in as access:dale@example\.com/);
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
  const oidcOf = (p: Provider): Discovered => ({ type: 'oidc', issuer: p.issuer, clientId: 'cli-client-1', scopes: ['openid', 'email'], tokenUse: 'id_token' });
  const accept = (f: FakeFactory) => (f.acceptBearer = (v) => /^Bearer .+\..+\./.test(v));

  it('CL9 /login finds the factory uses OIDC, signs in at the provider, remembers the method, and the next run starts signed in', async () => {
    const provider = await fakeProvider();
    try {
      const first = await run(['/login', '/whoami', '/exit'], { config: { instance: 'https://f.example.com' }, provider, discover: async () => oidcOf(provider), factory: accept });
      assert.match(first.text, /Signing in to https:\/\/f\.example\.com with OIDC \(127\.0\.0\.1\)/);
      assert.match(first.text, /Signed in as access:dale@example\.com/);
      assert.equal((await first.saved()).auth, 'oidc');
      assert.ok(first.store.data.get('https://f.example.com')?.startsWith('{'), 'the OIDC sign-in is in the store');
      assert.equal(provider.log.authorize.length, 1);

      // A second run with the saved hint and sign-in needs no browser and no discovery.
      const kept = first.store.data.get('https://f.example.com')!;
      const second = await run(['/exit'], { config: { instance: 'https://f.example.com', auth: 'oidc' }, storedRaw: kept, provider, discover: async () => { throw new Error('should not be asked'); }, factory: accept });
      assert.match(second.text, /Signed in\s+access:dale@example\.com/);
      assert.match(second.text, /Sign-in\s+OIDC/);
      assert.equal(provider.log.authorize.length, 1);
    } finally {
      await provider.close();
    }
  });

  it('CL9 "sign in as a different user" asks the provider to authenticate again', async () => {
    const provider = await fakeProvider();
    try {
      const { text } = await run(['/login', '/login', '2', '/exit'], { config: { instance: 'https://f.example.com' }, provider, discover: async () => oidcOf(provider), factory: accept });
      assert.match(text, /2\) Sign in as a different user/);
      assert.equal(provider.log.authorize.length, 2);
      assert.equal(provider.log.authorize[0].get('prompt'), null);
      assert.equal(provider.log.authorize[1].get('prompt'), 'login');
    } finally {
      await provider.close();
    }
  });

  it('CL9 an OIDC sign-in saved by this version is picked up even when the settings carry no hint', async () => {
    const provider = await fakeProvider();
    try {
      const first = await run(['/login', '/exit'], { config: { instance: 'https://f.example.com' }, provider, discover: async () => oidcOf(provider), factory: accept });
      const kept = first.store.data.get('https://f.example.com')!;
      const { text } = await run(['/exit'], { config: { instance: 'https://f.example.com' }, storedRaw: kept, factory: accept });
      assert.match(text, /Signed in\s+access:dale@example\.com/);
    } finally {
      await provider.close();
    }
  });

  it('CL9 when the factory cannot say how to sign in, the person is told and stays signed out', async () => {
    const { text } = await run(['/login', '/exit'], { config: { instance: 'https://f.example.com' }, discover: async () => { throw new Error('https://f.example.com does not say how to sign in.'); } });
    assert.match(text, /Could not find out how to sign in: https:\/\/f\.example\.com does not say/);
    assert.match(text, /Signed in\s+no/);
  });

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
