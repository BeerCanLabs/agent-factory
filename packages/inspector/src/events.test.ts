import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { EventHub, attachBus, busSinkFromEnv, eventBridgeSink, fileSink, hubOf, isBusWorthy, runEvent, tapLedger, type BusSink, type FactoryEvent } from './events.js';
import { PROGRESS_RING, RunProgress, sanitizeProgress } from './run-progress.js';

const run = (state: string, extra: Record<string, unknown> = {}) =>
  ({ runId: 'run-1', agentId: 'agent-a', state, actor: 'u', trigger: 'api', createdAt: 't0', updatedAt: 't1', ...extra }) as Parameters<typeof runEvent>[0];

const progress = (runId: string, callId: string) => ({
  runId,
  agentId: 'agent-a',
  at: '2026-10-08T00:00:00.000Z',
  kind: 'call.start' as const,
  callId,
  route: 'discord',
});

describe('§6.5 event hub: fan-out that a bad subscriber cannot break', () => {
  it('delivers to every subscriber, stops after unsubscribe, and logs a throwing subscriber without stopping the rest', () => {
    const hub = new EventHub();
    const got: string[] = [];
    const off = hub.subscribe((e) => void got.push(`a:${e.kind}`));
    hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((e) => void got.push(`c:${e.kind}`));
    const err = console.error;
    const lines: string[] = [];
    console.error = (m: string) => void lines.push(m);
    try {
      hub.publish(runEvent(run('WORKING')));
      off();
      hub.publish(runEvent(run('SUCCEEDED')));
    } finally {
      console.error = err;
    }
    assert.deepEqual(got, ['a:run', 'c:run', 'c:run']);
    assert.deepEqual(lines, ['[events] subscriber failed: boom', '[events] subscriber failed: boom']);
  });

  it('tapLedger publishes each appended row with its agent and keeps the store working; hubOf finds the hub', () => {
    const hub = new EventHub();
    const seen: FactoryEvent[] = [];
    hub.subscribe((e) => void seen.push(e));
    const ledger = tapLedger(new MemoryLedger(), hub);
    const row = ledger.append({ timestamp: '2026-10-08T00:00:00.000Z', agentId: 'agent-a', type: 'action', action: 'X' });
    assert.equal(hubOf(ledger), hub);
    assert.equal(hubOf({}), undefined);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { kind: 'ledger', agentId: 'agent-a', event: row });
    assert.equal(ledger.query().length, 1);
    assert.equal(ledger.head().seq, 1);
  });
});

describe('§6.5 which events go on an enterprise bus', () => {
  const ledgerEvent = (type: string, action?: string): FactoryEvent =>
    ({ kind: 'ledger', agentId: 'a', event: { type, action } as never }) as FactoryEvent;

  it('run outcomes and blocks, budget alerts, crashes and approval requests only', () => {
    assert.equal(isBusWorthy(runEvent(run('SUCCEEDED'))), true);
    assert.equal(isBusWorthy(runEvent(run('FAILED'))), true);
    for (const s of ['QUEUED', 'STARTING', 'WORKING']) assert.equal(isBusWorthy(runEvent(run(s))), false, s);
    assert.equal(isBusWorthy(ledgerEvent('budget.alert')), true);
    assert.equal(isBusWorthy(ledgerEvent('crash')), true);
    assert.equal(isBusWorthy(ledgerEvent('action', 'APPROVAL_REQUESTED')), true);
    assert.equal(isBusWorthy(ledgerEvent('action', 'SPEND_READ')), false);
    assert.equal(isBusWorthy({ kind: 'progress', agentId: 'a', progress: { seq: 1, ...progress('r', 'c') } }), false);
  });
});

