// S9 fix: the people, grants and keys calls hit /api/v1/<route>, not /api/v1/api/v1/<route> (404 not_found in prod).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { factoryApi, signOut } from './client.js';

it('S9: people, grants and keys calls are prefixed with /api/v1 exactly once', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ principals: [], grants: [], keys: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.listPrincipals();
  await factoryApi.listGrants();
  await factoryApi.listKeys();
  await factoryApi.rotateKey('key_x');
  assert.deepEqual(seen, ['/api/v1/principals', '/api/v1/grants', '/api/v1/keys', '/api/v1/keys/key_x/rotate']);
});

it('Sign out posts /api/v1/auth/logout with the session cookie, then lands on /login (even if the call fails)', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200, headers: { 'set-cookie': 'factory_session=; Max-Age=0' } });
  }) as typeof fetch;
  const went: string[] = [];
  await signOut((u) => went.push(u));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/auth/logout');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(went, ['/login']);

  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  await signOut((u) => went.push(u));
  assert.deepEqual(went, ['/login', '/login']);
});
