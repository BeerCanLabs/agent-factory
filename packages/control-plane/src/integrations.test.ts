import type { AddressInfo } from 'node:net';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { loadCatalog } from './catalog.js';
import { createFactoryServer, createRun, finishRun, SYSTEM, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { EventHub, attachBus, eventBridgeSink, fileSink, runEvent, tapLedger, type FactoryEvent } from './events.js';
import { attachEventStream } from './stream.js';
import { pollQueueOnce } from './queues.js';

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const TOKENS = { operator: 'operator-token', viewer: 'viewer-token' };

function setup() {
  const hub = new EventHub();
  const runs = new MemoryRunStore();
  runs.onChange = (r) => hub.publish(runEvent(r));
  const state = {
    agents: new Map(loadCatalog(agentsRoot).map((a) => [a.id, a])),
    ledger: tapLedger(new MemoryLedger(), hub),
    auth: bearerAuth([
      { name: 'viewer', token: 'viewer-token', roles: ['viewer'] },
      { name: 'operator', token: 'operator-token', roles: ['operator'] },
      { name: 'gateway', token: 'ingest-token', roles: ['ingest'] },
    ]),
    version: 'test',
    providers: [envProvider({ ECHO_WEBHOOK_SECRET: 'whsec' })],
    runtime: noopRuntime(),
    runs,
    runTokens: new RunTokens(undefined),
    callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    approvals: new ApprovalStore(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
  } as unknown as FactoryState;
  return { hub, state };
}

describe('WebSocket event stream', () => {
  const { hub, state } = setup();
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = createFactoryServer(state);
    attachEventStream(server, state, hub);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  function connect(opts: { token?: string; protocol?: boolean; agent?: string } = {}): Promise<{ ws: WebSocket; events: any[] }> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/api/v1/events${opts.agent ? `?agent=${opts.agent}` : ''}`;
      const ws = opts.protocol
        ? new WebSocket(url, ['bearer', opts.token ?? ''])
        : new WebSocket(url, { headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} });
      const events: any[] = [];
      ws.on('message', (d) => {
        const e = JSON.parse(String(d));
        events.push(e);
        if (e.kind === 'hello') resolve({ ws, events });
      });
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    });
  }

  it('rejects unauthenticated and non-viewer connections', async () => {
    await assert.rejects(connect(), /401/);
    await assert.rejects(connect({ token: 'ingest-token' }), /401/);
  });

  it('streams run state changes and ledger rows, filtered by agent', async () => {
    const { ws, events } = await connect({ token: 'viewer-token', agent: 'echo-agent' });
    await createRun(state, 'echo-agent', { actor: 'token:x', trigger: 'api' });
    await createRun(state, 'med-doc', { actor: 'token:x', trigger: 'api' });
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    const runStates = events.filter((e) => e.kind === 'run').map((e) => e.run.state);
    assert.deepEqual(runStates, ['QUEUED', 'STARTING', 'WORKING']);
    assert.ok(events.some((e) => e.kind === 'ledger' && e.event.action === 'RUN_STARTED' && typeof e.event.hash === 'string'));
    assert.ok(events.every((e) => e.kind === 'hello' || e.agentId === 'echo-agent'), 'agent filter holds');
  });

  it('accepts the bearer subprotocol for browsers', async () => {
    const { ws, events } = await connect({ token: 'viewer-token', protocol: true });
    assert.equal(events[0].actor, 'token:viewer');
    ws.close();
  });
});

describe('event bus', () => {
  it('ships only bus-worthy events to the sink, in batches', async () => {
    const { hub, state } = setup();
    const path = join(mkdtempSync(join(tmpdir(), 'bus-')), 'events.ndjson');
    const bus = attachBus(hub, fileSink(path), 60_000);
    const run = (await createRun(state, 'echo-agent', { actor: 'token:x', trigger: 'api' })).body as { runId: string };
    await finishRun(state, run.runId, 'DONE', { actor: SYSTEM.runtime });
    state.ledger.append({ agentId: 'echo-agent', type: 'budget.alert', action: 'BUDGET_PERDAY_EXCEEDED', actor: 'factory:policy' });
    await bus.flush();
    bus.stop();
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FactoryEvent);
    const shipped = lines.map((e) => (e.kind === 'run' ? `run:${e.run.state}` : `ledger:${e.event.type}`));
    assert.deepEqual(shipped, ['run:DONE', 'ledger:budget.alert']);
  });

  it('EventBridge: batches of 10, rejected entries are kept for the next flush', async () => {
    const calls: any[][] = [];
    let fail = true;
    const sink = eventBridgeSink('factory-bus', async (args) => {
      const entries = JSON.parse(args[args.indexOf('--entries') + 1]);
      calls.push(entries);
      return JSON.stringify({ FailedEntryCount: fail ? 1 : 0 });
    });
    const hub = new EventHub();
    const bus = attachBus(hub, sink, 60_000);
    for (let i = 0; i < 12; i++) {
      hub.publish({ kind: 'run', agentId: 'a', run: { runId: `r${i}`, agentId: 'a', state: 'DONE', trigger: 'api', updatedAt: '' } });
    }
    await bus.flush();
    fail = false;
    await bus.flush();
    bus.stop();
    assert.equal(calls[0].length, 10);
    assert.equal(calls[0][0].Source, 'agent-factory');
    assert.equal(calls[0][0].DetailType, 'factory.run');
    assert.equal(calls[0][0].EventBusName, 'factory-bus');
    const retried = calls.slice(1).flat();
    assert.equal(retried.length, 12, 'the failed batch was retried in full');
  });
});

describe('SQS queue trigger', () => {
  it('turns messages into runs and deletes only what the factory recorded', async () => {
    const { state } = setup();
    const deleted: string[] = [];
    const cli = async (args: string[]) => {
      if (args[1] === 'receive-message') {
        return JSON.stringify({
          Messages: [
            { MessageId: '1', ReceiptHandle: 'h1', Body: '{"order":1}' },
            { MessageId: '2', ReceiptHandle: 'h2', Body: 'plain text' },
          ],
        });
      }
      deleted.push(args[args.indexOf('--receipt-handle') + 1]);
      return '{}';
    };
    assert.equal(await pollQueueOnce(state, 'echo-agent', 'https://sqs.us-east-1.amazonaws.com/1/q', cli), 2);
    const runs = state.runs.list({ agentId: 'echo-agent' });
    assert.deepEqual(runs.map((r) => [r.state, r.actor, r.trigger]), [
      ['WORKING', 'queue:echo-agent', 'queue'],
      ['QUEUED', 'queue:echo-agent', 'queue'],
    ]);
    assert.deepEqual(runs[0].input, { order: 1 });
    assert.equal(runs[1].input, 'plain text');
    assert.deepEqual(deleted, ['h1', 'h2']);

    state.agents.get('echo-agent')!.state = 'PAUSED';
    deleted.length = 0;
    assert.equal(await pollQueueOnce(state, 'echo-agent', 'https://sqs.us-east-1.amazonaws.com/1/q', cli), 0);
    assert.deepEqual(deleted, [], 'paused agent: messages stay on the queue for redelivery');
  });

  it('delivers follow-up messages via /conversation to active run mailbox', async () => {
    const { state } = setup();
    const srv = createFactoryServer(state);
    const port = await listen(srv);
    try {
      // 1. Wake agent
      const wakeRes = await fetch(`http://127.0.0.1:${port}/api/v1/agents/echo-agent/wake`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKENS.operator}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text: 'first' } }),
      });
      assert.equal(wakeRes.status, 202);
      const run = (await wakeRes.json()) as { runId: string };
      const runToken = await state.runTokens.mint(state.runs.get(run.runId)!);

      // 2. Deliver second message via /conversation
      const convRes = await fetch(`http://127.0.0.1:${port}/api/v1/agents/echo-agent/conversation`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKENS.operator}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      });
      assert.equal(convRes.status, 202);

      // 3. Worker polls mailbox and receives the message immediately
      const mailRes = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${run.runId}/mailbox?timeout=1000`, {
        headers: { 'Authorization': `Bearer ${runToken}` },
      });
      assert.equal(mailRes.status, 200);
      const mailBody = (await mailRes.json()) as { ok: boolean; message: { payload: { text: string } } };
      assert.equal(mailBody.ok, true);
      assert.deepEqual(mailBody.message.payload, { text: 'second' });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