describe('§6.5 bus sinks: batch, ship, retry', () => {
  it('a file sink receives exactly the bus-worthy events as NDJSON, in order, one flush per batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bus-'));
    const path = join(dir, 'nested', 'bus.ndjson');
    const hub = new EventHub();
    const bus = attachBus(hub, fileSink(path), 60_000);
    const ledger = tapLedger(new MemoryLedger(), hub);
    const crash = ledger.append({ timestamp: '2026-10-08T00:00:00.000Z', agentId: 'agent-a', type: 'crash', action: 'CRASH' });
    ledger.append({ timestamp: '2026-10-08T00:00:01.000Z', agentId: 'agent-a', type: 'action', action: 'SPEND_READ' });
    hub.publish(runEvent(run('WORKING')));
    const done = runEvent(run('SUCCEEDED'));
    hub.publish(done);
    hub.publish({ kind: 'progress', agentId: 'agent-a', progress: { seq: 1, ...progress('run-1', 'c1') } });
    await bus.flush();
    await bus.flush();
    bus.stop();
    const expected = [{ kind: 'ledger', agentId: 'agent-a', event: crash }, done].map((e) => JSON.stringify(e)).join('\n') + '\n';
    assert.equal(readFileSync(path, 'utf8'), expected);
  });

  it('after stop() nothing more is queued', async () => {
    const sent: FactoryEvent[][] = [];
    const sink: BusSink = { name: 'mem', send: async (b) => void sent.push(b) };
    const hub = new EventHub();
    const bus = attachBus(hub, sink, 60_000);
    bus.stop();
    hub.publish(runEvent(run('FAILED')));
    await bus.flush();
    assert.deepEqual(sent, []);
  });

  it('a failed send is logged and the batch is retried, ahead of newer events, on the next flush', async () => {
    const batches: string[][] = [];
    let fail = true;
    const sink: BusSink = {
      name: 'flaky',
      send: async (b) => {
        if (fail) throw new Error('bus down');
        batches.push(b.map((e) => (e.kind === 'run' ? e.run.state : e.kind)));
      },
    };
    const hub = new EventHub();
    const bus = attachBus(hub, sink, 60_000);
    const err = console.error;
    const lines: string[] = [];
    console.error = (m: string) => void lines.push(m);
    try {
      hub.publish(runEvent(run('FAILED')));
      await bus.flush();
      hub.publish(runEvent(run('SUCCEEDED')));
      fail = false;
      await bus.flush();
    } finally {
      console.error = err;
      bus.stop();
    }
    assert.deepEqual(lines, ['[events] flaky: bus down']);
    assert.deepEqual(batches, [['FAILED', 'SUCCEEDED']]);
  });

  it('EventBridge gets source agent-factory, detail-type factory.<kind>, at most 10 entries per call, and a rejected entry throws', async () => {
    const calls: Array<{ args: string[] }> = [];
    let failed = 0;
    const sink = eventBridgeSink('bus-1', async (args) => {
      calls.push({ args });
      return JSON.stringify({ FailedEntryCount: failed });
    });
    const events = Array.from({ length: 23 }, (_, i) => runEvent(run('FAILED', { runId: `r${i}` })));
    await sink.send(events);
    assert.equal(sink.name, 'eventbridge:bus-1');
    assert.deepEqual(
      calls.map((c) => JSON.parse(c.args[c.args.indexOf('--entries') + 1]).length),
      [10, 10, 3],
    );
    assert.deepEqual(calls[0].args.slice(0, 3), ['events', 'put-events', '--entries']);
    const first = JSON.parse(calls[0].args[3])[0];
    assert.deepEqual(first, { EventBusName: 'bus-1', Source: 'agent-factory', DetailType: 'factory.run', Detail: JSON.stringify(events[0]) });
    failed = 2;
    await assert.rejects(() => sink.send(events.slice(0, 1)), /EventBridge rejected 2 event\(s\)/);
  });

  it('FACTORY_EVENT_BUS selects the sink and refuses anything else', () => {
    assert.equal(busSinkFromEnv({}), undefined);
    assert.equal(busSinkFromEnv({ FACTORY_EVENT_BUS: 'eventbridge:main' })?.name, 'eventbridge:main');
    const dir = mkdtempSync(join(tmpdir(), 'bus-'));
    assert.equal(busSinkFromEnv({ FACTORY_EVENT_BUS: `file://${join(dir, 'x.ndjson')}` })?.name, `file:${join(dir, 'x.ndjson')}`);
    assert.throws(() => busSinkFromEnv({ FACTORY_EVENT_BUS: 'kafka:x' }), /FACTORY_EVENT_BUS must be eventbridge:<bus> or file:\/\/<path>, got kafka:x/);
  });
});

