// Story #354 ([S3b] Two-phase content-ownership transfer with OAuth & private-skill purge, Epic #349):
// D11, D15, D23, D26, S3b.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, FileDocBackend, GrantStore, PrincipalStore } from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { getConnections } from './connections.js';
import { loadSkills, skillRegistry } from './skills.js';
import { setTransferNotifier, sweepStaleTransfers } from './transfers.js';

const SHA = '3'.repeat(40);
const RUNTIME_SHA = 'd'.repeat(40);
const RUN_KEY = 's3b-transfers-run-token-key-0123456789abcdef'; // secret-scan:allow (test fixture)

const TOKENS = {
  admin: 'tok-s3b-admin', // secret-scan:allow (test fixture)
  op: 'tok-s3b-op', // secret-scan:allow (test fixture)
  alice: 'tok-s3b-alice', // secret-scan:allow (test fixture)
  bob: 'tok-s3b-bob', // secret-scan:allow (test fixture)
  carol: 'tok-s3b-carol', // secret-scan:allow (test fixture)
  sarah: 'tok-s3b-sarah', // secret-scan:allow (test fixture)
} as const;

const ACTORS: Record<string, string> = {
  [TOKENS.admin]: 'user:admin',
  [TOKENS.op]: 'user:op',
  [TOKENS.alice]: 'user:alice',
  [TOKENS.bob]: 'user:bob',
  [TOKENS.carol]: 'user:carol',
  [TOKENS.sarah]: 'user:sarah',
};

function identityOnlyAuth(): AuthProvider {
  return {
    name: 's3b-identity-only',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
      const actor = ACTORS[authorization.slice('Bearer '.length).trim()];
      if (!actor) return { ok: false, reason: 'unknown token' };
      return { ok: true, principal: { actor, roles: [] } };
    },
  };
}

/** A writable in-memory secrets backend (the factory's Secrets Manager in production). */
function memorySecrets(): SecretProvider & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    name: 'memory',
    values,
    async get(n) {
      return values.get(n);
    },
    async put(n, v) {
      values.set(n, v);
    },
  };
}

const GMAIL = { kind: 'oauth-user', provider: 'gmail', authUrl: 'https://accounts.example/auth', tokenUrl: 'https://accounts.example/token', clientSecret: 'shared/gmail/oauth-client', authParams: {} } as const;

