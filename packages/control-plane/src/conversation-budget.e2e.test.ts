// GAP-091, TSK-113: a message into a live run asks the Treasurer first, as a wake does and the egress does on every
// model call. The refusal names the window; the agent never receives the message.
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { loadCatalog, BUILTIN_SYSTEM_AGENTS } from './catalog.js';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const OPERATOR = 'operator-token';

function setup() {
  const runtime = noopRuntime();
  const agents = new Map(loadCatalog(agentsRoot, { includeRetired: true }).map((a) => [a.id, a]));
  const state = {
    agents,
    ledger: new MemoryLedger(),
    auth: bearerAuth([{ name: 'operator', token: OPERATOR, roles: ['operator'] }]),
    version: 'test',
    providers: [envProvider({})],
    runtime,
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
  return { state, runtime };
}

async function listen(state: FactoryState): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createFactoryServer(state);
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function converse(port: number, agentId: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents/${agentId}/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; window?: string; ok?: boolean } };
}

const refusals = (state: FactoryState, agentId: string) => state.ledger.query({ agent: agentId }).filter((e) => e.action === 'CONVERSATION_REFUSED_BUDGET_EXCEEDED');
const handoffs = (state: FactoryState, agentId: string) => state.ledger.query({ agent: agentId }).filter((e) => e.action === 'CONVERSATION_HANDOFF');

describe('a message into a live run asks the Treasurer first', () => {
  it('an agent in good standing takes the message (202)', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perDay: 10, perMonth: 100 } });
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, 'donna', { content: 'hi', channelId: 'c1' });
      assert.equal(res.status, 202);
      assert.equal(handoffs(state, 'donna').length, 1);
      assert.equal(refusals(state, 'donna').length, 0);
    } finally {
      await srv.close();
    }
  });

  it('over the daily limit: 402 with the window, nothing delivered, one refusal row', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perDay: 1, perMonth: 100 } });
    state.spend.add('donna', 'prior-run', 5, new Date().toISOString());
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, 'donna', { content: 'how many steps?', channelId: 'c1' });
      assert.equal(res.status, 402);
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'perDay' });
      assert.equal(handoffs(state, 'donna').length, 0, 'the agent never receives the message');
      assert.equal(refusals(state, 'donna').length, 1);
    } finally {
      await srv.close();
    }
  });

  it('over the monthly limit names perMonth', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perMonth: 1 } });
    state.spend.add('donna', 'prior-run', 5, new Date().toISOString());
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, 'donna', { content: 'hi' });
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'perMonth' });
    } finally {
      await srv.close();
    }
  });

  it('a live run already flagged BLOCKED_BUDGET_EXCEEDED reports blocked', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perDay: 100 } });
    state.runs.create({ agentId: 'donna', state: 'BLOCKED_BUDGET_EXCEEDED', actor: 'test', trigger: 'manual' });
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, 'donna', { content: 'hi' });
      assert.equal(res.status, 402);
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'blocked' });
      assert.equal(handoffs(state, 'donna').length, 0);
    } finally {
      await srv.close();
    }
  });

  it('perRun counts when a run exists, and only then', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perRun: 0.5, perDay: 100 } });
    const srv = await listen(state);
    try {
      assert.equal((await converse(srv.port, 'donna', { content: 'no run yet' })).status, 202);
      const run = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'test', trigger: 'manual' });
      state.spend.add('donna', run.runId, 2, new Date().toISOString());
      const res = await converse(srv.port, 'donna', { content: 'live run over its own limit' });
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'perRun' });
    } finally {
      await srv.close();
    }
  });

  it('built-in agents are exempt, and an agent with no budget is unaffected', async () => {
    const { state } = setup();
    const srv = await listen(state);
    try {
      assert.equal((await converse(srv.port, 'donna', { content: 'no policy' })).status, 202);
      // echo-agent is a built-in cartridge; doctor is a built-in system agent. Both stay exempt.
      state.agents.set('doctor', { ...BUILTIN_SYSTEM_AGENTS.find((a) => a.id === 'doctor')! });
      for (const id of ['echo-agent', 'doctor']) {
        state.policies.set(id, { routes: [], budgetUsd: { perDay: 1 } });
        state.spend.add(id, 'prior-run', 5, new Date().toISOString());
        assert.equal((await converse(srv.port, id, { content: 'built-in' })).status, 202, id);
      }
    } finally {
      await srv.close();
    }
  });

  it('raising the limit lets the next message through', async () => {
    const { state } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perDay: 1 } });
    state.spend.add('donna', 'prior-run', 5, new Date().toISOString());
    const srv = await listen(state);
    try {
      assert.equal((await converse(srv.port, 'donna', { content: 'one' })).status, 402);
      state.policies.set('donna', { routes: [], budgetUsd: { perDay: 50 } });
      assert.equal((await converse(srv.port, 'donna', { content: 'two' })).status, 202);
    } finally {
      await srv.close();
    }
  });
});
