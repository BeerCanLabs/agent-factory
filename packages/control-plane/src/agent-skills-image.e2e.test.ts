// TSK-272 (DESIGN_AUTHORITY.md §6.18 CF6, RT1, §6.14 SK4): an agent created from a configuration that has adopted skills runs
// the pinned shared runtime with those skills layered on, built by the deployment's provider. Nothing is built from a
// repository, a provider that cannot build it refuses, and removing the skills puts the agent back on the runtime image.
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
import { AdmissionRefusedError, MemoryRunStore, noopRuntime, SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, imageTagFor, type BuildSkill } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdentityLinkStore } from './identity-links.js';
import { loadSkills, recordSkillChecks } from './skills.js';

const ADMIN = 'admin-skills-image';
const SHA = '7'.repeat(40);
const RUNTIME_SHA = 'e'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:test';
const SKILLS_IMAGE = (agent: string, skills: BuildSkill[]) => `registry.example/dynamic:${imageTagFor(agent, RUNTIME_SHA, skills)}`;

describe('an agent with adopted skills runs the shared runtime with them layered on (CF6, SK4, TSK-272)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const registered: Array<{ agentId: string; image: string; env?: Record<string, string> }> = [];
  const builds: Array<{ agentId: string; base: { image: string; commit: string }; skills: BuildSkill[] }> = [];
  let refuse: AdmissionRefusedError | undefined;
  /** While set, a skills build waits for it: the deploy is in flight. */
  let hold: Promise<void> | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const waitFor = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), `timed out waiting for ${what}`);
  };
  const create = async (id: string) => {
    const made = await call('POST', '/api/v1/agents', { id, name: id, soul: `You are ${id}.`, memory: { archetype: 'personal-assistant' }, roles: [] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call('PUT', `/api/v1/agents/${id}/policy`, { routes: ['models'] })).status, 200);
  };
  /** A private skill owned by the agent, registered, checked and approved: the factory adopts it for the agent. */
  const adoptSkill = async (agent: string, skillId: string) => {
    const manifest = { id: skillId, version: '1.0.0', name: skillId, description: 'A skill.', language: 'python', entry: skillId, visibility: 'private', owner: agent, requires: { routes: ['models'] } };
    assert.equal((await call('POST', '/api/v1/registry/skills', { repo: 'https://github.com/BeerCanLabs/skill-x', path: '.', commit: SHA, manifest })).status, 201);
    recordSkillChecks(state, skillId, '1.0.0', { passed: true });
    const approved = await call('POST', `/api/v1/registry/skills/${skillId}/versions/1.0.0/approve`, {});
    assert.deepEqual(approved.body.adopted, [agent], JSON.stringify(approved.body));
    return { id: skillId, version: '1.0.0', repo: 'https://github.com/BeerCanLabs/skill-x', path: '.', commit: SHA } satisfies BuildSkill;
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-skills-image-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('skills-image-run-token-key-0123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      newAgentsFromConfigurationOnly: true,
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async () => { throw new Error('a configuration agent is never built from a repository'); },
        buildSkillsImage: async (agentId: string, base: { image: string; commit: string }, skills: BuildSkill[]) => {
          builds.push({ agentId, base, skills });
          if (hold) await hold;
          if (refuse) throw refuse;
          return `registry.example/dynamic:${imageTagFor(agentId, base.commit, skills)}`;
        },
        provisionIdentity: async () => ({ identity: 'id', executionIdentity: 'exec' }),
        registerCompute: async (agentId: string, image: string, _s: string[], _i: string, _e?: string, _m?: string, env?: Record<string, string>) => { registered.push({ agentId, image, env }); },
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

  it('deploys an agent that adopted a skill before its first deploy: the runtime image plus the skill, started in the background', async () => {
    await create('nova');
    const skill = await adoptSkill('nova', 'notes');
    const deploy = await call('POST', '/api/v1/registry/agents/nova/deploy', {});
    assert.equal(deploy.status, 202, JSON.stringify(deploy.body));
    await waitFor(() => state.agents.get('nova')!.state === 'SLEEPING', 'the deploy to finish');
    assert.deepEqual(builds, [{ agentId: 'nova', base: { image: IMAGE, commit: RUNTIME_SHA }, skills: [skill] }], 'built on the pinned runtime, with the approved pin');
    const a = state.agents.get('nova')!;
    assert.equal(a.artifact, SKILLS_IMAGE('nova', [skill]));
    assert.equal(a.deployedCommit, RUNTIME_SHA);
    assert.deepEqual(a.deployedSkills, [{ id: 'notes', version: '1.0.0' }]);
    assert.deepEqual(registered, [{ agentId: 'nova', image: SKILLS_IMAGE('nova', [skill]), env: { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH } }], 'the container is told where its skills manifest is');
    const actions = ledger.query({ agent: 'nova' }).map((e) => e.action);
    assert.ok(actions.includes('AGENT_ADMITTED') && actions.includes('AGENT_DEPLOYED'), actions.join());
  });

  it('puts the agent back on the runtime image itself when its skills are removed, with no build', async () => {
    const before = builds.length;
    const removed = await call('DELETE', '/api/v1/agents/nova/skills/notes', {});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    await waitFor(() => registered.length === 2 && state.agents.get('nova')!.state === 'SLEEPING', 'the apply to finish');
    assert.equal(builds.length, before, 'nothing to build');
    assert.equal(state.agents.get('nova')!.artifact, IMAGE);
    assert.deepEqual(state.agents.get('nova')!.deployedSkills, []);
    assert.deepEqual(registered[1], { agentId: 'nova', image: IMAGE, env: undefined });
  });

  it('applies a skill adopted after the first deploy to a running agent, and a second agent has its own image', async () => {
    const skill = await adoptSkill('nova', 'journal');
    await waitFor(() => state.agents.get('nova')!.artifact === SKILLS_IMAGE('nova', [skill]), 'the adopted skill to be applied');
    assert.equal(builds.at(-1)!.agentId, 'nova');
    // Another agent: its own image (the agent id is in the tag), and nothing of nova's skills.
    await create('luna');
    assert.equal((await call('POST', '/api/v1/registry/agents/luna/deploy', {})).status, 200, 'no skills: the synchronous runtime deploy');
    assert.equal(state.agents.get('luna')!.artifact, IMAGE);
    assert.notEqual(SKILLS_IMAGE('luna', [skill]), SKILLS_IMAGE('nova', [skill]));
  });

  it('a refused skill build leaves nothing deployed: the agent is not marked deployed and the refusal is on the record', async () => {
    await create('vega');
    const skill = await adoptSkill('vega', 'ledger-notes');
    refuse = new AdmissionRefusedError('hardcoded_secret', 'a hard-coded credential in skill ledger-notes');
    const before = registered.length;
    assert.equal((await call('POST', '/api/v1/registry/agents/vega/deploy', {})).status, 202);
    await waitFor(() => ledger.query({ agent: 'vega' }).some((e) => e.action === 'AGENT_ADMISSION_REFUSED:hardcoded_secret'), 'the refusal');
    refuse = undefined;
    const a = state.agents.get('vega')!;
    assert.equal(a.deployedCommit, undefined);
    assert.equal(a.state, 'ERROR');
    assert.equal(a.admission?.status, 'refused');
    assert.equal(registered.length, before, 'no compute was registered');
    assert.equal(builds.at(-1)!.skills[0].id, skill.id);
  });

  it('a deploy in flight is on the record while it builds, refuses a second one, and a skill adopted meanwhile is applied when it ends', async () => {
    await create('orion');
    const first = await adoptSkill('orion', 'orion-notes');
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    assert.equal((await call('POST', '/api/v1/registry/agents/orion/deploy', {})).status, 202);
    const a = state.agents.get('orion')!;
    assert.equal(a.state, 'DEPLOYING');
    assert.equal(a.admission?.status, 'building');
    assert.equal(a.admission?.commit, RUNTIME_SHA, 'admitted at the runtime commit, not a repository commit');
    assert.equal((await call('POST', '/api/v1/registry/agents/orion/deploy', {})).body.error, 'invalid_state', 'no second deploy beside the first');
    const second = await adoptSkill('orion', 'orion-extra');
    release();
    hold = undefined;
    await waitFor(() => a.artifact === SKILLS_IMAGE('orion', [first, second]), 'the skill adopted during the build to be applied after it');
    assert.deepEqual(a.deployedSkills?.map((k) => k.id).sort(), ['orion-extra', 'orion-notes']);
    assert.equal(a.state, 'SLEEPING');
    assert.equal(a.admission?.status, 'admitted');
  });

  it('builds on the runtime the factory pins now, not the one the agent was created on', async () => {
    await create('lyra');
    assert.equal((await call('POST', '/api/v1/registry/agents/lyra/deploy', {})).status, 200);
    const pin = state.sharedRuntime!;
    const NEWER = 'a'.repeat(40);
    state.sharedRuntime = { repo: pin.repo, commit: NEWER, image: 'registry.example/factory-agent-runtime:newer' };
    try {
      const skill = await adoptSkill('lyra', 'lyra-notes');
      await waitFor(() => builds.at(-1)?.agentId === 'lyra' && state.agents.get('lyra')!.deployedSkills?.length === 1, 'the apply');
      assert.deepEqual(builds.at(-1)!.base, { image: 'registry.example/factory-agent-runtime:newer', commit: NEWER });
      const a = state.agents.get('lyra')!;
      assert.equal(a.deployedCommit, NEWER);
      assert.equal(a.admission?.commit, NEWER);
      assert.equal(a.artifact, `registry.example/dynamic:${imageTagFor('lyra', NEWER, [skill])}`);
    } finally {
      state.sharedRuntime = pin;
    }
  });

  it('a deploy brings a paused agent online, as for a repository agent; a refused redeploy leaves a running one as it was', async () => {
    const a = state.agents.get('lyra')!;
    const refused = () => ledger.query({ agent: 'lyra' }).filter((e) => e.action === 'AGENT_ADMISSION_REFUSED:hardcoded_secret').length;
    a.state = 'PAUSED';
    refuse = new AdmissionRefusedError('hardcoded_secret', 'a credential in a skill');
    try {
      assert.equal((await call('POST', '/api/v1/registry/agents/lyra/deploy', {})).status, 202);
      await waitFor(() => refused() === 1, 'the first refusal');
      assert.equal(a.state, 'PAUSED', 'a refused deploy leaves a paused agent paused');
    } finally {
      refuse = undefined;
    }
    assert.equal((await call('POST', '/api/v1/registry/agents/lyra/deploy', {})).status, 202);
    await waitFor(() => a.state === 'SLEEPING', 'the deploy to bring it online');
    const image = a.artifact;
    refuse = new AdmissionRefusedError('hardcoded_secret', 'a credential in a skill');
    try {
      assert.equal((await call('POST', '/api/v1/registry/agents/lyra/deploy', {})).status, 202);
      await waitFor(() => refused() === 2, 'the second refusal');
    } finally {
      refuse = undefined;
    }
    assert.equal(a.state, 'SLEEPING', 'the running version stays in place');
    assert.notEqual(a.artifact, undefined);
    assert.equal(a.artifact, image);
  });

  it('a provider that cannot build skills refuses to deploy the agent without them, and does not apply a skill to a running one', async () => {
    const dp = state.deployProvider!;
    const withBuild = dp.buildSkillsImage;
    delete (dp as { buildSkillsImage?: unknown }).buildSkillsImage;
    try {
      await create('rigel');
      await adoptSkill('rigel', 'plain-notes');
      const deploy = await call('POST', '/api/v1/registry/agents/rigel/deploy', {});
      assert.equal(deploy.body.error, 'skills_image_not_supported', JSON.stringify(deploy.body));
      assert.equal(state.agents.get('rigel')!.deployedCommit, undefined);
      // A running agent: adopting a skill is skipped on the record and leaves its image as it was.
      const nova = state.agents.get('nova')!;
      const image = nova.artifact;
      await adoptSkill('nova', 'extra-notes');
      await waitFor(() => ledger.query({ agent: 'nova' }).some((e) => e.action === 'AGENT_CONFIG_APPLY_SKIPPED'), 'the skipped apply');
      assert.equal(nova.artifact, image);
    } finally {
      dp.buildSkillsImage = withBuild;
    }
  });

  it('without a pinned runtime nothing is built or deployed', async () => {
    const pin = state.sharedRuntime;
    state.sharedRuntime = undefined;
    try {
      const before = builds.length;
      assert.equal((await call('POST', '/api/v1/registry/agents/rigel/deploy', {})).body.error, 'shared_runtime_not_configured');
      await adoptSkill('luna', 'late-notes');
      await waitFor(() => ledger.query({ agent: 'luna' }).some((e) => e.action === 'AGENT_CONFIG_APPLY_SKIPPED'), 'the skipped apply');
      assert.equal(builds.length, before);
      assert.equal(state.agents.get('luna')!.artifact, IMAGE);
    } finally {
      state.sharedRuntime = pin;
    }
  });
});
