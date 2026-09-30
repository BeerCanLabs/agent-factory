import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import type { AgentRecord } from './catalog.js';

const KEY = 'spend-e2e-run-token-key-0123456789abcdef';
const ADMIN = 'admin-spend-e2e';
const VIEWER = 'viewer-spend-e2e';
const GATEWAY = 'gateway-spend-e2e';

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
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const agent = (id: string): AgentRecord => ({
  id,
  name: id,
  role: 'test',
  state: 'SLEEPING',
  provider: 'local',
  artifact: '',
  requires: [],
  ungated: [],
  gated: [],
  triggers: [{ type: 'http', path: '/run' }],
  memoryPrefix: id,
  dir: `/tmp/${id}`,
});

describe('GET /api/v1/spend (TSK-045, E7 explicit grant)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const ledger = new MemoryLedger();
  const runTokens = new RunTokens(KEY);
  const tokenFor = async (agentId: string, runState: 'WORKING' | 'DONE') => {
    const run = state.runs.create({ agentId, state: runState, actor: 'test', trigger: 'test' });
    return { run, token: await runTokens.mint({ runId: run.runId, agentId }) };
  };

  before(async () => {
    state = {
      agents: new Map<string, AgentRecord>(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'gateway', token: GATEWAY, roles: ['gateway'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(undefined, { routes: ['models'], tools: { 'factory-spend': { allow: '*' } } }),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as FactoryState;
    for (const id of ['finley', 'castle', 'donna']) state.agents.set(id, agent(id));
    state.policies.set('finley', { routes: ['models'], tools: { 'factory-spend': { allow: '*' } } });
    state.policies.set('castle', { routes: ['models', 'github'] });
    cp = createFactoryServer(state);
    port = await listen(cp);

    // Two metered model calls by donna, attested by the gateway (the same path production uses).
    const { run } = await tokenFor('donna', 'WORKING');
    for (const [model, inT, outT, usd] of [['claude-sonnet-4-5', 1000, 200, 0.006], ['claude-haiku-4-5', 500, 100, 0.001]] as const) {
      const r = await call(port, '/api/v1/ledger', 'POST', GATEWAY, {
        agentId: 'donna', runId: run.runId, type: 'llm', actor: 'run:donna', model, inputTokens: inT, outputTokens: outT, costUsd: usd,
      });
      assert.ok(r.status < 300, r.text);
    }
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('a live run whose policy grants factory-spend reads per-agent spend by model, and the read is ledgered', async () => {
    const { run, token } = await tokenFor('finley', 'WORKING');
    const r = await call(port, '/api/v1/spend', 'GET', token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.currency, 'USD');
    const d = r.body.agents.donna;
    assert.equal(d.day.calls, 2);
    assert.equal(d.month.calls, 2);
    assert.equal(d.day.usd, 0.007);
    assert.equal(d.day.inputTokens, 1500);
    assert.equal(d.day.outputTokens, 300);
    assert.deepEqual(d.day.byModel['claude-sonnet-4-5'], { usd: 0.006, calls: 1, inputTokens: 1000, outputTokens: 200 });
    assert.equal(r.body.totalUsd.day, 0.007);
    assert.ok(!r.text.includes('messages') && !r.text.includes('prompt'));
    const row = ledger.query().find((e) => e.action === 'SPEND_READ' && e.runId === undefined && e.actor === `run:finley:${run.runId}`);
    assert.ok(row, 'SPEND_READ not ledgered');
  });

  it('a live run without the grant is 403, even when the factory fallback policy has it', async () => {
    const castle = await tokenFor('castle', 'WORKING');
    assert.equal((await call(port, '/api/v1/spend', 'GET', castle.token)).status, 403);
    // hydra has no admin-set policy: the fallback (which lists factory-spend) must not grant it.
    state.agents.set('hydra', agent('hydra'));
    const hydra = await tokenFor('hydra', 'WORKING');
    assert.equal((await call(port, '/api/v1/spend', 'GET', hydra.token)).status, 403);
  });

  it('a dead run token is 401', async () => {
    const { token } = await tokenFor('finley', 'DONE');
    assert.equal((await call(port, '/api/v1/spend', 'GET', token)).status, 401);
  });

  it('viewer principals may read; anonymous callers may not', async () => {
    assert.equal((await call(port, '/api/v1/spend', 'GET', VIEWER)).status, 200);
    assert.equal((await call(port, '/api/v1/spend', 'GET', ADMIN)).status, 200);
    assert.equal((await call(port, '/api/v1/spend')).status, 401);
    assert.equal((await call(port, '/api/v1/spend', 'GET', 'not-a-token')).status, 401);
  });
});
