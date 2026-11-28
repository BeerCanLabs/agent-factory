// Slice 3 (#564, D-4): session clocks and durability, and the revocation set, without the HTTP server.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocBackend } from '@beercanlabs/factory-bouncer';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SessionStore, type SessionsDoc } from './login.js';
import { RevocationSet, type RevocationDoc } from './revocation-set.js';
import { McpOAuthStore, refreshLifetimeMs, type McpOAuthDoc, type McpOAuthRefreshTokenRecord } from './mcp-oauth.js';

describe('D-4 session lifetimes', () => {
  it('ends a session after 12 hours idle, and slides the idle window when it is used', () => {
    let now = 1_700_000_000_000;
    const store = new SessionStore(() => now);
    const id = store.create('ada@example.com', 'google');
    assert.equal(store.get(id)?.email, 'ada@example.com');
    now += SESSION_IDLE_MS - 1;
    assert.ok(store.get(id), 'still inside the idle window, which slides');
    now += SESSION_IDLE_MS - 1;
    assert.ok(store.get(id), 'activity pushed the idle deadline forward');
    const seen = store.get(id)!.lastSeenAt;
    now = seen + SESSION_IDLE_MS;
    assert.equal(store.get(id), undefined, '12 hours with no use ends it');
  });

  it('ends a session 7 days after it was created even when it is still in use', () => {
    let now = 1_700_000_000_000;
    const store = new SessionStore(() => now);
    const id = store.create('ada@example.com', 'google');
    const created = store.get(id)!.createdAt;
    let cursor = created;
    while (cursor + SESSION_IDLE_MS < created + SESSION_ABSOLUTE_MS) {
      cursor += SESSION_IDLE_MS - 1000;
      now = cursor;
      assert.ok(store.get(id), 'activity inside the 7 days keeps the session');
    }
    now = created + SESSION_ABSOLUTE_MS - 1;
    assert.ok(store.get(id), 'one millisecond inside the 7 days');
    now = created + SESSION_ABSOLUTE_MS;
    assert.equal(store.get(id), undefined, '7 days absolute');
    assert.equal(SESSION_IDLE_MS, 12 * 60 * 60 * 1000);
    assert.equal(SESSION_ABSOLUTE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('survives a restart and a revoke on one task is visible to another', async () => {
    let now = 1_700_000_000_000;
    const backend = new MemoryDocBackend<SessionsDoc>();
    const a = await SessionStore.open(backend, { now: () => now });
    const id = a.create('ada@example.com', 'google');
    const sid = a.get(id)!.sid;
    await a.flush();
    const b = await SessionStore.open(backend, { now: () => now });
    assert.equal(b.get(id)?.sid, sid, 'a new process reads the durable session');
    assert.equal(a.revokeBySid(sid)?.email, 'ada@example.com');
    await a.flush();
    assert.equal(a.get(id), undefined);
    await b.reload();
    assert.equal(b.get(id), undefined, 'the other task sees the revoke');
    assert.equal(b.listForEmails(['ada@example.com']).length, 0);
  });
});

describe('revocation set', () => {
  it('remembers a sid until the token it revokes would have expired, and a second task can read it', async () => {
    let now = 1_700_000_000_000;
    const backend = new MemoryDocBackend<RevocationDoc>();
    const a = await RevocationSet.open(backend, { now: () => now });
    await a.revoke({ id: 'sess_a', kind: 'sid', expiresAt: now + 1000, reason: 'sign-out' });
    assert.equal(a.has('sess_a'), true);
    const b = await RevocationSet.open(backend, { now: () => now });
    assert.equal(b.has('sess_a'), true);
    now += 1000;
    assert.equal(b.has('sess_a'), false, 'the entry dies with the token');
    assert.equal(a.has('jti_missing'), false);
  });
});

describe('refresh lifetimes and cross-task reuse', () => {
  it('people slide 30 days and devices slide 90', () => {
    assert.equal(refreshLifetimeMs('person'), 30 * 24 * 60 * 60 * 1000);
    assert.equal(refreshLifetimeMs(undefined), 30 * 24 * 60 * 60 * 1000);
    assert.equal(refreshLifetimeMs('device'), 90 * 24 * 60 * 60 * 1000);
  });

  it('a refresh written on one task is visible to another, including after rotation', async () => {
    const backend = new MemoryDocBackend<McpOAuthDoc>();
    const a = await McpOAuthStore.open(backend);
    const b = await McpOAuthStore.open(backend);
    const record: McpOAuthRefreshTokenRecord = {
      tokenHash: 'hash-1',
      familyId: 'fam_1',
      generation: 1,
      principalId: 'user:ada',
      clientId: 'client',
      clientName: 'Client',
      deviceFamily: 'mcp:client',
      keyId: 'key_1',
      holder: 'device',
      expiresAt: new Date(Date.now() + refreshLifetimeMs('device')).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await a.saveRefreshToken(record);
    await b.reload();
    assert.equal(b.getRefreshTokenByHash('hash-1')?.holder, 'device');
    assert.equal(b.liveFamily('fam_1')?.revoked, false);
    await a.rotateRefreshTokenFamily('hash-1', 'hash-2', record.expiresAt, 'key_2', { holder: 'device' });
    await b.reload();
    assert.ok(b.getRefreshTokenByHash('hash-1')?.rotatedAt, 'the other task sees the rotation');
    assert.equal(b.getRefreshTokenByHash('hash-2')?.generation, 2);
    await b.revokeRefreshTokenFamily('fam_1', 'user:ada');
    await a.reload();
    assert.equal(a.liveFamily('fam_1')?.revoked, true);
  });
});
