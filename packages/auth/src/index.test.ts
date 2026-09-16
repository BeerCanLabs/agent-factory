import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authFromEnv, bearerAuth, oidcAuth } from './index.js';

describe('auth', () => {
  it('accepts a matching bearer token', async () => {
    const auth = bearerAuth('secret');
    const ok = await auth.verify('Bearer secret');
    assert.equal(ok.ok, true);
    const no = await auth.verify('Bearer other');
    assert.equal(no.ok, false);
  });

  it('checks oidc iss and aud', async () => {
    const payload = Buffer.from(JSON.stringify({ iss: 'https://idp.example', aud: 'factory', sub: 'user-1' })).toString(
      'base64url',
    );
    const jwt = `e30.${payload}.sig`;
    const auth = oidcAuth({ issuer: 'https://idp.example', audience: 'factory' });
    const ok = await auth.verify(`Bearer ${jwt}`);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.actor, 'user-1');
    const bad = await auth.verify(`Bearer e30.${Buffer.from(JSON.stringify({ iss: 'nope', aud: 'factory' })).toString('base64url')}.x`);
    assert.equal(bad.ok, false);
  });

  it('authFromEnv picks bearer when FACTORY_TOKEN is set', async () => {
    const auth = authFromEnv({ FACTORY_TOKEN: 't' });
    assert.equal(auth.name, 'bearer');
  });
});
