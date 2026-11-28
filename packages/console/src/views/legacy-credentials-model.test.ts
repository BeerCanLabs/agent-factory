import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { legacyCredentialRows, legacyKindsInUse } from './legacy-credentials-model.js';

describe('who still uses old credentials', () => {
  it('shows fk_, factory-token, oidc-bearer, and cloudflare-access even when the count is zero', () => {
    const rows = legacyCredentialRows([
      { id: 'fk_', count: 2, lastSeenAt: '2026-11-28T00:00:00.000Z', recent: [{ ts: '2026-11-28T00:00:00.000Z', path: '/api/v1/whoami', actor: 'user:stephanie' }] },
    ]);
    assert.deepEqual(rows.map((row) => row.id), ['fk_', 'fk_at_', 'factory-token', 'oidc-bearer', 'cloudflare-access']);
    assert.equal(rows[0]?.count, 2);
    assert.equal(rows.find((row) => row.id === 'cloudflare-access')?.count, 0);
    assert.deepEqual(legacyKindsInUse(rows), ['fk_']);
  });
});
