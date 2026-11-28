import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTORY_SCOPES,
  FACTORY_SCOPE_LABELS,
  FIRST_PARTY_HEADS,
  LEGACY_FULL_SCOPE,
  THIRD_PARTY_DENIED_SCOPES,
  isThirdPartyDeniedScope,
  scopeLabel,
} from './factory-scopes.js';

describe('factory scopes (front-door Phase 1 Slice 4)', () => {
  it('advertises real scopes and not the legacy mcp:full name', () => {
    assert.equal(FACTORY_SCOPES.includes('mcp'), true);
    assert.equal(FACTORY_SCOPES.includes('admin'), true);
    assert.equal((FACTORY_SCOPES as readonly string[]).includes(LEGACY_FULL_SCOPE), false);
    for (const scope of FACTORY_SCOPES) {
      assert.ok(FACTORY_SCOPE_LABELS[scope].length > 0, scope);
      assert.equal(scopeLabel(scope), FACTORY_SCOPE_LABELS[scope]);
    }
  });

  it('caps third-party clients below admin, grants:manage, and keys:manage', () => {
    assert.deepEqual(THIRD_PARTY_DENIED_SCOPES, ['admin', 'grants:manage', 'keys:manage']);
    assert.equal(isThirdPartyDeniedScope('admin'), true);
    assert.equal(isThirdPartyDeniedScope('mcp'), false);
    assert.equal(isThirdPartyDeniedScope('agents:read'), false);
  });

  it('names the first-party heads on factory.<domain>', () => {
    assert.deepEqual(
      FIRST_PARTY_HEADS.map((head) => head.name),
      ['Factory Console', 'Garrison', 'Web Chat', 'Connect'],
    );
  });
});