describe('S3b: two-phase ownership transfer with OAuth & private-skill purge (#354)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let grants: GrantStore;
  let secrets: ReturnType<typeof memorySecrets>;
  let port = 0;
  let clock = Date.now();
  const notified: Array<{ kind: string; from: string; to: string }> = [];

  const call = async (method: string, path: string, body?: unknown, token: string = TOKENS.admin, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const seedOAuth = async (agentId: string, by: string) => {
    await getConnections(state).saveGrant(agentId, {
      provider: 'gmail',
      clientRef: 'shared/gmail/oauth-client',
      refreshToken: `rt-${by}-0123456789`,
      scopes: ['mail.read'],
      obtainedAt: new Date().toISOString(),
      grantedBy: by,
      status: 'active',
    });
  };

  const registerSkill = (id: string, owner: string, visibility: 'private' | 'public', ownerAgent?: string) => {
    skillRegistry(state).save({
      id,
      version: '1.0.0',
      repo: `https://github.com/BeerCanLabs/${id}`,
      path: '.',
      commit: SHA,
      manifest: { id, version: '1.0.0', name: id, description: id, language: 'python', entry: id.replace(/-/g, '_'), requires: { routes: [] }, visibility, ...(ownerAgent ? { owner: ownerAgent } : {}) },
      status: 'approved',
      tests: 'passed',
      registeredBy: owner,
      registeredAt: new Date().toISOString(),
      owner,
    } as never);
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-s3b-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend(join(dir, 'principals')));
    grants = await GrantStore.open(new FileDocBackend(join(dir, 'grants')), { principals, now: () => new Date(clock) });
    for (const id of ['admin', 'op', 'alice', 'bob', 'carol', 'sarah']) {
      await principals.create({ id: `user:${id}`, displayName: id, emails: [`${id}@sackrider.org`], by: 'user:admin' });
    }
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:op', scope: { kind: 'fleet' }, role: 'operator', by: 'user:admin', granterIsAdmin: true });
    for (const v of ['alice', 'bob', 'carol', 'sarah']) {
      await grants.grant({ subject: `user:${v}`, scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    }
    secrets = memorySecrets();

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: identityOnlyAuth(),
      principals,
      grants,
      groups: await GroupStore.open(join(dir, 'groups')),
      schedules: new ScheduleStore(),
      version: '0.1.0',
      providers: [secrets],
      systems: { getConnectionProvider: (id: string) => (id === 'gmail' ? GMAIL : undefined), getConnectionProviders: () => [GMAIL] },
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(RUN_KEY),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: { 'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: 'registry.example/runtime:s3b' },
      deployProvider: {
        buildImage: async (agentId: string, source: { commit: string }) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId: string) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    setTransferNotifier(state, (e) => {
      notified.push({ kind: e.kind, from: e.from, to: e.to });
    });

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;

    const created = await call('POST', '/api/v1/agents', { id: 'friday', name: 'Friday', kind: 'personal', actAs: 'user:alice', soul: 'You help Alice.', memory: { archetype: 'personal-assistant' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const team = await call('POST', '/api/v1/agents', { id: 'ops-desk', name: 'Ops Desk', kind: 'team', accountableLead: 'user:sarah', soul: 'Team.', memory: { archetype: 'team-member' } }, TOKENS.op);
    assert.equal(team.status, 201, JSON.stringify(team.body));

    // friday runs Alice's private skill, Carol's private skill, and a public skill.
    registerSkill('alice-notes', 'user:alice', 'private', 'friday');
    registerSkill('carol-notes', 'user:carol', 'private', 'friday');
    registerSkill('public-search', 'user:carol', 'public');
    await state.configs!.put(
      { ...state.configs!.current('friday')!, skills: [{ id: 'alice-notes', version: '1.0.0' }, { id: 'carol-notes', version: '1.0.0' }, { id: 'public-search', version: '1.0.0' }] as never },
      { updatedBy: 'user:admin', reason: 's3b fixture' },
    );
    await secrets.put!('agents/friday/STATIC_API_KEY', 'static-agent-secret-value');
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC3: a team agent refuses transfer with 409', async () => {
    const res = await call('POST', '/api/v1/agents/ops-desk/transfer', { to: 'user:bob' }, TOKENS.admin);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, 'agent_kind_conflict');
  });

  it('only the active content-owner or an admin may start; unknown agent is 404', async () => {
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:bob' }, TOKENS.bob)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents/nobody/transfer', { to: 'user:bob' }, TOKENS.admin)).status, 404);
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', {}, TOKENS.alice)).status, 400);
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:alice' }, TOKENS.alice)).status, 400);
  });

  it('AC1: while pending Alice is read-only (403 on writes, reads succeed); cancel restores write with OAuth intact', async () => {
    await seedOAuth('friday', 'user:alice');
    const started = await call('POST', '/api/v1/agents/friday/transfer', { to: 'bob@sackrider.org' }, TOKENS.alice);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.transfer.to, 'user:bob');
    assert.equal((await call('GET', '/api/v1/agents/friday/transfer', undefined, TOKENS.bob)).body.transfer.from, 'user:alice');
    assert.equal((await call('GET', '/api/v1/agents/friday/transfer', undefined, TOKENS.carol)).status, 403);

    assert.equal((await call('GET', '/api/v1/agents/friday/settings', undefined, TOKENS.alice)).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/friday/settings', { soul: 'pending write' }, TOKENS.alice)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:carol' }, TOKENS.alice)).status, 403, 'read-only owner cannot restart');
    assert.equal((await call('GET', '/api/v1/agents/friday/settings', undefined, TOKENS.bob)).status, 403, 'recipient holds nothing yet');
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer/accept', {}, TOKENS.carol)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer/cancel', {}, TOKENS.bob)).status, 403);

    const cancelled = await call('POST', '/api/v1/agents/friday/transfer/cancel', {}, TOKENS.alice);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual(ownersOf(state, 'friday'), ['user:alice']);
    assert.equal((await call('PUT', '/api/v1/agents/friday/settings', { soul: 'restored' }, TOKENS.alice)).status, 200);
    assert.ok(await getConnections(state).getGrant('friday', 'gmail'), 'OAuth intact after cancel');
  });

  it('AC1: decline by the recipient restores Alice with OAuth intact', async () => {
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:bob' }, TOKENS.alice)).status, 202);
    const declined = await call('POST', '/api/v1/agents/friday/transfer/decline', {}, TOKENS.bob);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal((await call('PUT', '/api/v1/agents/friday/settings', { soul: 'after decline' }, TOKENS.alice)).status, 200);
    assert.ok(await getConnections(state).getGrant('friday', 'gmail'));
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer/accept', {}, TOKENS.bob)).status, 404, 'nothing pending');
  });

  it('AC1: the 7-day sweeper rolls back an expired transfer and restores Alice', async () => {
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:bob' }, TOKENS.alice)).status, 202);
    clock += 7 * 24 * 60 * 60 * 1000 + 1000;
    const restored = await sweepStaleTransfers(state);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].subject, 'user:alice');
    assert.deepEqual(ownersOf(state, 'friday'), ['user:alice']);
    assert.equal((await call('PUT', '/api/v1/agents/friday/settings', { soul: 'after expiry' }, TOKENS.alice)).status, 200);
    assert.ok(await getConnections(state).getGrant('friday', 'gmail'));
    assert.ok(ledger.query().some((e) => e.action === 'OWNERSHIP_TRANSFER_EXPIRED'));
  });

  it('AC2: Bob accepts; Bob owns, Alice is revoked, OAuth purged, Alice private skills detached, static secrets kept', async () => {
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:bob' }, TOKENS.alice)).status, 202);
    const accepted = await call('POST', '/api/v1/agents/friday/transfer/accept', {}, TOKENS.bob);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.owner, 'user:bob');
    assert.deepEqual(accepted.body.oauthPurged, ['gmail']);
    assert.deepEqual(accepted.body.privateSkillsDetached, ['alice-notes']);

    assert.deepEqual(ownersOf(state, 'friday'), ['user:bob']);
    assert.equal(grants.list({ scopeKind: 'agent', scopeId: 'friday' }).filter((g) => g.subject === 'user:alice').length, 0);
    assert.equal((await call('GET', '/api/v1/agents/friday/settings', undefined, TOKENS.alice)).status, 403);
    assert.equal((await call('PUT', '/api/v1/agents/friday/settings', { soul: 'Bob now' }, TOKENS.bob)).status, 200);

    assert.equal(await getConnections(state).getGrant('friday', 'gmail'), undefined, 'Alice OAuth tokens purged');
    assert.ok(![...secrets.values.values()].some((v) => v.includes('rt-user:alice')), 'no refresh token left in storage');
    assert.equal(secrets.values.get('agents/friday/STATIC_API_KEY'), 'static-agent-secret-value');
    assert.deepEqual(
      state.configs!.current('friday')!.skills.map((k) => k.id).sort(),
      ['carol-notes', 'public-search'],
    );
    const actions = ledger.query().map((e) => e.action);
    for (const a of ['OWNERSHIP_TRANSFER_STARTED', 'OWNERSHIP_TRANSFER_CANCELLED', 'OWNERSHIP_TRANSFER_DECLINED', 'OWNERSHIP_TRANSFER_ACCEPTED', 'CONNECTION_PURGED', 'SKILL_ADOPTION_REMOVED']) {
      assert.ok(actions.includes(a), `ledgered ${a}`);
    }
    assert.deepEqual(notified.map((n) => n.kind), ['started', 'cancelled', 'started', 'declined', 'started', 'expired', 'started', 'accepted']);
  });

  it('D23: an admin completes a departed owner’s transfer: starts it, and accepts for the recipient via act-as', async () => {
    const started = await call('POST', '/api/v1/agents/friday/transfer', { to: 'user:carol' }, TOKENS.admin);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.transfer.from, 'user:bob');
    assert.equal((await call('POST', '/api/v1/agents/friday/transfer/accept', {}, TOKENS.admin)).status, 403, 'admin must act as the recipient');
    const accepted = await call('POST', '/api/v1/agents/friday/transfer/accept', {}, TOKENS.admin, { 'x-factory-act-as': 'user:carol' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(ownersOf(state, 'friday'), ['user:carol']);
    assert.deepEqual(accepted.body.privateSkillsDetached, [], 'Bob owned no private skills on friday');
  });

  it('skills: a skill transfer uses the same grant transaction (read-only while pending, accept moves ownership)', async () => {
    await grants.grant({ subject: 'user:carol', scope: { kind: 'skill', id: 'public-search' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    const started = await call('POST', '/api/v1/skills/public-search/transfer', { to: 'user:bob' }, TOKENS.carol);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(grants.activeContentOwnerOf({ kind: 'skill', id: 'public-search' }), undefined);
    assert.equal((await call('POST', '/api/v1/skills/public-search/transfer/accept', {}, TOKENS.alice)).status, 403);
    const accepted = await call('POST', '/api/v1/skills/public-search/transfer/accept', {}, TOKENS.bob);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(grants.activeContentOwnerOf({ kind: 'skill', id: 'public-search' }), 'user:bob');
    assert.equal(skillRegistry(state).versions('public-search')[0].owner, 'user:bob');
  });
});
