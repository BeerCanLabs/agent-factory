// Story #373 ([S8] legacy auth import, shadow mode, cutover; Epic #349): R1, D4, D8, S8.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApiKeyStore, ApprovalStore, FileDocBackend, GrantStore, IdentityLinkStore, PrincipalStore, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { mapLegacyAgentRole } from './auth-migration.js';

const ADMIN = 'tok-s8-admin'; // secret-scan:allow (test fixture)
const bearer: AuthProvider = {
  name: 's8-identity-only',
  async verify(a) {
    return a === `Bearer ${ADMIN}` ? { ok: true, principal: { actor: 'user:admin', roles: [] } } : { ok: false, reason: 'unknown token' };
  },
};

describe('S8: legacy auth import, shadow mode and cutover (#373)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const saved = { a: process.env.FACTORY_ADMIN_EMAILS, t: process.env.FACTORY_TOKENS };
  const call = async (method: string, path: string, token = ADMIN, body = '{}') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : body });
    return { status: res.status, body: (await res.json()) as any };
  };

  before(async () => {
    process.env.FACTORY_ADMIN_EMAILS = 'Dale@Example.com, ops@example.com';
    process.env.FACTORY_TOKENS = JSON.stringify([{ name: 'deployer', token: 'x', roles: ['operator'] }]); // secret-scan:allow (test fixture)
    dir = mkdtempSync(join(tmpdir(), 's8-migration-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), { principals });
    await principals.create({ id: 'user:admin', displayName: 'Admin', emails: ['admin@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    const identityLinks = new IdentityLinkStore(join(dir, 'links'));
    identityLinks.link('discord', '1001', 'cloudflare:viewer@example.com', 'user:admin', { name: 'Vee', roles: ['viewer'], agentRoles: { higgins: ['member'] } });
    // Production-shaped (the Nov 3 import failure): a fleet operator whose legacy per-agent role is "Operator".
    identityLinks.link('discord', '1002', 'cloudflare:op@example.com', 'user:admin', { name: 'Op', roles: ['operator', 'viewer'], agentRoles: { switch: ['Operator'] } });
    state = {
      agents: new Map(), registryDir: join(dir, 'registry'), ledger, auth: bearer, principals, grants, identityLinks,
      keys: await ApiKeyStore.open(), version: 'test', providers: [envProvider({})], runtime: noopRuntime(), runs: new MemoryRunStore(),
      runTokens: new RunTokens('s8-migration-run-token-key-0123456789abcd'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(), policies: new PolicyStore(), spend: new SpendTracker(), secretValues: new Set(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['FACTORY_ADMIN_EMAILS', saved.a], ['FACTORY_TOKENS', saved.t]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it('S8 AC1: before import shadow mode reports mismatches and cutover is refused', async () => {
    const r = await call('GET', '/api/v1/auth-migration/readiness');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ready, false);
    assert.ok(r.body.mismatches > 0);
    assert.equal((await call('POST', '/api/v1/auth-migration/cutover')).status, 409);
    assert.ok(ledger.query().some((e) => e.action === 'AUTH_SHADOW_MISMATCH' && e.privilege));
  });

  it('S8 AC1: the importer creates principals, grants and a service key once, and is idempotent', async () => {
    const first = await call('POST', '/api/v1/auth-migration/import');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.principals, 4, 'dale, ops, the linked viewer and the linked operator');
    assert.ok(first.body.grants >= 4);
    assert.equal(first.body.keys, 1);
    assert.match(first.body.secrets[0].secret, /^fk_/);
    const second = await call('POST', '/api/v1/auth-migration/import');
    assert.deepEqual([second.body.principals, second.body.grants, second.body.keys], [0, 0, 0]);
    assert.ok(state.principals!.findByEmail('dale@example.com'));
    assert.ok(state.grants!.list({ subject: 'service:deployer' }).some((g) => g.role === 'operator'));
    assert.ok(!JSON.stringify(ledger.query()).includes(first.body.secrets[0].secret), 'the key secret is never ledgered');
  });

  it('S8: a legacy agent "Operator" maps to the fleet operator grant the person already holds, never widening access', async () => {
    assert.deepEqual(mapLegacyAgentRole('Operator', ['operator', 'viewer']), { fleet: 'operator' });
    assert.deepEqual(mapLegacyAgentRole('Operator', ['viewer']), { refused: 'Operator' });
    assert.deepEqual(mapLegacyAgentRole('Realtor', []), { agent: 'Realtor' });
    const op = state.principals!.list().find((p) => p.emails?.includes('op@example.com'));
    assert.ok(op, 'the production-shaped link imported without a 400');
    assert.ok(state.grants!.list({ subject: op.id, scopeKind: 'fleet' }).some((g) => g.role === 'operator'));
  });

  it('S8: reissueKeys revokes keys left by a partial run and returns fresh secrets once', async () => {
    const owner = state.keys!.list().find((k) => k.owner.startsWith('service:'))!.owner;
    const old = state.keys!.list({ owner });
    const r = await call('POST', '/api/v1/auth-migration/import', ADMIN, JSON.stringify({ reissueKeys: true }));
    assert.equal(r.status, 200);
    assert.equal(r.body.revokedKeys, old.length);
    assert.equal(r.body.keys, 1);
    assert.match(r.body.secrets[0].secret, /^fk_/);
    assert.ok(old.every((k) => state.keys!.get(k.id)!.revokedAt), 'the orphaned keys are revoked');
    assert.equal(r.body.grants, 0, 'grants are ensure-style; a rerun adds none');
  });

  it('S8 AC1: after import shadow mode shows zero mismatches; cutover strips link roles and is ledgered', async () => {
    const r = await call('GET', '/api/v1/auth-migration/readiness');
    assert.equal(r.body.mismatches, 0, JSON.stringify(r.body.sample));
    assert.equal(r.body.ownerOrphans, 0, 'every live item has an owner/lead for hold routing');
    assert.deepEqual(r.body.orphans, [], 'readiness names each orphan so an admin can grant its owner');
    assert.equal(r.body.ready, true);
    const c = await call('POST', '/api/v1/auth-migration/cutover');
    assert.equal(c.status, 200);
    assert.equal(state.authCutover, true);
    assert.equal(state.identityLinks!.list()[0].roles, undefined, 'link roles are gone; grants decide');
    assert.ok(ledger.query().some((e) => e.action === 'AUTH_CUTOVER' && e.actor === 'user:admin'));
    assert.ok(state.identityLinks!.list().every((l) => !l.roles?.length && !Object.keys(l.agentRoles ?? {}).length), 'agent link roles are stripped too');
    const after = await call('GET', '/api/v1/auth-migration/readiness');
    assert.equal(after.body.mismatches, 0, 'no legacy link roles remain to compare');
    state.authCutover = undefined; // a restart loses the flag; the ledgered AUTH_CUTOVER row keeps it
    assert.equal((await call('GET', '/api/v1/auth-migration/readiness')).body.cutover, true);
    assert.equal((await call('POST', '/api/v1/auth-migration/cutover')).status, 200, 'a rerun after cutover is allowed');
  });

  it('S8: the migration routes need grants.manage', async () => {
    for (const [m, p] of [['GET', '/api/v1/auth-migration/readiness'], ['POST', '/api/v1/auth-migration/import'], ['POST', '/api/v1/auth-migration/cutover']] as const) {
      assert.equal((await call(m, p, 'nobody')).status, 401);
    }
  });
});
