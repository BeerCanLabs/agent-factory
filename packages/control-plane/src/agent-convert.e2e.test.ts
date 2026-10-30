// TSK-283 (DESIGN_AUTHORITY.md §6.18 CF6, CF1, CF4, §6.8 L4, GAP-209, GAP-116; decisions 5, 8):
// Convert repository agent in place to configuration agent and AM1 runtime shim gate.
// Elevated per CF4: POST /api/v1/agents/:id/convert (agents.settings.set; admin or agent-owner).
// Pre-checks: refusing built-in or already-configured agents, policy and shared runtime requirements.
// Reach coverage: target skills must cover repository declared routes unless dropUncoveredRoutes is true.
// In-place conversion execution: activation smoke gate; failure restores repository agent on previous image.
// Preserves: id, ledger history, owners, policy, memoryPrefix, channel links, schedules.
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
import {
  VersionedConfigStore,
  FileConfigBackend,
  registryOf,
  saveSharedRuntime,
  type DeployProvider,
  type AgentRecord,
} from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdentityLinkStore } from './identity-links.js';
import { loadSkills, skillRegistry } from './skills.js';
import { configOf } from './config-store.js';

const ADMIN = 'admin-token-convert-e2e';
const OPERATOR = 'operator-token-convert-e2e';
const VIEWER = 'viewer-token-convert-e2e';

const COMMIT_RUNTIME = '1'.repeat(40);
const REPO_COMMIT = '9'.repeat(40);

const DIGEST_RUNTIME = 'a'.repeat(64);
const IMAGE_RUNTIME = `ghcr.io/beercanlabs/agent-runtime@sha256:${DIGEST_RUNTIME}`;

