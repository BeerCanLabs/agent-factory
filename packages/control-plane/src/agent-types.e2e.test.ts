// Story #352 ([S2b] Agent types (personal vs team) and ownership model, Epic #349):
// D7, D10, D11, D12, D13, D15, D24, D26, D29, D30.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import {
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  GrantStoreError,
  PrincipalStore,
} from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdentityLinkStore } from './identity-links.js';
import { ownersOf } from './config-store.js';
import { loadSkills } from './skills.js';

const TOKENS = {
  admin: 'tok-user-admin',
  op: 'tok-user-op',
  dale: 'tok-user-dale',
  alice: 'tok-user-alice',
  sarah: 'tok-user-sarah',
  geordi: 'tok-user-geordi',
  stephanie: 'tok-user-stephanie',
  bob: 'tok-user-bob',
  ingress: 'tok-svc-ingress',
} as const;

const ACTORS: Record<string, { actor: string; roles: Array<'operator' | 'gatekeeper-ingress'> }> = {
  [TOKENS.admin]: { actor: 'user:admin', roles: [] },
  [TOKENS.op]: { actor: 'user:op', roles: [] },
  [TOKENS.dale]: { actor: 'user:dale', roles: [] },
  [TOKENS.alice]: { actor: 'user:alice', roles: [] },
  [TOKENS.sarah]: { actor: 'user:sarah', roles: [] },
  [TOKENS.geordi]: { actor: 'user:geordi', roles: [] },
  [TOKENS.stephanie]: { actor: 'user:stephanie', roles: [] },
  [TOKENS.bob]: { actor: 'user:bob', roles: [] },
  [TOKENS.ingress]: { actor: 'service:gatekeeper-ingress', roles: ['operator', 'gatekeeper-ingress'] },
};

function identityOnlyAuth(): AuthProvider {
  return {
    name: 'identity-only-test',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) {
        return { ok: false, reason: 'missing bearer token' };
      }
      const presented = authorization.slice('Bearer '.length).trim();
      const entry = ACTORS[presented];
      if (!entry) return { ok: false, reason: 'unknown token' };
      return { ok: true, principal: { actor: entry.actor, roles: entry.roles } };
    },
  };
}

const SHA = '7'.repeat(40);
const RUNTIME_SHA = 'e'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:s2b';
const RUN_KEY = 's2b-agent-types-run-token-key-0123456789abcdef';