describe('§6.5 progress sanitizer: only the declared fields survive', () => {
  it('drops undeclared fields and rejects bad identifiers, kinds and non-objects', () => {
    const ok = sanitizeProgress({ ...progress('run-1', 'c1'), model: 'claude-sonnet-4-6', status: 200, durationMs: 12.6, outcome: 'ok', body: 'secret', url: 'https://x/?k=1' });
    assert.deepEqual(ok, { runId: 'run-1', agentId: 'agent-a', at: '2026-10-08T00:00:00.000Z', kind: 'call.start', callId: 'c1', route: 'discord', model: 'claude-sonnet-4-6', status: 200, durationMs: 13, outcome: 'ok' });
    assert.equal(sanitizeProgress(null), undefined);
    assert.equal(sanitizeProgress([]), undefined);
    assert.equal(sanitizeProgress({ ...progress('run 1', 'c1') }), undefined, 'space in an id');
    assert.equal(sanitizeProgress({ ...progress('run-1', 'c1'), kind: 'call.middle' }), undefined);
    assert.equal(sanitizeProgress({ ...progress('run-1', 'c1'), route: 'https://x/y' }), undefined, 'a URL is not a route id');
    const bad = sanitizeProgress({ ...progress('run-1', 'c1'), model: 'has space', status: 99, durationMs: -1, outcome: 'weird' });
    assert.deepEqual(bad, progress('run-1', 'c1'));
    const noTime = sanitizeProgress({ ...progress('run-1', 'c1'), at: 'not a time' });
    assert.ok(noTime && !Number.isNaN(Date.parse(noTime.at)));
  });
});

describe('§6.5 progress ring: per-run, bounded, resumable', () => {
  it('numbers events per run from 1, resumes after a cursor, and keeps only the newest per run', () => {
    const p = new RunProgress(3, 10);
    for (let i = 1; i <= 5; i++) assert.equal(p.append(progress('r1', `c${i}`)).seq, i);
    assert.equal(p.append(progress('r2', 'x')).seq, 1);
    const all = p.read('r1');
    assert.deepEqual(all.events.map((e) => e.seq), [3, 4, 5]);
    assert.equal(all.next, 5);
    assert.deepEqual(p.read('r1', 4).events.map((e) => e.seq), [5]);
    assert.deepEqual(p.read('nope', 7), { events: [], next: 7 });
    assert.deepEqual(p.read('nope'), { events: [], next: 0 });
    assert.equal(PROGRESS_RING, 100);
  });

  it('drops the least recently written run beyond the run limit and wakes its waiters', async () => {
    const p = new RunProgress(5, 2);
    p.append(progress('a', '1'));
    p.append(progress('b', '1'));
    const waiting = p.wait('a', 1, 5_000);
    p.append(progress('b', '2'));
    p.append(progress('c', '1'));
    assert.equal(p.size, 2);
    assert.deepEqual(p.read('a'), { events: [], next: 0 });
    assert.deepEqual(await waiting, { events: [], next: 1 }, 'the cursor it passed comes back');
  });

  it('wait() answers at once when events exist or the wait is zero, on the next append, on timeout, and on abort', async () => {
    const p = new RunProgress();
    // The wait timer is unref'd (a server has other work keeping it alive); hold the loop open for the test.
    const hold = setTimeout(() => {}, 2_000);
    p.append(progress('r', '1'));
    assert.equal((await p.wait('r', undefined, 0)).events.length, 1);
    assert.equal((await p.wait('r', 1, 0)).events.length, 0);
    const pending = p.wait('r', 1, 5_000);
    p.append(progress('r', '2'));
    assert.deepEqual((await pending).events.map((e) => e.seq), [2]);
    const t0 = Date.now();
    assert.deepEqual((await p.wait('r', 2, 30)).events, []);
    assert.ok(Date.now() - t0 >= 25);
    const ac = new AbortController();
    const aborted = p.wait('r', 2, 5_000, ac.signal);
    ac.abort();
    assert.deepEqual((await aborted).events, []);
    clearTimeout(hold);
  });
});
