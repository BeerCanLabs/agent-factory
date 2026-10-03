import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, PolicyStore } from './policy.js';
import { EventHub, RunProgress, isBusWorthy, tapLedger, type FactoryEvent } from './events.js';

const KEY = 'progress-e2e-run-token-key-0123456789abcdef';
const VIEWER = 'viewer-progress-e2e';
const GATEKEEPER_EGRESS = 'gatekeeper-egress-progress-e2e';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('§6.5 run progress events: run-scoped, bounded, headless', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const hub = new EventHub();
  const published: FactoryEvent[] = [];
  const runTokens = new RunTokens(KEY);

  const liveRun = async (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'test' });
    return { run, token: await runTokens.mint({ runId: run.runId, agentId }) };
  };
  const ev = (runId: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    agentId,
    at: new Date().toISOString(),
    kind: 'call.start',
    callId: `c-${Math.random().toString(36).slice(2)}`,
    route: 'google-gmail',
    ...extra,
  });
  const report = (events: unknown[], token = GATEKEEPER_EGRESS) => call(port, '/api/v1/gatekeeper-egress/progress', 'POST', token, { events });

  before(async () => {
    state = {
      agents: new Map(),
      ledger: tapLedger(new MemoryLedger(), hub),
      auth: bearerAuth([
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'gatekeeper-egress', token: GATEKEEPER_EGRESS, roles: ['gatekeeper-egress'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as FactoryState;
    hub.subscribe((e) => published.push(e));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('§6.5 a run reads its own progress events, in order, from a cursor', async () => {
    const { run, token } = await liveRun('donna');
    const first = await call(port, `/api/v1/runs/${run.runId}/events`, 'GET', token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.events, []);
    const cursor = first.body.next;

    assert.equal((await report([ev(run.runId, 'donna'), ev(run.runId, 'donna', { kind: 'call.end', status: 200, durationMs: 412, outcome: 'ok' })])).body.accepted, 2);
    const got = await call(port, `/api/v1/runs/${run.runId}/events?after=${cursor}`, 'GET', token);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.events.map((e: { kind: string; seq: number }) => [e.kind, e.seq]), [['call.start', 1], ['call.end', 2]]);
    assert.equal(got.body.events[1].outcome, 'ok');
    assert.equal(got.body.next, 2);

    const none = await call(port, `/api/v1/runs/${run.runId}/events?after=2&wait=0`, 'GET', token);
    assert.deepEqual(none.body.events, []);
  });

  it('§6.5 a waiting reader is answered as soon as an event arrives (long poll)', async () => {
    const { run, token } = await liveRun('donna');
    const t0 = Date.now();
    const pending = call(port, `/api/v1/runs/${run.runId}/events?after=0&wait=10000`, 'GET', token);
    await new Promise((r) => setTimeout(r, 50));
    await report([ev(run.runId, 'donna', { route: 'models', model: 'claude-sonnet' })]);
    const got = await pending;
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(got.body.events.length, 1);
    assert.equal(got.body.events[0].model, 'claude-sonnet');
  });

  it("E2 the events endpoint refuses another run's token, a forged token, no token, and a finished run", async () => {
    const a = await liveRun('donna');
    const b = await liveRun('finley');
    await report([ev(a.run.runId, 'donna')]);
    assert.equal((await call(port, `/api/v1/runs/${a.run.runId}/events?wait=0`, 'GET', b.token)).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${a.run.runId}/events?wait=0`)).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${a.run.runId}/events?wait=0`, 'GET', VIEWER)).status, 401, 'an operator token is not the run');
    const forged = await new RunTokens('another-key-0123456789abcdef0123456789').mint({ runId: a.run.runId, agentId: 'donna' });
    assert.equal((await call(port, `/api/v1/runs/${a.run.runId}/events?wait=0`, 'GET', forged)).status, 401);
    state.runs.update(a.run.runId, { state: 'DONE' });
    assert.equal((await call(port, `/api/v1/runs/${a.run.runId}/events?wait=0`, 'GET', a.token)).status, 401);
  });

  it('E2 only gatekeeper-egress reports progress, and only for a live run of the agent it names', async () => {
    const { run, token } = await liveRun('donna');
    assert.equal((await report([ev(run.runId, 'donna')], VIEWER)).status, 403);
    assert.equal((await report([ev(run.runId, 'donna')], token)).status, 401, 'a run cannot write its own progress');
    assert.equal((await report([ev(run.runId, 'finley'), ev('no-such-run', 'donna')])).body.accepted, 0);
    const got = await call(port, `/api/v1/runs/${run.runId}/events?wait=0`, 'GET', token);
    assert.deepEqual(got.body.events, []);
  });

  it('E3 S1 only declared metadata fields are kept: bodies, URLs, headers and secrets are dropped', async () => {
    const { run, token } = await liveRun('donna');
    await report([
      ev(run.runId, 'donna', { body: 'private body', url: 'https://gmail.googleapis.com/x?q=secret', headers: { authorization: 'Bearer sk-live' }, model: 'has spaces?q=1' }),
      ev(run.runId, 'donna', { route: 'https://gmail.googleapis.com/x?q=secret' }),
    ]);
    const got = await call(port, `/api/v1/runs/${run.runId}/events?wait=0`, 'GET', token);
    assert.equal(got.body.events.length, 1, 'an event whose route is not an identifier is refused');
    const wire = JSON.stringify(got.body);
    for (const leak of ['private body', 'googleapis', 'sk-live', 'authorization', '?q=']) assert.ok(!wire.includes(leak), `leaked ${leak}`);
    assert.deepEqual(Object.keys(got.body.events[0]).sort(), ['agentId', 'at', 'callId', 'kind', 'route', 'runId', 'seq']);
  });

  it('§6.5 progress is published on the event hub but never sent to the enterprise bus', async () => {
    const { run } = await liveRun('donna');
    published.length = 0;
    await report([ev(run.runId, 'donna')]);
    const p = published.filter((e) => e.kind === 'progress');
    assert.equal(p.length, 1);
    assert.equal(p[0].agentId, 'donna');
    assert.equal(isBusWorthy(p[0]), false);
  });

  it('§6.5 the per-run buffer is bounded (last 100 events) and so is the number of runs', async () => {
    const { run, token } = await liveRun('donna');
    const many = Array.from({ length: 130 }, () => ev(run.runId, 'donna'));
    assert.equal((await report(many)).body.accepted, 130);
    const got = await call(port, `/api/v1/runs/${run.runId}/events?wait=0`, 'GET', token);
    assert.equal(got.body.events.length, 100);
    assert.equal(got.body.events[0].seq, 31);
    assert.equal(got.body.next, 130);

    const small = new RunProgress(3, 2);
    for (const id of ['r1', 'r2', 'r3']) small.append({ runId: id, agentId: 'a', at: new Date().toISOString(), kind: 'call.start', callId: 'c', route: 'x' });
    assert.equal(small.size, 2);
    assert.deepEqual(small.read('r1').events, [], 'the stalest run was dropped');
  });
});
