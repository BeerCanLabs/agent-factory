import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { factoryIssuerInfo } from './keys-model.js';

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
