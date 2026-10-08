// TSK-054: the control plane runs the factory's checks on every registered skill version and approval waits on them
// (DESIGN_AUTHORITY.md §6.14 SK1); revocation asks the configuration store which agents use a version (SK3).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
import {
  fakeSkillChecker,
  FileConfigBackend,
  VersionedConfigStore,
  type SkillChecker,
  type SkillCheckOutcome,
  type SkillCheckRequest,
  type SkillVersionRecord,
} from '@beercanlabs/factory-registrar';
import { approvedSkill, configStoreSkillUsage, loadSkills, resumeSkillChecks, skillRegistry } from './skills.js';

const ADMIN = 'admin-skill-checks-token';
const OPERATOR = 'operator-skill-checks-token';
const REPO = 'https://github.com/BeerCanLabs/skill-discord-progress';
const SHA = 'c'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function manifest(version: string) {
  return {
    id: 'discord-progress',
    version,
    name: 'Discord progress',
    description: 'One live status message per run.',
    language: 'python',
    entry: 'discord_progress/render.py',
    requires: { routes: ['discord'] },
  };
}

/** A checker whose runs end when the test says so. */
function heldChecker() {
  const pending = new Map<string, (o: SkillCheckOutcome) => void>();
  const results = new Map<string, Promise<SkillCheckOutcome>>();
  const requests: Array<SkillCheckRequest & { runId: string }> = [];
  let n = 0;
  const checker: SkillChecker & { requests: typeof requests; finish(runId: string, o: SkillCheckOutcome): void } = {
    name: 'held',
    requests,
    async start(req) {
      const runId = `held-${++n}`;
      requests.push({ ...req, runId });
      results.set(runId, new Promise((resolve) => pending.set(runId, resolve)));
      return runId;
    },
    result: (runId) => results.get(runId) ?? Promise.resolve({ passed: false, failures: ['unknown run'] }),
    finish: (runId, o) => pending.get(runId)?.(o),
  };
  return checker;
}

