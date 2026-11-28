import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { LegacyCredentialUse } from './legacy-credential-use.js';
import type { AuthRequestLogEntry } from './auth-method.js';

function entry(authMethod: AuthRequestLogEntry['authMethod'], actor: string): AuthRequestLogEntry {
  return {
    event: 'auth.request',
    ts: '2026-11-28T07:00:00.000Z',
    method: 'GET',
    path: '/api/v1/whoami',
    status: 200,
    authMethod,
    actor,
    durationMs: 1,
  };
}

describe('legacy credential tally', () => {
  it('counts fk_, factory-token, oidc-bearer, and cloudflare-access, and writes a ledger sample', () => {
    const ledger = new MemoryLedger();
    const use = new LegacyCredentialUse();
    use.note(entry('api-key', 'user:stephanie'), ledger, 1_000);
    use.note(entry('static-token', 'token:probe'), ledger, 2_000);
    use.note(entry('oidc-bearer', 'oidc:ada@example.com'), ledger, 3_000);
    use.note(entry('cloudflare-access', 'cloudflare:owner@example.com'), ledger, 4_000);
    use.note(entry('access-jwt', 'user:stephanie'), ledger, 5_000);
    use.note(entry('api-key', 'user:stephanie'), ledger, 6_000);
    const snap = use.snapshot();
    const count = (id: string) => snap.kinds.find((kind) => kind.id === id)?.count;
    assert.equal(count('fk_'), 2);
    assert.equal(count('factory-token'), 1);
    assert.equal(count('oidc-bearer'), 1);
    assert.equal(count('cloudflare-access'), 1);
    assert.equal(count('fk_at_'), 0);
    const actions = ledger.query().map((row) => row.action);
    assert.equal(actions.filter((action) => action === 'AUTH_LEGACY_CREDENTIAL').length, 4);
    assert.equal(actions.includes('AUTH_LEGACY_CREDENTIAL') && ledger.query().some((row) => row.subject === 'credential:fk_'), true);
  });
});
