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
import {
  VersionedConfigStore,
  type ConfigBackend,
  type ConfigRecord,
} from '@beercanlabs/factory-registrar';
import {
  packSkillPackage,
  validateSkillPackage,
} from '@beercanlabs/factory-contract';
import {
  AdmissionRefusedError,
  imageTagFor,
  MemoryRunStore,
  noopRuntime,
  type BuildSkill,
  type DeployProvider,
  type SourceRef,
} from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { loadSkills, recordSkillChecks } from './skills.js';
import { runActivationSmoke } from './smoke.js';
import { deployConfigured } from './agent-creation.js';

const ADMIN = 'smoke-admin-token';
const OWNER = 'smoke-owner-token';
const EGRESS_TOKEN = 'smoke-egress-token';
const ECR = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agents';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  return {
    description: 'memory',
    loadAll: async () => records,
    write: async (r) => void records.push(r),
    remove: async () => {},
  };
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function makePackageDir(dir: string, yamlContent: string, entryPy = 'def tools(): return []\n', testPy = 'def test_smoke(): assert True\n') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.yaml'), yamlContent, 'utf8');
  writeFileSync(join(dir, 'entry.py'), entryPy, 'utf8');
  writeFileSync(join(dir, 'test_entry.py'), testPy, 'utf8');
}

