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

it('#434: Add person posts the display name and email to /api/v1/principals', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"id":"user:ada","displayName":"Ada","emails":["ada@example.com"]}', { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.createPrincipal(' Ada ', 'Ada@Example.com ');
  assert.equal(calls[0].url, '/api/v1/principals');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { displayName: 'Ada', emails: ['ada@example.com'] });
  const { validNewPerson } = await import('../views/PeopleView.js');
  assert.equal(validNewPerson('Ada', 'ada@example.com'), true);
  assert.equal(validNewPerson('', 'ada@example.com'), false);
  assert.equal(validNewPerson('Ada', 'not-an-email'), false);
  assert.equal(validNewPerson('x'.repeat(257), 'ada@example.com'), false);
});

it('#434: Rename sends PATCH /api/v1/principals/:id with the trimmed display name', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"principal":{"id":"user:dale","displayName":"Dale"}}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.renamePrincipal('user:dale', '  Dale  ');
  assert.equal(calls[0].url, '/api/v1/principals/user%3Adale');
  assert.equal(calls[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { displayName: 'Dale' });
});
