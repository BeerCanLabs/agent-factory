import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cliDiscoveryFromEnv } from './discovery.js';

const base = { FACTORY_OIDC_ISSUER: 'https://login.example.com/tenant/v2.0/', FACTORY_OIDC_CLI_CLIENT_ID: 'cli-client-1' };

describe('§6.17 CL9 the CLI discovery document', () => {
  it('CL9 is published only when a CLI client id is configured', () => {
    assert.equal(cliDiscoveryFromEnv({}), undefined);
    assert.equal(cliDiscoveryFromEnv({ FACTORY_OIDC_ISSUER: base.FACTORY_OIDC_ISSUER }), undefined);
  });

  it('CL9 carries the issuer, client id, scopes and token to present, with sensible defaults', () => {
    assert.deepEqual(cliDiscoveryFromEnv(base), {
      auth: { type: 'oidc', issuer: 'https://login.example.com/tenant/v2.0', clientId: 'cli-client-1', scopes: ['openid', 'email', 'profile'], tokenUse: 'id_token' },
    });
    const full = cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_CLI_SCOPES: 'email, offline_access', FACTORY_OIDC_CLI_TOKEN_USE: 'access_token', FACTORY_OIDC_CLI_REDIRECT_PORT: '53682' });
    assert.deepEqual(full?.auth.scopes, ['openid', 'email', 'offline_access']);
    assert.equal(full?.auth.tokenUse, 'access_token');
    assert.equal(full?.auth.redirectPort, 53682);
  });

  it('CL9 holds no secret: only the keys it documents, whatever else is in the environment', () => {
    const doc = cliDiscoveryFromEnv({ ...base, FACTORY_TOKEN: 'shared', FACTORY_OIDC_CLIENT_SECRET: 'shh', FACTORY_ACCESS_AUD: 'aud' });
    assert.deepEqual(Object.keys(doc!.auth).sort(), ['clientId', 'issuer', 'scopes', 'tokenUse', 'type']);
    assert.doesNotMatch(JSON.stringify(doc), /shared|shh|aud\b/);
  });

  it('CL9 a bad configuration stops the factory rather than publishing a bad document', () => {
    assert.throws(() => cliDiscoveryFromEnv({ FACTORY_OIDC_CLI_CLIENT_ID: 'x' }), /needs FACTORY_OIDC_ISSUER/);
    assert.throws(() => cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_ISSUER: 'http://remote.example.com' }), /https/);
    assert.throws(() => cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_CLI_TOKEN_USE: 'refresh_token' }), /id_token or access_token/);
    assert.throws(() => cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_CLI_REDIRECT_PORT: '80' }), /1024/);
    assert.throws(() => cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_CLI_CLIENT_ID: 'a b' }), /client id/);
    assert.ok(cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_ISSUER: 'http://localhost:9000' }), 'loopback http is for development');
  });

  it('CL9 warns, and still publishes, when the factory\'s audience is not the CLI\'s client id for an ID token', () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warned.push(m);
    try {
      assert.ok(cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_AUDIENCE: 'factory-api' }));
      assert.equal(warned.length, 1);
      assert.match(warned[0], /FACTORY_OIDC_AUDIENCE \(factory-api\)/);
      warned.length = 0;
      cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_AUDIENCE: 'cli-client-1' });
      cliDiscoveryFromEnv({ ...base, FACTORY_OIDC_AUDIENCE: 'factory-api', FACTORY_OIDC_CLI_TOKEN_USE: 'access_token' });
      assert.equal(warned.length, 0);
    } finally {
      console.warn = orig;
    }
  });
});
