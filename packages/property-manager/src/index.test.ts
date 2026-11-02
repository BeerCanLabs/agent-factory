import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRecord } from '@beercanlabs/factory-registrar';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import {
  createRun,
  finishRun,
  MemoryRunStore,
  dockerDeployProvider,
  dockerRuntime,
  dockerApi,
  parseImageMap,
  type DockerApi,
  type PropertyManagerState,
} from './index.js';

describe('Property Manager index and dockerDeployProvider', () => {
  it('exports docker utilities from index', () => {
    assert.equal(typeof dockerDeployProvider, 'function');
    assert.equal(typeof dockerRuntime, 'function');
    assert.equal(typeof dockerApi, 'function');
    assert.equal(typeof parseImageMap, 'function');
  });

  it('dockerDeployProvider builds images, provisions identities, and registers compute', async () => {
    const images: Record<string, string> = { 'known-agent': 'custom-image:1' };
    const provider = dockerDeployProvider(images);

    // buildImage
    assert.equal(await provider.buildImage('known-agent'), 'custom-image:1');
    assert.equal(await provider.buildImage('new-agent'), 'factory-agent-new-agent:dev');

    // buildSkillsImage
    assert.equal(await provider.buildSkillsImage('new-agent', { image: 'base-img:v1' }), 'base-img:v1');

    // provisionIdentity
    assert.deepEqual(await provider.provisionIdentity('new-agent'), { identity: 'docker:new-agent' });

    // registerCompute mutates images map
    await provider.registerCompute('new-agent', 'updated-image:v2');
    assert.equal(images['new-agent'], 'updated-image:v2');
    assert.equal(await provider.buildImage('new-agent'), 'updated-image:v2');
  });

  it('dockerRuntime.start falls back to sha256:<digest> when repo@sha256:<digest> returns 404', async () => {
    const digest = 'a'.repeat(64);
    const repoWithDigest = `factory-agent-runtime@sha256:${digest}`;
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const api: DockerApi = async (method, path, body: any) => {
      calls.push({ method, path, body });
      if (path.startsWith('/containers/create')) {
        if (body?.Image === repoWithDigest) {
          return { status: 404, body: { message: 'No such image' } };
        }
        return { status: 201, body: { Id: 'fallback-c123' } };
      }
      if (path.endsWith('/start')) return { status: 204, body: {} };
      return { status: 200, body: {} };
    };

    const rt = dockerRuntime({
      api,
      images: { 'test-agent': repoWithDigest },
      network: 'test-net',
    });

    const agent: AgentRecord = {
      id: 'test-agent',
      name: 'Test',
      role: 'agent',
      state: 'IDLE',
      provider: 'local',
      artifact: '',
      requires: [],
      triggers: [],
      memoryPrefix: 'test-agent',
      dir: '/tmp',
    };

    const { handle } = await rt.start(agent, {}, { runId: 'run-fallback', runEnv: {} });
    assert.equal(handle, 'docker:fallback-c123');

    const createCalls = calls.filter((c) => c.path.startsWith('/containers/create'));
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].body.Image, repoWithDigest);
    assert.equal(createCalls[1].body.Image, `sha256:${digest}`);
  });
});

