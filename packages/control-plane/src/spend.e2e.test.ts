import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker, type CloudCostSource, type ComputeSource } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
import { createTreasury } from './spend.js';
import type { AgentRecord } from '@beercanlabs/factory-registrar';

const KEY = 'spend-e2e-run-token-key-0123456789abcdef';
const ADMIN = 'admin-spend-e2e';
const VIEWER = 'viewer-spend-e2e';
const GATEKEEPER_EGRESS = 'gatekeeper-egress-spend-e2e';

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
        { name: 'gatekeeper-egress', token: GATEKEEPER_EGRESS, roles: ['gatekeeper-egress'] },
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

    // Two metered model calls by donna, attested by the gatekeeper-egress (the same path production uses).
    const { run } = await tokenFor('donna', 'WORKING');
    for (const [model, inT, outT, usd] of [['claude-sonnet-4-5', 1000, 200, 0.006], ['claude-haiku-4-5', 500, 100, 0.001]] as const) {
      const r = await call(port, '/api/v1/ledger', 'POST', GATEKEEPER_EGRESS, {
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

describe('Treasurer endpoints (/report, /compute, /budgets) (DESIGN_AUTHORITY §6.15)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const ledger = new MemoryLedger();
  const runTokens = new RunTokens(KEY);

  const mockCloud: CloudCostSource = {
    provider: 'aws',
    costs: async (window) => ({
      provider: 'aws',
      start: window.start,
      end: window.end,
      lines: [
        { recordType: 'Usage', service: 'Amazon Elastic Compute Cloud - Compute', usd: 40 },
        { recordType: 'Usage', service: 'Amazon Bedrock Edition', usd: 10 },
        { recordType: 'Credit', service: 'Amazon Elastic Compute Cloud - Compute', usd: -50 },
      ],
      usage: [
        { service: 'Amazon Elastic Compute Cloud - Compute', usageType: 'BoxUsage:t4g.small', usd: 40, quantity: 720 },
        { service: 'Amazon Bedrock Edition', usageType: 'BedrockUsage', usd: 10, quantity: 100 },
      ],
    }),
  };

  const mockCompute: ComputeSource = {
    provider: 'aws',
    cluster: 'factory-prod-cluster',
    inventory: async () => ({
      provider: 'aws',
      cluster: 'factory-prod-cluster',
      services: [
        { name: 'control-plane', group: 'service:control-plane', running: 1, vcpu: 0.5, memoryGb: 1, spot: false },
      ],
      tasks: [
        { taskArn: 'arn:task:1', group: 'agent-finley', status: 'RUNNING', vcpu: 0.25, memoryGb: 0.5, spot: true, startedAt: new Date(Date.now() - 3600_000).toISOString() },
        { taskArn: 'arn:task:2', group: 'agent-ghost', status: 'RUNNING', vcpu: 0.25, memoryGb: 0.5, spot: false, startedAt: new Date(Date.now() - 7200_000).toISOString() },
      ],
    }),
  };

  const tokenFor = async (agentId: string, runState: 'WORKING' | 'DONE') => {
    const run = state.runs.create({ agentId, state: runState, actor: 'test', trigger: 'test' });
    return { run, token: await runTokens.mint({ runId: run.runId, agentId }) };
  };

  before(async () => {
    const treasury = createTreasury({ cloud: mockCloud, compute: mockCompute });
    treasury.budgets.set({ totalMonthUsd: 300 }, 'system');
    state = {
      agents: new Map<string, AgentRecord>(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      treasury,
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as FactoryState;

    for (const id of ['finley', 'castle']) state.agents.set(id, agent(id));
    state.policies.set('finley', { routes: ['models'], tools: { 'factory-spend': { allow: '*' } } });
    state.policies.set('castle', { routes: ['models'] });

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('GET /api/v1/spend/report builds report, splits gross vs credits, and ledgers read', async () => {
    const r = await call(port, '/api/v1/spend/report', 'GET', VIEWER);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.period.period, 'current');
    assert.equal(r.body.currency, 'USD');
    assert.equal(r.body.totals.infraGrossUsd, 40);
    assert.equal(r.body.totals.creditsUsd, -50);
    assert.equal(r.body.totals.netUsd, -10);
    assert.ok(r.body.budgets);

    const log = ledger.query().find((e) => e.action === 'SPEND_REPORT_READ');
    assert.ok(log, 'SPEND_REPORT_READ not logged');
  });

  it('GET /api/v1/spend/report?period=last queries previous month', async () => {
    const r = await call(port, '/api/v1/spend/report?period=last', 'GET', VIEWER);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.period.period, 'last');
  });

  it('GET /api/v1/spend/report?period=invalid returns 400', async () => {
    const r = await call(port, '/api/v1/spend/report?period=tomorrow', 'GET', VIEWER);
    assert.equal(r.status, 400);
  });

  it('live run with factory-spend can read report; run without it is 403', async () => {
    const finley = await tokenFor('finley', 'WORKING');
    const rAllowed = await call(port, '/api/v1/spend/report', 'GET', finley.token);
    assert.equal(rAllowed.status, 200);

    const castle = await tokenFor('castle', 'WORKING');
    const rDenied = await call(port, '/api/v1/spend/report', 'GET', castle.token);
    assert.equal(rDenied.status, 403);
  });

  it('GET /api/v1/spend/compute reports house services, tasks, spot awareness, and orphans', async () => {
    const r = await call(port, '/api/v1/spend/compute', 'GET', VIEWER);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.cluster, 'factory-prod-cluster');
    assert.equal(r.body.services.length, 1);
    assert.equal(r.body.services[0].name, 'control-plane');
    assert.ok(r.body.houseMonthlyUsd > 0);

    const tasks = r.body.agentTasks;
    assert.equal(tasks.length, 2);
    const finleyTask = tasks.find((t: any) => t.agentId === 'finley');
    assert.ok(finleyTask);
    assert.equal(finleyTask.spot, true);
    // ghost agent is not registered: orphan
    const ghostTask = tasks.find((t: any) => t.agentId === 'ghost');
    assert.ok(ghostTask);
    assert.equal(ghostTask.orphan, true);

    const log = ledger.query().find((e) => e.action === 'SPEND_COMPUTE_READ');
    assert.ok(log, 'SPEND_COMPUTE_READ not logged');
  });

  it('GET /api/v1/spend/budgets returns current and history', async () => {
    const r = await call(port, '/api/v1/spend/budgets', 'GET', VIEWER);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.current.budgets.totalMonthUsd, 300);
    assert.equal(r.body.history.length, 1);

    const log = ledger.query().find((e) => e.action === 'SPEND_BUDGETS_READ');
    assert.ok(log, 'SPEND_BUDGETS_READ not logged');
  });

  it('PUT /api/v1/spend/budgets enforces admin role and updates budget', async () => {
    const viewerAttempt = await call(port, '/api/v1/spend/budgets', 'PUT', VIEWER, { totalMonthUsd: 500 });
    assert.equal(viewerAttempt.status, 403);

    const badPayload = await call(port, '/api/v1/spend/budgets', 'PUT', ADMIN, { totalMonthUsd: -50 });
    assert.equal(badPayload.status, 400);

    const okUpdate = await call(port, '/api/v1/spend/budgets', 'PUT', ADMIN, { totalMonthUsd: 450 });
    assert.equal(okUpdate.status, 200, okUpdate.text);
    assert.equal(okUpdate.body.version, 2);
    assert.equal(okUpdate.body.budgets.totalMonthUsd, 450);

    const afterRead = await call(port, '/api/v1/spend/budgets', 'GET', VIEWER);
    assert.equal(afterRead.body.current.budgets.totalMonthUsd, 450);

    const log = ledger.query().find((e) => e.action === 'FACTORY_BUDGET_SET');
    assert.ok(log, 'FACTORY_BUDGET_SET not logged');
  });

  it('setting a budget that is already crossed emits a budget.alert event', async () => {
    // Current spend in mock is $40 infra + $10 bedrock = $50 total gross.
    // Setting budget to $40 means gross spend $50 exceeds 100% of budget.
    const res = await call(port, '/api/v1/spend/budgets', 'PUT', ADMIN, { totalMonthUsd: 40 });
    assert.equal(res.status, 200);

    const alerts = ledger.query().filter((e) => e.type === 'budget.alert');
    assert.ok(alerts.length > 0, 'No budget.alert emitted');
    assert.ok(alerts.some((a) => a.action?.includes('FACTORY_BUDGET_TOTAL')));
  });
});

