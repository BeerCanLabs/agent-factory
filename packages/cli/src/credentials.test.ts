import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSession, FileStore, KeychainStore, NeedsLoginError, expiryOf, isFresh, type CredentialStore } from './credentials.js';

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const NOW = 1_800_000_000_000;
const memory = (): CredentialStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};

describe('§6.17 CL1 sign-in', () => {
  it('CL1 reads the expiry from the assertion and treats one about to expire as stale', () => {
    assert.equal(expiryOf(jwt(123)), 123);
    assert.equal(expiryOf('garbage'), undefined);
    assert.equal(isFresh(jwt(NOW / 1000 + 3600), NOW), true);
    assert.equal(isFresh(jwt(NOW / 1000 + 10), NOW), false);
    assert.equal(isFresh('garbage', NOW), false);
  });

  it('CL1 uses the stored assertion while fresh and asks cloudflared for a new one when it is stale', async () => {
    const store = memory();
    const fresh = jwt(NOW / 1000 + 3600);
    const calls: string[][] = [];
    const cf = async (args: string[]) => (calls.push(args), { code: 0, stdout: fresh + '\n' });
    const s = new AccessSession('https://f.example.com', store, cf, {}, () => NOW);
    store.data.set('https://f.example.com', jwt(NOW / 1000 - 5));
    assert.equal(await s.token(), fresh);
    assert.deepEqual(calls[0], ['access', 'token', '-app=https://f.example.com']);
    assert.equal(store.data.get('https://f.example.com'), fresh);
    calls.length = 0;
    assert.equal(await s.token(), fresh); // now fresh: no call
    assert.equal(calls.length, 0);
    await s.token(true); // a 401 forces a new one
    assert.equal(calls.length, 1);
  });

  it('CL1 tells the person to log in when cloudflared has no sign-in, and never invents a credential', async () => {
    const s = new AccessSession('https://f.example.com', memory(), async () => ({ code: 1, stdout: '' }), {}, () => NOW);
    await assert.rejects(s.token(), NeedsLoginError);
    const missing = new AccessSession('https://f.example.com', memory(), async () => { throw new Error('ENOENT'); }, {}, () => NOW);
    await assert.rejects(missing.token(), /factory login/);
  });

  it('CL1 login runs the proxy browser flow, then keeps the assertion', async () => {
    const store = memory();
    const fresh = jwt(NOW / 1000 + 3600);
    const calls: Array<[string[], boolean]> = [];
    const cf = async (args: string[], interactive: boolean) => (calls.push([args, interactive]), { code: 0, stdout: args[1] === 'token' ? fresh : '' });
    await new AccessSession('https://f.example.com', store, cf, {}, () => NOW).login();
    assert.deepEqual(calls[0], [['access', 'login', 'https://f.example.com'], true]);
    assert.equal(store.data.get('https://f.example.com'), fresh);
  });

  it('CL1 never reads FACTORY_TOKEN', async () => {
    const s = new AccessSession('https://f.example.com', memory(), async () => ({ code: 1, stdout: '' }), { FACTORY_TOKEN: 'shared-admin' }, () => NOW);
    await assert.rejects(s.token(), NeedsLoginError);
  });

  it('CL1 the Keychain gets the secret on stdin, not on the command line', async () => {
    const seen: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const store = new KeychainStore(async (cmd, args, input) => (seen.push({ cmd, args, input }), { code: 0, stdout: 'tok\n' }));
    await store.set('https://f.example.com', 'secret.jwt.value');
    assert.deepEqual(seen[0].args, ['-i']);
    assert.match(seen[0].input ?? '', /add-generic-password -U .* -w "secret\.jwt\.value"/);
    assert.ok(!seen[0].args.join(' ').includes('secret.jwt.value'));
    assert.equal(await store.get('https://f.example.com'), 'tok');
    await assert.rejects(store.set('x', 'a\nb'), /malformed/);
  });

  it('CL1 the file fallback is readable by its owner only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-'));
    const path = join(dir, 'c.json');
    const store = new FileStore(path);
    await store.set('i', 't');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await store.get('i'), 't');
    await store.delete('i');
    assert.equal(await store.get('i'), undefined);
  });
});
