// TSK-159 (DESIGN_AUTHORITY.md §6.14 SK4, SK6): a change to an agent's adopted skills rebuilds and redeploys exactly that
// configuration. A fake deploy provider records what the build and the launch were given; the routes are the real ones.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { VersionedConfigStore, type ConfigBackend, type ConfigRecord } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { AdmissionRefusedError, SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, imageTagFor, noopRuntime, type BuildSkill, type DeployProvider, type SourceRef } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { applyConfig } from './apply.js';
import { loadSkills, recordSkillChecks } from './skills.js';

const ADMIN = 'apply-admin-token';
const OWNER = 'apply-owner-token';
const REPO = 'https://github.com/BeerCanLabs/skill-x';
const SHA = 'a'.repeat(40);
const ECR = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agents';
const AGENT_SHA = 'c'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  return { description: 'memory', loadAll: async () => records, write: async (r) => void records.push(r), remove: async () => {} };
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const manifest = (id: string, version: string, extra: Record<string, unknown> = {}) => ({
  id,
  version,
  name: id,
  description: `The ${id} skill.`,
  language: 'python',
  entry: id.replace(/-/g, '_'),
  requires: { routes: ['tavily'] },
  ...extra,
});

type Build = { agentId: string; source: SourceRef; skills: BuildSkill[] | undefined };
type Registered = { agentId: string; imageUri: string; launchEnv: Record<string, string> | undefined };