const KEY = 'convert-agent-run-token-key-0123456789abc';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('Convert repository agent in place (TSK-283, CF6, L4, AM1, GAP-209)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);
  const computeRegistered: Array<{ agentId: string; imageUri: string }> = [];

  const call = async (path: string, method = 'GET', token: string = ADMIN, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-agent-convert-'));
    ledger = new MemoryLedger();

    const provider: DeployProvider = {
      async buildImage(agentId, source, skills) {
        return `repo-image:${agentId}:${source.commit}`;
      },
      async buildSkillsImage(agentId, runtime, skills) {
        return `layered-image:${agentId}:${runtime.commit}:${skills.map((s) => s.id).join('-')}`;
      },
      async provisionIdentity() {
        return { identity: 'task-role', executionIdentity: 'exec-role' };
      },
      async registerCompute(agentId, imageUri) {
        computeRegistered.push({ agentId, imageUri });
      },
    };

    const sharedRuntime = {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_RUNTIME,
      image: IMAGE_RUNTIME,
    };

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
      resolveCommit: async () => REPO_COMMIT,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      schedules: new ScheduleStore(join(dir, 'schedules')),
      sharedRuntime,
      deployProvider: provider,
      newAgentsFromConfigurationOnly: true,
      repositoryAgentIds: new Set(['skippy-like', 'repo-stay']),
    } as unknown as FactoryState;

    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    saveSharedRuntime(state.registryDir, sharedRuntime);

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. Reach Coverage Check (422 uncovered_routes) prevents dropping routes without dropUncoveredRoutes', async () => {
    // Register repository agent skippy-like declaring egress route 'knowledge'
    const skippyAgent: AgentRecord = {
      id: 'skippy-like',
      name: 'Skippy',
      role: 'Assistant',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'repo-image:skippy-like:v1',
      repo: 'https://github.com/BeerCanLabs/SM-skippy',
      commit: REPO_COMMIT,
      deployedCommit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'skippy-like',
      dir: '/tmp/skippy-like',
      egress: { routes: ['knowledge'], hosts: [] },
      skillRoutes: { retrieval: ['knowledge'] },
    };
    state.agents.set('skippy-like', skippyAgent);
    registryOf(state).save(skippyAgent);

    // Initial policy
    state.policies.set('skippy-like', { routes: ['knowledge'], models: ['gemini-2.0-flash'], budgetUsd: { perDay: 10, perMonth: 100 } });

    // Initial config record with owners
    await state.configs!.put(
      {
        ...configOf(state, 'skippy-like'),
        owners: ['token:admin', 'token:owner'],
      },
      { updatedBy: 'token:admin', reason: 'initial config' },
    );

    // Initial schedule
    state.schedules!.save({
      id: 'sched-skippy-1',
      agentId: 'skippy-like',
      name: 'Morning Brief',
      cron: '0 9 * * *',
      prompt: 'morning brief',
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    // Initial identity link (Discord role Member)
    state.identityLinks!.link('discord', 'disc-user-1', 'discord:disc-user-1', 'token:admin', {
      agentRoles: { 'skippy-like': ['Member'] },
    });

    // Attempt convert with skills: [] (which does not cover route 'knowledge')
    const res = await call('/api/v1/agents/skippy-like/convert', 'POST', ADMIN, {
      soul: 'You are Skippy.',
      roles: { Member: { skills: {} } },
      memory: { archetype: 'purpose-built' },
      skills: [],
    });

    assert.equal(res.status, 422);
    assert.equal(res.body?.error, 'uncovered_routes');
    assert.deepEqual(res.body?.uncovered, ['knowledge']);

    // skippy-like remains a repository agent
    const afterCheck = state.agents.get('skippy-like')!;
    assert.equal(afterCheck.createdFrom, undefined);
    assert.equal(afterCheck.commit, REPO_COMMIT);
    assert.equal(afterCheck.artifact, 'repo-image:skippy-like:v1');

    // Verify an agent with models and discord in its routes plus custom-legacy-api only reports custom-legacy-api as uncovered
    const customAgent: AgentRecord = {
      ...skippyAgent,
      id: 'custom-reach-agent',
      egress: { routes: ['models', 'discord', 'custom-legacy-api'], hosts: [] },
      skillRoutes: {},
    };
    state.agents.set('custom-reach-agent', customAgent);
    registryOf(state).save(customAgent);
    state.policies.set('custom-reach-agent', { routes: ['models', 'discord', 'custom-legacy-api'], models: ['gemini-2.0-flash'] });

    const customRes = await call('/api/v1/agents/custom-reach-agent/convert', 'POST', ADMIN, {
      soul: 'custom',
      memory: { archetype: 'purpose-built' },
      skills: [],
    });
    assert.equal(customRes.status, 422);
    assert.equal(customRes.body?.error, 'uncovered_routes');
    assert.deepEqual(customRes.body?.uncovered, ['custom-legacy-api']);
  });

  it('2. In-Place Conversion Preserves Identity, Policy, Owners, Schedules, and Role Assignments', async () => {
    // Register and approve skill knowledge-retrieval@0.1.0 covering route 'knowledge'
    skillRegistry(state).save({
      id: 'knowledge-retrieval',
      version: '0.1.0',
      repo: 'https://github.com/BeerCanLabs/test-skills',
      path: '.',
      commit: COMMIT_RUNTIME,
      manifest: {
        schema: 1,
        id: 'knowledge-retrieval',
        version: '0.1.0',
        name: 'Knowledge Retrieval',
        description: 'Retrieves knowledge',
        requires: { routes: ['knowledge'] },
        smoke: { action: 'search-knowledge', input: { query: 'ping' } },
      },
      status: 'approved',
      tests: 'passed',
      registeredBy: 'admin',
      registeredAt: new Date().toISOString(),
      published: true,
    });

    const preVersions = await state.configs!.history('skippy-like');

    // Call POST /api/v1/agents/skippy-like/convert adopting knowledge-retrieval
    const res = await call('/api/v1/agents/skippy-like/convert', 'POST', ADMIN, {
      soul: 'You are Skippy.',
      roles: { Member: { skills: { 'knowledge-retrieval': { allow: ['*'] } } } },
      memory: { archetype: 'purpose-built' },
      skills: [{ id: 'knowledge-retrieval', version: '0.1.0' }],
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body?.ok, true);
    assert.equal(res.body?.id, 'skippy-like');
    assert.equal(res.body?.createdFrom, 'configuration');
    assert.deepEqual(res.body?.deployedRuntime, {
      repo: state.sharedRuntime!.repo,
      commit: state.sharedRuntime!.commit,
      image: state.sharedRuntime!.image,
    });

    // Verify converted agent properties in registry
    const converted = state.agents.get('skippy-like')!;
    assert.equal(converted.createdFrom, 'configuration');
    assert.equal(converted.state, 'SLEEPING');
    assert.equal(converted.repo, state.sharedRuntime!.repo);
    assert.equal(converted.commit, state.sharedRuntime!.commit);
    assert.equal(converted.deployedCommit, state.sharedRuntime!.commit);
    assert.deepEqual(converted.deployedRuntime, state.sharedRuntime);
    assert.equal(converted.skillIds, undefined);
    assert.equal(converted.skillRoutes, undefined);
    assert.equal(converted.roles, undefined);

    // Exactly one new configuration version added over pre-conversion config
    const postVersions = await state.configs!.history('skippy-like');
    assert.equal(postVersions.length, preVersions.length + 1);

    const storedConfig = state.configs!.current('skippy-like')!;
    assert.deepEqual(storedConfig.source, {
      repo: state.sharedRuntime!.repo,
      commit: state.sharedRuntime!.commit,
    });
    assert.deepEqual(storedConfig.skills, [{ id: 'knowledge-retrieval', version: '0.1.0' }]);
    assert.equal(storedConfig.agent?.soul, 'You are Skippy.');
    assert.equal(storedConfig.agent?.memory?.archetype, 'purpose-built');

    // Existing owners, policy, schedules, and Discord role assignments are 100% preserved
    assert.deepEqual(storedConfig.owners, ['token:admin', 'token:owner']);
    assert.deepEqual(state.policies.get('skippy-like')?.routes, ['knowledge']);
    const schedules = state.schedules!.list({ agentId: 'skippy-like' });
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].cron, '0 9 * * *');
    assert.equal(schedules[0].prompt, 'morning brief');
    const link = state.identityLinks!.resolveLink('discord', 'disc-user-1');
    assert.deepEqual(link?.agentRoles?.['skippy-like'], ['Member']);

    // Ledger checks: AGENT_CONVERTED, smoke runs, AGENT_DEPLOYED
    const entries = ledger.query().filter((e) => e.agentId === 'skippy-like');
    const convertEntry = entries.find((e) => e.action === 'AGENT_CONVERTED');
    assert.ok(convertEntry, 'AGENT_CONVERTED must be ledgered');
    assert.equal(convertEntry.commit, state.sharedRuntime!.commit);
    assert.ok(entries.some((e) => e.action === 'AGENT_DEPLOYED'), 'AGENT_DEPLOYED must be ledgered');
    assert.ok(
      entries.some((e) => e.action === 'tool:search-knowledge' || e.action === 'tool:hello-world' || e.action === 'AGENT_ADMITTED'),
      'smoke runs and admission ledgered'
    );

    // Verify waking skippy-like injects FACTORY_MEMORY_ARCHETYPE=purpose-built into run environment
    const wakeRes = await call('/api/v1/agents/skippy-like/wake', 'POST', ADMIN, {});
    assert.equal(wakeRes.status, 202);
    const lastStart = (state.runtime as any).started.at(-1);
    assert.equal(lastStart?.agentId, 'skippy-like');
    assert.equal(lastStart?.runEnv?.FACTORY_MEMORY_ARCHETYPE, 'purpose-built');
  });

  it('3. Smoke Failure during Conversion Leaves Repository Agent Untouched (L4)', async () => {
    // Register and deploy repository agent repo-stay on REPO_COMMIT
    const repoStay: AgentRecord = {
      id: 'repo-stay',
      name: 'Repo Stay',
      role: 'Worker',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'repo-image:v1',
      repo: 'https://github.com/BeerCanLabs/repo-stay',
      commit: REPO_COMMIT,
      deployedCommit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'repo-stay',
      dir: '/tmp/repo-stay',
    };
    state.agents.set('repo-stay', repoStay);
    registryOf(state).save(repoStay);
    state.policies.set('repo-stay', { routes: ['knowledge'], models: ['gemini-2.0-flash'] });

    const preStayVersions = (await state.configs!.history('repo-stay')).length;
    computeRegistered.length = 0;

    // Configure state.smokeHandler to fail smoke during conversion
    state.smokeHandler = async ({ agent }) => {
      if (agent.id === 'repo-stay') {
        return { ok: false, error: 'simulated activation smoke failure for repo-stay' };
      }
      return { ok: true };
    };

    try {
      const res = await call('/api/v1/agents/repo-stay/convert', 'POST', ADMIN, {
        soul: 'Repo Stay Soul',
        roles: {},
        memory: { archetype: 'purpose-built' },
        skills: [],
        dropUncoveredRoutes: true,
      });

      assert.equal(res.status, 502);

      // Verify AGENT_SMOKE_FAILED was recorded
      const smokeFailed = ledger.query().find((e) => e.agentId === 'repo-stay' && e.action === 'AGENT_SMOKE_FAILED');
      assert.ok(smokeFailed, 'AGENT_SMOKE_FAILED was recorded in ledger');

      // Verify AGENT_CONVERTED was NOT recorded
      const converted = ledger.query().find((e) => e.agentId === 'repo-stay' && e.action === 'AGENT_CONVERTED');
      assert.equal(converted, undefined, 'AGENT_CONVERTED must not be recorded on smoke failure');

      // Verify repo-stay remains a repository agent
      const stayAgent = state.agents.get('repo-stay')!;
      assert.equal(stayAgent.createdFrom, undefined);
      assert.equal(stayAgent.commit, REPO_COMMIT);
      assert.equal(stayAgent.deployedCommit, REPO_COMMIT);
      assert.equal(stayAgent.artifact, 'repo-image:v1');

      // Verify compute registration rolled back to previous artifact
      const lastCompute = computeRegistered.filter((c) => c.agentId === 'repo-stay').at(-1);
      assert.equal(lastCompute?.imageUri, 'repo-image:v1');

      // Verify no new configuration version was created
      const postStayVersions = (await state.configs!.history('repo-stay')).length;
      assert.equal(postStayVersions, preStayVersions);
    } finally {
      delete state.smokeHandler;
    }
  });

  it('4. Refusals: builtin agents, already-configuration agents, missing agents, missing archetype, and unknown role skills', async () => {
    // Builtin agent refusal
    state.agents.set('factory-manager', {
      id: 'factory-manager',
      name: 'Factory Manager',
      role: 'Staff',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'builtin:image',
      isBuiltin: true,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'factory-manager',
      dir: '/tmp/factory-manager',
    });
    const builtinRes = await call('/api/v1/agents/factory-manager/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
    });
    assert.equal(builtinRes.status, 400);
    assert.equal(builtinRes.body?.error, 'builtin_agent');

    // Already-configuration agent refusal (skippy-like is now configuration)
    const alreadyConfigRes = await call('/api/v1/agents/skippy-like/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
    });
    assert.equal(alreadyConfigRes.status, 409);
    assert.equal(alreadyConfigRes.body?.error, 'already_configuration_agent');

    // Unknown agent
    const missingRes = await call('/api/v1/agents/non-existent/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
    });
    assert.equal(missingRes.status, 404);
    assert.equal(missingRes.body?.error, 'agent_not_found');

    // Missing archetype on a repository agent
    const noArchRes = await call('/api/v1/agents/repo-stay/convert', 'POST', ADMIN, {
      soul: 'soul',
    });
    assert.equal(noArchRes.status, 422);
    assert.equal(noArchRes.body?.error, 'archetype_required');

    // Role references unadopted skill
    const unadoptedRes = await call('/api/v1/agents/repo-stay/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
      roles: { Admin: { skills: { 'non-adopted-skill': { allow: ['*'] } } } },
      skills: [],
    });
    assert.equal(unadoptedRes.status, 422);
    assert.equal(unadoptedRes.body?.error, 'unknown_skill');

    // Skill not registered
    const unregSkillRes = await call('/api/v1/agents/repo-stay/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
      skills: [{ id: 'missing-skill', version: '1.0.0' }],
    });
    assert.equal(unregSkillRes.status, 409);
    assert.equal(unregSkillRes.body?.error, 'skill_unavailable');

    // Retired or purged agent refusal
    const baseStay = state.agents.get('repo-stay')!;
    const retiredAgent: AgentRecord = {
      ...baseStay,
      id: 'repo-retired',
      state: 'RETIRED_PENDING_PURGE',
    };
    state.agents.set('repo-retired', retiredAgent);
    registryOf(state).save(retiredAgent);
    const retiredRes = await call('/api/v1/agents/repo-retired/convert', 'POST', ADMIN, {
      soul: 'soul',
      memory: { archetype: 'purpose-built' },
    });
    assert.equal(retiredRes.status, 409);
    assert.equal(retiredRes.body?.error, 'invalid_state');
  });

  it('5. In-Place Conversion with dropUncoveredRoutes=true and zero skills activates runtime image', async () => {
    // repo-drop agent declaring route 'legacy-route'
    const repoDrop: AgentRecord = {
      id: 'repo-drop',
      name: 'Repo Drop',
      role: 'Worker',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'repo-image:drop:v1',
      repo: 'https://github.com/BeerCanLabs/repo-drop',
      commit: REPO_COMMIT,
      deployedCommit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'repo-drop',
      dir: '/tmp/repo-drop',
      egress: { routes: ['legacy-route'], hosts: [] },
    };
    state.agents.set('repo-drop', repoDrop);
    registryOf(state).save(repoDrop);
    state.policies.set('repo-drop', { routes: ['knowledge', 'legacy-route', 'models'], models: ['gemini-2.0-flash'] });

    computeRegistered.length = 0;
    const res = await call('/api/v1/agents/repo-drop/convert', 'POST', ADMIN, {
      soul: 'Dropped routes agent',
      memory: { archetype: 'personal-assistant' },
      skills: [],
      dropUncoveredRoutes: true,
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body?.ok, true);
    assert.equal(res.body?.createdFrom, 'configuration');
    assert.equal(res.body?.artifact, IMAGE_RUNTIME);

    const agent = state.agents.get('repo-drop')!;
    assert.equal(agent.createdFrom, 'configuration');
    assert.equal(agent.artifact, IMAGE_RUNTIME);
    assert.equal(agent.deployedCommit, COMMIT_RUNTIME);
    assert.deepEqual(agent.deployedRuntime, state.sharedRuntime);

    // Verify compute was registered with IMAGE_RUNTIME
    const lastCompute = computeRegistered.filter((c) => c.agentId === 'repo-drop').at(-1);
    assert.equal(lastCompute?.imageUri, IMAGE_RUNTIME);

    // Verify uncovered routes were pruned from policy, while covered routes remain
    const updatedPolicy = state.policies.get('repo-drop')!;
    assert.ok(!updatedPolicy.routes.includes('legacy-route'), 'legacy-route should be pruned from policy');
    assert.ok(!updatedPolicy.routes.includes('knowledge'), 'knowledge should be pruned from policy');
    assert.ok(updatedPolicy.routes.includes('models'), 'models should remain in policy');

    // Verify AGENT_CONVERTED and AGENT_DEPLOYED in ledger
    const entries = ledger.query().filter((e) => e.agentId === 'repo-drop');
    assert.ok(entries.some((e) => e.action === 'AGENT_CONVERTED'));
    assert.ok(entries.some((e) => e.action === 'AGENT_DEPLOYED'));
  });

  it('allows owner/admin converting agent to adopt unapproved own-use spec: 1 package with tests: passed, refuses non-owner (H7, A7, A12)', async () => {
    const reg = skillRegistry(state);
    reg.save({
      id: 'own-use-skill',
      version: '1.0.0',
      manifest: {
        spec: 1,
        id: 'own-use-skill',
        version: '1.0.0',
        name: 'Own Use Skill',
        description: 'private skill with passing tests',
        language: 'python',
        entry: 'entry.py',
        smoke: { entry: 'entry.py' },
        requires: { routes: ['models'], credentials: [] },
      } as any,
      packageHash: 'c'.repeat(64),
      status: 'pending',
      tests: 'passed',
      owner: 'token:operator',
      published: false,
    });

    const repoAlienAgent: AgentRecord = {
      id: 'repo-alien',
      name: 'Alien Agent',
      role: 'Assistant',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'repo-image:repo-alien:v1',
      repo: 'https://github.com/BeerCanLabs/SM-alien',
      commit: REPO_COMMIT,
      deployedCommit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'repo-alien',
      dir: '/tmp/repo-alien',
      egress: { routes: ['models'], hosts: [] },
      owners: ['token:alice'],
    };
    state.agents.set('repo-alien', repoAlienAgent);
    registryOf(state).save(repoAlienAgent);
    state.policies.set('repo-alien', { routes: ['models'], models: ['gemini-2.0-flash'] });

    const alienRes = await call('/api/v1/agents/repo-alien/convert', 'POST', ADMIN, {
      soul: 'Alien soul',
      memory: { archetype: 'personal-assistant' },
      skills: [{ id: 'own-use-skill', version: '1.0.0' }],
    });
    assert.equal(alienRes.status, 403);
    assert.equal(alienRes.body?.error, 'skill_private');

    const repoOperatorAgent: AgentRecord = {
      id: 'repo-operator',
      name: 'Operator Agent',
      role: 'Assistant',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'repo-image:repo-operator:v1',
      repo: 'https://github.com/BeerCanLabs/SM-operator',
      commit: REPO_COMMIT,
      deployedCommit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'repo-operator',
      dir: '/tmp/repo-operator',
      egress: { routes: ['models'], hosts: [] },
      owners: ['token:operator'],
    };
    state.agents.set('repo-operator', repoOperatorAgent);
    registryOf(state).save(repoOperatorAgent);
    state.policies.set('repo-operator', { routes: ['models'], models: ['gemini-2.0-flash'] });

    const operatorRes = await call('/api/v1/agents/repo-operator/convert', 'POST', OPERATOR, {
      soul: 'Operator soul',
      memory: { archetype: 'personal-assistant' },
      skills: [{ id: 'own-use-skill', version: '1.0.0' }],
    });
    assert.equal(operatorRes.status, 200, JSON.stringify(operatorRes.body));
    assert.equal(operatorRes.body?.ok, true);
    assert.equal(operatorRes.body?.createdFrom, 'configuration');
  });
});