describe('Property Manager lifecycle concurrency & trigger attribution (#345)', () => {
  it('never starts two containers concurrently when createRun arrives during finishRun teardown, and stamps trigger on ledger rows', async () => {
    let liveContainers = 0;
    let maxConcurrentContainers = 0;
    const startedRunIds: string[] = [];

    const agent: AgentRecord = {
      id: 'donna',
      name: 'Donna',
      role: 'agent',
      state: 'IDLE',
      provider: 'local',
      artifact: '',
      requires: [],
      triggers: [],
      memoryPrefix: 'donna',
      dir: '/tmp',
    };

    const ledger = new MemoryLedger();
    const state: PropertyManagerState = {
      agents: new Map([['donna', agent]]),
      ledger,
      providers: [envProvider({})],
      runtime: {
        async start(_agent, _secrets, ctx) {
          liveContainers++;
          maxConcurrentContainers = Math.max(maxConcurrentContainers, liveContainers);
          startedRunIds.push(ctx.runId);
          await new Promise((r) => setTimeout(r, 25));
          return { handle: `h-${ctx.runId}` };
        },
        async stop() {
          await new Promise((r) => setTimeout(r, 40));
          liveContainers--;
        },
        running: () => [],
      },
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('pm-concurrency-test-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: { get: () => ({ routes: [], models: [] }), has: () => true },
      spend: new SpendTracker(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set(),
    };

    // 1) Start first scheduled run
    const r1 = await createRun(state, 'donna', { actor: 'factory:scheduler', trigger: 'schedule' });
    assert.equal(r1.status, 202);
    const run1Id = (r1.body as { runId: string }).runId;

    // 2) Queue second scheduled run while r1 is running
    const r2 = await createRun(state, 'donna', { actor: 'factory:scheduler', trigger: 'schedule' });
    const run2Id = (r2.body as { runId: string; state: string }).runId;
    assert.equal((r2.body as { state: string }).state, 'QUEUED');

    // 3) Begin finishing r1 (slow 40ms runtime.stop); mid-teardown, an interactive conversation wake arrives!
    const finishing1 = finishRun(state, run1Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
    await new Promise((r) => setTimeout(r, 10));
    const r3 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
    const run3Id = (r3.body as { runId: string; state: string }).runId;
    assert.equal((r3.body as { state: string }).state, 'QUEUED', 'must queue behind finishing/queued runs, never launch concurrently');

    await finishing1;
    assert.equal(maxConcurrentContainers, 1, 'at most 1 container may run at once');
    assert.deepEqual(startedRunIds, [run1Id, run2Id], 'FIFO order preserved');

    // 4) Finish r2 -> r3 starts
    await finishRun(state, run2Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
    assert.equal(maxConcurrentContainers, 1);
    assert.deepEqual(startedRunIds, [run1Id, run2Id, run3Id]);

    await finishRun(state, run3Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
    assert.equal(liveContainers, 0);

    // Verify ledger rows carry authoritative trigger
    const run1Events = ledger.query().filter((e) => e.runId === run1Id);
    assert.ok(run1Events.length >= 2);
    for (const ev of run1Events) assert.equal(ev.trigger, 'schedule');
    const run3Events = ledger.query().filter((e) => e.runId === run3Id);
    assert.ok(run3Events.length >= 2);
    for (const ev of run3Events) assert.equal(ev.trigger, 'conversation');
  });

  it('F1: skips SLEEPING and offline ingress presence notification when handing straight off to a QUEUED run (#345)', async () => {
    const http = await import('node:http');
    const presenceEvents: Array<{ agentId: string; presence: string }> = [];
    const ingress = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (req.url === '/api/v1/presence') presenceEvents.push(JSON.parse(b));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => ingress.listen(0, '127.0.0.1', r));
    const port = (ingress.address() as { port: number }).port;

    try {
      const agent: AgentRecord = {
        id: 'donna',
        name: 'Donna',
        role: 'agent',
        state: 'SLEEPING',
        provider: 'local',
        artifact: '',
        requires: [],
        triggers: [],
        memoryPrefix: 'donna',
        warmDownSeconds: 300,
        dir: '/tmp',
      };
      const state: PropertyManagerState = {
        agents: new Map([['donna', agent]]),
        ledger: new MemoryLedger(),
        providers: [envProvider({})],
        runtime: {
          start: async (_a, _s, ctx) => ({ handle: `h-${ctx.runId}` }),
          stop: async () => {},
          running: () => false,
        },
        runs: new MemoryRunStore(),
        runTokens: new RunTokens('pm-f1-test-key-0123456789abcdef01234567'),
        callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
        policies: { get: () => ({ routes: [], models: [] }), has: () => true },
        spend: new SpendTracker(),
        gatekeeperIngressUrl: `http://127.0.0.1:${port}`,
        gatekeeperIngressToken: 'test-tok', // secret-scan:allow
        idleMs: 0,
        idleTimers: new Map(),
        secretValues: new Set(),
      };

      const r1 = await createRun(state, 'donna', { actor: 'factory:scheduler', trigger: 'schedule' });
      const run1Id = (r1.body as { runId: string }).runId;
      const r2 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
      const run2Id = (r2.body as { runId: string }).runId;
      presenceEvents.length = 0;

      // Finishing r1 while r2 is QUEUED must NOT emit 'offline' or drop agent.state to SLEEPING
      await finishRun(state, run1Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
      assert.equal(agent.state, 'WORKING');
      assert.deepEqual(
        presenceEvents.map((e) => e.presence),
        ['starting'],
        'must emit starting for r2 without an intervening offline',
      );

      // Finishing r2 with no more queued runs emits 'offline' and sets SLEEPING
      presenceEvents.length = 0;
      await finishRun(state, run2Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
      assert.equal(agent.state, 'SLEEPING');
      assert.deepEqual(presenceEvents.map((e) => e.presence), ['offline']);
    } finally {
      await new Promise<void>((r) => ingress.close(() => r()));
    }
  });

  it('F3: pre-start failures when draining a QUEUED run mark it FAILED without rejecting finishRun and still advance subsequent QUEUED runs (#345)', async () => {
    let secretShouldThrow = false;
    let secretPresent = true;
    const startedRunIds: string[] = [];

    const agent: AgentRecord = {
      id: 'donna',
      name: 'Donna',
      role: 'agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: ['DYNAMIC_SECRET'],
      ungated: ['DYNAMIC_SECRET'],
      triggers: [],
      memoryPrefix: 'donna',
      dir: '/tmp',
    };

    const state: PropertyManagerState = {
      agents: new Map([['donna', agent]]),
      ledger: new MemoryLedger(),
      providers: [
        {
          name: 'flaky',
          async get(name: string) {
            if (secretShouldThrow) throw new Error('secrets backend timeout');
            return secretPresent && name === 'DYNAMIC_SECRET' ? 'val-1234' : undefined;
          },
        },
      ],
      runtime: {
        start: async (_a, _s, ctx) => {
          startedRunIds.push(ctx.runId);
          return { handle: `h-${ctx.runId}` };
        },
        stop: async () => {},
        running: () => false,
      },
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('pm-f3-test-key-0123456789abcdef01234567'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: { get: () => ({ routes: [], models: [] }), has: () => true },
      spend: new SpendTracker(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set(),
    };

    const r1 = await createRun(state, 'donna', { actor: 'factory:scheduler', trigger: 'schedule' });
    const run1Id = (r1.body as { runId: string }).runId;
    const r2 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
    const run2Id = (r2.body as { runId: string }).runId;
    const r3 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
    const run3Id = (r3.body as { runId: string }).runId;
    const r4 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
    const run4Id = (r4.body as { runId: string }).runId;
    const r5 = await createRun(state, 'donna', { actor: 'factory:ingress', trigger: 'conversation' });
    const run5Id = (r5.body as { runId: string }).runId;

    // Force uncached bindAgentSecrets to throw on r2, miss secret on r3, throw in runTokens.mint on r4, then succeed on r5!
    state.secretCache?.clear();
    let bindCalls = 0;
    state.providers = [
      {
        name: 'flaky-seq',
        async get(name: string) {
          bindCalls++;
          if (bindCalls === 1) throw new Error('transient vault failure');
          if (bindCalls === 2) return undefined; // missing secret -> PRE_FLIGHT_MISSING_SECRET
          return name === 'DYNAMIC_SECRET' ? 'val-1234' : undefined;
        },
      },
    ];
    const realTokens = state.runTokens;
    state.runTokens = {
      mint: async (r) => {
        if (r.runId === run4Id) throw new Error('token signer unavailable');
        return realTokens.mint(r);
      },
    } as RunTokens;

    // finishRun(r1) must NOT reject even though r2 throws in bindAgentSecrets, r3 hits PRE_FLIGHT_MISSING_SECRET, and r4 throws in runTokens.mint; r5 must start!
    const done1 = await finishRun(state, run1Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
    assert.equal(done1.state, 'DONE');
    assert.equal(state.runs.get(run2Id)?.state, 'FAILED', 'r2 transitioned to FAILED instead of wedging in STARTING');
    assert.equal(state.runs.get(run3Id)?.state, 'PRE_FLIGHT_MISSING_SECRET', 'r3 recorded PRE_FLIGHT_MISSING_SECRET');
    assert.equal(state.runs.get(run4Id)?.state, 'FAILED', 'r4 mint error transitioned to FAILED instead of wedging in STARTING');
    assert.equal(state.runs.get(run5Id)?.state, 'WORKING', 'r5 behind r2, r3, and r4 still advanced to WORKING');
    assert.deepEqual(startedRunIds, [run1Id, run5Id]);

    await finishRun(state, run5Id, 'DONE', { actor: 'run:donna', exitCode: 0 });
  });
});

