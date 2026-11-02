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
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import {
  canRunManageModels,
  checkOwnsAnyAgent,
  createFactoryServer,
  resolveRequesterActor,
  type FactoryState,
} from './app.js';
import { accessForRun } from './access-enforcement.js';
import { IdentityLinkStore } from './identity-links.js';
import { ownersOf } from './config-store.js';
import { requesterOfRun, scheduleRunOptions } from './schedules.js';
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
  ci: 'tok-svc-ci',
} as const;

const ACTORS: Record<string, { actor: string; roles: Array<'admin' | 'operator' | 'gatekeeper-ingress'> }> = {
  [TOKENS.admin]: { actor: 'user:admin', roles: [] },
  [TOKENS.op]: { actor: 'user:op', roles: [] },
  [TOKENS.dale]: { actor: 'user:dale', roles: [] },
  [TOKENS.alice]: { actor: 'user:alice', roles: [] },
  [TOKENS.sarah]: { actor: 'user:sarah', roles: [] },
  [TOKENS.geordi]: { actor: 'user:geordi', roles: [] },
  [TOKENS.stephanie]: { actor: 'user:stephanie', roles: [] },
  [TOKENS.bob]: { actor: 'user:bob', roles: [] },
  [TOKENS.ingress]: { actor: 'service:gatekeeper-ingress', roles: ['operator', 'gatekeeper-ingress'] },
  [TOKENS.ci]: { actor: 'service:ci', roles: ['admin'] },
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

    await groups.createGroup({ id: 'sre', name: 'SRE Team', roles: [], members: ['user:geordi'] });

    const identityLinks = new IdentityLinkStore(join(dir, 'links'));
    identityLinks.link('discord', 'dale-discord-1', 'user:dale', 'user:admin');
    identityLinks.link('discord', 'alice-discord-1', 'user:alice', 'user:admin');
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
      schedules: new ScheduleStore(),
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
        buildImage: async (agentId: string, source: { commit: string }) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId: string) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
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

  it('AC5/D15/D26/F1: GrantStore is authoritative over stale ConfigStore.owners across pending-revoked, transfer accept, grant revoke, and PUT /owners sync', async () => {
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
    // ConfigStore.owners still holds stale ['user:alice'], while authoritative ownersOf(state, 'alice-bot') is [] during pending-revoked!
    assert.deepEqual(state.configs!.current('alice-bot')?.owners, ['user:alice']);
    assert.deepEqual(ownersOf(state, 'alice-bot'), []);

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
    assert.deepEqual(ownersOf(state, 'alice-bot'), ['user:alice']);
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Restored active owner.' }, TOKENS.alice)).status,
      200,
    );
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/bundle', undefined, TOKENS.alice)).status, 200);
    assert.equal(
      (await call('POST', `/api/v1/approvals/${heldId}`, { decision: 'reject' }, TOKENS.alice)).status,
      200,
    );

    // F1: Accept ownership transfer (Alice -> Bob) WITHOUT touching ConfigStore.owners directly:
    // Alice (still in ConfigStore.owners!) must get 403 on reads & writes; Bob must get 200 and become ownersOf!
    const transfer2 = await grants.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'alice-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
      principals,
    });
    await grants.resolveOwnershipTransfer({ transferId: transfer2.transferId, action: 'accept', by: 'user:bob' });
    assert.deepEqual(state.configs!.current('alice-bot')?.owners, ['user:alice'], 'ConfigStore still holds stale Alice');
    assert.deepEqual(ownersOf(state, 'alice-bot'), ['user:bob'], 'GrantStore is authoritative for ownersOf');
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Stale Alice write' }, TOKENS.alice)).status,
      403,
    );
    assert.equal((await call('GET', '/api/v1/agents/alice-bot/settings', undefined, TOKENS.alice)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents/alice-bot/wake', {}, TOKENS.alice)).status, 403);
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'New owner Bob write.' }, TOKENS.bob)).status,
      200,
    );

    // F1: Revoking Bob's content-owner grant immediately removes Bob's write/read authority (403) and ownersOf -> []
    const bobOwnerGrant = grants
      .list({ scopeKind: 'agent', scopeId: 'alice-bot' })
      .find((g) => g.role === 'content-owner' && g.subject === 'user:bob')!;
    await grants.revoke(bobOwnerGrant.id, { by: 'user:admin' });
    assert.deepEqual(ownersOf(state, 'alice-bot'), []);
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Revoked Bob write' }, TOKENS.bob)).status,
      403,
    );

    // F1: Admin PUT /api/v1/agents/alice-bot/owners syncs BOTH GrantStore and ConfigStore.owners
    const putOwnerRes = await call('PUT', '/api/v1/agents/alice-bot/owners', { owners: ['user:alice'] }, TOKENS.admin);
    assert.equal(putOwnerRes.status, 200, JSON.stringify(putOwnerRes.body));
    assert.deepEqual(ownersOf(state, 'alice-bot'), ['user:alice']);
    assert.deepEqual(state.configs!.current('alice-bot')?.owners, ['user:alice']);
    assert.equal(
      (await call('PUT', '/api/v1/agents/alice-bot/settings', { soul: 'Alice restored via PUT /owners.' }, TOKENS.alice)).status,
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

    // 2. Configure skill routes + Family role ceiling on personal agent `donna`, and grant `subrole:Family` to `user:stephanie` (F5)
    const donnaRecord = state.agents.get('donna')!;
    donnaRecord.skillIds = ['calendar', 'bank'];
    donnaRecord.skillRoutes = { calendar: ['gcal'], bank: ['plaid'] };
    const roleSetting = await call(
      'PUT',
      '/api/v1/agents/donna/settings',
      {
        roles: [{ name: 'Family', skills: { calendar: { allow: ['*'], deny: [] } } }],
      },
      TOKENS.dale,
    );
    assert.equal(roleSetting.status, 200, JSON.stringify(roleSetting.body));

    await grants.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'donna' },
      role: 'subrole:Family',
      by: 'user:dale',
    });

    // Stephanie wakes and converses with donna (both direct and via Discord ingress)
    const stephWake = await call('POST', '/api/v1/agents/donna/wake', { input: { text: 'grocery list' } }, TOKENS.stephanie);
    assert.equal(stephWake.status, 202, JSON.stringify(stephWake.body));
    const stephDirectWakeRun = state.runs.get(stephWake.body.runId)!;
    assert.equal(stephDirectWakeRun.caller?.actor, 'user:stephanie');
    assert.deepEqual(stephDirectWakeRun.caller?.agentRoles, ['Family'], 'direct /wake populates caller with stripped subrole:');
    assert.deepEqual(
      accessForRun(state, stephDirectWakeRun, donnaRecord),
      { restricted: true, routes: { gcal: 'allowed', plaid: 'denied' } },
      'F1: direct Console/API /wake by restricted subrole principal enforces E12 route ceiling',
    );
    state.runs.update(stephDirectWakeRun.runId, { state: 'DONE' } as never);

    const stephConvo = await call(
      'POST',
      '/api/v1/agents/donna/conversation',
      { message: 'add milk' },
      TOKENS.stephanie,
    );
    assert.equal(stephConvo.status, 202, JSON.stringify(stephConvo.body));
    const stephDirectConvoRun = state.runs.get(stephConvo.body.runId)!;
    assert.deepEqual(accessForRun(state, stephDirectConvoRun, donnaRecord), {
      restricted: true,
      routes: { gcal: 'allowed', plaid: 'denied' },
    });
    state.runs.update(stephDirectConvoRun.runId, { state: 'DONE' } as never);

    // F1: Warm-run isolation (`409 busy_with_another_person`) when Dale (owner) has a live WORKING run on donna
    // and Stephanie (restricted subrole:Family) sends a direct Console/API `/conversation` without requestedBy!
    for (const r of state.runs.list({ agentId: 'donna', active: true })) {
      state.runs.update(r.runId, { state: 'DONE' } as never);
    }
    const daleWarmRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'user:dale',
      trigger: 'conversation',
    });
    const stephIntoDaleWarm = await call(
      'POST',
      '/api/v1/agents/donna/conversation',
      { message: 'read plaid inside dale run' },
      TOKENS.stephanie,
    );
    assert.equal(stephIntoDaleWarm.status, 409, JSON.stringify(stephIntoDaleWarm.body));
    assert.equal(stephIntoDaleWarm.body.error, 'busy_with_another_person');
    state.runs.update(daleWarmRun.runId, { state: 'DONE' } as never);

    // F1: Approval decision delivery preserves principal origin (`user:stephanie`) when Stephanie's direct run finishes
    // and owner Dale rejects with notes — spawned `approval` run stays Stephanie's and restricted (`plaid: 'denied'`)!
    const stephOriginRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'user:stephanie',
      trigger: 'manual',
      caller: stephDirectWakeRun.caller,
    });
    const { approval: stephOriginHold } = state.approvals.hold({
      runId: stephOriginRun.runId,
      agentId: 'donna',
      route: 'plaid',
      tool: 'POST /accounts/transfer',
      argsSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      request: { method: 'POST', path: '/accounts/transfer', headers: {}, body: '{}', bodyEncoding: 'utf8' },
    });
    state.runs.update(stephOriginRun.runId, { state: 'DONE' } as never);
    const daleRejectsDirectOrigin = await call(
      'POST',
      `/api/v1/approvals/${stephOriginHold.approvalId}`,
      { decision: 'reject', notes: 'family role cannot use bank' },
      TOKENS.dale,
    );
    assert.equal(daleRejectsDirectOrigin.status, 200, JSON.stringify(daleRejectsDirectOrigin.body));
    assert.equal(daleRejectsDirectOrigin.body.delivered, 'run');
    const approvalSpawnedRun = state.runs
      .list({ agentId: 'donna' })
      .filter((r) => r.trigger === 'approval')
      .pop()!;
    assert.equal(approvalSpawnedRun.actor, 'user:stephanie', 'decision run preserves principal requester actor');
    assert.equal((approvalSpawnedRun.input as { notes?: string }).notes, 'family role cannot use bank');
    assert.deepEqual(accessForRun(state, approvalSpawnedRun, donnaRecord), {
      restricted: true,
      routes: { gcal: 'allowed', plaid: 'denied' },
    });
    state.runs.update(approvalSpawnedRun.runId, { state: 'DONE' } as never);

    const stephIngressWake = await call(
      'POST',
      '/api/v1/agents/donna/wake',
      { requestedBy: { provider: 'discord', id: 'steph-discord-1' }, input: { text: 'hi donna' } },
      TOKENS.ingress,
    );
    assert.equal(stephIngressWake.status, 202, JSON.stringify(stephIngressWake.body));
    const stephRun = state.runs.get(stephIngressWake.body.runId)!;
    assert.deepEqual(stephRun.caller?.agentRoles, ['Family'], 'authorizeIngress strips subrole: prefix');

    // F5: accessForRun enforces GrantStore subrole:Family ceiling on donna (gcal allowed, plaid denied),
    // while active personal content-owner (Alice on alice-bot), team accountable-lead (Sarah), and team member (Geordi) are NOT_RESTRICTED
    assert.deepEqual(accessForRun(state, stephRun, donnaRecord), {
      restricted: true,
      routes: { gcal: 'allowed', plaid: 'denied' },
    });
    const geordiDirectWakeRun = state.runs.get(geordiWake.body.runId)!;
    const triageRecord = state.agents.get('incident-triage')!;
    triageRecord.skillIds = ['pagerduty'];
    triageRecord.skillRoutes = { pagerduty: ['pd-api'] };
    assert.deepEqual(accessForRun(state, geordiDirectWakeRun, triageRecord), { restricted: false });

    const aliceBotRecord = state.agents.get('alice-bot')!;
    aliceBotRecord.skillIds = ['calendar'];
    aliceBotRecord.skillRoutes = { calendar: ['gcal'] };
    const aliceRun = state.runs.create({
      agentId: 'alice-bot',
      state: 'WORKING',
      actor: 'service:gatekeeper-ingress',
      trigger: 'manual',
      requestedBy: { provider: 'discord', id: 'alice-discord-1' },
    });
    assert.deepEqual(accessForRun(state, aliceRun, aliceBotRecord), { restricted: false });

    const geordiIngressRun = state.runs.get(geordiIngressWake.body.runId)!;
    assert.deepEqual(accessForRun(state, geordiIngressRun, triageRecord), { restricted: false });
    const sarahRun = state.runs.create({
      agentId: 'incident-triage',
      state: 'WORKING',
      actor: 'service:gatekeeper-ingress',
      trigger: 'manual',
      requestedBy: { provider: 'discord', id: 'sarah-discord-1' },
    });
    assert.deepEqual(accessForRun(state, sarahRun, triageRecord), { restricted: false });

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

  it('F2: failed agent creation rollback never revokes pre-existing admin grants on that scopeId', async () => {
    // Admin pre-grants content-owner (user:alice) and agent-member (user:stephanie) before `pregranted-bot` is created
    const preOwner = await grants.grant({
      subject: 'user:alice',
      scope: { kind: 'agent', id: 'pregranted-bot' },
      role: 'content-owner',
      agentKind: 'personal',
      by: 'user:admin',
      granterIsAdmin: true,
    });
    const preMember = await grants.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'pregranted-bot' },
      role: 'agent-member',
      agentKind: 'personal',
      by: 'user:admin',
      granterIsAdmin: true,
    });

    // Unrelated operator user:op attempts to squat `pregranted-bot` -> 409 owner_exists
    const squatAttempt1 = await call(
      'POST',
      '/api/v1/agents',
      { id: 'pregranted-bot', name: 'Squat', memory: { archetype: 'personal-assistant' } },
      TOKENS.op,
    );
    assert.equal(squatAttempt1.status, 409);
    assert.equal(squatAttempt1.body.error, 'owner_exists');
    assert.equal(state.agents.has('pregranted-bot'), false);

    // Pre-existing admin grants MUST still be intact; a second squat attempt MUST also get 409!
    const remaining = grants.list({ scopeKind: 'agent', scopeId: 'pregranted-bot' });
    assert.equal(remaining.length, 2);
    assert.equal(remaining.some((g) => g.id === preOwner.id && g.state === 'active'), true);
    assert.equal(remaining.some((g) => g.id === preMember.id && g.state === 'active'), true);

    const squatAttempt2 = await call(
      'POST',
      '/api/v1/agents',
      { id: 'pregranted-bot', name: 'Squat Again', memory: { archetype: 'personal-assistant' } },
      TOKENS.op,
    );
    assert.equal(squatAttempt2.status, 409);
    assert.equal(squatAttempt2.body.error, 'owner_exists');

    // Admin creating `pregranted-bot` on behalf of `user:alice` succeeds idempotently (201) keeping both pre-grants
    const legitimateCreate = await call(
      'POST',
      '/api/v1/agents',
      { id: 'pregranted-bot', name: 'Pregranted Bot', actAs: 'user:alice', memory: { archetype: 'personal-assistant' } },
      TOKENS.admin,
    );
    assert.equal(legitimateCreate.status, 201, JSON.stringify(legitimateCreate.body));
    assert.deepEqual(ownersOf(state, 'pregranted-bot'), ['user:alice']);
    assert.equal(grants.list({ scopeKind: 'agent', scopeId: 'pregranted-bot' }).length, 2);
  });

  it('F3/F4: repository re-registration preserves kind & owner/lead across admin and CI callers, rejects kind flips with 409, and enforces mixed-case agentKindLookup', async () => {
    const NEXT_SHA = '8'.repeat(40);

    // 1. Register a personal repo agent owned by user:dale (submitted by admin via actAs)
    const repoPersonal1 = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-dale-repo-pa',
        commit: SHA,
        actAs: 'user:dale',
        cartridge: { id: 'dale-repo-pa', name: 'Dale Repo PA', kind: 'personal', memory: { archetype: 'personal-assistant' } },
      },
      TOKENS.admin,
    );
    assert.equal(repoPersonal1.status, 201, JSON.stringify(repoPersonal1.body));
    assert.equal(repoPersonal1.body.kind, 'personal');
    assert.deepEqual(ownersOf(state, 'dale-repo-pa'), ['user:dale']);

    // Re-registering new commit by admin AND by CI service key (`service:ci`) succeeds 201 and keeps user:dale as sole content-owner!
    const repoPersonalAdminReReg = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-dale-repo-pa',
        commit: NEXT_SHA,
        cartridge: { id: 'dale-repo-pa', name: 'Dale Repo PA v2', kind: 'personal', memory: { archetype: 'personal-assistant' } },
      },
      TOKENS.admin,
    );
    assert.equal(repoPersonalAdminReReg.status, 201, JSON.stringify(repoPersonalAdminReReg.body));
    assert.deepEqual(ownersOf(state, 'dale-repo-pa'), ['user:dale']);

    const repoPersonalCiReReg = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-dale-repo-pa',
        commit: SHA,
        cartridge: { id: 'dale-repo-pa', name: 'Dale Repo PA v3', kind: 'personal', memory: { archetype: 'personal-assistant' } },
      },
      TOKENS.ci,
    );
    assert.equal(repoPersonalCiReReg.status, 201, JSON.stringify(repoPersonalCiReReg.body));
    assert.deepEqual(ownersOf(state, 'dale-repo-pa'), ['user:dale']);

    // 2. Re-registering existing team repo agent `ops-watch` with `cartridge.kind: 'team'` (and NO accountableLead in payload)
    // or with omitted `kind` succeeds 201 for both admin and CI service key, preserving `kind: 'team'` and `user:sarah`!
    const repoTeamCiReReg1 = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: NEXT_SHA,
        cartridge: { id: 'ops-watch', name: 'Ops Watch v2', kind: 'team', memory: { archetype: 'team-member' } },
      },
      TOKENS.ci,
    );
    assert.equal(repoTeamCiReReg1.status, 201, JSON.stringify(repoTeamCiReReg1.body));
    assert.equal(repoTeamCiReReg1.body.kind, 'team');
    assert.equal(repoTeamCiReReg1.body.accountableLead, 'user:sarah');

    const repoTeamCiReReg2 = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: SHA,
        cartridge: { id: 'ops-watch', name: 'Ops Watch v3', memory: { archetype: 'team-member' } },
      },
      TOKENS.ci,
    );
    assert.equal(repoTeamCiReReg2.status, 201, JSON.stringify(repoTeamCiReReg2.body));
    assert.equal(repoTeamCiReReg2.body.kind, 'team');
    assert.equal(repoTeamCiReReg2.body.accountableLead, 'user:sarah');
    assert.equal(
      grants.list({ scopeKind: 'agent', scopeId: 'ops-watch' }).filter((g) => g.role === 'content-owner').length,
      0,
    );

    // Rotate `ops-watch` accountable-lead in GrantStore from user:sarah to user:bob, then re-register via CI & admin
    // with stale checked-in `cartridge.accountableLead: 'user:sarah'` inside `body.cartridge` -> rotated lead `user:bob` is preserved & synced!
    await grants.grant({
      subject: 'user:bob',
      scope: { kind: 'agent', id: 'ops-watch' },
      role: 'accountable-lead',
      agentKind: 'team',
      by: 'user:admin',
      granterIsAdmin: true,
      replaceExisting: true,
    });
    const repoTeamCiAfterRotate = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: NEXT_SHA,
        cartridge: {
          id: 'ops-watch',
          name: 'Ops Watch v4',
          kind: 'team',
          accountableLead: 'user:sarah',
          memory: { archetype: 'team-member' },
        },
      },
      TOKENS.ci,
    );
    assert.equal(repoTeamCiAfterRotate.status, 201, JSON.stringify(repoTeamCiAfterRotate.body));
    assert.equal(repoTeamCiAfterRotate.body.accountableLead, 'user:bob', 'F3: non-mutating re-registration syncs rotated accountable-lead from GrantStore');
    const activeOpsLeadsAfterCi = grants
      .list({ scopeKind: 'agent', scopeId: 'ops-watch' })
      .filter((g) => g.role === 'accountable-lead' && g.state === 'active');
    assert.equal(activeOpsLeadsAfterCi.length, 1);
    assert.equal(activeOpsLeadsAfterCi[0].subject, 'user:bob');

    const repoTeamAdminAfterRotate = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: SHA,
        cartridge: {
          id: 'ops-watch',
          name: 'Ops Watch v5',
          kind: 'team',
          accountableLead: 'user:sarah',
          memory: { archetype: 'team-member' },
        },
      },
      TOKENS.admin,
    );
    assert.equal(repoTeamAdminAfterRotate.status, 201, JSON.stringify(repoTeamAdminAfterRotate.body));
    assert.equal(repoTeamAdminAfterRotate.body.accountableLead, 'user:bob');

    // Explicit top-level `body.accountableLead` by admin DOES rotate the GrantStore lead intentionally
    const explicitTopLevelLead = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: NEXT_SHA,
        accountableLead: 'user:sarah',
        cartridge: { id: 'ops-watch', name: 'Ops Watch v6', kind: 'team', memory: { archetype: 'team-member' } },
      },
      TOKENS.admin,
    );
    assert.equal(explicitTopLevelLead.status, 201, JSON.stringify(explicitTopLevelLead.body));
    assert.equal(explicitTopLevelLead.body.accountableLead, 'user:sarah');

    // Attempting to flip kind on re-registration (`team` -> `personal` or `personal` -> `team`) returns 409 agent_kind_conflict
    const flipTeamToPersonal = await call(
      'POST',
      '/api/v1/registry/agents',
      {
        repo: 'https://github.com/BeerCanLabs/SM-ops-watch',
        commit: NEXT_SHA,
        kind: 'personal',
        cartridge: { id: 'ops-watch', name: 'Ops Watch Bad', memory: { archetype: 'personal-assistant' } },
      },
      TOKENS.admin,
    );
    assert.equal(flipTeamToPersonal.status, 409);
    assert.equal(flipTeamToPersonal.body.error, 'agent_kind_conflict');

    // 3. F4: Mixed-case agent ID registered as `kind: 'team'` rejects lowercase grant with `agentKind: 'personal'` (409)
    const mixedCaseTeam = await call(
      'POST',
      '/api/v1/agents',
      {
        id: 'MixedCaseTeam',
        name: 'Mixed Case Team',
        kind: 'team',
        accountableLead: 'user:sarah',
        memory: { archetype: 'team-member' },
      },
      TOKENS.admin,
    );
    assert.equal(mixedCaseTeam.status, 201, JSON.stringify(mixedCaseTeam.body));
    await assert.rejects(
      () =>
        grants.grant({
          subject: 'user:bob',
          scope: { kind: 'agent', id: 'mixedcaseteam' },
          role: 'content-owner',
          agentKind: 'personal',
          by: 'user:admin',
          granterIsAdmin: true,
        }),
      (err: unknown) => err instanceof GrantStoreError && err.status === 409 && err.code === 'agent_kind_conflict',
    );
  });

  it('F2/F4: requesterOfRun recognizes canonical user:/service: principals across run-scoped models, role-requests, and schedules; checkOwnsAnyAgent treats GrantStore as sole source of truth', async () => {
    // F4: checkOwnsAnyAgent returns true for active GrantStore owner/lead and false when GrantStore has no active grant,
    // even if stale legacy `agent.owners` or ConfigStore owners exist.
    assert.equal(checkOwnsAnyAgent(state, 'user:dale'), true);
    assert.equal(checkOwnsAnyAgent(state, 'user:sarah'), true);
    const donnaRec = state.agents.get('donna') as unknown as { owners?: string[] };
    donnaRec.owners = ['user:bob'];
    try {
      assert.equal(checkOwnsAnyAgent(state, 'user:bob'), false, 'F4: GrantStore is authoritative in checkOwnsAnyAgent');
    } finally {
      delete donnaRec.owners;
    }

    // F2: Direct Console/API runs started by canonical `user:<id>` and `service:<id>` principals resolve via `requesterOfRun`
    const daleDirectRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'user:dale',
      trigger: 'manual',
    });
    const sarahDirectRun = state.runs.create({
      agentId: 'incident-triage',
      state: 'WORKING',
      actor: 'user:sarah',
      trigger: 'manual',
    });
    const stephDirectRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'user:stephanie',
      trigger: 'manual',
    });
    const ciDirectRun = state.runs.create({
      agentId: 'ops-watch',
      state: 'WORKING',
      actor: 'service:ci',
      trigger: 'api',
    });

    assert.deepEqual(requesterOfRun(state, daleDirectRun), { kind: 'principal', actor: 'user:dale' });
    assert.deepEqual(requesterOfRun(state, sarahDirectRun), { kind: 'principal', actor: 'user:sarah' });
    assert.deepEqual(requesterOfRun(state, stephDirectRun), { kind: 'principal', actor: 'user:stephanie' });
    assert.deepEqual(requesterOfRun(state, ciDirectRun), { kind: 'principal', actor: 'service:ci' });

    assert.equal(resolveRequesterActor(state, daleDirectRun), 'user:dale');
    assert.equal(resolveRequesterActor(state, sarahDirectRun), 'user:sarah');
    assert.deepEqual(canRunManageModels(state, daleDirectRun), { allowed: true, actor: 'user:dale' });
    assert.deepEqual(canRunManageModels(state, sarahDirectRun), { allowed: true, actor: 'user:sarah' });
    assert.deepEqual(canRunManageModels(state, stephDirectRun), { allowed: false });

    const daleRunTok = await state.runTokens!.mint({ runId: daleDirectRun.runId, agentId: 'donna' });
    const stephRunTok = await state.runTokens!.mint({ runId: stephDirectRun.runId, agentId: 'donna' });

    // 1. Run-token model switch (`PUT /api/v1/runs/:id/models`): allowed for user:dale (200), refused for user:stephanie (403)
    const daleSetModels = await call(
      'PUT',
      `/api/v1/runs/${daleDirectRun.runId}/models`,
      { currentModel: 'claude-sonnet' },
      daleRunTok,
    );
    assert.equal(daleSetModels.status, 200, JSON.stringify(daleSetModels.body));

    const stephSetModels = await call(
      'PUT',
      `/api/v1/runs/${stephDirectRun.runId}/models`,
      { currentModel: 'gemini-2.0-flash' },
      stephRunTok,
    );
    assert.equal(stephSetModels.status, 403, JSON.stringify(stephSetModels.body));

    // 2. Run-token role-assignment request (`POST /api/v1/runs/:id/role-requests`): allowed for user:dale (202), refused for user:stephanie (403)
    const daleRoleReq = await call(
      'POST',
      `/api/v1/runs/${daleDirectRun.runId}/role-requests`,
      { provider: 'discord', identity: 'alice-discord-1', roles: ['Family'] },
      daleRunTok,
    );
    assert.equal(daleRoleReq.status, 202, JSON.stringify(daleRoleReq.body));

    const stephRoleReq = await call(
      'POST',
      `/api/v1/runs/${stephDirectRun.runId}/role-requests`,
      { provider: 'discord', identity: 'alice-discord-1', roles: ['Family'] },
      stephRunTok,
    );
    assert.equal(stephRoleReq.status, 403, JSON.stringify(stephRoleReq.body));
    assert.equal(stephRoleReq.body.error, 'requester_not_owner');

    // 3. Run-token schedule creation (`POST /api/v1/schedules`): records `requestedBy: { kind: 'principal', actor: 'user:stephanie' }`
    // and firing it carries Stephanie's restricted `subrole:Family` reach (`gcal` allowed, `plaid` denied)!
    const stephSchedCreate = await call(
      'POST',
      '/api/v1/schedules',
      { name: 'Morning Calendar', cron: '0 8 * * *', prompt: 'Check calendar' },
      stephRunTok,
    );
    assert.equal(stephSchedCreate.status, 200, JSON.stringify(stephSchedCreate.body));
    const createdSched = state.schedules!.get(stephSchedCreate.body.schedule.id)!;
    assert.deepEqual(createdSched.requestedBy, { kind: 'principal', actor: 'user:stephanie' });

    const schedOpts = scheduleRunOptions(state, createdSched);
    assert.ok(schedOpts, 'scheduleRunOptions resolves GrantStore wake authority for user:stephanie');
    assert.equal(schedOpts.caller.actor, 'user:stephanie');
    assert.deepEqual(schedOpts.caller.agentRoles, ['Family']);

    const firedSchedRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'factory:timekeeper',
      trigger: 'schedule',
      input: { scheduleId: createdSched.id },
      caller: schedOpts.caller,
    });
    assert.deepEqual(accessForRun(state, firedSchedRun, state.agents.get('donna')!), {
      restricted: true,
      routes: { gcal: 'allowed', plaid: 'denied' },
    });

    for (const r of [daleDirectRun, sarahDirectRun, stephDirectRun, ciDirectRun, firedSchedRun]) {
      state.runs.update(r.runId, { state: 'DONE' } as never);
    }
  });

  it('fails closed with 503 (and denied skill routes) when GrantStore is unhealthy (including F6 agent-builder)', async () => {
    const heldId = holdOnRun('donna');
    const builderRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'user:op',
      caller: { actor: 'user:op', role: 'operator', roles: ['operator'] },
      trigger: 'api',
    });
    const builderToken = await state.runTokens!.mint({ runId: builderRun.runId, agentId: 'agent-builder' });
    const stephRun = state.runs.create({
      agentId: 'donna',
      state: 'WORKING',
      actor: 'service:gatekeeper-ingress',
      trigger: 'manual',
      requestedBy: { provider: 'discord', id: 'steph-discord-1' },
    });

    grants.markUnhealthy('simulated S3 backend failure');
    assert.equal(grants.healthy, false);
    assert.deepEqual(ownersOf(state, 'donna'), []);
    assert.equal(checkOwnsAnyAgent(state, 'user:dale'), false, 'F4: checkOwnsAnyAgent fails closed when GrantStore is unhealthy');

    // F5: accessForRun fails closed (all routes denied) when GrantStore is unhealthy
    assert.deepEqual(accessForRun(state, stephRun, state.agents.get('donna')!), {
      restricted: true,
      routes: { gcal: 'denied', plaid: 'denied' },
    });

    // F6: agent-builder fails closed with 503 grant_store_unhealthy even when run.caller cached legacy roles
    const unhealthyBuilderCatalog = await call(
      'POST',
      `/api/v1/runs/${builderRun.runId}/builder`,
      { op: 'catalog' },
      builderToken,
    );
    assert.equal(unhealthyBuilderCatalog.status, 503);
    assert.equal(unhealthyBuilderCatalog.body.error, 'grant_store_unhealthy');

    const unhealthyBuilderValidate = await call(
      'POST',
      `/api/v1/runs/${builderRun.runId}/builder`,
      { op: 'validate', spec: { id: 'no-publish', memory: { archetype: 'personal-assistant' } } },
      builderToken,
    );
    assert.equal(unhealthyBuilderValidate.status, 503);
    assert.equal(unhealthyBuilderValidate.body.error, 'grant_store_unhealthy');

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
