import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAccessResource } from '@beercanlabs/factory-auth';
import { intersectTokenScopesWithLiveGrants, resourceAudiences } from './resource-verifier.js';

describe('resource-server verifier (Slice 5)', () => {
  it('accepts the api or mcp audience on the primary issuer and the Phase 3 alias', () => {
    const primary = 'https://auth.example.test';
    const alias = 'https://factory-dashboard.example.test';
    assert.deepEqual(resourceAudiences([primary, alias], 'api'), [
      canonicalAccessResource(primary, 'api'),
      canonicalAccessResource(alias, 'api'),
    ]);
    assert.deepEqual(resourceAudiences([primary], 'mcp'), [canonicalAccessResource(primary, 'mcp')]);
  });

  it('intersects token scopes with live grants and drops a privilege the caller no longer holds', () => {
    const operator = { actor: 'user:nora', roles: ['operator' as const] };
    const narrowed = intersectTokenScopesWithLiveGrants(
      operator,
      { privileges: ['agents.read', 'grants.manage'] },
      [],
    );
    assert.deepEqual(narrowed?.privileges, ['agents.read']);
    const revoked = intersectTokenScopesWithLiveGrants(
      { actor: 'user:nora', roles: [] },
      { privileges: ['agents.read', 'grants.manage'] },
      [],
    );
    assert.deepEqual(revoked?.privileges, []);
    assert.equal(intersectTokenScopesWithLiveGrants(operator, undefined, []), undefined);
  });
});