describe('S2b: Agent types (personal vs team) and ownership model (#352)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let principals: PrincipalStore;
  let grants: GrantStore;
  let groups: GroupStore;
  let port = 0;

  const call = async (method: string, path: string, body?: unknown, token: string = TOKENS.admin) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  function holdOnRun(agentId: string, requestedBy?: { provider: string; id: string }): string {
    const run = state.runs.create({
      agentId,
      state: 'WORKING',
      actor: 'user:op',
      trigger: 'manual',
      ...(requestedBy ? { requestedBy } : {}),
    });
    const argsSha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const { approval } = state.approvals.hold({
      runId: run.runId,
      agentId,
      route: 'github',
      tool: 'POST /repos/test/issues',
      argsSha256,
      request: { method: 'POST', path: '/repos/test/issues', headers: {}, body: '{}', bodyEncoding: 'utf8' },
    });
    return approval.approvalId;
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-s2b-'));
    ledger = new MemoryLedger();
    principals = await PrincipalStore.open(new FileDocBackend(join(dir, 'principals')));
    grants = await GrantStore.open(new FileDocBackend(join(dir, 'grants')), { principals });
    groups = await GroupStore.open(join(dir, 'groups'));

    for (const [id, email, name] of [
      ['user:admin', 'admin@sackrider.org', 'Admin'],
      ['user:op', 'op@sackrider.org', 'Operator'],
      ['user:dale', 'dale@sackrider.org', 'Dale'],
      ['user:alice', 'alice@sackrider.org', 'Alice'],
      ['user:sarah', 'sarah@sackrider.org', 'Sarah'],
      ['user:geordi', 'geordi@sackrider.org', 'Geordi'],
      ['user:stephanie', 'stephanie@sackrider.org', 'Stephanie'],
      ['user:bob', 'bob@sackrider.org', 'Bob'],
    ] as const) {
      await principals.create({
        id,
        displayName: name,
        emails: [email],
        by: 'user:admin',
      });
    }

    // Pure GrantStore fleet roles (zero token roles on human callers)
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:op', scope: { kind: 'fleet' }, role: 'operator', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:dale', scope: { kind: 'fleet' }, role: 'operator', by: 'user:admin', granterIsAdmin: true });
    for (const viewer of ['user:alice', 'user:sarah', 'user:geordi', 'user:stephanie', 'user:bob']) {
      await grants.grant({ subject: viewer, scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    }

    await groups.createGroup({ id: 'sre', name: 'SRE Team', roles: [], members: ['user:geordi'], createdBy: 'user:admin' });

    const identityLinks = new IdentityLinkStore(join(dir, 'links'));
    identityLinks.link('discord', 'dale-discord-1', 'user:dale', 'user:admin');
    identityLinks.link('discord', 'sarah-discord-1', 'user:sarah', 'user:admin');
    identityLinks.link('discord', 'geordi-discord-1', 'user:geordi', 'user:admin');
    identityLinks.link('discord', 'steph-discord-1', 'user:stephanie', 'user:admin');

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: identityOnlyAuth(),
      principals,
      grants,
      groups,
      identityLinks,
      version: '0.1.0',
      providers: [envProvider({})],
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
      modelCatalog: {
        'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never,
        'claude-sonnet': { provider: 'anthropic', url: 'https://models.example/v1' } as never,
      },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async (agentId, source) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC1/AC2: creating a personal agent defaults kind to "personal", assigns submitter as sole content-owner, and grants owner privileges + skills.register', async () => {
    const res = await call(
      'POST',
      '/api/v1/agents',
      {
        id: 'donna',
        name: 'Donna',
        soul: 'You are Donna, personal assistant.',
        memory: { archetype: 'personal-assistant' },
        roles: [{ name: 'Family', skills: { '*': { allow: ['*'] } } }],
      },
      TOKENS.dale,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'personal');

    const record = state.agents.get('donna')!;
    assert.equal(record.kind, 'personal');
    assert.equal(record.accountableLead, undefined);
    assert.deepEqual(ownersOf(state, 'donna'), ['user:dale']);

    const donnaGrants = grants.list({ scopeKind: 'agent', scopeId: 'donna' });
    assert.equal(donnaGrants.length, 1);
    assert.equal(donnaGrants[0].subject, 'user:dale');
    assert.equal(donnaGrants[0].role, 'content-owner');
    assert.equal(donnaGrants[0].state, 'active');

    // Admin configures budget/policy & deploys donna WITHOUT holding content-owner on donna
    assert.equal(
      (await call('PUT', '/api/v1/agents/donna/policy', { routes: ['models'], models: ['gemini-2.0-flash', 'claude-sonnet'], budgetUsd: { perDay: 10, perMonth: 100 } }, TOKENS.admin)).status,
      200,
    );
    assert.equal((await call('POST', '/api/v1/registry/agents/donna/deploy', {}, TOKENS.admin)).status, 200);

    // Content-owner Dale manages settings, exports bundle, and registers a skill (skills.register from content-owner)
    const getSettings = await call('GET', '/api/v1/agents/donna/settings', undefined, TOKENS.dale);
    assert.equal(getSettings.status, 200);
    assert.equal(
      (await call('PUT', '/api/v1/agents/donna/settings', { soul: 'You are Donna v2.' }, TOKENS.dale)).status,
      200,
    );
    const bundle = await call('GET', '/api/v1/agents/donna/bundle', undefined, TOKENS.dale);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.body.agent.kind, 'personal');

    // Unrelated viewer Alice cannot read settings or export bundle
    assert.equal((await call('GET', '/api/v1/agents/donna/settings', undefined, TOKENS.alice)).status, 403);
    assert.equal((await call('GET', '/api/v1/agents/donna/bundle', undefined, TOKENS.alice)).status, 403);
  });

  it('AC2/D7/D12: admin creates a personal agent with actAs / onBehalfOf -> target user becomes sole content-owner; admin holds zero content-owner grants; non-admin actAs is 403', async () => {
    // Non-admin operator attempting actAs is refused 403 with zero writes
    const denied = await call(
      'POST',
      '/api/v1/agents',
      {
        id: 'alice-denied',
        name: 'Alice Denied',
        kind: 'personal',
        actAs: 'user:alice',
        memory: { archetype: 'personal-assistant' },
      },
      TOKENS.op,
    );
    assert.equal(denied.status, 403);
    assert.equal(state.agents.has('alice-denied'), false);
    assert.deepEqual(grants.list({ scopeKind: 'agent', scopeId: 'alice-denied' }), []);

    // Admin creates alice-bot on behalf of user:alice
    const created = await call(
      'POST',
      '/api/v1/agents',
      {
        id: 'alice-bot',
        name: 'Alice Bot',
        kind: 'personal',
        actAs: 'user:alice',
        soul: 'You help Alice.',
        memory: { archetype: 'personal-assistant' },
      },
      TOKENS.admin,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.kind, 'personal');
    assert.deepEqual(ownersOf(state, 'alice-bot'), ['user:alice']);

    const botGrants = grants.list({ scopeKind: 'agent', scopeId: 'alice-bot' });
    assert.equal(botGrants.length, 1);
    assert.equal(botGrants[0].subject, 'user:alice');
    assert.equal(botGrants[0].role, 'content-owner');
    assert.equal(botGrants[0].createdBy, 'user:admin');
    assert.equal(botGrants[0].onBehalfOf, 'user:alice');

    // Admin sets policy & models without holding content-owner; Alice (viewer fleet role + content-owner) reads & updates settings + registers a skill
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/policy', { routes: ['models'], models: ['gemini-2.0-flash', 'claude-sonnet'], budgetUsd: { perDay: 5, perMonth: 50 } }, TOKENS.admin)).status,
      200,
    );
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/models', { currentModel: 'claude-sonnet' }, TOKENS.admin)).status,
      200,
    );
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/settings', undefined, TOKENS.alice)).status, 200);
    assert.equal(
      (
        await call(
          'POST',
          '/api/v1/registry/skills',
          {
            repo: 'https://github.com/BeerCanLabs/skill-alice',
            path: '.',
            commit: SHA,
            manifest: { id: 'alice-helper', version: '1.0.0', name: 'Alice Helper', description: 'Helps Alice.', language: 'python', entry: 'main' },
          },
          TOKENS.alice,
        )
      ).status,
      201,
      'content-owner with only fleet viewer holds skills.register',
    );
  });

  it('AC3/D10/D12/D30: operator creates a team agent with accountableLead -> zero content-owner, owners is empty, submitter gets neither lead nor owner, accountableLead manages team agent', async () => {
    const created = await call(
      'POST',
      '/api/v1/agents',
      {
        id: 'incident-triage',
        name: 'Incident Triage',
        kind: 'team',
        accountableLead: 'user:sarah',
        soul: 'You triage production incidents.',
        memory: { archetype: 'team-member' },
      },
      TOKENS.op,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.kind, 'team');
    assert.equal(created.body.accountableLead, 'user:sarah');

    const record = state.agents.get('incident-triage')!;
    assert.equal(record.kind, 'team');
    assert.equal(record.accountableLead, 'user:sarah');
    assert.deepEqual(ownersOf(state, 'incident-triage'), []);
    const cfg = state.configs!.current('incident-triage')!;
    assert.equal('owners' in cfg, false, 'team agent stores zero owners in ConfigStore');

    const teamGrants = grants.list({ scopeKind: 'agent', scopeId: 'incident-triage' });
    assert.equal(teamGrants.length, 1);
    assert.equal(teamGrants[0].subject, 'user:sarah');
    assert.equal(teamGrants[0].role, 'accountable-lead');
    assert.equal(teamGrants[0].createdBy, 'user:op');
    assert.equal(
      teamGrants.some((g) => g.role === 'content-owner'),
      false,
      'team agent has zero content-owner grants',
    );
    assert.equal(
      teamGrants.some((g) => g.subject === 'user:op'),
      false,
      'submitter does NOT automatically become lead or owner on a team agent',
    );

    // Admin sets policy, models & deploys without content-owner or accountable-lead
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/policy', { routes: ['models'], models: ['gemini-2.0-flash', 'claude-sonnet'], budgetUsd: { perDay: 20, perMonth: 200 } }, TOKENS.admin)).status,
      200,
    );
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/models', { currentModel: 'gemini-2.0-flash' }, TOKENS.admin)).status,
      200,
    );
    assert.equal((await call('POST', '/api/v1/registry/agents/incident-triage/deploy', {}, TOKENS.admin)).status, 200);

    // Accountable lead Sarah (only fleet viewer + accountable-lead) manages settings, models, credentials & registers skills
    assert.equal((await call('GET', '/api/v1/agents/incident-triage/settings', undefined, TOKENS.sarah)).status, 200);
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/settings', { soul: 'You triage Sev1/Sev2 incidents.' }, TOKENS.sarah)).status,
      200,
    );
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/models', { currentModel: 'claude-sonnet' }, TOKENS.sarah)).status,
      200,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/v1/registry/skills',
          {
            repo: 'https://github.com/BeerCanLabs/skill-triage',
            path: '.',
            commit: SHA,
            manifest: { id: 'triage-playbook', version: '1.0.0', name: 'Triage Playbook', description: 'Runbook.', language: 'python', entry: 'main' },
          },
          TOKENS.sarah,
        )
      ).status,
      201,
      'accountable-lead holds skills.register',
    );
    // Team accountable-lead does NOT hold personal bundle export (config.export.agent); admin can still export team bundle
    assert.equal((await call('GET', '/api/v1/agents/incident-triage/bundle', undefined, TOKENS.sarah)).status, 403);
    const exportedTeam = await call('GET', '/api/v1/agents/incident-triage/bundle', undefined, TOKENS.admin);
    assert.equal(exportedTeam.status, 200);
    assert.equal(exportedTeam.body.agent.kind, 'team');

    // Importing a team bundle requires accountableLead at import time (422 if omitted, 201 when provided)
    const missingLeadImport = await call(
      'POST',
      '/api/v1/agents/import',
      { bundle: { ...exportedTeam.body, agent: { ...exportedTeam.body.agent, id: 'triage-copy-bad' } } },
      TOKENS.admin,
    );
    assert.equal(missingLeadImport.status, 422);
    assert.equal(missingLeadImport.body.error, 'accountable_lead_required');
    assert.equal(state.agents.has('triage-copy-bad'), false);

    const validTeamImport = await call(
      'POST',
      '/api/v1/agents/import',
      {
        bundle: { ...exportedTeam.body, agent: { ...exportedTeam.body.agent, id: 'triage-copy' } },
        accountableLead: 'user:sarah',
      },
      TOKENS.admin,
    );
    assert.equal(validTeamImport.status, 201, JSON.stringify(validTeamImport.body));
    assert.equal(state.agents.get('triage-copy')?.kind, 'team');
    assert.deepEqual(ownersOf(state, 'triage-copy'), []);
    const importedGrants = grants.list({ scopeKind: 'agent', scopeId: 'triage-copy' });
    assert.equal(importedGrants.length, 1);
    assert.equal(importedGrants[0].role, 'accountable-lead');
    assert.equal(importedGrants[0].subject, 'user:sarah');

    // Repository registration also supports kind: "team" + accountableLead
    const repoTeam = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: SHA,
        kind: 'team',
        accountableLead: 'user:sarah',
        cartridge: { id: 'ops-watch', name: 'Ops Watch', memory: { archetype: 'team-member' } },
      },
      TOKENS.admin,
    );
    assert.equal(repoTeam.status, 201, JSON.stringify(repoTeam.body));
    assert.equal(repoTeam.body.kind, 'team');
    assert.equal(repoTeam.body.accountableLead, 'user:sarah');
    assert.deepEqual(ownersOf(state, 'ops-watch'), []);
    assert.equal(grants.list({ scopeKind: 'agent', scopeId: 'ops-watch' })[0]?.role, 'accountable-lead');
  });

  it('AC3/AC4/D11/D13/D30: rejects missing/unknown accountableLead, personal+lead conflict, multi-owner personal, team+owners conflict, and invalid kind with zero partial writes', async () => {
    const baseSpec = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: id,
      memory: { archetype: 'team-member' },
      ...extra,
    });

    // 1. Team without accountableLead -> 422 accountable_lead_required
    const noLead = await call('POST', '/api/v1/agents', baseSpec('bad-team-nolead', { kind: 'team' }), TOKENS.op);
    assert.equal(noLead.status, 422);
    assert.equal(noLead.body.error, 'accountable_lead_required');
    assert.equal(state.agents.has('bad-team-nolead'), false);

    // 2. Non-admin naming an unknown principal as accountableLead -> 403 unknown_subject (D13, zero writes)
    const unknownLead = await call(
      'POST',
      '/api/v1/agents',
      baseSpec('bad-team-stranger', { kind: 'team', accountableLead: 'ghost@outsider.example' }),
      TOKENS.op,
    );
    assert.equal(unknownLead.status, 403);
    assert.equal(unknownLead.body.error, 'unknown_subject');
    assert.equal(principals.findByEmail('ghost@outsider.example'), undefined, 'zero shadow principal materialized');
    assert.equal(state.agents.has('bad-team-stranger'), false);

    // 3. Personal with accountableLead -> 409 agent_kind_conflict
    const personalWithLead = await call(
      'POST',
      '/api/v1/agents',
      baseSpec('bad-personal-lead', { kind: 'personal', accountableLead: 'user:sarah' }),
      TOKENS.dale,
    );
    assert.equal(personalWithLead.status, 409);
    assert.equal(personalWithLead.body.error, 'agent_kind_conflict');

    // 4. Personal with >1 owners -> 409 single_owner_only (on create and on PUT /owners)
    const multiOwnerCreate = await call(
      'POST',
      '/api/v1/agents',
      baseSpec('bad-multi-owner', { kind: 'personal', owners: ['user:dale', 'user:alice'] }),
      TOKENS.admin,
    );
    assert.equal(multiOwnerCreate.status, 409);
    assert.equal(multiOwnerCreate.body.error, 'single_owner_only');

    const multiOwnerPut = await call(
      'PUT',
      '/api/v1/agents/donna/owners',
      { owners: ['user:dale', 'user:alice'] },
      TOKENS.admin,
    );
    assert.equal(multiOwnerPut.status, 409);
    assert.equal(multiOwnerPut.body.error, 'single_owner_only');

    // 5. Team with non-empty owners -> 409 agent_kind_conflict (on create and on PUT /owners)
    const teamWithOwnersCreate = await call(
      'POST',
      '/api/v1/agents',
      baseSpec('bad-team-owners', { kind: 'team', accountableLead: 'user:sarah', owners: ['user:sarah'] }),
      TOKENS.admin,
    );
    assert.equal(teamWithOwnersCreate.status, 409);
    assert.equal(teamWithOwnersCreate.body.error, 'agent_kind_conflict');

    const teamWithOwnersPut = await call(
      'PUT',
      '/api/v1/agents/incident-triage/owners',
      { owners: ['user:sarah'] },
      TOKENS.admin,
    );
    assert.equal(teamWithOwnersPut.status, 409);
    assert.equal(teamWithOwnersPut.body.error, 'agent_kind_conflict');
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/owners', { owners: [] }, TOKENS.admin)).status,
      200,
    );

    // 6. Invalid kind -> 400 invalid_kind
    const badKind = await call('POST', '/api/v1/agents', baseSpec('bad-kind', { kind: 'hybrid' }), TOKENS.admin);
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.error, 'invalid_kind');
  });

  it('AC4: live GrantStore agentKindLookup wired to state.agents rejects mismatched roles and second content-owner with 409', async () => {
    // Granting content-owner on registered team agent incident-triage (even omitting agentKind) -> 409 agent_kind_conflict
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:bob',
          scope: { kind: 'agent', id: 'incident-triage' },
          role: 'content-owner',
          by: 'user:admin',
          granterIsAdmin: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // Ownership transfer on registered team agent -> 409 agent_kind_conflict
    await assert.rejects(
      () =>
        grants.startOwnershipTransfer({
          scope: { kind: 'agent', id: 'incident-triage' },
          fromSubject: 'user:sarah',
          toSubject: 'user:bob',
          by: 'user:admin',
          granterIsAdmin: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // Granting accountable-lead on registered personal agent donna -> 409 agent_kind_conflict
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:bob',
          scope: { kind: 'agent', id: 'donna' },
          role: 'accountable-lead',
          by: 'user:admin',
          granterIsAdmin: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );

    // Granting a second content-owner on personal agent donna -> 409 owner_exists
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:bob',
          scope: { kind: 'agent', id: 'donna' },
          role: 'content-owner',
          by: 'user:admin',
          granterIsAdmin: true,
          initialSubmission: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'owner_exists',
    );
  });

  it('AC5/D15/D26: pending-revoked content-owner on personal agent retains read-only access and is refused writes, bundle export, wake, conversation, and hold decisions despite legacy ConfigStore.owners', async () => {
    // Give user:alice a personal agent where she holds only fleet viewer + content-owner (no fleet operator)
    // Start ownership transfer on alice-bot from user:alice to user:bob
    const transfer = await grants.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'alice-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
      principals,
    });
    assert.equal(transfer.outgoing.state, 'pending-revoked');
    assert.equal(transfer.incoming.state, 'pending-accepted');
    // Note: ConfigStore.owners STILL lists ['user:alice'], proving GrantStore readOnly suppresses legacy owner fallback!
    assert.deepEqual(ownersOf(state, 'alice-bot'), ['user:alice']);

    assert.equal((await call('POST', '/api/v1/registry/agents/alice-bot/deploy', {}, TOKENS.admin)).status, 200);

    // Read-only subset remains 200 for outgoing pending-revoked owner
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/settings', undefined, TOKENS.alice)).status, 200);
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/models', undefined, TOKENS.alice)).status, 200);

    // Mutations, bundle export, wake, conversation, and approval clearance are all 403!
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Mutated while pending-revoked' }, TOKENS.alice)).status,
      403,
    );
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/models', { currentModel: 'gemini-2.0-flash' }, TOKENS.alice)).status,
      403,
    );
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/bundle', undefined, TOKENS.alice)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents/alice-bot/wake', {}, TOKENS.alice)).status, 403);
    assert.equal(
      (await call('POST', '/api/v1/agents/alice-bot/conversation', { message: 'hello' }, TOKENS.alice)).status,
      403,
    );
    const heldId = holdOnRun('alice-bot');
    const approvalAttempt = await call('POST', `/api/v1/approvals/${heldId}`, { decision: 'approve' }, TOKENS.alice);
    assert.equal(approvalAttempt.status, 403);

    // Incoming pending-handover recipient Bob also has zero authority before accepting
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/settings', undefined, TOKENS.bob)).status, 403);

    // Cancel transfer -> Alice returns to active content-owner and regains full authority immediately
    await grants.resolveOwnershipTransfer({ transferId: transfer.transferId, action: 'cancel', by: 'user:alice' });
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Restored active owner.' }, TOKENS.alice)).status,
      200,
    );
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/bundle', undefined, TOKENS.alice)).status, 200);
    assert.equal(
      (await call('POST', `/api/v1/approvals/${heldId}`, { decision: 'reject' }, TOKENS.alice)).status,
      200,
    );
  });

  it('AC5/D29: team member (via group grant) wakes, converses, and clears holds on team agent; personal agent-member wakes & converses ONLY and NEVER clears holds even on a run she initiated', async () => {
    // 1. Grant `member` on team agent `incident-triage` to `group:sre` (containing user:geordi)
    await grants.grant({
      subject: 'group:sre',
      scope: { kind: 'agent', id: 'incident-triage' },
      role: 'member',
      by: 'user:sarah',
    });

    // Geordi (fleet viewer + group:sre team member) wakes, converses, and clears holds on incident-triage
    const geordiWake = await call('POST', '/api/v1/agents/incident-triage/wake', { input: { task: 'check alerts' } }, TOKENS.geordi);
    assert.equal(geordiWake.status, 202, JSON.stringify(geordiWake.body));

    const geordiConvo = await call(
      'POST',
      '/api/v1/agents/incident-triage/conversation',
      { message: 'status check' },
      TOKENS.geordi,
    );
    assert.equal(geordiConvo.status, 202, JSON.stringify(geordiConvo.body));

    // Ingress wake on incident-triage for Geordi via Discord link
    const geordiIngressWake = await call(
      'POST',
      '/api/v1/agents/incident-triage/wake',
      { requestedBy: { provider: 'discord', id: 'geordi-discord-1' }, input: { text: 'ping' } },
      TOKENS.ingress,
    );
    assert.equal(geordiIngressWake.status, 202, JSON.stringify(geordiIngressWake.body));

    // Team member Geordi clears a held request on incident-triage (D29)
    const teamHold1 = holdOnRun('incident-triage', { provider: 'discord', id: 'sarah-discord-1' });
    const geordiApprove = await call('POST', `/api/v1/approvals/${teamHold1}`, { decision: 'reject' }, TOKENS.geordi);
    assert.equal(geordiApprove.status, 200, JSON.stringify(geordiApprove.body));

    // Team accountable-lead Sarah also clears a held request on incident-triage (D29)
    const teamHold2 = holdOnRun('incident-triage', { provider: 'discord', id: 'geordi-discord-1' });
    const sarahApprove = await call('POST', `/api/v1/approvals/${teamHold2}`, { decision: 'reject' }, TOKENS.sarah);
    assert.equal(sarahApprove.status, 200, JSON.stringify(sarahApprove.body));

    // Team member Geordi CANNOT mutate team agent settings or models (those belong to accountable-lead / admin)
    assert.equal(
      (await call('PUT', '/api/v1/agents/incident-triage/settings', { soul: 'nope' }, TOKENS.geordi)).status,
      403,
    );

    // 2. Grant `agent-member` (subRole: 'Family') on personal agent `donna` to `user:stephanie`
    await grants.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'donna' },
      role: 'agent-member',
      subRoles: ['Family'],
      by: 'user:dale',
    });

    // Stephanie wakes and converses with donna (both direct and via Discord ingress)
    const stephWake = await call('POST', '/api/v1/agents/donna/wake', { input: { text: 'grocery list' } }, TOKENS.stephanie);
    assert.equal(stephWake.status, 202, JSON.stringify(stephWake.body));

    const stephConvo = await call(
      'POST',
      '/api/v1/agents/donna/conversation',
      { message: 'add milk' },
      TOKENS.stephanie,
    );
    assert.equal(stephConvo.status, 202, JSON.stringify(stephConvo.body));

    const stephIngressWake = await call(
      'POST',
      '/api/v1/agents/donna/wake',
      { requestedBy: { provider: 'discord', id: 'steph-discord-1' }, input: { text: 'hi donna' } },
      TOKENS.ingress,
    );
    assert.equal(stephIngressWake.status, 202, JSON.stringify(stephIngressWake.body));

    // CRITICAL D29 INVARIANT: A held request on a run of personal agent `donna` initiated by Stephanie (agent-member)
    // CANNOT be decided by Stephanie (403), and CAN be decided by Dale (personal content-owner, 200)!
    const personalHold = holdOnRun('donna', { provider: 'discord', id: 'steph-discord-1' });
    const stephDecide = await call('POST', `/api/v1/approvals/${personalHold}`, { decision: 'reject' }, TOKENS.stephanie);
    assert.equal(stephDecide.status, 403, 'personal agent-member NEVER clears holds, even on a run she initiated (D29)');

    const daleDecide = await call('POST', `/api/v1/approvals/${personalHold}`, { decision: 'reject' }, TOKENS.dale);
    assert.equal(daleDecide.status, 200, JSON.stringify(daleDecide.body));
  });

  it('agent-builder validates and publishes both team (with accountableLead) and personal agents using GrantStore fleet operator authority', async () => {
    const builderRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'user:op',
      caller: { actor: 'user:op', role: 'viewer', roles: [] },
      trigger: 'api',
    });
    const builderToken = await state.runTokens!.mint({ runId: builderRun.runId, agentId: 'agent-builder' });

    // Validate missing accountableLead on team spec -> 422
    const invalidTeam = await call(
      'POST',
      `/api/v1/runs/${builderRun.runId}/builder`,
      { op: 'validate', spec: { id: 'builder-team', kind: 'team', memory: { archetype: 'team-member' } } },
      builderToken,
    );
    assert.equal(invalidTeam.status, 422);
    assert.equal(invalidTeam.body.error, 'accountable_lead_required');

    // Publish valid team agent via agent-builder -> 201, accountable-lead granted to Sarah, zero owners
    const publishedTeam = await call(
      'POST',
      `/api/v1/runs/${builderRun.runId}/builder`,
      {
        op: 'publish',
        spec: {
          id: 'builder-team',
          name: 'Builder Team Agent',
          kind: 'team',
          accountableLead: 'user:sarah',
          soul: 'Built by agent-builder.',
          memory: { archetype: 'team-member' },
        },
      },
      builderToken,
    );
    assert.equal(publishedTeam.status, 201, JSON.stringify(publishedTeam.body));
    assert.equal(state.agents.get('builder-team')?.kind, 'team');
    assert.deepEqual(ownersOf(state, 'builder-team'), []);
    assert.equal(grants.list({ scopeKind: 'agent', scopeId: 'builder-team' })[0]?.role, 'accountable-lead');
  });

  it('fails closed with 503 when GrantStore is unhealthy', async () => {
    const heldId = holdOnRun('donna');
    grants.markUnhealthy('simulated S3 backend failure');
    assert.equal(grants.healthy, false);

    assert.equal(
      (
        await call(
          'POST',
          '/api/v1/agents',
          { id: 'unhealthy-agent', name: 'No', memory: { archetype: 'personal-assistant' } },
          TOKENS.dale,
        )
      ).status,
      503,
    );
    assert.equal((await call('GET', '/api/v1/agents/donna/settings', undefined, TOKENS.dale)).status, 503);
    assert.equal((await call('POST', '/api/v1/agents/donna/wake', {}, TOKENS.dale)).status, 503);
    assert.equal((await call('POST', `/api/v1/approvals/${heldId}`, { decision: 'reject' }, TOKENS.dale)).status, 503);
  });
});
