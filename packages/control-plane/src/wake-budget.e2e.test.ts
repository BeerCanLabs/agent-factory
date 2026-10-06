import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { loadCatalog, BUILTIN_SYSTEM_AGENTS } from './catalog.js';
import { createFactoryServer, createRun, SYSTEM, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
import { pollQueueOnce } from './queues.js';
import { ScheduleStore, agentsDueForCron } from '@beercanlabs/factory-timekeeper';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const OPERATOR = 'operator-token';

function setup() {
  const runtime = noopRuntime();
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
      triggers: [{ type: 'webhook', path: '/hooks/donna', secretRef: 'DONNA_WEBHOOK_SECRET' }],
      memoryPrefix: 'donna',
      warmDownSeconds: 300,
      dir: '/tmp/donna',
      model: 'deterministic',
      requestedModels: [],
      approvedModels: [],
    });
  }
  const donna = agents.get('donna')!;
  donna.ungated = [];
  const state = {
    agents,
    ledger: new MemoryLedger(),
    auth: bearerAuth([{ name: 'operator', token: OPERATOR, roles: ['operator'] }]),
    version: 'test',
    providers: [envProvider({ DONNA_WEBHOOK_SECRET: 'whsec', ECHO_WEBHOOK_SECRET: 'echosec' })],
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

/** Day spend is over perDay. perMonth is left high so the refused window is perDay. */
function overDay(state: FactoryState, agentId: string) {
  state.policies.set(agentId, { routes: [], budgetUsd: { perRun: 0.01, perDay: 1, perMonth: 100 } });
  state.spend.add(agentId, 'prior-run', 5, new Date().toISOString());
}

function overMonth(state: FactoryState, agentId: string) {
  state.policies.set(agentId, { routes: [], budgetUsd: { perMonth: 1 } });
  state.spend.add(agentId, 'prior-run', 5, new Date().toISOString());
}

function refusals(state: FactoryState, agentId: string) {
  return state.ledger.query({ agent: agentId }).filter((e) => e.action === 'WAKE_REFUSED_BUDGET_EXCEEDED');
}

async function listen(state: FactoryState): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createFactoryServer(state);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function post(port: number, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; window?: string; runId?: string } };
}

