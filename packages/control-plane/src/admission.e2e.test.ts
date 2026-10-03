import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Build } from '@aws-sdk/client-codebuild';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { BUILTIN_SYSTEM_AGENTS } from './catalog.js';
import { AdmissionRefusedError, imageTagFor, noopRuntime, type AdmissionRefusal, type DeployProvider, type SourceRef } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, PolicyStore } from './policy.js';
import { checkRepoUrl } from './source.js';
import { admissionFailure, buildAgentImage } from './aws/codebuild.js';

const ADMIN = 'admin-admission-token';
const REPO = 'https://github.com/BeerCanLabs/SM-donna.git';
const C1 = 'e3410b53beb5bfb037ff1444e1778acd32c39530';
const C2 = '0123456789abcdef0123456789abcdef01234567';
const HEAD = 'ffffffffffffffffffffffffffffffffffffffff';
const ECR = '123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-dynamic-agents';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

type FakeDeploy = DeployProvider & {
  builds: Array<{ agentId: string; source: SourceRef }>;
  computes: Array<{ agentId: string; imageUri: string }>;
  refuse?: AdmissionRefusal;
};

function fakeDeployProvider(): FakeDeploy {
  const fake: FakeDeploy = {
    builds: [],
    computes: [],
    async buildImage(agentId, source) {
      fake.builds.push({ agentId, source });
      if (fake.refuse) throw new AdmissionRefusedError(fake.refuse, `refused: ${fake.refuse}`, 'PRE_BUILD');
      return `${ECR}:${imageTagFor(agentId, source.commit)}`;
    },
    async provisionIdentity(agentId) {
      return { identity: `role/${agentId}` };
    },
    async registerCompute(agentId, imageUri) {
      fake.computes.push({ agentId, imageUri });
    },
  };
  return fake;
}

