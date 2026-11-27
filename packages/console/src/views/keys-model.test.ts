import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_TOKEN_LIFETIME_MINUTES, factoryIssuerInfo, keysAccessTokenCopy } from './keys-model.js';

describe('keys access-token copy (front-door Phase 1 Slice 2)', () => {
  it('says new access tokens are 10-minute JWTs and that legacy keys still work', () => {
    const copy = keysAccessTokenCopy();
    assert.equal(ACCESS_TOKEN_LIFETIME_MINUTES, 10);
    assert.match(copy.issuer, /10-minute JWTs/);
    assert.match(copy.issuer, /fk_at_/);
    assert.match(copy.issuer, /fk_/);
    assert.match(copy.keys, /10-minute JWTs/);
    assert.match(copy.keys, /dual-run/);
    assert.doesNotMatch(copy.issuer, /next slice/i);
    assert.doesNotMatch(copy.keys, /next slice/i);
  });
});

describe('factoryIssuerInfo (front-door Phase 1 Slice 1)', () => {
  it('uses discovery metadata when present', () => {
    assert.deepEqual(
      factoryIssuerInfo('https://factory-dashboard.example.com/', {
        issuer: 'https://auth.example.com/',
        jwks_uri: 'https://auth.example.com/jwks',
      }),
      {
        issuer: 'https://auth.example.com',
        jwksUri: 'https://auth.example.com/jwks',
        discoveryUrl: 'https://factory-dashboard.example.com/.well-known/openid-configuration',
      },
    );
  });

  it('falls back to the page origin when discovery is missing or incomplete', () => {
    assert.deepEqual(factoryIssuerInfo('https://factory.example.com', null), {
      issuer: 'https://factory.example.com',
      jwksUri: 'https://factory.example.com/jwks',
      discoveryUrl: 'https://factory.example.com/.well-known/openid-configuration',
    });
    assert.deepEqual(factoryIssuerInfo('https://factory.example.com', { issuer: 1, jwks_uri: '' }), {
      issuer: 'https://factory.example.com',
      jwksUri: 'https://factory.example.com/jwks',
      discoveryUrl: 'https://factory.example.com/.well-known/openid-configuration',
    });
  });
});
