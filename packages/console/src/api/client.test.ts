// S9 fix: the people, grants and keys calls hit /api/v1/<route>, not /api/v1/api/v1/<route> (404 not_found in prod).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { factoryApi } from './client.js';

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
