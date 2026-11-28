import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_TOKEN_LIFETIME_MINUTES, REFRESH_DEVICE_DAYS, REFRESH_PERSON_DAYS, SESSION_ABSOLUTE_DAYS, SESSION_IDLE_HOURS, connectedAppCopy, connectedAppsIntro, factoryIssuerInfo, keysAccessTokenCopy, sessionLifetimeCopy } from './keys-model.js';

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

describe('session lifetime copy (front-door Phase 1 Slice 3)', () => {
  it('names the D-4 lifetimes in plain language', () => {
    const copy = sessionLifetimeCopy();
    assert.equal(SESSION_IDLE_HOURS, 12);
    assert.equal(SESSION_ABSOLUTE_DAYS, 7);
    assert.equal(REFRESH_PERSON_DAYS, 30);
    assert.equal(REFRESH_DEVICE_DAYS, 90);
    assert.match(copy, /12 hours/);
    assert.match(copy, /idle/);
    assert.match(copy, /7 days/);
    assert.match(copy, /30 days/);
    assert.match(copy, /people/);
    assert.match(copy, /90 days/);
    assert.match(copy, /devices/);
  });
});

describe('connected apps (front-door Phase 1 Slice 4)', () => {
  it('shows granted scopes in plain language and marks a first-party head', () => {
    const copy = connectedAppCopy({
      clientName: 'Factory Console',
      scope: 'admin mcp',
      scopes: [
        { id: 'mcp', label: 'Use the factory MCP tools your account already allows' },
        { id: 'admin', label: 'Administer the factory' },
      ],
      origin: 'https://factory.example',
      firstParty: true,
    });
    assert.equal(copy.kind, 'First-party factory app');
    assert.equal(copy.origin, 'https://factory.example');
    assert.match(copy.scopes, /Administer the factory/);
    assert.match(copy.scopes, /MCP tools/);
    assert.doesNotMatch(copy.kind, /Third-party/);
  });

  it('labels every other app as third-party and keeps the raw scope when labels are absent', () => {
    const copy = connectedAppCopy({ clientName: 'Cursor', scope: 'mcp', firstParty: false });
    assert.equal(copy.kind, 'Third-party app');
    assert.equal(copy.scopes, 'mcp');
    assert.match(connectedAppsIntro(), /First-party/);
    assert.match(connectedAppsIntro(), /Console, Garrison, Web Chat, and Connect/);
    assert.match(connectedAppsIntro(), /fk_at_/);
    assert.match(connectedAppsIntro(), /immediately/);
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
