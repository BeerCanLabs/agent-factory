import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { knownMethod } from './methods.js';
import { encodeStored } from './oidc.js';
import type { CredentialStore } from './credentials.js';

const store = (value?: string): CredentialStore => ({ get: async () => value, set: async () => {}, delete: async () => {} });

describe('§6.17 CL9 which method an address uses before the factory is asked', () => {
  it('CL9 a saved hint wins; otherwise the kind of sign-in already stored says it', async () => {
    assert.equal(await knownMethod('https://f', 'oidc', store('bare.jwt.value'), {}), 'oidc');
    assert.equal(await knownMethod('https://f', undefined, store(encodeStored({ kind: 'oidc' })), {}), 'oidc');
    assert.equal(await knownMethod('https://f', undefined, store('header.payload.sig'), {}), 'cloudflare-access', 'an earlier version stored a bare Access assertion');
    assert.equal(await knownMethod('https://f', undefined, store(), {}), undefined);
  });

  it('CL1 an Access assertion given in the environment is used even with nothing saved', async () => {
    assert.equal(await knownMethod('https://f', undefined, store(), { FACTORY_CLI_ACCESS_TOKEN: 'abc' }), 'cloudflare-access');
  });
});
