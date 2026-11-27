import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { allowedIssuerOrigins, buildAsMetadata, resolveAsIssuer } from './as-discovery.js';

function req(host: string, proto = 'https'): http.IncomingMessage {
  return { headers: { host, 'x-forwarded-proto': proto } } as http.IncomingMessage;
}

describe('resolveAsIssuer and AS metadata (front-door Phase 1 Slice 1)', () => {
  it('uses the request origin when it is the primary issuer or an alias', () => {
    const state = {
      asIssuer: 'https://auth.example.com',
      asIssuerAliases: ['https://factory-dashboard.example.com'],
      loginBaseUrl: 'https://login-should-not-win.example.com',
      publicBaseUrl: 'https://public-should-not-win.example.com',
    };
    assert.equal(resolveAsIssuer(state, req('auth.example.com')), 'https://auth.example.com');
    assert.equal(resolveAsIssuer(state, req('factory-dashboard.example.com')), 'https://factory-dashboard.example.com');
    assert.equal(resolveAsIssuer(state, req('other.example.com')), 'https://auth.example.com');
    assert.deepEqual(allowedIssuerOrigins(state), [
      'https://auth.example.com',
      'https://factory-dashboard.example.com',
    ]);
  });

  it('falls back to loginBaseUrl, then publicBaseUrl, then the request host, then localhost', () => {
    assert.equal(resolveAsIssuer({ loginBaseUrl: 'https://login.example.com/' }), 'https://login.example.com');
    assert.equal(resolveAsIssuer({ publicBaseUrl: 'https://factory.test/' }), 'https://factory.test');
    assert.equal(resolveAsIssuer({}, req('127.0.0.1:8080', 'http')), 'http://127.0.0.1:8080');
    assert.equal(resolveAsIssuer({}), 'http://localhost');
  });

  it('buildAsMetadata is internally consistent and advertises ES256 + jwks_uri', () => {
    const meta = buildAsMetadata('https://auth.example.com/');
    assert.equal(meta.issuer, 'https://auth.example.com');
    assert.equal(meta.jwks_uri, 'https://auth.example.com/jwks');
    assert.equal(meta.authorization_endpoint, 'https://auth.example.com/authorize');
    assert.equal(meta.token_endpoint, 'https://auth.example.com/token');
    assert.deepEqual(meta.id_token_signing_alg_values_supported, ['ES256']);
    assert.deepEqual(meta.subject_types_supported, ['public']);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  });
});
