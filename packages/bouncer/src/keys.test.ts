import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashApiKey, sameHash } from '@beercanlabs/factory-auth';
import { ApiKeyStore, ApiKeyStoreError, MemoryDocBackend, type ApiKeysDoc } from './index.js';

describe('S5 ApiKeyStore', () => {
  it('stores only the hash, compares in constant time, and honours expiry', async () => {
    let now = new Date('2026-11-01T00:00:00Z');
    const backend = new MemoryDocBackend<ApiKeysDoc>();
    const store = await ApiKeyStore.open(backend, { now: () => now });
    const { record, plaintext } = await store.create({ owner: 'user:s', deviceFamily: 'tesla', expiresAt: '2026-11-02T00:00:00Z', by: 'user:admin' });
    assert.equal(record.hash, hashApiKey(plaintext));
    assert.ok(!JSON.stringify(await backend.loadLatest()).includes(plaintext));
    assert.ok(sameHash(record.hash, hashApiKey(plaintext)) && !sameHash(record.hash, hashApiKey(plaintext + 'x')));
    assert.equal(store.verify(plaintext)?.id, record.id);
    now = new Date('2026-11-03T00:00:00Z');
    assert.equal(store.verify(plaintext), undefined, 'expired');
    const again = await store.create({ owner: 'user:s', deviceFamily: 'tesla', by: 'user:admin' });
    assert.equal(again.record.expiresAt, null, 'non-expiring allowed; expired key frees the device family');
  });

  it('grace window ends, revocation is immediate, bad input is refused, and an unhealthy store refuses everything', async () => {
    let now = new Date('2026-11-01T00:00:00Z');
    const store = await ApiKeyStore.open(new MemoryDocBackend<ApiKeysDoc>(), { now: () => now });
    const a = await store.create({ owner: 'service:ingest', roles: ['ingest'], by: 'user:admin' });
    const r = await store.rotate(a.record.id, { graceSeconds: 30, by: 'user:admin' });
    assert.ok(store.verify(a.plaintext) && store.verify(r.plaintext));
    now = new Date('2026-11-01T00:00:31Z');
    assert.equal(store.verify(a.plaintext), undefined);
    await store.revoke(a.record.id, { by: 'user:admin' });
    assert.equal(store.verify(r.plaintext), undefined);
    await assert.rejects(store.create({ owner: 'bob', by: 'x' }), ApiKeyStoreError);
    await assert.rejects(store.create({ owner: 'user:s', by: 'x' }), /deviceFamily/);
    await assert.rejects(store.create({ owner: 'user:s', deviceFamily: 'x', roles: ['admin'], by: 'x' }), /live grants/);
    const broken = await ApiKeyStore.open({ description: 'x', loadLatest: async () => { throw new Error('down'); }, write: async () => {} });
    assert.equal(broken.healthy, false);
    assert.equal(broken.verify('fk_anything'), undefined);
  });
});