describe('SK1 skill checks: started at registration, recorded when they end, required for approval (TSK-054)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  const outcomes = new Map<string, SkillCheckOutcome>();
  const fake = fakeSkillChecker((req) => outcomes.get(req.version) ?? { passed: true, failures: [] });
  const actions = (key: string) => ledger.query().filter((e) => e.agentId === key).map((e) => e.action);

  async function call(path: string, method = 'GET', token: string | undefined = ADMIN, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function settled(version: string): Promise<SkillVersionRecord> {
    for (let i = 0; i < 200; i++) {
      const rec = skillRegistry(state).get('discord-progress', version);
      if (rec && rec.tests !== 'pending-build') return rec;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`discord-progress@${version} checks never ended`);
  }

  const register = (version: string, token = OPERATOR) => call('/api/v1/registry/skills', 'POST', token, { repo: REPO, path: '.', commit: SHA, manifest: manifest(version) });

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-skill-checks-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
      skillChecker: fake,
    } as FactoryState;
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('SK1 registering a version starts the checks on its pinned commit and registered manifest', async () => {
    const reg = await register('1.0.0');
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.tests, 'pending-build');
    assert.equal(reg.body.checkRun.checker, 'fake');
    assert.equal(reg.body.checkRun.startedBy, 'token:operator');
    const started = fake.requests.find((r) => r.version === '1.0.0');
    assert.ok(started, 'the checker was started');
    assert.deepEqual({ repo: started.repo, path: started.path, commit: started.commit }, { repo: REPO, path: '.', commit: SHA });
    assert.equal(started.manifest.language, 'python');
    assert.deepEqual(actions('skill:discord-progress@1.0.0').slice(0, 2), ['SKILL_REGISTERED', 'SKILL_CHECKS_STARTED']);
  });

  it('SK1 checks that pass are recorded on the version, which an admin can then approve', async () => {
    const rec = await settled('1.0.0');
    assert.equal(rec.tests, 'passed');
    assert.ok(rec.checks?.at);
    assert.equal(rec.checks?.run, reg1RunId());
    assert.equal(rec.checks?.failures, undefined);
    assert.equal(rec.checkRun, undefined);
    const shown = await call('/api/v1/skills/discord-progress', 'GET');
    assert.equal(shown.body.versions[0].tests, 'passed');
    assert.ok(shown.body.versions[0].checks.at);
    const ok = await call('/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', ADMIN, { reason: 'reviewed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(approvedSkill(state, 'discord-progress', '1.0.0'));
    assert.ok(actions('skill:discord-progress@1.0.0').includes('SKILL_CHECKS_PASSED'));
  });

  function reg1RunId() {
    return fake.requests.find((r) => r.version === '1.0.0')?.runId;
  }

  it('E5 SK1 checks that fail refuse approval with checks_failed and the reasons, and are ledgered', async () => {
    outcomes.set('1.1.0', { passed: false, failures: ['provider SDK: discord_progress/llm.py:1 imports boto3', 'tests: python -m unittest discover failed (FAILED (failures=1))'] });
    assert.equal((await register('1.1.0')).status, 201);
    const rec = await settled('1.1.0');
    assert.equal(rec.tests, 'failed');
    assert.deepEqual(rec.checks?.failures, outcomes.get('1.1.0')!.failures);
    const res = await call('/api/v1/registry/skills/discord-progress/versions/1.1.0/approve', 'POST', ADMIN, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'checks_failed');
    assert.deepEqual(res.body.failures, outcomes.get('1.1.0')!.failures);
    assert.equal(approvedSkill(state, 'discord-progress', '1.1.0'), undefined);
    const row = ledger.query().find((e) => e.agentId === 'skill:discord-progress@1.1.0' && e.action === 'SKILL_CHECKS_FAILED');
    assert.ok(row?.payloadSha256, 'the failures are ledgered by hash');
    assert.equal(row?.actor, 'factory:admission');
  });

  it('SK1 an admin re-runs the checks: the version is pending again, and the new outcome decides', async () => {
    assert.equal((await call('/api/v1/registry/skills/discord-progress/versions/1.1.0/checks', 'POST', OPERATOR)).status, 403, 'only an admin re-runs');
    outcomes.set('1.1.0', { passed: true, failures: [] });
    const rerun = await call('/api/v1/registry/skills/discord-progress/versions/1.1.0/checks', 'POST', ADMIN);
    assert.equal(rerun.status, 202, JSON.stringify(rerun.body));
    assert.equal(rerun.body.tests, 'pending-build');
    assert.equal(rerun.body.checks, undefined, 'the previous outcome no longer stands');
    assert.equal(rerun.body.checkRun.startedBy, 'token:admin');
    const rec = await settled('1.1.0');
    assert.equal(rec.tests, 'passed');
    assert.equal((await call('/api/v1/registry/skills/discord-progress/versions/1.1.0/approve', 'POST', ADMIN, {})).status, 200);
    const rows = actions('skill:discord-progress@1.1.0');
    assert.deepEqual(rows.filter((a) => a?.startsWith('SKILL_CHECKS_')), ['SKILL_CHECKS_STARTED', 'SKILL_CHECKS_FAILED', 'SKILL_CHECKS_STARTED', 'SKILL_CHECKS_PASSED']);
  });

  it('SK1 a re-run is refused for an approved version or an unknown one', async () => {
    const approved = await call('/api/v1/registry/skills/discord-progress/versions/1.0.0/checks', 'POST', ADMIN);
    assert.equal(approved.status, 409);
    assert.equal(approved.body.error, 'already_approved');
    assert.equal((await call('/api/v1/registry/skills/discord-progress/versions/9.9.9/checks', 'POST', ADMIN)).status, 404);
  });

  it('SK1 only the latest run decides: a superseded run that ends later changes nothing', async () => {
    const held = heldChecker();
    state.skillChecker = held;
    try {
      assert.equal((await register('1.2.0')).status, 201);
      assert.equal((await call('/api/v1/registry/skills/discord-progress/versions/1.2.0/checks', 'POST', ADMIN)).status, 202);
      const [first, second] = held.requests.map((r) => r.runId);
      held.finish(second, { passed: true, failures: [] });
      const rec = await settled('1.2.0');
      assert.equal(rec.tests, 'passed');
      held.finish(first, { passed: false, failures: ['tests: stale'] });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(skillRegistry(state).get('discord-progress', '1.2.0')?.tests, 'passed');
    } finally {
      state.skillChecker = fake;
    }
  });

  it('SK1 a restarted control plane follows the runs it had started', async () => {
    const held = heldChecker();
    state.skillChecker = held;
    try {
      assert.equal((await register('1.3.0')).status, 201);
      const runId = held.requests[0].runId;
      // A new control plane process: the same records, a fresh in-memory registry, the same checker.
      const restarted = { ...state, skillChecker: held } as FactoryState;
      loadSkills(restarted, join(dataDir, 'skills'));
      assert.equal(await resumeSkillChecks(restarted), 1);
      held.finish(runId, { passed: false, failures: ['hosts: discord_progress/post.py:1 hard-codes discord.com'] });
      for (let i = 0; i < 200 && skillRegistry(restarted).get('discord-progress', '1.3.0')?.tests === 'pending-build'; i++) await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(skillRegistry(restarted).get('discord-progress', '1.3.0')?.checks?.failures, ['hosts: discord_progress/post.py:1 hard-codes discord.com']);
    } finally {
      state.skillChecker = fake;
    }
  });

  it('SK1 with no checker configured a version stays pending-build and a re-run says so', async () => {
    state.skillChecker = null;
    try {
      const reg = await register('1.4.0');
      assert.equal(reg.status, 201);
      assert.equal(reg.body.tests, 'pending-build');
      assert.equal(reg.body.checkRun, undefined);
      const rerun = await call('/api/v1/registry/skills/discord-progress/versions/1.4.0/checks', 'POST', ADMIN);
      assert.equal(rerun.status, 501);
      assert.equal(rerun.body.error, 'checker_not_configured');
      assert.equal((await call('/api/v1/registry/skills/discord-progress/versions/1.4.0/approve', 'POST', ADMIN, {})).body.error, 'checks_pending');
    } finally {
      state.skillChecker = fake;
    }
  });

  it('SK1 SK3 the usage hook reads the configuration store: revoking a version an agent\'s configuration pins is refused', async () => {
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dataDir, 'config')));
    state.agents.set('ada', { id: 'ada', name: 'Ada', role: 'Test', state: 'SLEEPING', provider: 'cloud', artifact: 'x', requires: [], ungated: [], gated: [], triggers: [], dir: '/tmp/ada' } as never);
    await state.configs.put({ agentId: 'ada', source: { repo: 'https://github.com/BeerCanLabs/SM-ada', commit: SHA }, skills: [{ id: 'discord-progress', version: '1.0.0' }], policy: null }, { updatedBy: 'token:admin', reason: 'adopt' });
    await state.configs.put({ agentId: 'bob', source: {}, skills: [{ id: 'discord-progress', version: '1.1.0' }], policy: null }, { updatedBy: 'token:admin', reason: 'adopt' });
    assert.deepEqual(configStoreSkillUsage(state)('discord-progress', '1.0.0'), ['ada']);
    assert.deepEqual(configStoreSkillUsage(state)('discord-progress', '9.0.0'), []);

    const blocked = await call('/api/v1/registry/skills/discord-progress/versions/1.0.0/reject', 'POST', ADMIN, { reason: 'leaks' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'skill_in_use');
    assert.deepEqual(blocked.body.agents, ['ada']);

    // Redeployed without it: the current configuration no longer pins the version, so revocation goes through.
    await state.configs.put({ agentId: 'ada', source: { repo: 'https://github.com/BeerCanLabs/SM-ada', commit: SHA }, skills: [], policy: null }, { updatedBy: 'token:admin', reason: 'drop skill' });
    const revoked = await call('/api/v1/registry/skills/discord-progress/versions/1.0.0/reject', 'POST', ADMIN, { reason: 'leaks' });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(approvedSkill(state, 'discord-progress', '1.0.0'), undefined);
  });
});