describe('Activation smoke gate (TSK-281, §6.8 L4, §6.14 SK1)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let computeRegistered: Array<{ agentId: string; imageUri: string }>;
  let ingressPresence: Array<{ agentId: string; presence: string }>;

  const call = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const publishSkill = async (m: Record<string, unknown>) => {
    const res = await call('/api/v1/registry/skills', 'POST', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/test-skills',
      path: '.',
      commit: SHA1,
      manifest: m,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    recordSkillChecks(state, m.id as string, m.version as string, { passed: true });
    const approved = await call(`/api/v1/registry/skills/${m.id}/versions/${m.version}/approve`, 'POST', ADMIN, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    return approved.body;
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-smoke-e2e-'));
    ledger = new MemoryLedger();
    computeRegistered = [];
    ingressPresence = [];

    const provider: DeployProvider = {
      async buildImage(agentId, source, skills) {
        return `${ECR}:${imageTagFor(agentId, source.commit, skills ?? [])}`;
      },
      async provisionIdentity() {
        return { identity: 'task-role', executionIdentity: 'exec-role' };
      },
      async registerCompute(agentId, imageUri) {
        computeRegistered.push({ agentId, imageUri });
      },
    };

    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'owner', token: OWNER, roles: ['viewer', 'operator'] },
        { name: 'egress', token: EGRESS_TOKEN, roles: ['gatekeeper-egress'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(),
      deployProvider: provider,
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: new RunTokens('smoke-e2e-run-token-key-0123456789'),
      secretValues: new Set(),
      sharedRuntime: {
        repo: 'https://github.com/BeerCanLabs/factory-agent-runtime',
        commit: SHA1,
        image: 'registry.example/factory-agent-runtime:pinned',
      },
    } as FactoryState;

    state.configs = await VersionedConfigStore.open(memoryBackend());
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('1. Hello-world activation smoke turn (happy path)', () => {
    it('runs hello-world smoke during repository-agent deploy and records AGENT_DEPLOYED on success', async () => {
      // 1. Setup repo agent
      state.agents.set('repo-agent', {
        id: 'repo-agent',
        name: 'Repo Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/repo-agent',
      });
      await state.configs!.put({ agentId: 'repo-agent', source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 }, skills: [], policy: { routes: ['models'] }, owners: ['owner'] }, { updatedBy: 'test', reason: 'init' });
      state.policies.set('repo-agent', { routes: ['models'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      // 2. Deploy
      const res = await call('/api/v1/registry/agents/repo-agent/deploy', 'POST', ADMIN, { commit: SHA1 });
      assert.equal(res.status, 202);

      // Wait for deploy to complete
      for (let i = 0; i < 50; i++) {
        await sleep(20);
        if (state.agents.get('repo-agent')?.state === 'SLEEPING') break;
      }

      const agent = state.agents.get('repo-agent')!;
      assert.equal(agent.state, 'SLEEPING');
      assert.equal(agent.deployedCommit, SHA1);
      assert.ok(agent.artifact.includes('repo-agent-'));

      // Check ledger
      const entries = ledger.query().filter((e) => e.agentId === 'repo-agent');
      const smokeRun = state.runs.list({ agentId: 'repo-agent' }).find((r) => r.trigger === 'smoke');
      assert.ok(smokeRun, 'smoke run was created');
      assert.equal(smokeRun.state, 'DONE');
      assert.equal((smokeRun.input as any)?.factoryKind, 'smoke');
      assert.equal((smokeRun.input as any)?.smoke, 'hello-world');

      // Check metered llm entry
      const llmEntry = entries.find((e) => e.type === 'llm' && e.runId === smokeRun.runId);
      assert.ok(llmEntry, 'metered llm entry was recorded');

      // Check AGENT_DEPLOYED row
      const deployEntry = entries.find((e) => e.action === 'AGENT_DEPLOYED');
      assert.ok(deployEntry, 'AGENT_DEPLOYED entry recorded');

      // Smoke run did not consume agent budget
      const agentSpend = state.spend.get('repo-agent');
      assert.equal(agentSpend.day, 0);
      assert.equal(agentSpend.month, 0);
    });

    it('runs hello-world smoke during configuration-mode agent deploy (0 skills)', async () => {
      // 1. Create agent via POST /api/v1/agents
      const made = await call('/api/v1/agents', 'POST', ADMIN, {
        id: 'config-agent',
        name: 'Config Agent',
        soul: 'You are Config Agent.',
        memory: { archetype: 'personal-assistant' },
        roles: [],
      });
      assert.equal(made.status, 201);
      await call('/api/v1/agents/config-agent/policy', 'PUT', ADMIN, { routes: ['models'] });

      // 2. Deploy configured
      const deployed = await call('/api/v1/registry/agents/config-agent/deploy', 'POST', ADMIN, {});
      assert.equal(deployed.status, 200);

      const agent = state.agents.get('config-agent')!;
      assert.equal(agent.state, 'SLEEPING');
      assert.equal(agent.artifact, state.sharedRuntime!.image);

      const smokeRun = state.runs.list({ agentId: 'config-agent' }).find((r) => r.trigger === 'smoke');
      assert.ok(smokeRun, 'smoke run was executed for configured agent');
      assert.equal(smokeRun.state, 'DONE');
    });
  });

  describe('2. Smoke failure & rollback', () => {
    it('first deploy smoke failure leaves agent in ERROR, clears artifact, ledgers AGENT_SMOKE_FAILED', async () => {
      state.agents.set('flaky-agent', {
        id: 'flaky-agent',
        name: 'Flaky Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/flaky-agent',
      });
      await state.configs!.put({ agentId: 'flaky-agent', source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 }, skills: [], policy: { routes: ['models'] }, owners: ['owner'] }, { updatedBy: 'test', reason: 'init' });
      state.policies.set('flaky-agent', { routes: ['models'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      // Inject custom smoke handler that fails
      state.smokeHandler = async ({ agent }) => {
        if (agent.id === 'flaky-agent') {
          return { ok: false, error: 'simulated model failure on boot' };
        }
        return { ok: true };
      };

      try {
        const res = await call('/api/v1/registry/agents/flaky-agent/deploy', 'POST', ADMIN, { commit: SHA1 });
        assert.equal(res.status, 202);

        for (let i = 0; i < 50; i++) {
          await sleep(20);
          if (state.agents.get('flaky-agent')?.state === 'ERROR') break;
        }

        const agent = state.agents.get('flaky-agent')!;
        assert.equal(agent.state, 'ERROR');
        assert.equal(agent.artifact, '');
        assert.equal(agent.deployedCommit, undefined);

        const failed = ledger.query().find((e) => e.agentId === 'flaky-agent' && e.action === 'AGENT_SMOKE_FAILED');
        assert.ok(failed, 'AGENT_SMOKE_FAILED was ledgered');
        const smokeRun = state.runs.get(failed.runId!);
        assert.match(String(smokeRun?.error), /simulated model failure on boot/);
      } finally {
        delete state.smokeHandler;
      }
    });

    it('upgrade deploy smoke failure rolls back compute to previous artifact, keeps previous deployedCommit', async () => {
      // 1. Initial healthy deploy
      state.agents.set('upgrade-agent', {
        id: 'upgrade-agent',
        name: 'Upgrade Agent',
        role: 'Worker',
        state: 'SLEEPING',
        provider: 'cloud',
        artifact: `${ECR}:upgrade-agent-${SHA1.slice(0, 12)}`,
        deployedCommit: SHA1,
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/upgrade-agent',
      });
      await state.configs!.put({ agentId: 'upgrade-agent', source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 }, skills: [], policy: { routes: ['models'] }, owners: ['owner'] }, { updatedBy: 'test', reason: 'init' });
      state.policies.set('upgrade-agent', { routes: ['models'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      const prevArtifact = state.agents.get('upgrade-agent')!.artifact;

      // 2. Trigger upgrade to SHA2, but make smoke fail
      state.smokeHandler = async ({ agent }) => {
        if (agent.id === 'upgrade-agent') {
          return { ok: false, error: 'runtime memory corruption on upgrade' };
        }
        return { ok: true };
      };

      try {
        computeRegistered.length = 0;
        const res = await call('/api/v1/registry/agents/upgrade-agent/deploy', 'POST', ADMIN, { commit: SHA2 });
        assert.equal(res.status, 202);

        for (let i = 0; i < 50; i++) {
          await sleep(20);
          if (state.agents.get('upgrade-agent')?.state === 'ERROR') break;
        }

        const agent = state.agents.get('upgrade-agent')!;
        assert.equal(agent.state, 'ERROR');
        assert.equal(agent.artifact, prevArtifact, 'artifact was restored to previous version');
        assert.equal(agent.deployedCommit, SHA1, 'deployedCommit was restored to previous version');

        // Confirm rollback compute registration was executed
        assert.ok(computeRegistered.length >= 2, 'candidate compute and rollback compute were registered');
        assert.equal(computeRegistered[computeRegistered.length - 1].imageUri, prevArtifact);

        const failed = ledger.query().find((e) => e.agentId === 'upgrade-agent' && e.action === 'AGENT_SMOKE_FAILED');
        assert.ok(failed, 'AGENT_SMOKE_FAILED was ledgered');
      } finally {
        delete state.smokeHandler;
      }
    });

    it('configured agent deploy smoke failure returns 502 smoke_failed and rolls back', async () => {
      const made = await call('/api/v1/agents', 'POST', ADMIN, {
        id: 'failing-cfg-agent',
        name: 'Failing Cfg Agent',
        soul: 'You are Failing Cfg Agent.',
        memory: { archetype: 'personal-assistant' },
        roles: [],
      });
      assert.equal(made.status, 201);
      await call('/api/v1/agents/failing-cfg-agent/policy', 'PUT', ADMIN, { routes: ['models'] });

      state.smokeHandler = async ({ agent }) => {
        if (agent.id === 'failing-cfg-agent') {
          return { ok: false, error: 'failed hello-world model completion' };
        }
        return { ok: true };
      };

      try {
        const deployed = await call('/api/v1/registry/agents/failing-cfg-agent/deploy', 'POST', ADMIN, {});
        assert.equal(deployed.status, 502);
        assert.equal(deployed.body.error, 'smoke_failed');

        const agent = state.agents.get('failing-cfg-agent')!;
        assert.equal(agent.state, 'ERROR');
        assert.equal(agent.artifact, '');
      } finally {
        delete state.smokeHandler;
      }
    });

    it('configured agent redeploy smoke failure rolls back compute to prevArtifact and preserves prevDeployedCommit', async () => {
      const made = await call('/api/v1/agents', 'POST', ADMIN, {
        id: 'upgrade-cfg-agent',
        name: 'Upgrade Cfg Agent',
        soul: 'You are Upgrade Cfg Agent.',
        memory: { archetype: 'personal-assistant' },
        roles: [],
      });
      assert.equal(made.status, 201);
      await call('/api/v1/agents/upgrade-cfg-agent/policy', 'PUT', ADMIN, { routes: ['models'] });

      // First deploy succeeds
      const firstDeploy = await call('/api/v1/registry/agents/upgrade-cfg-agent/deploy', 'POST', ADMIN, {});
      assert.equal(firstDeploy.status, 200);

      const agent = state.agents.get('upgrade-cfg-agent')!;
      assert.equal(agent.state, 'SLEEPING');
      const prevArtifact = agent.artifact;
      const prevCommit = agent.deployedCommit;
      assert.ok(prevArtifact);
      assert.ok(prevCommit);

      // Upgrade runtime version and make smoke fail
      const origSharedRuntime = state.sharedRuntime;
      state.sharedRuntime = {
        repo: 'https://github.com/BeerCanLabs/agent-runtime',
        commit: SHA2,
        image: `${ECR}:agent-runtime-${SHA2.slice(0, 12)}`,
      };

      state.smokeHandler = async ({ agent: a }) => {
        if (a.id === 'upgrade-cfg-agent') {
          return { ok: false, error: 'runtime v2 activation check failed' };
        }
        return { ok: true };
      };

      try {
        computeRegistered.length = 0;
        const upgradeDeploy = await call('/api/v1/registry/agents/upgrade-cfg-agent/deploy', 'POST', ADMIN, {});
        assert.equal(upgradeDeploy.status, 502);
        assert.equal(upgradeDeploy.body.error, 'smoke_failed');

        const reloaded = state.agents.get('upgrade-cfg-agent')!;
        assert.equal(reloaded.state, 'SLEEPING', 'agent state is restored to SLEEPING');
        assert.equal(reloaded.artifact, prevArtifact, 'artifact is restored to previous runtime image');
        assert.equal(reloaded.deployedCommit, prevCommit, 'deployedCommit is restored to previous commit');

        // Confirm compute registration rolled back
        assert.ok(computeRegistered.length >= 2, 'candidate compute and rollback compute were registered');
        assert.equal(computeRegistered[computeRegistered.length - 1].imageUri, prevArtifact);

        const failed = ledger.query().find((e) => e.agentId === 'upgrade-cfg-agent' && e.action === 'AGENT_SMOKE_FAILED');
        assert.ok(failed, 'AGENT_SMOKE_FAILED was recorded');
        assert.equal(failed.commit, SHA2);
        const smokeRun = state.runs.get(failed.runId!);
        assert.match(String(smokeRun?.error), /runtime v2 activation check failed/);
      } finally {
        delete state.smokeHandler;
        state.sharedRuntime = origSharedRuntime;
      }
    });

    it('fails hello-world smoke and ledgers AGENT_SMOKE_FAILED when candidate produces empty or whitespace reply', async () => {
      state.agents.set('blank-agent', {
        id: 'blank-agent',
        name: 'Blank Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/blank-agent',
      });
      await state.configs!.put({ agentId: 'blank-agent', source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 }, skills: [], policy: { routes: ['models'] }, owners: ['owner'] }, { updatedBy: 'test', reason: 'init' });
      state.policies.set('blank-agent', { routes: ['models'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      const invalidReplies = [
        '',
        '   ',
        { reply: '' },
        { reply: '   ' },
        { output: '' },
        { status: 'succeeded', output: { reply: '' } },
      ];

      for (const invalid of invalidReplies) {
        state.smokeHandler = async () => ({ ok: true, result: invalid });
        try {
          const outcome = await runActivationSmoke(state, state.agents.get('blank-agent')!, [], SHA1, 'test-actor');
          assert.equal(outcome.ok, false);
          assert.equal(outcome.error, 'hello-world smoke run produced empty or invalid result');

          const failed = ledger.query().filter((e) => e.agentId === 'blank-agent' && e.action === 'AGENT_SMOKE_FAILED').pop();
          assert.ok(failed, 'AGENT_SMOKE_FAILED was ledgered');
          const smokeRun = state.runs.get(failed.runId!);
          assert.equal(smokeRun?.error, 'hello-world smoke run produced empty or invalid result');
        } finally {
          delete state.smokeHandler;
        }
      }
    });
  });

  describe('3. Per-adopted-skill smoke gate', () => {
    it('executes skill smoke turn, verifies required route egress, and passes activation', async () => {
      // 1. Publish approved skill with smoke and requires.routes
      await publishSkill({
        id: 'test-smoke-skill',
        version: '1.0.0',
        name: 'Test Smoke Skill',
        description: 'Test skill with smoke',
        language: 'python',
        entry: 'entry.py',
        requires: { routes: ['tavily'] },
        actions: [
          { id: 'search', route: 'tavily', method: 'POST', path: '/search', hold: false },
        ],
        smoke: {
          action: 'search',
          input: { q: 'hello' },
        },
      });

      // 2. Setup agent with this skill adopted
      state.agents.set('skilled-agent', {
        id: 'skilled-agent',
        name: 'Skilled Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/skilled-agent',
      });
      await state.configs!.put({
        agentId: 'skilled-agent',
        source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 },
        skills: [{ id: 'test-smoke-skill', version: '1.0.0' }],
        policy: { routes: ['models', 'tavily'] },
        owners: ['owner'],
      }, { updatedBy: 'test', reason: 'adopt' });
      state.policies.set('skilled-agent', { routes: ['models', 'tavily'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      // 3. Deploy
      const res = await call('/api/v1/registry/agents/skilled-agent/deploy', 'POST', ADMIN, { commit: SHA1 });
      assert.equal(res.status, 202);

      for (let i = 0; i < 50; i++) {
        await sleep(20);
        if (state.agents.get('skilled-agent')?.state === 'SLEEPING') break;
      }

      const agent = state.agents.get('skilled-agent')!;
      assert.equal(agent.state, 'SLEEPING');

      // Verify two smoke runs: hello-world then skill smoke
      const smokeRuns = state.runs.list({ agentId: 'skilled-agent' }).filter((r) => r.trigger === 'smoke');
      assert.equal(smokeRuns.length, 2);
      assert.equal((smokeRuns[0].input as any).smoke, 'hello-world');
      assert.equal((smokeRuns[1].input as any).smoke, 'skill');
      assert.equal((smokeRuns[1].input as any).skillId, 'test-smoke-skill');
      assert.equal((smokeRuns[1].input as any).action, 'search');

      // Verify egress row exists for the skill's required route
      const egressRow = ledger.query().find((e) => e.runId === smokeRuns[1].runId && (e as any).route === 'tavily');
      assert.ok(egressRow, 'egress row recorded for tavily route');
    });

    it('fails activation and rolls back if skill smoke omits route egress entry', async () => {
      await publishSkill({
        id: 'no-egress-skill',
        version: '1.0.0',
        name: 'No Egress Skill',
        description: 'No egress test',
        language: 'python',
        entry: 'entry.py',
        requires: { routes: ['weather'] },
        actions: [{ id: 'get-weather', route: 'weather', method: 'GET', path: '/now', hold: false }],
        smoke: { action: 'get-weather', input: {} },
      });

      state.agents.set('strict-agent', {
        id: 'strict-agent',
        name: 'Strict Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/strict-agent',
      });
      await state.configs!.put({
        agentId: 'strict-agent',
        source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 },
        skills: [{ id: 'no-egress-skill', version: '1.0.0' }],
        policy: { routes: ['models', 'weather'] },
        owners: ['owner'],
      }, { updatedBy: 'test', reason: 'adopt' });
      state.policies.set('strict-agent', { routes: ['models', 'weather'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      // Custom handler that finishes DONE but appends NO egress row for weather
      state.smokeHandler = async ({ smokeType }) => {
        if (smokeType === 'skill') {
          return { ok: true, omitEgress: true, result: { done: true } } as any; // Omits writing egress row
        }
        return { ok: true };
      };

      try {
        const res = await call('/api/v1/registry/agents/strict-agent/deploy', 'POST', ADMIN, { commit: SHA1 });
        assert.equal(res.status, 202);

        for (let i = 0; i < 50; i++) {
          await sleep(20);
          if (state.agents.get('strict-agent')?.state === 'ERROR') break;
        }

        const agent = state.agents.get('strict-agent')!;
        assert.equal(agent.state, 'ERROR');

        const failed = ledger.query().find((e) => e.agentId === 'strict-agent' && e.action === 'AGENT_SMOKE_FAILED');
        assert.ok(failed, 'AGENT_SMOKE_FAILED recorded');
        const smokeRun = state.runs.get(failed.runId!);
        assert.match(String(smokeRun?.error), /did not record egress on required route 'weather'/);
      } finally {
        delete state.smokeHandler;
      }
    });
  });

  describe('4. Gatekeeper egress temporary smoke policy & spend caps', () => {
    it('serves temporary smoke policy with model wildcard, smokeRoutes union, discord excluded, and perRun cap 0.25', async () => {
      // Create a test run with trigger: smoke
      const runRes = await call('/api/v1/agents', 'POST', ADMIN, {
        id: 'policy-test-agent',
        name: 'Policy Test Agent',
        soul: 'You are Policy Test Agent.',
        memory: { archetype: 'personal-assistant' },
        roles: [],
      });
      assert.equal(runRes.status, 201);
      await call('/api/v1/agents/policy-test-agent/policy', 'PUT', ADMIN, { routes: ['models', 'discord'] });

      // Create smoke run
      const run = state.runs.create({
        agentId: 'policy-test-agent',
        state: 'WORKING',
        actor: 'factory:smoke',
        trigger: 'smoke',
        input: {
          factoryKind: 'smoke',
          smokeRoutes: ['tavily', 'discord'],
        },
      });

      // Read run policy as gatekeeper egress does
      const egressRes = await call(`/api/v1/gatekeeper-egress/runs/${run.runId}`, 'GET', ADMIN);
      assert.equal(egressRes.status, 200);
      assert.equal(egressRes.body.policySet, true);
      assert.deepEqual(egressRes.body.policy.models, ['gemini-2.0-flash']);
      // Models route is included, Discord route is stripped out, tavily is included
      assert.ok(egressRes.body.policy.routes.includes('models'), 'models was included');
      assert.ok(!egressRes.body.policy.routes.includes('discord'), 'discord was stripped');
      assert.ok(egressRes.body.policy.routes.includes('tavily'), 'tavily was included');
      assert.equal(egressRes.body.policy.budgetUsd.perRun, 0.25);
    });

    it('tracks smoke spend in smokeRunSpend and blocks run if smoke spend cap is exceeded', async () => {
      const run = state.runs.create({
        agentId: 'policy-test-agent',
        state: 'WORKING',
        actor: 'factory:smoke',
        trigger: 'smoke',
      });

      // Post metered LLM call under cap
      const post1 = await call('/api/v1/ledger', 'POST', EGRESS_TOKEN, {
        agentId: 'policy-test-agent',
        runId: run.runId,
        type: 'llm',
        actor: `run:policy-test-agent`,
        costUsd: 0.15,
        model: 'test-model',
      });
      assert.equal(post1.status, 201);
      assert.equal(state.smokeRunSpend?.get(run.runId), 0.15);
      assert.equal(state.runs.get(run.runId)!.state, 'WORKING');

      // Post metered LLM call that exceeds 0.25 cap
      const post2 = await call('/api/v1/ledger', 'POST', EGRESS_TOKEN, {
        agentId: 'policy-test-agent',
        runId: run.runId,
        type: 'llm',
        actor: `run:policy-test-agent`,
        costUsd: 0.15,
        model: 'test-model',
      });
      assert.equal(post2.status, 201);
      assert.equal(state.smokeRunSpend?.get(run.runId), 0.30);
      assert.equal(state.runs.get(run.runId)!.state, 'BLOCKED_BUDGET_EXCEEDED');

      // Regular agent spend tracker was NOT mutated
      assert.equal(state.spend.get('policy-test-agent').day, 0);
    });

    it('caps budgetUsd.perRun to Math.min(perRunCap, remainingActivationBudget) in egress run query', async () => {
      const run = state.runs.create({
        agentId: 'policy-test-agent',
        state: 'WORKING',
        actor: 'factory:smoke',
        trigger: 'smoke',
        input: {
          factoryKind: 'smoke',
          activationId: 'test-act-cap',
        },
      });

      state.smokeBudgetUsd = { perRun: 0.25, perActivation: 1.00 };
      state.smokeActivationSpend ??= new Map();

      // Case A: activation spend is 0.85 -> remaining 0.15 < 0.25
      state.smokeActivationSpend.set('test-act-cap', 0.85);
      const resA = await call(`/api/v1/gatekeeper-egress/runs/${run.runId}`, 'GET', ADMIN);
      assert.equal(resA.status, 200);
      assert.equal(resA.body.policy.budgetUsd.perRun, 0.15);

      // Case B: activation spend is 0.10 -> remaining 0.90 > 0.25 -> capped at 0.25
      state.smokeActivationSpend.set('test-act-cap', 0.10);
      const resB = await call(`/api/v1/gatekeeper-egress/runs/${run.runId}`, 'GET', ADMIN);
      assert.equal(resB.status, 200);
      assert.equal(resB.body.policy.budgetUsd.perRun, 0.25);

      // Case C: activation spend is 1.05 -> remaining 0 -> capped at 0
      state.smokeActivationSpend.set('test-act-cap', 1.05);
      const resC = await call(`/api/v1/gatekeeper-egress/runs/${run.runId}`, 'GET', ADMIN);
      assert.equal(resC.status, 200);
      assert.equal(resC.body.policy.budgetUsd.perRun, 0);
    });

    it('tracks cumulative activation spend across turns and fails smoke if smokeBudgetUsd.perActivation is exceeded', async () => {
      await publishSkill({
        id: 'budget-smoke-skill',
        version: '1.0.0',
        name: 'Budget Smoke Skill',
        description: 'Budget smoke skill',
        language: 'python',
        entry: 'entry.py',
        requires: { routes: ['tavily'] },
        actions: [{ id: 'search', route: 'tavily', method: 'POST', path: '/search', hold: false }],
        smoke: { action: 'search', input: { query: 'test' } },
      });

      state.agents.set('budget-test-agent', {
        id: 'budget-test-agent',
        name: 'Budget Test Agent',
        role: 'Worker',
        state: 'PENDING_DEPLOY',
        provider: 'cloud',
        artifact: '',
        repo: 'https://github.com/BeerCanLabs/agent-repo',
        commit: SHA1,
        requires: [],
        ungated: [],
        gated: [],
        triggers: [],
        dir: '/tmp/budget-test-agent',
      });
      await state.configs!.put({
        agentId: 'budget-test-agent',
        source: { repo: 'https://github.com/BeerCanLabs/agent-repo', commit: SHA1 },
        skills: [{ id: 'budget-smoke-skill', version: '1.0.0' }],
        policy: { routes: ['models', 'tavily'] },
        owners: ['owner'],
      }, { updatedBy: 'test', reason: 'adopt' });
      state.policies.set('budget-test-agent', { routes: ['models', 'tavily'], budgetUsd: { perRun: 1.0, perDay: 10.0, perMonth: 50.0 } });

      // Set perActivation cap to 0.10
      state.smokeBudgetUsd = { perRun: 0.25, perActivation: 0.10 };

      // Case 1: hello-world uses 0.10, so remaining budget before skill smoke is 0
      state.smokeHandler = async ({ smokeType }) => {
        if (smokeType === 'hello-world') {
          return { ok: true, costUsd: 0.10, result: { reply: 'hello world' } };
        }
        return { ok: true };
      };

      try {
        const outcome1 = await runActivationSmoke(
          state,
          state.agents.get('budget-test-agent')!,
          [{ id: 'budget-smoke-skill', version: '1.0.0', manifest: { id: 'budget-smoke-skill', version: '1.0.0' } as any, source: {} as any }],
          SHA1,
          'test-actor',
        );
        assert.equal(outcome1.ok, false);
        assert.equal(outcome1.error, 'smoke activation budget exceeded');

        const failed1 = ledger.query().filter((e) => e.agentId === 'budget-test-agent' && e.action === 'AGENT_SMOKE_FAILED').pop();
        assert.ok(failed1);
        assert.equal(failed1.action, 'AGENT_SMOKE_FAILED');
      } finally {
        delete state.smokeHandler;
      }

      // Case 2: POST /api/v1/ledger pushes cumulative activation spend over perActivation during a smoke run
      const smokeRun = state.runs.create({
        agentId: 'budget-test-agent',
        state: 'WORKING',
        actor: 'factory:smoke',
        trigger: 'smoke',
        input: {
          factoryKind: 'smoke',
          activationId: 'act-mid-exceed',
        },
      });

      // Post 1: $0.06 (under $0.10 cap)
      const post1 = await call('/api/v1/ledger', 'POST', EGRESS_TOKEN, {
        agentId: 'budget-test-agent',
        runId: smokeRun.runId,
        type: 'llm',
        actor: 'run:budget-test-agent',
        costUsd: 0.06,
        model: 'test-model',
      });
      assert.equal(post1.status, 201);
      assert.equal(state.smokeActivationSpend?.get('act-mid-exceed'), 0.06);
      assert.equal(state.runs.get(smokeRun.runId)!.state, 'WORKING');

      // Post 2: $0.05 (total $0.11 > $0.10 perActivation cap)
      const post2 = await call('/api/v1/ledger', 'POST', EGRESS_TOKEN, {
        agentId: 'budget-test-agent',
        runId: smokeRun.runId,
        type: 'llm',
        actor: 'run:budget-test-agent',
        costUsd: 0.05,
        model: 'test-model',
      });
      assert.equal(post2.status, 201);
      assert.equal(state.smokeActivationSpend?.get('act-mid-exceed'), 0.11);
      assert.equal(state.runs.get(smokeRun.runId)!.state, 'BLOCKED_BUDGET_EXCEEDED');
    });
  });

  describe('5. Skill package admission gate (SK1, L4)', () => {
    it('refuses skill package missing smoke declaration', async () => {
      const pkgDir = join(dataDir, 'no-smoke-pkg');
      makePackageDir(pkgDir, `spec: 1\nid: no-smoke\nname: No Smoke\nversion: 1.0.0\nlanguage: python\ndescription: No smoke pkg\nentry: entry.py\n`);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, false);
      assert.ok(packed.issues.some((i) => i.includes('must declare a smoke check')));
    });

    it('refuses skill package with hold: true action and no dryRun', async () => {
      const pkgDir = join(dataDir, 'hold-no-dryrun-pkg');
      const yaml = `spec: 1
id: hold-no-dryrun
name: Hold No DryRun
version: 1.0.0
language: python
description: Hold without dryRun
entry: entry.py
requires:
  routes: [printer]
actions:
  - id: print-job
    route: printer
    method: POST
    path: /print
    hold: true
smoke:
  action: print-job
  input: {}
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, false);
      assert.ok(packed.issues.some((i) => i.includes('hold: true and requires dryRun: true')));
    });

    it('accepts skill package with hold: true action and dryRun: true', async () => {
      const pkgDir = join(dataDir, 'hold-with-dryrun-pkg');
      const yaml = `spec: 1
id: hold-with-dryrun
name: Hold With DryRun
version: 1.0.0
language: python
description: Hold with dryRun
entry: entry.py
requires:
  routes: [printer]
actions:
  - id: print-job
    route: printer
    method: POST
    path: /print
    hold: true
smoke:
  action: print-job
  input: {}
  dryRun: true
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, true, JSON.stringify(packed));
      assert.ok(packed.buffer);
      const validated = await validateSkillPackage(packed.buffer);
      assert.equal(validated.ok, true);
    });
  });

  describe('6. Approved skills packaging and validation', () => {
    it('packages and validates discord-progress@0.1.2 with declared smoke', async () => {
      const pkgDir = join(dataDir, 'discord-progress-0.1.2');
      const yaml = `spec: 1
id: discord-progress
name: Discord Progress
version: 0.1.2
language: python
description: Posts progress updates to Discord
entry: entry.py
requires:
  routes: [discord]
actions:
  - id: post-progress
    route: discord
    method: POST
    path: /progress
    hold: false
smoke:
  action: post-progress
  input: { message: 'activation smoke' }
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, true, JSON.stringify(packed));
      const validated = await validateSkillPackage(packed.buffer);
      assert.equal(validated.ok, true);
    });

    it('packages and validates factory-schedules@0.1.2 with declared smoke', async () => {
      const pkgDir = join(dataDir, 'factory-schedules-0.1.2');
      const yaml = `spec: 1
id: factory-schedules
name: Factory Schedules
version: 0.1.2
language: python
description: Manages autonomous wakeup schedules
entry: entry.py
requires:
  routes: [schedules]
actions:
  - id: list-schedules
    route: schedules
    method: GET
    path: /schedules
    hold: false
smoke:
  action: list-schedules
  input: {}
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, true, JSON.stringify(packed));
      const validated = await validateSkillPackage(packed.buffer);
      assert.equal(validated.ok, true);
    });

    it('packages and validates print@0.1.2 with hold: true and dryRun: true smoke', async () => {
      const pkgDir = join(dataDir, 'print-0.1.2');
      const yaml = `spec: 1
id: print
name: Print
version: 0.1.2
language: python
description: Physical print tool with human approval
entry: entry.py
requires:
  routes: [print]
actions:
  - id: print-page
    route: print
    method: POST
    path: /jobs
    hold: true
smoke:
  action: print-page
  input: { text: 'smoke test' }
  dryRun: true
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, true, JSON.stringify(packed));
      const validated = await validateSkillPackage(packed.buffer);
      assert.equal(validated.ok, true);
    });

    it('packages and validates tavily-search@0.1.1 with declared smoke', async () => {
      const pkgDir = join(dataDir, 'tavily-search-0.1.1');
      const yaml = `spec: 1
id: tavily-search
name: Tavily Search
version: 0.1.1
language: python
description: Web search via Tavily API
entry: entry.py
requires:
  routes: [tavily]
actions:
  - id: search
    route: tavily
    method: POST
    path: /search
    hold: false
smoke:
  action: search
  input: { query: 'beer can labs' }
`;
      makePackageDir(pkgDir, yaml);
      const packed = await packSkillPackage(pkgDir);
      assert.equal(packed.ok, true, JSON.stringify(packed));
      const validated = await validateSkillPackage(packed.buffer);
      assert.equal(validated.ok, true);
    });
  });
});
