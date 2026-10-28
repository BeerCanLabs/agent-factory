// TSK-282 (DESIGN_AUTHORITY.md §6.8 L2, §6.17 CL2, §6.18 CF6, §6.3.1 E7; decision 4):
// Headless agent-builder house staff agent and run-scoped builder route POST /api/v1/runs/:id/builder.
// Only callable by run.agentId === 'agent-builder'.
// Requires verified human caller holding agents.create (operators and admins, decision 7).
// Supports catalog, validate, and publish ops; publish creates config agent in PENDING_BUDGET with creator as owner.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime, type Run } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { loadSkills, skillRegistry } from './skills.js';

const ADMIN = 'admin-builder-token';
const OPERATOR = 'operator-builder-token';
const VIEWER = 'viewer-builder-token';

const SHA = '6'.repeat(40);
const RUNTIME_SHA = 'd'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:test';
const KEY = 'agent-builder-run-token-key-0123456789abc';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('Headless agent-builder house staff agent (TSK-282, GAP-208, L2, CL2, CF6, E7)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);

  const callBuilder = async (runId: string, token: string | undefined, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${runId}/builder`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-builder-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      defaultModel: 'gemini-2.0-flash',
      deployProvider: {
        buildImage: async () => { throw new Error('not called in builder test'); },
        provisionIdentity: async () => ({ identity: 'id', executionIdentity: 'exec' }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));

    // Register approved skill fixture
    skillRegistry(state).save({
      id: 'discord-progress',
      version: '1.0.0',
      manifest: {
        id: 'discord-progress',
        version: '1.0.0',
        name: 'Discord progress',
        description: 'Status updates',
        language: 'python',
        entry: 'progress',
        requires: { routes: ['models'] },
        smoke: { action: 'progress', input: {} },
      },
      status: 'approved',
      tests: 'passed',
      published: true,
    });

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses calls without a run token (401) or from another agent than agent-builder (403)', async () => {
    // 1. Without token -> 401
    const unauth = await callBuilder('run-1', undefined, { op: 'catalog' });
    assert.equal(unauth.status, 401);

    // 2. Run token for echo-agent (not agent-builder) -> 403 forbidden
    const echoRun = state.runs.create({
      agentId: 'echo-agent',
      state: 'WORKING',
      actor: 'token:operator',
      trigger: 'manual',
    } as never);
    const echoToken = await tokens.mint({ runId: echoRun.runId, agentId: 'echo-agent' });
    const echoRes = await callBuilder(echoRun.runId, echoToken, { op: 'catalog' });
    assert.equal(echoRes.status, 403);
    assert.equal(echoRes.body.error, 'forbidden');
  });

  it('refuses builder calls when triggered by cron, smoke, or webhook or with SYSTEM actor (403 builder_caller_required)', async () => {
    // Cron trigger
    const cronRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:operator',
      trigger: 'cron',
    } as never);
    const cronToken = await tokens.mint({ runId: cronRun.runId, agentId: 'agent-builder' });
    const cronRes = await callBuilder(cronRun.runId, cronToken, { op: 'catalog' });
    assert.equal(cronRes.status, 403);
    assert.equal(cronRes.body.error, 'builder_caller_required');

    // Smoke trigger
    const smokeRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:operator',
      trigger: 'smoke',
    } as never);
    const smokeToken = await tokens.mint({ runId: smokeRun.runId, agentId: 'agent-builder' });
    const smokeRes = await callBuilder(smokeRun.runId, smokeToken, { op: 'catalog' });
    assert.equal(smokeRes.status, 403);
    assert.equal(smokeRes.body.error, 'builder_caller_required');

    // System actor
    const sysRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'SYSTEM',
      trigger: 'api',
    } as never);
    const sysToken = await tokens.mint({ runId: sysRun.runId, agentId: 'agent-builder' });
    const sysRes = await callBuilder(sysRun.runId, sysToken, { op: 'catalog' });
    assert.equal(sysRes.status, 403);
    assert.equal(sysRes.body.error, 'builder_caller_required');
  });

  it('refuses builder calls when human caller holds only viewer role (403 forbidden)', async () => {
    const viewerRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:viewer',
      caller: { actor: 'token:viewer', roles: ['viewer'], provider: 'token' },
      trigger: 'api',
    } as never);
    const viewerToken = await tokens.mint({ runId: viewerRun.runId, agentId: 'agent-builder' });
    const res = await callBuilder(viewerRun.runId, viewerToken, { op: 'catalog' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
    assert.equal(res.body.reason, 'agents.create required');
  });

  it('serves catalog operation when caller holds operator or admin role', async () => {
    const opRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:operator',
      caller: { actor: 'token:operator', roles: ['operator'], provider: 'token' },
      trigger: 'api',
    } as never);
    const opToken = await tokens.mint({ runId: opRun.runId, agentId: 'agent-builder' });
    const res = await callBuilder(opRun.runId, opToken, { op: 'catalog' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.archetypes, ['purpose-built', 'personal-assistant', 'team-member']);
    assert.ok(Array.isArray(res.body.skills));
    assert.ok(res.body.skills.some((s: any) => s.id === 'discord-progress'));
    assert.ok(Array.isArray(res.body.models));
    assert.equal(res.body.defaultModel, 'gemini-2.0-flash');
  });

  it('validates candidate specifications without mutating factory state (dry run)', async () => {
    const opRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:operator',
      caller: { actor: 'token:operator', roles: ['operator'], provider: 'token' },
      trigger: 'api',
    } as never);
    const opToken = await tokens.mint({ runId: opRun.runId, agentId: 'agent-builder' });

    // 1. Missing or invalid ID
    const badId = await callBuilder(opRun.runId, opToken, {
      op: 'validate',
      spec: { id: '__internal', memory: { archetype: 'personal-assistant' } },
    });
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error, 'invalid_id');

    // 2. Missing archetype
    const badArch = await callBuilder(opRun.runId, opToken, {
      op: 'validate',
      spec: { id: 'builder-test-1', memory: {} },
    });
    assert.equal(badArch.status, 422);
    assert.equal(badArch.body.error, 'archetype_required');

    // 3. Unapproved skill
    const badSkill = await callBuilder(opRun.runId, opToken, {
      op: 'validate',
      spec: {
        id: 'builder-test-1',
        memory: { archetype: 'purpose-built' },
        skills: [{ id: 'nonexistent-skill', version: '1.0.0' }],
      },
    });
    assert.equal(badSkill.status, 422);
    assert.equal(badSkill.body.error, 'unknown_skill');

    // 4. Role naming a skill not in candidate adopted skills
    const badRole = await callBuilder(opRun.runId, opToken, {
      op: 'validate',
      spec: {
        id: 'builder-test-1',
        memory: { archetype: 'purpose-built' },
        roles: [{ name: 'Operator', skills: { 'some-skill': { allow: ['*'] } } }],
        skills: [{ id: 'discord-progress', version: '1.0.0' }],
      },
    });
    assert.equal(badRole.status, 422);
    assert.equal(badRole.body.error, 'unknown_skill');

    // 5. Valid spec -> passes
    const valid = await callBuilder(opRun.runId, opToken, {
      op: 'validate',
      spec: {
        id: 'builder-test-1',
        name: 'Builder Test One',
        soul: 'You are a test agent.',
        memory: { archetype: 'personal-assistant' },
        skills: [{ id: 'discord-progress', version: '1.0.0' }],
        roles: [{ name: 'Family', skills: { 'discord-progress': { allow: ['*'] } } }],
      },
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.ok, true);
    assert.equal(valid.body.valid, true);

    // Verify dry run did not create agent
    assert.equal(state.agents.has('builder-test-1'), false);
    assert.equal(state.configs!.current('builder-test-1'), undefined);
  });

  it('publishes a configuration agent, requesting skill adoptions, in PENDING_BUDGET, ledgering AGENT_BUILT_BY_BUILDER', async () => {
    const adminRun = state.runs.create({
      agentId: 'agent-builder',
      state: 'WORKING',
      actor: 'token:admin',
      caller: { actor: 'token:admin', roles: ['admin'], provider: 'token' },
      trigger: 'api',
    } as never);
    const adminToken = await tokens.mint({ runId: adminRun.runId, agentId: 'agent-builder' });

    const spec = {
      id: 'published-agent',
      name: 'Published Agent',
      soul: 'You are published by agent-builder.',
      memory: { archetype: 'purpose-built' },
      skills: [{ id: 'discord-progress', version: '1.0.0' }],
      roles: [{ name: 'Staff', skills: { 'discord-progress': { allow: ['*'] } } }],
    };

    const pubRes = await callBuilder(adminRun.runId, adminToken, {
      op: 'publish',
      spec,
    });
    assert.equal(pubRes.status, 201, JSON.stringify(pubRes.body));
    assert.equal(pubRes.body.ok, true);
    assert.equal(pubRes.body.agent.id, 'published-agent');

    // 1. Agent created and stored in PENDING_BUDGET
    const agent = state.agents.get('published-agent')!;
    assert.ok(agent);
    assert.equal(agent.createdFrom, 'configuration');
    assert.equal(agent.state, 'PENDING_BUDGET');
    assert.equal(state.policies.has('published-agent'), false);

    // 2. Creator becomes owner
    const cfg = state.configs!.current('published-agent')!;
    assert.ok(cfg);
    assert.deepEqual(cfg.owners, ['token:admin']);

    // 3. Skills adoption requested
    assert.ok(pubRes.body.skills.some((s: any) => s.id === 'discord-progress' && s.state === 'requested'));

    // 4. Ledger record AGENT_BUILT_BY_BUILDER
    const rows = ledger.query({ agentId: 'published-agent' });
    const builtRow = rows.find((r) => r.action === 'AGENT_BUILT_BY_BUILDER');
    assert.ok(builtRow, 'ledger must contain AGENT_BUILT_BY_BUILDER');
    assert.equal(builtRow?.actor, 'token:admin');
    assert.equal(builtRow?.requestId, adminRun.runId);
  });
});