describe('§6.8 L3/L4: pinned registration, admission build, and SHA-tagged deploy', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let regDir: string;
  let state: FactoryState;
  let deploy: FakeDeploy;
  const resolved: string[] = [];

  async function call(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function settled(id: string) {
    for (let i = 0; i < 100; i++) {
      const agent = state.agents.get(id)!;
      if (agent.state !== 'DEPLOYING') return agent;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${id} still DEPLOYING`);
  }

  function actions(id: string) {
    return state.ledger.query().filter((e) => e.agentId === id);
  }

  before(async () => {
    regDir = mkdtempSync(join(tmpdir(), 'cp-admission-test-'));
    const ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: regDir,
      ledger,
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      // A fallback policy with routes must not count as the agent's own policy (L4).
      policies: new PolicyStore(undefined, { routes: ['anthropic'] }),
      spend: new SpendTracker(),
      resolveCommit: async (repo) => {
        resolved.push(repo);
        if (repo.includes('unreachable')) throw new Error('fatal: could not read Username');
        return HEAD;
      },
    } as FactoryState;
    for (const b of BUILTIN_SYSTEM_AGENTS) state.agents.set(b.id, structuredClone(b));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  beforeEach(() => {
    deploy = fakeDeployProvider();
    state.deployProvider = deploy;
  });

  after(() => {
    cp.close();
    rmSync(regDir, { recursive: true, force: true });
  });

  it('registration pins the given commit on the agent record', async () => {
    const res = await call('/api/v1/registry/agents', 'POST', { id: 'donna', name: 'Donna', repo: REPO, commit: C1 });
    assert.equal(res.status, 201);
    assert.equal(res.body.repo, REPO);
    assert.equal(res.body.commit, C1);
    assert.equal(resolved.length, 0, 'an explicit commit is not re-resolved');
    const stored = JSON.parse(readFileSync(join(regDir, 'donna.json'), 'utf8'));
    assert.equal(stored.commit, C1);
    const reg = actions('donna').find((e) => e.action === 'AGENT_REGISTERED');
    assert.equal(reg?.commit, C1);
  });

  it('registration without a commit resolves the default-branch HEAD once and pins it', async () => {
    const res = await call('/api/v1/registry/agents', 'POST', { id: 'headless', repo: 'https://github.com/example/agent.git' });
    assert.equal(res.status, 201);
    assert.equal(res.body.commit, HEAD);
    assert.deepEqual(resolved, ['https://github.com/example/agent.git']);
    const unresolved = await call('/api/v1/registry/agents', 'POST', { id: 'nope', repo: 'https://github.com/example/unreachable.git' });
    assert.equal(unresolved.status, 422);
    assert.equal(unresolved.body.error, 'commit_unresolved');
    assert.equal(state.agents.has('nope'), false);
  });

  it('registration refuses a short or mutable ref, a credentialed URL, and built-in ids', async () => {
    for (const commit of ['main', 'e3410b5', C1.toUpperCase()]) {
      const r = await call('/api/v1/registry/agents', 'POST', { id: 'bad-commit', repo: REPO, commit });
      assert.equal(r.status, 400, commit);
      assert.equal(r.body.error, 'invalid_commit');
    }
    const cred = await call('/api/v1/registry/agents', 'POST', { id: 'bad-repo', repo: 'https://x-access-token:ghp_abc@github.com/o/r.git', commit: C1 });
    assert.equal(cred.status, 400);
    assert.equal(cred.body.error, 'invalid_repo');
    assert.equal(checkRepoUrl('--upload-pack=touch /tmp/x'), undefined);
    const builtin = await call('/api/v1/registry/agents', 'POST', { id: 'gatekeeper-ingress', repo: REPO, commit: C1 });
    assert.equal(builtin.status, 409);
    assert.equal(state.agents.get('gatekeeper-ingress')?.name, 'gatekeeper-ingress');
  });

  it('deploy without the agent’s own policy (or with no routes) is refused 409 policy_required', async () => {
    const res = await call('/api/v1/registry/agents/donna/deploy', 'POST');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'policy_required');
    state.policies.set('donna', { routes: [] });
    const empty = await call('/api/v1/registry/agents/donna/deploy', 'POST');
    assert.equal(empty.status, 409);
    assert.equal(empty.body.error, 'policy_required');
    assert.equal(deploy.builds.length, 0);
  });

  it('deploy of an agent with no pinned source is refused rather than built from latest', async () => {
    await call('/api/v1/registry/agents', 'POST', { id: 'unpinned', name: 'No repo' });
    state.policies.set('unpinned', { routes: ['anthropic'] });
    const res = await call('/api/v1/registry/agents/unpinned/deploy', 'POST');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'commit_required');
    assert.equal(deploy.builds.length, 0);
  });

  it('deploy builds exactly the pinned commit and registers the SHA-tagged image, recording deployedCommit', async () => {
    state.policies.set('donna', { routes: ['xai', 'discord'] });
    const res = await call('/api/v1/registry/agents/donna/deploy', 'POST');
    assert.equal(res.status, 202);
    const agent = await settled('donna');
    assert.deepEqual(deploy.builds, [{ agentId: 'donna', source: { repo: REPO, commit: C1 } }]);
    const image = `${ECR}:donna-${C1.slice(0, 12)}`;
    assert.deepEqual(deploy.computes, [{ agentId: 'donna', imageUri: image }]);
    assert.equal(agent.state, 'SLEEPING');
    assert.equal(agent.deployedCommit, C1);
    assert.equal(agent.artifact, image);
    assert.equal(agent.admission?.status, 'admitted');
    const stored = JSON.parse(readFileSync(join(regDir, 'donna.json'), 'utf8'));
    assert.equal(stored.deployedCommit, C1);
    const deployed = actions('donna').find((e) => e.action === 'AGENT_DEPLOYED');
    assert.ok(deployed, 'AGENT_DEPLOYED ledgered');
    assert.equal(deployed.commit, C1);
    assert.equal(JSON.stringify(actions('donna')).includes('secret'), false);
  });

  it('a failing admission build (tests_failed) refuses the new commit and keeps the running version', async () => {
    deploy.refuse = 'tests_failed';
    const res = await call('/api/v1/registry/agents/donna/deploy', 'POST', { commit: C2 });
    assert.equal(res.status, 202);
    const agent = await settled('donna');
    assert.equal(deploy.computes.length, 0, 'nothing registered for a refused commit');
    assert.equal(agent.admission?.status, 'refused');
    assert.equal(agent.admission?.reason, 'tests_failed');
    assert.equal(agent.admission?.commit, C2);
    assert.equal(agent.admission?.phase, 'PRE_BUILD');
    assert.equal(agent.deployedCommit, C1, 'the admitted commit is still the deployed one');
    assert.equal(agent.state, 'SLEEPING');
    assert.ok(actions('donna').some((e) => e.action === 'AGENT_ADMISSION_REFUSED:tests_failed' && e.commit === C2));
  });

  it('a repository without tests (no_tests) is refused with the reason and never deployed', async () => {
    deploy.refuse = 'no_tests';
    state.policies.set('headless', { routes: ['anthropic'] });
    const res = await call('/api/v1/registry/agents/headless/deploy', 'POST');
    assert.equal(res.status, 202);
    const agent = await settled('headless');
    assert.equal(agent.state, 'ERROR');
    assert.equal(agent.admission?.reason, 'no_tests');
    assert.equal(agent.deployedCommit, undefined);
    assert.equal(deploy.computes.length, 0);
    const got = await call('/api/v1/registry/agents/headless');
    assert.equal(got.body.admission.reason, 'no_tests');
    assert.ok(actions('headless').some((e) => e.action === 'AGENT_ADMISSION_REFUSED:no_tests'));
  });

  it('deploy refuses an invalid commit in the request', async () => {
    const res = await call('/api/v1/registry/agents/donna/deploy', 'POST', { commit: 'latest' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_commit');
  });
});

describe('AWS admission build (CodeBuild)', () => {
  const failed = (phaseType: string, message: string): Build => ({
    buildStatus: 'FAILED',
    phases: [
      { phaseType: 'SUBMITTED', phaseStatus: 'SUCCEEDED' },
      { phaseType: 'INSTALL', phaseStatus: phaseType === 'INSTALL' ? 'FAILED' : 'SUCCEEDED', contexts: phaseType === 'INSTALL' ? [{ message }] : [] },
      ...(phaseType === 'INSTALL' ? [] : [{ phaseType, phaseStatus: 'FAILED' as const, contexts: [{ statusCode: 'COMMAND_EXECUTION_ERROR', message }] }]),
      { phaseType: 'COMPLETED' },
    ],
  });

  it('maps the buildspec exit codes and failed phase to refusal reasons', () => {
    const cases: Array<[string, string, AdmissionRefusal]> = [
      ['PRE_BUILD', 'Error while executing command: case "$KIND" in ... Reason: exit status 3', 'no_tests'],
      ['PRE_BUILD', 'Error while executing command: KNOWN=... Reason: exit status 6', 'hardcoded_secret'],
      ['PRE_BUILD', 'Error while executing command: case "$KIND" in ... Reason: exit status 4', 'tests_failed'],
      ['INSTALL', 'Error while executing command: git clone. Reason: exit status 5', 'source_unavailable'],
      ['BUILD', 'Error while executing command: docker build. Reason: exit status 1', 'build_failed'],
      ['POST_BUILD', 'Error while executing command: docker push. Reason: exit status 1', 'push_failed'],
    ];
    for (const [phase, message, reason] of cases) {
      const err = admissionFailure(failed(phase, message));
      assert.equal(err.reason, reason, message);
      assert.equal(err.phase, phase);
      assert.ok(err.message.includes(phase));
    }
  });

  it('starts the pinned build and returns the commit-tagged image, polling until it ends', async () => {
    process.env.FACTORY_ECR_REPO_URI = ECR;
    const sent: Array<{ name: string; input: any }> = [];
    let polls = 0;
    const client = {
      async send(cmd: { constructor: { name: string }; input: any }) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'StartBuildCommand') return { build: { id: 'b-1' } };
        polls += 1;
        return { builds: [{ id: 'b-1', buildStatus: polls < 2 ? 'IN_PROGRESS' : 'SUCCEEDED' }] };
      },
    };
    const image = await buildAgentImage('donna', { repo: REPO, commit: C1 }, { client: client as any, pollMs: 1 });
    assert.equal(image, `${ECR}:donna-e3410b53beb5`);
    const env = Object.fromEntries(sent[0].input.environmentVariablesOverride.map((v: any) => [v.name, v.value]));
    assert.deepEqual(env, { AGENT_ID: 'donna', REPO_URL: REPO, GIT_COMMIT: C1, IMAGE_TAG: 'donna-e3410b53beb5' });
    assert.equal(sent[0].input.sourceLocationOverride, undefined);
    assert.equal(polls, 2);
  });

  it('surfaces a failed build as an AdmissionRefusedError', async () => {
    process.env.FACTORY_ECR_REPO_URI = ECR;
    const client = {
      async send(cmd: { constructor: { name: string } }) {
        if (cmd.constructor.name === 'StartBuildCommand') return { build: { id: 'b-2' } };
        return { builds: [failed('PRE_BUILD', 'Error while executing command: x. Reason: exit status 3')] };
      },
    };
    await assert.rejects(
      buildAgentImage('donna', { repo: REPO, commit: C1 }, { client: client as any, pollMs: 1 }),
      (err: unknown) => err instanceof AdmissionRefusedError && err.reason === 'no_tests' && err.phase === 'PRE_BUILD',
    );
  });
});
