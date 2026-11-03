// Story #359 ([S6] IdP setup, break-glass, lockout recovery, Epic #349): R9, R11, R12, D5, D16.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyStore, BREAK_GLASS_OWNER, GrantStore, MemoryDocBackend, PrincipalStore, type ApiKeysDoc } from '@beercanlabs/factory-bouncer';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bootstrapAdmin, drainRecoveryOutbox, recoverLockout, type RecoveryOutboxDoc } from './recover.js';
import { validateIdpConfig } from './idp-config.js';

async function stores() {
  const principals = await PrincipalStore.open();
  const grants = await GrantStore.open(new MemoryDocBackend(), { principals });
  const keys = await ApiKeyStore.open(new MemoryDocBackend<ApiKeysDoc>());
  return { principals, grants, keys, ledger: new MemoryLedger(), outbox: new MemoryDocBackend<RecoveryOutboxDoc>() };
}

describe('S6 lockout recovery, bootstrap and IdP config (#359)', () => {
  it('AC1: with an unreachable admin and a lost break-glass key, recovery adds a recovery admin and a fresh break-glass key, prints nothing secret, and LOCKOUT_RECOVERED joins a valid ledger chain', async () => {
    const s = await stores();
    const gone = await s.principals.create({ displayName: 'Gone', emails: ['gone@example.com'], by: 'test' });
    await s.grants.grant({ subject: gone.id, scope: { kind: 'fleet' }, role: 'admin', by: 'test', granterIsAdmin: true });
    const lost = await s.keys.create({ owner: BREAK_GLASS_OWNER, roles: ['admin'], by: 'test' });
    s.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: 'EARLIER', actor: 'test' });

    const written: string[] = [];
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...x: unknown[]) => void logs.push(x.join(' '));
    let out;
    try {
      out = await recoverLockout({ ...s, operator: 'arn:aws:iam::566332862296:role/ops', email: 'Recovery@Example.com', reseedBreakGlass: true, writeSecret: async (p) => void written.push(p) });
    } finally {
      console.log = orig;
    }
    assert.equal(written.length, 1);
    assert.match(written[0], /^fk_/);
    assert.ok(!JSON.stringify(out).includes(written[0]) && !logs.join('\n').includes(written[0]), 'secret never returned or printed');
    assert.equal(s.keys.verify(lost.plaintext), undefined, 'the lost key is revoked');
    assert.equal(s.keys.verify(written[0])?.owner, BREAK_GLASS_OWNER);
    const rec = s.principals.findByEmail('recovery@example.com');
    assert.ok(rec && s.grants.list({ subject: rec.id }).some((g) => g.role === 'admin' && g.scope.kind === 'fleet'));

    const drained = await drainRecoveryOutbox({ outbox: s.outbox, ledger: s.ledger, reload: async () => {} });
    assert.equal(drained, 2);
    const actions = s.ledger.query().map((e) => e.action);
    assert.ok(actions.some((a) => a === 'LOCKOUT_RECOVERED:admin'));
    assert.ok(actions.some((a) => a.startsWith('LOCKOUT_RECOVERED:break-glass:')));
    assert.equal(s.ledger.verify().ok, true);
    assert.ok(!JSON.stringify(s.ledger.query()).includes(written[0]));
    assert.equal(await drainRecoveryOutbox({ outbox: s.outbox, ledger: s.ledger, reload: async () => {} }), 0, 'drains once');
  });

  it('a failed secret write keeps the old break-glass key and drops the new one', async () => {
    const s = await stores();
    const old = await s.keys.create({ owner: BREAK_GLASS_OWNER, roles: ['admin'], by: 'test' });
    await assert.rejects(recoverLockout({ ...s, operator: 'op', reseedBreakGlass: true, writeSecret: async () => { throw new Error('denied'); } }), /denied/);
    assert.equal(s.keys.verify(old.plaintext)?.id, old.record.id);
    assert.equal(s.keys.list({ owner: BREAK_GLASS_OWNER }).length, 1);
  });

  it('FACTORY_BOOTSTRAP_ADMIN applies only while zero human admins exist', async () => {
    const s = await stores();
    assert.equal(await bootstrapAdmin(s, undefined), 'unset');
    assert.equal(await bootstrapAdmin(s, 'first@example.com'), 'bootstrapped');
    assert.equal(await bootstrapAdmin(s, 'second@example.com'), 'ignored');
    assert.equal(s.principals.findByEmail('second@example.com'), undefined);
  });

  it('IdP config is validated and never stores secret values', () => {
    assert.equal(validateIdpConfig({ providers: [{ id: 'google', clientId: 'abc', clientSecretRef: 'factory/prod/GOOGLE_OAUTH' }] }).ok, true);
    assert.equal(validateIdpConfig({ providers: [{ id: 'google', clientId: 'abc', clientSecret: 'x' }] }).ok, false);
    assert.equal(validateIdpConfig({ providers: [{ id: 'oidc', clientId: 'abc' }] }).ok, false, 'oidc needs an issuer');
    assert.equal(validateIdpConfig({ providers: [{ id: 'okta', clientId: 'abc' }] }).ok, false);
    assert.equal(validateIdpConfig({ providers: [] }).ok, false);
  });
});
