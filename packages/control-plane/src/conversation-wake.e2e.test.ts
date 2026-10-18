// GAP-176, TSK-237: a message to an agent with no run wakes it through the one wake path (§6.15); a message to a live
// run goes to its mailbox and starts nothing; a WORKING agent that outlived its run goes back to sleep; and heartbeats are
// judged from this control plane's start, not across the gap a stop-then-start deploy leaves (prod 2026-10-18).
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, checkHealth, noopRuntime, reconcileRuns } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

const OPERATOR = 'operator-token';

function setup() {
  const runtime = noopRuntime();
  const rosie = {
    id: 'rosie',
    name: 'Rosie',
    role: 'Smart Home',
    state: 'SLEEPING',
    provider: 'local',
    artifact: '',
    requires: [],
    ungated: [],
    gated: [],
    triggers: [],
    memoryPrefix: 'rosie',
    warmDownSeconds: 300,
    dir: '/tmp/rosie',
    requestedModels: [],
    approvedModels: [],
  };
  const state = {
    agents: new Map([['rosie', rosie]]),
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

async function converse(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents/rosie/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; woke?: boolean; runId?: string } };
}

const handoffs = (state: FactoryState) => state.ledger.query({ agent: 'rosie' }).filter((e) => e.action === 'CONVERSATION_HANDOFF');

describe('a message always reaches an agent (GAP-176, §6.15)', () => {
  it('wakes an agent with no run: exactly one run, carrying the message, and the handoff names it', async () => {
    const { state, runtime } = setup();
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, { input: { content: 'hey Rosie', channelId: 'c1' } });
      assert.equal(res.status, 202);
      assert.equal(res.body.woke, true);
      const runs = state.runs.list({ agentId: 'rosie' });
      assert.equal(runs.length, 1, 'exactly one run');
      assert.equal(runs[0].runId, res.body.runId);
      assert.equal(runs[0].trigger, 'conversation');
      assert.deepEqual(runs[0].input, { content: 'hey Rosie', channelId: 'c1' });
      assert.equal(runtime.started.length, 1, 'the container was started once');
      assert.equal(state.mailboxes?.get('rosie')?.messages.length ?? 0, 0, 'nothing parked in the mailbox');
      const rows = handoffs(state);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].runId, res.body.runId, 'the handoff is tied to the run that serves it');
    } finally {
      await srv.close();
    }
  });

  it('delivers to the mailbox of a live run and starts nothing', async () => {
    const { state, runtime } = setup();
    const srv = await listen(state);
    try {
      const first = await converse(srv.port, { input: { content: 'one' } });
      const second = await converse(srv.port, { input: { content: 'two' } });
      assert.equal(second.status, 202);
      assert.equal(second.body.woke, undefined);
      assert.equal(state.runs.list({ agentId: 'rosie' }).length, 1, 'no second run');
      assert.equal(runtime.started.length, 1);
      assert.deepEqual(state.mailboxes?.get('rosie')?.messages.map((m) => m.payload), [{ content: 'two' }]);
      assert.equal(handoffs(state)[1].runId, first.body.runId);
    } finally {
      await srv.close();
    }
  });

  it('a wake refusal is returned and starts nothing', async () => {
    const { state, runtime } = setup();
    Object.assign(state.agents.get('rosie')!, { requires: ['ROSIE_HA_TOKEN'], ungated: ['ROSIE_HA_TOKEN'] });
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, { input: { content: 'hey' } });
      assert.equal(res.status, 412, 'unbound secrets refuse the wake, as on /wake');
      assert.equal(runtime.started.length, 0);
      assert.equal(handoffs(state).length, 0, 'nothing was handed off');
    } finally {
      await srv.close();
    }
  });
});

describe('agent state and health follow the runs (GAP-176)', () => {
  it('reconcile puts a WORKING agent with no live run back to sleep', async () => {
    const { state } = setup();
    state.agents.get('rosie')!.state = 'WORKING';
    await reconcileRuns(state);
    assert.equal(state.agents.get('rosie')!.state, 'SLEEPING');
  });

  it('reconcile leaves a WORKING agent with a live run alone', async () => {
    const { state } = setup();
    const srv = await listen(state);
    try {
      await converse(srv.port, { input: { content: 'hi' } });
      assert.equal(state.agents.get('rosie')!.state, 'WORKING');
      await reconcileRuns(state);
      assert.equal(state.agents.get('rosie')!.state, 'WORKING');
    } finally {
      await srv.close();
    }
  });

  it('a heartbeat older than this control plane is not lost until a full timeout after it started', async () => {
    const { state } = setup();
    const srv = await listen(state);
    try {
      const res = await converse(srv.port, { input: { content: 'hi' } });
      const t0 = Date.parse('2026-10-18T06:20:19Z');
      // Last heartbeat before the deploy's gap; this control plane started six minutes later.
      state.runs.update(res.body.runId!, { lastHeartbeatAt: '2026-10-18T06:14:07Z' });
      Object.assign(state, { heartbeatTimeoutMs: 90_000, healthSince: t0 });
      await checkHealth(state, t0 + 15_000);
      assert.equal(state.runs.get(res.body.runId!)!.state, 'WORKING', 'not halted on a gap the agent did not cause');
      await checkHealth(state, t0 + 91_000);
      assert.equal(state.runs.get(res.body.runId!)!.state, 'BLOCKED_UNHEALTHY', 'still halted once silent for a full timeout');
    } finally {
      await srv.close();
    }
  });
});
