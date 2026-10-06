// GAP-093, TSK-114: an agent stuck in ERROR, or holding a run nothing is running, can be reset from the API; and a
// budget change from the console's budget field lets a budget-blocked run go again, as the policy editor already did.
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { loadCatalog } from './catalog.js';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const OPERATOR = 'operator-token';
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';

function setup() {
  const agents = new Map(loadCatalog(agentsRoot, { includeRetired: true }).map((a) => [a.id, a]));
  if (!agents.has('donna')) {
    agents.set('donna', {
      id: 'donna',
      name: 'Donna',
      role: 'Executive Assistant',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: 'donna',
      warmDownSeconds: 300,
      dir: '/tmp/donna',
      model: 'deterministic',
      requestedModels: [],
      approvedModels: [],
    });
  }
  const state = {
    agents,
    ledger: new MemoryLedger(),
    auth: bearerAuth([
      { name: 'operator', token: OPERATOR, roles: ['operator'] },
      { name: 'admin', token: ADMIN, roles: ['admin'] },
      { name: 'viewer', token: VIEWER, roles: ['viewer'] },
    ]),
    version: 'test',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    runTokens: new RunTokens(undefined),
    callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    approvals: new ApprovalStore(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
  } as unknown as FactoryState;
  return state;
}

async function listen(state: FactoryState): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createFactoryServer(state);
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function call(port: number, method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ledgerActions = (state: FactoryState, agentId: string) => state.ledger.query({ agent: agentId }).map((e) => e.action);

describe('reset an agent', () => {
  it('ends the runs it still has and returns an ERROR agent to SLEEPING', async () => {
    const state = setup();
    const donna = state.agents.get('donna')!;
    donna.state = 'ERROR';
    const run = state.runs.create({ agentId: 'donna', state: 'BLOCKED_BUDGET_EXCEEDED', actor: 'test', trigger: 'manual' });
    const srv = await listen(state);
    try {
      const res = await call(srv.port, 'POST', '/api/v1/agents/donna/reset', OPERATOR);
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'SLEEPING');
      assert.equal(donna.state, 'SLEEPING');
      assert.equal(state.runs.get(run.runId)!.state, 'CANCELLED');
      assert.deepEqual(state.runs.list({ agentId: 'donna', active: true }), []);
      const row = state.ledger.query({ agent: 'donna' }).find((e) => e.action === 'AGENT_RESET')!;
      assert.equal(row.actor, 'token:operator');
      assert.equal(ledgerActions(state, 'donna').filter((a) => a === 'RUN_CANCELLED').length, 1, 'each ended run is ledgered');
    } finally {
      await srv.close();
    }
  });

  it('works on a sleeping agent with nothing to end, and writes the ledger row', async () => {
    const state = setup();
    state.agents.get('donna')!.state = 'SLEEPING';
    const srv = await listen(state);
    try {
      const res = await call(srv.port, 'POST', '/api/v1/agents/donna/reset', ADMIN);
      assert.equal(res.status, 200);
      assert.ok(ledgerActions(state, 'donna').includes('AGENT_RESET'));
    } finally {
      await srv.close();
    }
  });

  it('refuses a paused or isolated agent (their own controls apply) and an unknown agent', async () => {
    const state = setup();
    const srv = await listen(state);
    try {
      for (const s of ['PAUSED', 'ISOLATED'] as const) {
        state.agents.get('donna')!.state = s;
        const res = await call(srv.port, 'POST', '/api/v1/agents/donna/reset', OPERATOR);
        assert.equal(res.status, 409, s);
        assert.equal(state.agents.get('donna')!.state, s);
      }
      assert.equal((await call(srv.port, 'POST', '/api/v1/agents/nope/reset', OPERATOR)).status, 404);
    } finally {
      await srv.close();
    }
  });

  it('needs the operator role: a viewer is refused, and the refusal names the role', async () => {
    const state = setup();
    state.agents.get('donna')!.state = 'ERROR';
    const srv = await listen(state);
    try {
      const res = await call(srv.port, 'POST', '/api/v1/agents/donna/reset', VIEWER);
      assert.equal(res.status, 403);
      assert.equal(res.body.required, 'operator');
      assert.equal(state.agents.get('donna')!.state, 'ERROR');
    } finally {
      await srv.close();
    }
  });

  it('does not touch the budget: an over-budget agent is still refused at the next wake', async () => {
    const state = setup();
    state.agents.get('donna')!.state = 'ERROR';
    state.policies.set('donna', { routes: [], budgetUsd: { perMonth: 1 } });
    state.spend.add('donna', 'prior-run', 5, new Date().toISOString());
    const srv = await listen(state);
    try {
      assert.equal((await call(srv.port, 'POST', '/api/v1/agents/donna/reset', OPERATOR)).status, 200);
      const wake = await call(srv.port, 'POST', '/api/v1/agents/donna/wake', OPERATOR);
      assert.equal(wake.status, 402);
      assert.equal(wake.body.window, 'perMonth');
      assert.deepEqual(state.policies.get('donna').budgetUsd, { perMonth: 1 });
    } finally {
      await srv.close();
    }
  });
});

describe("the console's budget field lets a budget-blocked run go again", () => {
  it('raising the limit above spend unblocks the run; a limit still below spend leaves it blocked', async () => {
    const state = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perMonth: 1 } });
    state.spend.add('donna', 'prior-run', 5, new Date().toISOString());
    const run = state.runs.create({ agentId: 'donna', state: 'BLOCKED_BUDGET_EXCEEDED', actor: 'test', trigger: 'manual' });
    const srv = await listen(state);
    try {
      const low = await call(srv.port, 'PUT', '/api/v1/registry/agents/donna/budget', ADMIN, { spendLimitUsd: 2, period: 'monthly' });
      assert.equal(low.status, 200);
      assert.equal(state.runs.get(run.runId)!.state, 'BLOCKED_BUDGET_EXCEEDED');
      const high = await call(srv.port, 'PUT', '/api/v1/registry/agents/donna/budget', ADMIN, { spendLimitUsd: 50, period: 'monthly' });
      assert.equal(high.status, 200);
      assert.equal(state.runs.get(run.runId)!.state, 'WORKING');
      assert.ok(ledgerActions(state, 'donna').includes('RUN_UNBLOCKED'));
    } finally {
      await srv.close();
    }
  });
});
