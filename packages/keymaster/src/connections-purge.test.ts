// Story #354 ([S3b], Epic #349): D15 — purge an outgoing owner's user-OAuth grant on transfer accept.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionKeymaster, grantSecretName } from './connections.js';

describe('ConnectionKeymaster.purgeGrant (S3b, D15)', () => {
  it('tombstones the grant, drops cached tokens, ledgers, and is a no-op when nothing is there', async () => {
    const values = new Map<string, string>();
    const events: Array<Record<string, unknown>> = [];
    const km = new ConnectionKeymaster({
      providers: [{ name: 'mem', get: async (n) => values.get(n), put: async (n, v) => void values.set(n, v) }],
      ledger: { append: (e: Record<string, unknown>) => void events.push(e) } as never,
      getProvider: () => ({ kind: 'oauth-user', provider: 'gmail', authUrl: 'https://a.example', tokenUrl: 'https://t.example', clientSecret: 'c', authParams: {} }),
      now: () => Date.parse('2026-11-02T00:00:00Z'),
    });
    await km.saveGrant('friday', {
      provider: 'gmail',
      clientRef: 'c',
      refreshToken: 'refresh-token-alice-1234', // secret-scan:allow (test fixture)
      accessToken: 'access-token-alice-1234', // secret-scan:allow (test fixture)
      expiresAt: '2026-11-03T00:00:00Z',
      scopes: [],
      obtainedAt: '2026-11-01T00:00:00Z',
      grantedBy: 'user:alice',
      status: 'active',
    });
    const cached = await km.accessToken('friday', 'gmail');
    assert.equal(cached.ok, true);

    assert.equal(await km.purgeGrant('friday', 'gmail', 'user:bob'), true);
    assert.equal(await km.getGrant('friday', 'gmail'), undefined);
    const stored = values.get(grantSecretName('friday', 'gmail'))!;
    assert.ok(!stored.includes('alice-1234'), 'no token value left');
    const after = await km.accessToken('friday', 'gmail');
    assert.equal(after.ok, false, 'cached access token dropped');
    assert.deepEqual(events.map((e) => e.action).filter((a) => a === 'CONNECTION_PURGED'), ['CONNECTION_PURGED']);

    assert.equal(await km.purgeGrant('friday', 'gmail', 'user:bob'), false);
    assert.equal(await km.purgeGrant('../x', 'gmail', 'user:bob'), false);
  });
});
