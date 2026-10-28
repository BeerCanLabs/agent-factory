// TSK-280 (DESIGN_AUTHORITY.md §6.18 RT1, §6.8 L4, GAP-206): Admin-approved runtime rollout.
// The runtime version is factory data, persisted and covered by R1, seeded from env on first boot.
// PUT /api/v1/runtime (admin; privilege runtime.set) rolls out to configuration agents with
// ledgered rebuild and activation smoke gate; failure keeps previous image and compute.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { VersionedConfigStore, FileConfigBackend, type DeployProvider } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { loadSkills, recordSkillChecks } from './skills.js';
import { loadSharedRuntime, saveSharedRuntime, type SharedRuntimePin } from './agent-creation.js';
import { checkRegistry } from './config-store.js';

const ADMIN = 'admin-token-runtime-rollout';
const OPERATOR = 'operator-token-runtime-rollout';
const VIEWER = 'viewer-token-runtime-rollout';

const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);
const COMMIT_3 = '3'.repeat(40);
const REPO_COMMIT = '9'.repeat(40);

const DIGEST_1 = '1'.repeat(64);
const DIGEST_2 = '2'.repeat(64);
const DIGEST_3 = '3'.repeat(64);

const IMAGE_1 = `ghcr.io/beercanlabs/agent-runtime@sha256:${DIGEST_1}`;
const IMAGE_2 = `ghcr.io/beercanlabs/agent-runtime@sha256:${DIGEST_2}`;
const IMAGE_3 = `ghcr.io/beercanlabs/agent-runtime@sha256:${DIGEST_3}`;