describe('applying an agent’s configuration: a skills change rebuilds and redeploys it (TSK-159)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let builds: Build[];
  let registered: Registered[];
  let buildMs = 0;
  let refuse: AdmissionRefusedError | undefined;
  /** Refuse every build from the Nth on (counting from 1 in `builds`); Infinity: never. */
  let refuseFrom = Infinity;
  /** Fail registering compute, as a provider can after a good build. */
  let registerFails = false;

  const call = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const actions = (name: string, agentId?: string) => ledger.query().filter((e) => e.action === name && (!agentId || e.agentId === agentId));
  const agent = (id: string) => state.agents.get(id)!;
  const deployed = (id: string) => (agent(id).deployedSkills ?? []).map((s) => `${s.id}@${s.version}`).sort();
  const configured = (id: string) => (state.configs!.current(id)?.skills ?? []).map((s) => `${s.id}@${s.version}`).sort();

  /** Waits until the agent is not deploying and `ok` holds, long enough for a queued second apply to start. */
  async function settled(id: string, ok: () => boolean = () => true) {
    for (let i = 0, quiet = 0; i < 600; i++) {
      await sleep(5);
      quiet = agent(id).state !== 'DEPLOYING' && ok() ? quiet + 1 : 0;
      if (quiet >= 4) return;
    }
    throw new Error(`${id} did not settle: ${agent(id).state}`);
  }

  async function publish(m: Record<string, unknown>, token = ADMIN) {
    assert.equal((await call('/api/v1/registry/skills', 'POST', token, { repo: REPO, path: '.', commit: SHA, manifest: m })).status, 201);
    recordSkillChecks(state, m.id as string, m.version as string, { passed: true });
    const approved = await call(`/api/v1/registry/skills/${m.id}/versions/${m.version}/approve`, 'POST', ADMIN, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    return approved.body;
  }
  const adopt = async (agentId: string, skillId: string, version = '0.1.0') => {
    assert.equal((await call(`/api/v1/agents/${agentId}/skills`, 'POST', OWNER, { skillId, version })).status, 201);
    const done = await call(`/api/v1/agents/${agentId}/skills/${skillId}/adoption/approve`, 'POST', ADMIN, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
  };

  /** A registered, deployed agent: the state a running agent is in when someone adopts a skill. */
  async function deployedAgent(id: string, over: Partial<ReturnType<typeof agent>> = {}) {
    state.agents.set(id, {
      id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'cloud', artifact: `${ECR}:${id}-cccccccccccc`, requires: [], ungated: [], gated: [], triggers: [],
      dir: `/agents/${id}`, repo: `https://github.com/BeerCanLabs/SM-${id}`, commit: AGENT_SHA, deployedCommit: AGENT_SHA, deployedSkills: [], memoryPrefix: id, ...over,
    } as never);
    state.policies.set(id, { routes: ['tavily'] });
    await state.configs!.put({ agentId: id, source: { repo: `https://github.com/BeerCanLabs/SM-${id}`, commit: AGENT_SHA }, skills: [], policy: { routes: ['tavily'] }, owners: ['token:owner'] }, { updatedBy: 'test', reason: 'setup' });
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-apply-'));
    ledger = new MemoryLedger();
    builds = [];
    registered = [];
    const provider: DeployProvider = {
      async buildImage(agentId, source, skills) {
        builds.push({ agentId, source, skills });
        await sleep(buildMs);
        if (refuse || builds.length >= refuseFrom) throw refuse ?? new AdmissionRefusedError('build_failed', 'docker build failed');
        return `${ECR}:${imageTagFor(agentId, source.commit, skills ?? [])}`;
      },
      async provisionIdentity() {
        return { identity: 'task-role', executionIdentity: 'exec-role' };
      },
      async registerCompute(agentId, imageUri, _secrets, _identity, _exec, _prefix, launchEnv) {
        if (registerFails) throw new Error('RegisterTaskDefinition failed');
        registered.push({ agentId, imageUri, launchEnv });
      },
    };
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'owner', token: OWNER, roles: ['viewer'] },
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
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
    } as FactoryState;
    state.configs = await VersionedConfigStore.open(memoryBackend());
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
    await publish(manifest('tavily-search', '0.1.0'));
    await publish(manifest('print', '0.1.0', { requires: { routes: ['print'] } }));
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('adopting a skill builds the image with it, tags it by the pins, names the manifest at launch, and records what runs', async () => {
    await deployedAgent('higgins');
    builds.length = 0;
    registered.length = 0;
    await adopt('higgins', 'tavily-search');
    await settled('higgins', () => builds.length === 1 && registered.length === 1);

    const reg = state.configs!.current('higgins')!.skills;
    assert.deepEqual(reg, [{ id: 'tavily-search', version: '0.1.0' }]);
    assert.equal(builds[0].agentId, 'higgins');
    assert.deepEqual(builds[0].source, { repo: 'https://github.com/BeerCanLabs/SM-higgins', commit: AGENT_SHA });
    assert.deepEqual(builds[0].skills, [{ id: 'tavily-search', version: '0.1.0', repo: REPO, path: '.', commit: SHA }]);
    const tag = imageTagFor('higgins', AGENT_SHA, builds[0].skills!);
    assert.match(tag, /^higgins-cccccccccccc-[0-9a-f]{12}$/);
    assert.equal(registered[0].imageUri, `${ECR}:${tag}`);
    assert.deepEqual(registered[0].launchEnv, { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH });
    assert.equal(agent('higgins').artifact, `${ECR}:${tag}`);
    assert.deepEqual(deployed('higgins'), ['tavily-search@0.1.0']);
    assert.equal(agent('higgins').state, 'SLEEPING');
    for (const a of ['AGENT_CONFIG_APPLY_STARTED', 'AGENT_ADMITTED', 'AGENT_DEPLOYED', 'AGENT_CONFIG_APPLIED']) assert.equal(actions(a, 'higgins').length, 1, a);
  });

  it('applying a configuration the image already matches builds nothing', async () => {
    const before = builds.length;
    const out = applyConfig(state, 'higgins', 'token:admin', 'again');
    assert.deepEqual([out.status, (out as { reason?: string }).reason], ['unchanged', 'image_matches']);
    await sleep(30);
    assert.equal(builds.length, before);
  });

  it('removing the skill rebuilds without it: the old tag, no manifest at launch', async () => {
    builds.length = 0;
    registered.length = 0;
    assert.equal((await call('/api/v1/agents/higgins/skills/tavily-search', 'DELETE', OWNER, {})).status, 200);
    await settled('higgins', () => registered.length === 1);
    assert.equal(builds[0].skills, undefined);
    assert.equal(registered[0].imageUri, `${ECR}:higgins-cccccccccccc`, 'an agent with no skills keeps the tag it always had');
    assert.equal(registered[0].launchEnv, undefined);
    assert.deepEqual(deployed('higgins'), []);
  });

  it('a private skill is built in as soon as its version is approved', async () => {
    const approved = await publish(manifest('printer', '0.1.0', { visibility: 'private', owner: 'higgins', requires: { routes: ['print'] }, actions: [{ id: 'print-page', route: 'print', method: 'POST', path: '/jobs', hold: true }] }));
    assert.deepEqual(approved.adopted, ['higgins']);
    await settled('higgins', () => deployed('higgins').includes('printer@0.1.0'));
    assert.deepEqual(configured('higgins'), ['printer@0.1.0']);
    assert.deepEqual(builds.at(-1)!.skills!.map((s) => s.id), ['printer']);
    assert.equal(agent('higgins').state, 'SLEEPING');
  });

  it('a skills change that arrives during a deploy is applied when it ends, not dropped', async () => {
    await deployedAgent('donna');
    builds.length = 0;
    buildMs = 60;
    try {
      assert.equal((await call('/api/v1/agents/donna/skills', 'POST', OWNER, { skillId: 'tavily-search', version: '0.1.0' })).status, 201);
      assert.equal((await call('/api/v1/agents/donna/skills', 'POST', OWNER, { skillId: 'print', version: '0.1.0' })).status, 201);
      const first = await call('/api/v1/agents/donna/skills/tavily-search/adoption/approve', 'POST', ADMIN, {});
      assert.equal(first.status, 200);
      await sleep(15);
      assert.equal(agent('donna').state, 'DEPLOYING', 'the first build is under way');
      const second = await call('/api/v1/agents/donna/skills/print/adoption/approve', 'POST', ADMIN, {});
      assert.equal(second.status, 200);
      await settled('donna', () => builds.length === 2 && deployed('donna').length === 2);
    } finally {
      buildMs = 0;
    }
    assert.deepEqual(builds[0].skills!.map((s) => s.id), ['tavily-search']);
    assert.deepEqual(builds[1].skills!.map((s) => s.id), ['print', 'tavily-search']);
    assert.deepEqual(deployed('donna'), ['print@0.1.0', 'tavily-search@0.1.0']);
    assert.deepEqual(configured('donna'), deployed('donna'));
  });

  it('a refused build leaves the running image in place, and the ledger says the apply failed', async () => {
    await deployedAgent('nick');
    refuse = new AdmissionRefusedError('build_failed', 'docker build failed');
    try {
      await adopt('nick', 'tavily-search');
      await settled('nick', () => actions('AGENT_CONFIG_APPLY_FAILED', 'nick').length === 1);
    } finally {
      refuse = undefined;
    }
    assert.equal(agent('nick').state, 'SLEEPING', 'the running version stays');
    assert.deepEqual(deployed('nick'), []);
    assert.deepEqual(configured('nick'), ['tavily-search@0.1.0'], 'the configuration still says what should run');
    assert.equal(actions('AGENT_ADMISSION_REFUSED:build_failed', 'nick').length, 1);
    assert.equal(agent('nick').artifact, `${ECR}:nick-cccccccccccc`);
  });

  it('an agent that was never deployed is not built by an adoption; its first deploy builds the skills in', async () => {
    state.agents.set('castle', { id: 'castle', name: 'castle', role: 'Agent', state: 'PENDING_DEPLOY', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/castle', repo: 'https://github.com/BeerCanLabs/SM-castle', commit: AGENT_SHA } as never);
    state.policies.set('castle', { routes: ['tavily'] });
    await state.configs!.put({ agentId: 'castle', source: { repo: 'https://github.com/BeerCanLabs/SM-castle', commit: AGENT_SHA }, skills: [], policy: { routes: ['tavily'] }, owners: ['token:owner'] }, { updatedBy: 'test', reason: 'setup' });
    builds.length = 0;
    await adopt('castle', 'tavily-search');
    await sleep(40);
    assert.equal(builds.length, 0, 'nothing is deployed to rebuild');
    assert.equal(actions('AGENT_CONFIG_APPLY_STARTED', 'castle').length, 0);

    const deploy = await call('/api/v1/registry/agents/castle/deploy', 'POST', ADMIN, {});
    assert.equal(deploy.status, 202, JSON.stringify(deploy.body));
    await settled('castle', () => builds.length === 1 && agent('castle').deployedCommit === AGENT_SHA);
    assert.deepEqual(builds[0].skills!.map((s) => s.id), ['tavily-search']);
    assert.deepEqual(deployed('castle'), ['tavily-search@0.1.0']);
  });

  it('refuses to build with a skill that is no longer approved, on a deploy and on an apply', async () => {
    await deployedAgent('geordi');
    await state.configs!.put({ ...(state.configs!.current('geordi') as never), skills: [{ id: 'tavily-search', version: '9.9.9' }] }, { updatedBy: 'test', reason: 'pin a version that is not registered' });
    const deploy = await call('/api/v1/registry/agents/geordi/deploy', 'POST', ADMIN, {});
    assert.equal(deploy.status, 409);
    assert.equal(deploy.body.error, 'skill_unavailable');
    assert.match(deploy.body.message, /tavily-search@9\.9\.9 is not registered/);
    const before = builds.length;
    const out = applyConfig(state, 'geordi', 'token:admin', 'test');
    assert.deepEqual([out.status, (out as { reason?: string }).reason], ['failed', 'skill_unavailable']);
    assert.equal(builds.length, before);
    assert.equal(agent('geordi').state, 'SLEEPING');
    assert.equal(actions('AGENT_CONFIG_APPLY_FAILED', 'geordi').length, 1);

    // Registered, but not something an agent may run: a retired skill, and a version nobody has approved.
    await publish(manifest('gone-skill', '0.1.0'));
    assert.equal((await call('/api/v1/registry/skills/gone-skill/retire', 'POST', ADMIN, {})).status, 200);
    assert.equal((await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: manifest('tavily-search', '0.2.0') })).status, 201);
    for (const [pin, why] of [['gone-skill@0.1.0', 'is retired'], ['tavily-search@0.2.0', 'is pending']] as const) {
      const [id, version] = pin.split('@');
      await state.configs!.put({ ...(state.configs!.current('geordi') as never), skills: [{ id, version }] }, { updatedBy: 'test', reason: `pin ${pin}` });
      const refused = await call('/api/v1/registry/agents/geordi/deploy', 'POST', ADMIN, {});
      assert.equal(refused.status, 409, pin);
      assert.match(refused.body.message, new RegExp(`${id}@${version} ${why}`), pin);
      assert.equal(builds.length, before, `${pin}: nothing was built`);
    }
  });

  it('does not apply to an agent without a policy route, or when no provider is bound, and says so', async () => {
    await deployedAgent('rosie');
    state.policies.set('rosie', { routes: [] });
    await state.configs!.put({ ...(state.configs!.current('rosie') as never), skills: [{ id: 'tavily-search', version: '0.1.0' }] }, { updatedBy: 'test', reason: 'adopt' });
    assert.deepEqual([applyConfig(state, 'rosie', 'token:admin', 't').status, (applyConfig(state, 'rosie', 'token:admin', 't') as { reason?: string }).reason], ['skipped', 'policy_required']);
    state.policies.set('rosie', { routes: ['tavily'] });
    const provider = state.deployProvider;
    state.deployProvider = undefined;
    try {
      assert.equal((applyConfig(state, 'rosie', 'token:admin', 't') as { reason?: string }).reason, 'deploy_provider_not_configured');
    } finally {
      state.deployProvider = provider;
    }
    assert.ok(actions('AGENT_CONFIG_APPLY_SKIPPED', 'rosie').length >= 2);
    assert.equal(agent('rosie').state, 'SLEEPING');
  });

  describe('a forced retire or revocation (SK6)', () => {
    it('pauses the agent for the skill, strips and rebuilds it without the skill, then resumes it', async () => {
      await deployedAgent('finley');
      await adopt('finley', 'print');
      await settled('finley', () => deployed('finley').includes('print@0.1.0'));
      builds.length = 0;
      buildMs = 40;
      let forced: Awaited<ReturnType<typeof call>>;
      try {
        forced = await call('/api/v1/registry/skills/print/retire', 'POST', ADMIN, { force: true, reason: 'replaced' });
        assert.equal(forced.status, 200, JSON.stringify(forced.body));
        assert.ok(forced.body.paused.includes('finley') && forced.body.removedFrom.includes('finley'));
        assert.equal(agent('finley').state === 'PAUSED' || agent('finley').state === 'DEPLOYING', true);
        await settled('finley', () => !deployed('finley').includes('print@0.1.0'));
      } finally {
        buildMs = 0;
      }
      assert.deepEqual(configured('finley'), []);
      assert.deepEqual(deployed('finley'), []);
      assert.equal(agent('finley').state, 'SLEEPING', 'resumed by the redeploy');
      assert.equal(agent('finley').pausedForSkill, undefined);
      assert.equal(actions('AGENT_RESUMED_AFTER_SKILL_CHANGE', 'finley').length, 1);
    });

    it('does not resume an agent that someone else had paused', async () => {
      await deployedAgent('archie');
      await adopt('archie', 'tavily-search');
      await settled('archie', () => deployed('archie').includes('tavily-search@0.1.0'));
      assert.equal((await call('/api/v1/agents/archie/pause', 'POST', ADMIN, {})).status, 200);
      assert.equal(agent('archie').state, 'PAUSED');
      assert.equal((await call('/api/v1/agents/archie/skills/tavily-search', 'DELETE', OWNER, {})).status, 200);
      await settled('archie', () => !deployed('archie').includes('tavily-search@0.1.0'));
      assert.equal(agent('archie').state, 'PAUSED', 'a skills change does not unpause it');
      assert.deepEqual(deployed('archie'), []);
    });

    it('a forced retire does not resume an agent an operator had paused before it', async () => {
      await publish(manifest('extra-skill', '0.1.0'));
      await deployedAgent('ada');
      await adopt('ada', 'extra-skill');
      await settled('ada', () => deployed('ada').includes('extra-skill@0.1.0'));
      assert.equal((await call('/api/v1/agents/ada/pause', 'POST', ADMIN, {})).status, 200);
      const forced = await call('/api/v1/registry/skills/extra-skill/retire', 'POST', ADMIN, { force: true });
      assert.equal(forced.status, 200, JSON.stringify(forced.body));
      await settled('ada', () => !deployed('ada').includes('extra-skill@0.1.0'));
      assert.equal(agent('ada').pausedForSkill, undefined, 'it was not paused for the skill');
      assert.equal(agent('ada').state, 'PAUSED', 'still paused by the operator');
      assert.equal(actions('AGENT_RESUMED_AFTER_SKILL_CHANGE', 'ada').length, 0);
    });

    it('a skill stays in use until the agents running it are redeployed without it, even after it is removed from their configuration', async () => {
      await deployedAgent('switch');
      await adopt('switch', 'tavily-search');
      await settled('switch', () => deployed('switch').includes('tavily-search@0.1.0'));
      // Take it out of the configuration only, as if the rebuild had not happened yet.
      await state.configs!.put({ ...(state.configs!.current('switch') as never), skills: [] }, { updatedBy: 'test', reason: 'removed, not yet redeployed' });
      assert.deepEqual(configured('switch'), []);
      assert.deepEqual(deployed('switch'), ['tavily-search@0.1.0']);
      const plain = await call('/api/v1/registry/skills/tavily-search/retire', 'POST', ADMIN, {});
      assert.equal(plain.status, 409);
      assert.equal(plain.body.error, 'skill_in_use');
      assert.ok(plain.body.agents.includes('switch'), 'the image still has it');
    });
  });

  describe('a skills change while a deploy runs, from either entry point (review of #133)', () => {
    const route = (id: string) => call(`/api/v1/registry/agents/${id}/deploy`, 'POST', ADMIN, {});

    it('a change during a deploy started by the route is applied when it ends, not dropped', async () => {
      await deployedAgent('finn');
      assert.equal((await call('/api/v1/agents/finn/skills', 'POST', OWNER, { skillId: 'tavily-search', version: '0.1.0' })).status, 201);
      builds.length = 0;
      buildMs = 60;
      try {
        assert.equal((await route('finn')).status, 202);
        await sleep(15);
        assert.equal(agent('finn').state, 'DEPLOYING', 'the route’s build is under way');
        const approved = await call('/api/v1/agents/finn/skills/tavily-search/adoption/approve', 'POST', ADMIN, {});
        assert.equal(approved.status, 200, JSON.stringify(approved.body));
        await settled('finn', () => builds.length === 2 && deployed('finn').length === 1);
      } finally {
        buildMs = 0;
      }
      assert.equal(builds[0].skills, undefined, 'the route built what the configuration said when it started');
      assert.deepEqual(builds[1].skills!.map((s) => s.id), ['tavily-search']);
      assert.deepEqual(deployed('finn'), ['tavily-search@0.1.0']);
      assert.equal(agent('finn').state, 'SLEEPING');
    });

    it('an agent paused for a revoked skill mid-deploy stays paused while its image still has the skill', async () => {
      await publish(manifest('doomed-skill', '0.1.0')); // only gina uses it, so no other agent is rebuilt by its retirement
      await deployedAgent('gina');
      await adopt('gina', 'doomed-skill');
      await settled('gina', () => deployed('gina').includes('doomed-skill@0.1.0'));
      builds.length = 0;
      buildMs = 200; // longer than the retire takes, so its apply is queued while this deploy is still running
      refuseFrom = 2; // the route’s build (1) goes through; the rebuild without the skill (2) is refused
      try {
        assert.equal((await route('gina')).status, 202);
        await sleep(15);
        const forced = await call('/api/v1/registry/skills/doomed-skill/retire', 'POST', ADMIN, { force: true });
        assert.equal(forced.status, 200, JSON.stringify(forced.body));
        await settled('gina', () => builds.length === 2 && actions('AGENT_CONFIG_APPLY_FAILED', 'gina').length === 1);
      } finally {
        buildMs = 0;
        refuseFrom = Infinity;
      }
      assert.deepEqual(deployed('gina'), ['doomed-skill@0.1.0'], 'the image that is running still has the skill');
      assert.equal(agent('gina').state, 'PAUSED', 'so the agent must not be online');
      assert.equal(agent('gina').pausedForSkill, 'doomed-skill');
      assert.equal(actions('AGENT_RESUMED_AFTER_SKILL_CHANGE', 'gina').length, 0);
    });

    it('a build that is refused does not bring a paused agent back online either', async () => {
      await publish(manifest('doomed-too', '0.1.0'));
      await deployedAgent('jack');
      await adopt('jack', 'doomed-too');
      await settled('jack', () => deployed('jack').includes('doomed-too@0.1.0'));
      builds.length = 0;
      buildMs = 200; // longer than the retire takes, so its apply is queued while this deploy is still running
      refuseFrom = 1; // every build is refused, the route’s first one included
      try {
        assert.equal((await route('jack')).status, 202);
        await sleep(15);
        assert.equal((await call('/api/v1/registry/skills/doomed-too/retire', 'POST', ADMIN, { force: true })).status, 200);
        await settled('jack', () => builds.length === 2);
      } finally {
        buildMs = 0;
        refuseFrom = Infinity;
      }
      assert.deepEqual(deployed('jack'), ['doomed-too@0.1.0'], 'the image that is running still has the skill');
      assert.equal(agent('jack').state, 'PAUSED');
    });

    it('and once a rebuild without the skill succeeds, it is resumed', async () => {
      const out = applyConfig(state, 'gina', 'token:admin', 'retry');
      assert.equal(out.status, 'started', JSON.stringify(out));
      await settled('gina', () => deployed('gina').length === 0);
      assert.equal(agent('gina').state, 'SLEEPING');
      assert.equal(agent('gina').pausedForSkill, undefined);
      assert.equal(actions('AGENT_RESUMED_AFTER_SKILL_CHANGE', 'gina').length, 1);
    });
  });

  describe('a failure after a good build (review of #133)', () => {
    it('an apply leaves a healthy agent as it was, because its image and compute are still in place', async () => {
      await publish(manifest('fresh-skill', '0.1.0'));
      await deployedAgent('hugh');
      registerFails = true;
      try {
        await adopt('hugh', 'fresh-skill');
        await settled('hugh', () => actions('AGENT_CONFIG_APPLY_FAILED', 'hugh').length === 1);
      } finally {
        registerFails = false;
      }
      assert.equal(agent('hugh').state, 'SLEEPING', 'not ERROR: an adoption must not take a working agent out of service');
      assert.deepEqual(deployed('hugh'), []);
      assert.equal(actions('AGENT_DEPLOY_FAILED', 'hugh').length, 1);
      assert.equal(actions('AGENT_CONFIG_APPLIED', 'hugh').length, 0, 'and it is not reported as applied');
    });

    it('the deploy route keeps its behavior: a failure after the build leaves the agent in ERROR', async () => {
      await deployedAgent('iris');
      registerFails = true;
      try {
        assert.equal((await call('/api/v1/registry/agents/iris/deploy', 'POST', ADMIN, {})).status, 202);
        await settled('iris', () => agent('iris').state === 'ERROR');
      } finally {
        registerFails = false;
      }
      assert.equal(agent('iris').state, 'ERROR');
    });
  });
});