describe('wake asks the Treasurer before a run exists', () => {
  it('manual POST /wake returns 402 and does not start a task', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const srv = await listen(state);
    try {
      const res = await post(srv.port, '/api/v1/agents/donna/wake', undefined, { Authorization: `Bearer ${OPERATOR}` });
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'perDay' });
      assert.equal(res.status, 402);
      assert.equal(runtime.started.length, 0);
      assert.equal(state.runs.list({ agentId: 'donna' }).length, 0);
      const row = refusals(state, 'donna');
      assert.equal(row.length, 1);
      assert.equal(row[0].actor, SYSTEM.policy);
      assert.equal(row[0].type, 'action');
      assert.equal(row[0].runId, undefined);
    } finally {
      await srv.close();
    }
  });

  it('the gatekeeper-ingress wake call is the same refusal', async () => {
    const { state, runtime } = setup();
    overMonth(state, 'donna');
    const srv = await listen(state);
    try {
      // packages/gatekeeper-ingress/src/server.ts posts { input: msg } to this path.
      const res = await post(
        srv.port,
        '/api/v1/agents/donna/wake',
        { input: { text: 'hello', channelId: 'c1' } },
        { Authorization: `Bearer ${OPERATOR}` },
      );
      assert.equal(res.status, 402);
      assert.deepEqual(res.body, { error: 'budget_exceeded', window: 'perMonth' });
      assert.equal(runtime.started.length, 0);
      assert.equal(refusals(state, 'donna').length, 1);
    } finally {
      await srv.close();
    }
  });

  it('a webhook returns 402 and does not start a task', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const srv = await listen(state);
    try {
      const res = await post(srv.port, '/api/v1/hooks/donna', { text: 'ping' }, { 'x-factory-secret': 'whsec' });
      assert.equal(res.status, 402);
      assert.equal(res.body.window, 'perDay');
      assert.equal(runtime.started.length, 0);
      assert.equal(state.runs.list({ agentId: 'donna' }).length, 0);
    } finally {
      await srv.close();
    }
  });

  it('MCP wake_agent returns the refusal body and does not start a task', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const srv = await listen(state);
    try {
      const res = await post(
        srv.port,
        '/mcp',
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wake_agent', arguments: { id: 'donna' } } },
        { Authorization: `Bearer ${OPERATOR}` },
      );
      assert.equal(res.status, 200);
      const text = (res.body as unknown as { result: { content: Array<{ text: string }> } }).result.content[0].text;
      assert.deepEqual(JSON.parse(text), { error: 'budget_exceeded', window: 'perDay' });
      assert.equal(runtime.started.length, 0);
      assert.equal(refusals(state, 'donna').length, 1);
    } finally {
      await srv.close();
    }
  });

  it('a fired cron does not start the agent', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const donna = state.agents.get('donna')!;
    donna.triggers = [...donna.triggers, { type: 'cron', schedule: '* * * * *' }];
    const due = agentsDueForCron(state.agents.values());
    assert.ok(due.some((a) => a.id === 'donna'));
    const out = await createRun(state, 'donna', { actor: SYSTEM.scheduler, trigger: 'cron' });
    assert.equal(out.status, 402);
    assert.deepEqual(out.body, { error: 'budget_exceeded', window: 'perDay' });
    assert.equal(runtime.started.length, 0);
    assert.equal(refusals(state, 'donna').length, 1);
  });

  it('a fired schedule does not start the agent, and checkDue will not retry that minute', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const store = new ScheduleStore();
    state.schedules = store;
    const when = new Date();
    store.save({
      id: 'sched-1',
      agentId: 'donna',
      name: 'tick',
      cron: '* * * * *',
      prompt: 'do the thing',
      enabled: true,
      createdAt: when.toISOString(),
    });
    const due = store.checkDue(when);
    assert.equal(due.length, 1);
    assert.ok(store.get('sched-1')!.lastRunMinute);
    const out = await createRun(state, 'donna', {
      actor: SYSTEM.scheduler,
      trigger: 'schedule',
      input: { content: due[0].prompt, scheduleId: due[0].id, source: 'schedule' },
    });
    assert.equal(out.status, 402);
    assert.equal(runtime.started.length, 0);
    assert.equal(refusals(state, 'donna').length, 1);
    // checkDue stamps lastRunMinute before createRun returns, so a 402 does not come due again in that minute.
    assert.equal(store.checkDue(when).length, 0);
  });

  it('a queued message refused with 402 stays on the queue, writes no ledger row, and runs once the limit is raised', async () => {
    const { state, runtime } = setup();
    overDay(state, 'donna');
    const deleted: string[] = [];
    const cli = async (args: string[]) => {
      if (args[1] === 'receive-message') {
        return JSON.stringify({ Messages: [{ MessageId: '1', ReceiptHandle: 'h1', Body: '{"n":1}' }] });
      }
      deleted.push(args[args.indexOf('--receipt-handle') + 1]);
      return '{}';
    };
    const queue = 'https://sqs.us-east-1.amazonaws.com/1/q';
    assert.equal(await pollQueueOnce(state, 'donna', queue, cli), 0);
    assert.deepEqual(deleted, []);
    assert.equal(runtime.started.length, 0);
    assert.equal(state.runs.list({ agentId: 'donna' }).length, 0);
    assert.equal(refusals(state, 'donna').length, 0);

    state.policies.set('donna', { routes: [], budgetUsd: { perDay: 100, perMonth: 100 } });
    assert.equal(await pollQueueOnce(state, 'donna', queue, cli), 1);
    assert.deepEqual(deleted, ['h1']);
    assert.equal(runtime.started.length, 1);
    assert.equal(runtime.started[0].agentId, 'donna');
  });

  it('a replayed messageId still returns 200 after the agent goes over budget', async () => {
    const { state, runtime } = setup();
    const first = await createRun(state, 'donna', { actor: 'token:operator', trigger: 'manual', input: { messageId: 'm-1' } });
    assert.equal(first.status, 202);
    const runId = (first.body as { runId: string }).runId;
    overDay(state, 'donna');
    const again = await createRun(state, 'donna', { actor: 'token:operator', trigger: 'manual', input: { messageId: 'm-1' } });
    assert.equal(again.status, 200);
    assert.equal((again.body as { runId: string }).runId, runId);
    assert.equal(runtime.started.length, 1);
    assert.equal(refusals(state, 'donna').length, 0);
  });

  it('built-ins stay exempt and an agent with no budget is unaffected', async () => {
    const { state, runtime } = setup();
    const echo = state.agents.get('echo-agent')!;
    assert.equal(echo.category, 'builtin');
    assert.equal(BUILTIN_SYSTEM_AGENTS.some((a) => a.id === 'echo-agent'), false);
    overDay(state, 'echo-agent');
    const echoWake = await createRun(state, 'echo-agent', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(echoWake.status, 202);
    assert.equal(refusals(state, 'echo-agent').length, 0);

    const doctor = { ...BUILTIN_SYSTEM_AGENTS.find((a) => a.id === 'doctor')!, ungated: [] as string[] };
    state.agents.set('doctor', doctor);
    overDay(state, 'doctor');
    const doctorWake = await createRun(state, 'doctor', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(doctorWake.status, 202);
    assert.equal(refusals(state, 'doctor').length, 0);

    const open = await createRun(state, 'donna', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(open.status, 202);
    assert.deepEqual(runtime.started.map((s) => s.agentId).sort(), ['doctor', 'donna', 'echo-agent']);
  });

  it('a perRun limit does not refuse a wake, and raising the daily limit lets the next wake through', async () => {
    const { state, runtime } = setup();
    state.policies.set('donna', { routes: [], budgetUsd: { perRun: 0 } });
    state.spend.add('donna', 'prior-run', 50, new Date().toISOString());
    const underRunOnly = await createRun(state, 'donna', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(underRunOnly.status, 202);
    assert.equal(runtime.started.length, 1);

    const { state: blocked, runtime: blockedRuntime } = setup();
    overDay(blocked, 'donna');
    const refused = await createRun(blocked, 'donna', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(refused.status, 402);
    blocked.policies.set('donna', { routes: [], budgetUsd: { perDay: 100, perMonth: 100 } });
    const next = await createRun(blocked, 'donna', { actor: 'token:operator', trigger: 'manual' });
    assert.equal(next.status, 202);
    assert.equal(blockedRuntime.started.length, 1);
  });
});