const KEY = 'runtime-rollout-run-token-key-0123456789abc';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('Admin-approved runtime rollout (TSK-280, RT1, L4, GAP-206)', { concurrency: false }, () => {
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
    dir = mkdtempSync(join(tmpdir(), 'cp-runtime-rollout-'));
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

    const initialRuntime: SharedRuntimePin = {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_1,
      image: IMAGE_1,
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
      sharedRuntime: initialRuntime,
      deployProvider: provider,
      newAgentsFromConfigurationOnly: true,
      repositoryAgentIds: new Set(['repo-agent']),
    } as unknown as FactoryState;

    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    saveSharedRuntime(state.registryDir, initialRuntime);

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. Authorization & Validation: role gating and image digest / commit validation', async () => {
    // Viewer is rejected with 403
    const viewerPut = await call('/api/v1/runtime', 'PUT', VIEWER, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_2,
      image: IMAGE_2,
    });
    assert.equal(viewerPut.status, 403);
    assert.equal(viewerPut.body?.error, 'forbidden');

    // Operator is rejected with 403
    const operatorPut = await call('/api/v1/runtime', 'PUT', OPERATOR, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_2,
      image: IMAGE_2,
    });
    assert.equal(operatorPut.status, 403);
    assert.equal(operatorPut.body?.error, 'forbidden');

    // Tag-only image without @sha256:<64-hex> is rejected with 400 invalid_runtime
    const tagOnlyPut = await call('/api/v1/runtime', 'PUT', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_2,
      image: 'ghcr.io/beercanlabs/agent-runtime:latest',
    });
    assert.equal(tagOnlyPut.status, 400);
    assert.equal(tagOnlyPut.body?.error, 'invalid_runtime');
    assert.match(tagOnlyPut.body?.message, /sha256/i);

    // Non-40-hex commit is rejected with 400 invalid_runtime
    const badCommitPut = await call('/api/v1/runtime', 'PUT', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: 'main',
      image: IMAGE_2,
    });
    assert.equal(badCommitPut.status, 400);
    assert.equal(badCommitPut.body?.error, 'invalid_runtime');
    assert.match(badCommitPut.body?.message, /40-character hex sha/i);

    // Empty repo is rejected with 400 invalid_runtime
    const emptyRepoPut = await call('/api/v1/runtime', 'PUT', ADMIN, {
      repo: '',
      commit: COMMIT_2,
      image: IMAGE_2,
    });
    assert.equal(emptyRepoPut.status, 400);
    assert.equal(emptyRepoPut.body?.error, 'invalid_runtime');
  });

  it('2. Fleet Rollout across 0-skill and 1-skill Configuration Agents', async () => {
    // 2a. Register a skill with declared smoke
    const skillRes = await call('/api/v1/registry/skills', 'POST', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/ping-skill',
      path: '.',
      commit: COMMIT_1,
      manifest: {
        id: 'ping-skill',
        version: '1.0.0',
        name: 'Ping Skill',
        description: 'Ping with smoke test',
        language: 'python',
        entry: 'entry.py',
        requires: { routes: ['ping'] },
        actions: [
          { id: 'ping', route: 'ping', method: 'GET', path: '/ping', hold: false },
        ],
        smoke: {
          action: 'ping',
          input: { check: 'ping' },
        },
      },
    });
    assert.equal(skillRes.status, 201, JSON.stringify(skillRes.body));
    recordSkillChecks(state, 'ping-skill', '1.0.0', { passed: true });
    const approvedSkill = await call('/api/v1/registry/skills/ping-skill/versions/1.0.0/approve', 'POST', ADMIN, {});
    assert.equal(approvedSkill.status, 200);

    // 2b. Create cfg-zero (0 skills)
    const zeroRes = await call('/api/v1/agents', 'POST', ADMIN, {
      id: 'cfg-zero',
      name: 'Config Zero',
      soul: 'You are cfg-zero.',
      memory: { archetype: 'personal-assistant' },
      roles: [],
    });
    assert.equal(zeroRes.status, 201);
    await call('/api/v1/agents/cfg-zero/policy', 'PUT', ADMIN, { routes: ['models'] });

    // Deploy cfg-zero
    const deployZero = await call('/api/v1/registry/agents/cfg-zero/deploy', 'POST', ADMIN, {});
    assert.equal(deployZero.status, 200);
    const cfgZero = state.agents.get('cfg-zero')!;
    assert.equal(cfgZero.state, 'SLEEPING');
    assert.equal(cfgZero.deployedCommit, COMMIT_1);
    assert.equal(cfgZero.artifact, IMAGE_1);
    assert.deepEqual(cfgZero.deployedRuntime, { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: COMMIT_1, image: IMAGE_1 });

    // 2c. Create cfg-one (1 skill)
    const oneRes = await call('/api/v1/agents', 'POST', ADMIN, {
      id: 'cfg-one',
      name: 'Config One',
      soul: 'You are cfg-one.',
      memory: { archetype: 'personal-assistant' },
      roles: [],
    });
    assert.equal(oneRes.status, 201);
    await call('/api/v1/agents/cfg-one/policy', 'PUT', ADMIN, { routes: ['models', 'ping'] });

    // Adopt ping-skill for cfg-one
    await call('/api/v1/agents/cfg-one/skills', 'POST', ADMIN, { skillId: 'ping-skill', version: '1.0.0' });
    await call('/api/v1/agents/cfg-one/skills/ping-skill/adoption/approve', 'POST', ADMIN, {});

    // Deploy cfg-one
    const deployOne = await call('/api/v1/registry/agents/cfg-one/deploy', 'POST', ADMIN, {});
    assert.equal(deployOne.status, 202); // 202 for skills builder deploy

    // Wait for cfg-one to finish deploying
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (state.agents.get('cfg-one')?.state === 'SLEEPING') break;
    }
    const cfgOne = state.agents.get('cfg-one')!;
    assert.equal(cfgOne.state, 'SLEEPING');
    assert.equal(cfgOne.deployedCommit, COMMIT_1);
    assert.ok(cfgOne.artifact.startsWith('layered-image:cfg-one:'));
    assert.deepEqual(cfgOne.deployedRuntime, { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: COMMIT_1, image: IMAGE_1 });

    // 2d. Register and deploy repository-mode agent repo-agent
    state.agents.set('repo-agent', {
      id: 'repo-agent',
      name: 'Repo Agent',
      role: 'Worker',
      state: 'PENDING_DEPLOY',
      provider: 'cloud',
      artifact: '',
      repo: 'https://github.com/BeerCanLabs/repo-agent',
      commit: REPO_COMMIT,
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/tmp/repo-agent',
    });
    await state.configs!.put({ agentId: 'repo-agent', source: { repo: 'https://github.com/BeerCanLabs/repo-agent', commit: REPO_COMMIT }, skills: [], policy: { routes: ['models'] }, owners: ['token:admin'] }, { updatedBy: 'test', reason: 'init' });
    state.policies.set('repo-agent', { routes: ['models'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });
    const deployRepo = await call('/api/v1/registry/agents/repo-agent/deploy', 'POST', ADMIN, { commit: REPO_COMMIT });
    assert.equal(deployRepo.status, 202);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (state.agents.get('repo-agent')?.state === 'SLEEPING') break;
    }
    const repoAgent = state.agents.get('repo-agent')!;
    assert.equal(repoAgent.state, 'SLEEPING');
    assert.equal(repoAgent.deployedCommit, REPO_COMMIT);
    assert.equal(repoAgent.createdFrom, undefined);

    // 2e. GET /api/v1/runtime -> returns v1 and both cfg-zero and cfg-one with upToDate: true
    const runtimeGet1 = await call('/api/v1/runtime', 'GET', VIEWER);
    assert.equal(runtimeGet1.status, 200);
    assert.deepEqual(runtimeGet1.body.runtime, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_1,
      image: IMAGE_1,
    });
    const agentList1 = runtimeGet1.body.agents as Array<{ id: string; upToDate: boolean; deployedRuntime: SharedRuntimePin }>;
    assert.equal(agentList1.length, 2, 'only configuration-mode agents are listed');
    assert.deepEqual(agentList1.map((a) => a.id).sort(), ['cfg-one', 'cfg-zero']);
    assert.equal(agentList1.find((a) => a.id === 'cfg-zero')?.upToDate, true);
    assert.equal(agentList1.find((a) => a.id === 'cfg-one')?.upToDate, true);

    // 2f. PUT /api/v1/runtime with runtime v2 -> rolls out to both cfg-zero and cfg-one
    computeRegistered.length = 0;
    const rolloutV2 = await call('/api/v1/runtime', 'PUT', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: COMMIT_2,
      image: IMAGE_2,
    });
    assert.equal(rolloutV2.status, 200);
    assert.equal(rolloutV2.body.ok, true);
    assert.equal(rolloutV2.body.runtime.commit, COMMIT_2);
    assert.equal(rolloutV2.body.runtime.image, IMAGE_2);

    // Verify ledger has RUNTIME_VERSION_SET
    const setEntry = ledger.query().find((e) => e.action === 'RUNTIME_VERSION_SET');
    assert.ok(setEntry, 'RUNTIME_VERSION_SET was ledgered');
    assert.equal(setEntry.agentId, 'factory');
    assert.equal(setEntry.commit, COMMIT_2);

    // Verify cfg-zero was upgraded
    const updatedZero = state.agents.get('cfg-zero')!;
    assert.equal(updatedZero.deployedCommit, COMMIT_2);
    assert.equal(updatedZero.artifact, IMAGE_2);
    assert.equal(updatedZero.deployedRuntime?.commit, COMMIT_2);
    assert.equal(updatedZero.deployedRuntime?.image, IMAGE_2);

    // Verify cfg-one was upgraded with new layered image on v2
    const updatedOne = state.agents.get('cfg-one')!;
    assert.equal(updatedOne.deployedCommit, COMMIT_2);
    assert.ok(updatedOne.artifact.includes(COMMIT_2));
    assert.equal(updatedOne.deployedRuntime?.commit, COMMIT_2);
    assert.equal(updatedOne.deployedRuntime?.image, IMAGE_2);

    // Verify repo-agent was untouched
    const untouchedRepo = state.agents.get('repo-agent')!;
    assert.equal(untouchedRepo.deployedCommit, REPO_COMMIT);
    assert.equal(untouchedRepo.artifact, `repo-image:repo-agent:${REPO_COMMIT}`);

    // Verify GET /api/v1/runtime reports upToDate: true and deployedRuntime.commit === COMMIT_2
    const runtimeGet2 = await call('/api/v1/runtime', 'GET', VIEWER);
    assert.equal(runtimeGet2.status, 200);
    const agentList2 = runtimeGet2.body.agents as Array<{ id: string; upToDate: boolean; deployedRuntime: SharedRuntimePin }>;
    const getZero = agentList2.find((a) => a.id === 'cfg-zero');
    const getOne = agentList2.find((a) => a.id === 'cfg-one');
    assert.equal(getZero?.upToDate, true);
    assert.equal(getZero?.deployedRuntime.commit, COMMIT_2);
    assert.equal(getOne?.upToDate, true);
    assert.equal(getOne?.deployedRuntime.commit, COMMIT_2);
  });

  it('3. Partial Rollout Failure & Per-Agent Rollback (L4)', async () => {
    const v2ArtifactOne = state.agents.get('cfg-one')!.artifact;

    // Configure smoke so cfg-zero passes smoke on v3, but cfg-one fails smoke on v3
    state.smokeHandler = async ({ agent }) => {
      if (agent.id === 'cfg-one') {
        return { ok: false, error: 'simulated activation smoke failure for cfg-one on v3' };
      }
      return { ok: true };
    };

    try {
      computeRegistered.length = 0;
      const rolloutV3 = await call('/api/v1/runtime', 'PUT', ADMIN, {
        repo: 'https://github.com/BeerCanLabs/agent-factory',
        commit: COMMIT_3,
        image: IMAGE_3,
      });
      assert.equal(rolloutV3.status, 200);

      // Verify cfg-zero successfully upgraded to v3
      const zero = state.agents.get('cfg-zero')!;
      assert.equal(zero.deployedCommit, COMMIT_3);
      assert.equal(zero.artifact, IMAGE_3);
      assert.equal(zero.deployedRuntime?.commit, COMMIT_3);

      // Verify cfg-one rolled back to v2
      const one = state.agents.get('cfg-one')!;
      assert.equal(one.deployedCommit, COMMIT_2, 'cfg-one kept v2 deployedCommit');
      assert.equal(one.artifact, v2ArtifactOne, 'cfg-one restored previous v2 layered artifact');
      assert.equal(one.deployedRuntime?.commit, COMMIT_2, 'cfg-one kept v2 deployedRuntime pin');
      assert.equal(state.configs?.current('cfg-one')?.source?.commit, COMMIT_2, 'cfg-one source.commit in config store remains COMMIT_2 on failed smoke upgrade');

      // Verify AGENT_SMOKE_FAILED was ledgered for cfg-one on commit v3
      const failedEntry = ledger.query().find((e) => e.agentId === 'cfg-one' && e.action === 'AGENT_SMOKE_FAILED' && e.commit === COMMIT_3);
      assert.ok(failedEntry, 'AGENT_SMOKE_FAILED was ledgered for cfg-one on v3');

      // Verify compute rollback was called for cfg-one with v2ArtifactOne
      const lastComputeOne = computeRegistered.filter((c) => c.agentId === 'cfg-one').at(-1);
      assert.equal(lastComputeOne?.imageUri, v2ArtifactOne, 'rollback compute registration restored v2 image');

      // Verify GET /api/v1/runtime reports upToDate: false for cfg-one and upToDate: true for cfg-zero
      const runtimeGet3 = await call('/api/v1/runtime', 'GET', VIEWER);
      const agentList3 = runtimeGet3.body.agents as Array<{ id: string; upToDate: boolean; deployedRuntime: SharedRuntimePin }>;
      const getZero = agentList3.find((a) => a.id === 'cfg-zero');
      const getOne = agentList3.find((a) => a.id === 'cfg-one');

      assert.equal(getZero?.upToDate, true);
      assert.equal(getZero?.deployedRuntime.commit, COMMIT_3);

      assert.equal(getOne?.upToDate, false, 'cfg-one is not upToDate after failed upgrade');
      assert.equal(getOne?.deployedRuntime.commit, COMMIT_2, 'cfg-one reports running v2');
    } finally {
      delete state.smokeHandler;
    }
  });

  it('4. Persistence across Restart', async () => {
    // checkRegistry succeeds with _runtime.json present in registryDir
    const regCheck = checkRegistry(state.registryDir!);
    assert.equal(regCheck.ok, true, `checkRegistry should pass with _runtime.json present: ${JSON.stringify(regCheck)}`);

    // loadSharedRuntime from state.registryDir reads back the latest approved pin (v3)
    const pin = loadSharedRuntime(state.registryDir);
    assert.ok(pin);
    assert.equal(pin.repo, 'https://github.com/BeerCanLabs/agent-factory');
    assert.equal(pin.commit, COMMIT_3);
    assert.equal(pin.image, IMAGE_3);
    assert.ok(pin.updatedAt);
    assert.equal(pin.updatedBy, 'token:admin');
  });
});
