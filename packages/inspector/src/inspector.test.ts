import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { createInspector } from './inspector.js';
import type { BusSink, FactoryEvent } from './events.js';

const report = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  agentId: 'agent-a',
  at: '2026-10-08T00:00:00.000Z',
  kind: 'call.start',
  callId: `c-${Math.random().toString(36).slice(2)}`,
  route: 'discord',
  ...extra,
});

describe('§6.15 the Inspector contract', () => {
  it('publishes run changes and ledger rows to subscribers, and stops when a subscriber unsubscribes', () => {
    const inspector = createInspector();
    const seen: string[] = [];
    const off = inspector.subscribe((e) => void seen.push(e.kind === 'run' ? `run:${e.run.state}` : e.kind));
    const ledger = inspector.tapLedger(new MemoryLedger());
    inspector.publishRun({ runId: 'r1', agentId: 'agent-a', state: 'WORKING', trigger: 'api', updatedAt: 't' });
    ledger.append({ timestamp: '2026-10-08T00:00:00.000Z', agentId: 'agent-a', type: 'action', action: 'X' });
    off();
    inspector.publishRun({ runId: 'r1', agentId: 'agent-a', state: 'SUCCEEDED', trigger: 'api', updatedAt: 't' });
    assert.deepEqual(seen, ['run:WORKING', 'ledger']);
    assert.equal(ledger.query().length, 1, 'the tapped store still works');
  });

  it('reportProgress keeps only what is sanitized and live, stores it per run with a sequence, and publishes it', async () => {
    const inspector = createInspector();
    const published: FactoryEvent[] = [];
    inspector.subscribe((e) => void published.push(e));
    const live = new Set(['run-1']);
    const accepted = inspector.reportProgress(
      [report('run-1'), report('run-1', { kind: 'call.end', status: 200, outcome: 'ok', body: 'leak' }), report('run-2'), { nonsense: true }, report('run 1')],
      (e) => live.has(e.runId),
    );
    assert.equal(accepted, 2);
    const got = await inspector.readProgress('run-1', undefined, 0);
    assert.deepEqual(got.events.map((e) => [e.seq, e.kind]), [[1, 'call.start'], [2, 'call.end']]);
    assert.equal(got.next, 2);
    assert.ok(!JSON.stringify(got).includes('leak'));
    assert.deepEqual(published.map((e) => e.kind), ['progress', 'progress']);
    assert.deepEqual((await inspector.readProgress('run-2', undefined, 0)).events, [], 'a run that was not live has no ring');
  });

  it('readProgress waits for the next event and resumes from a cursor', async () => {
    const inspector = createInspector();
    inspector.reportProgress([report('run-1')], () => true);
    const hold = setTimeout(() => {}, 2_000);
    const pending = inspector.readProgress('run-1', 1, 5_000);
    inspector.reportProgress([report('run-1', { kind: 'call.end' })], () => true);
    assert.deepEqual((await pending).events.map((e) => e.seq), [2]);
    clearTimeout(hold);
  });

  it('progress limits come from the options', async () => {
    const inspector = createInspector({ progressPerRun: 2, progressRuns: 1 });
    inspector.reportProgress([report('r'), report('r'), report('r')], () => true);
    assert.deepEqual((await inspector.readProgress('r', undefined, 0)).events.map((e) => e.seq), [2, 3]);
    inspector.reportProgress([report('other')], () => true);
    assert.deepEqual((await inspector.readProgress('r', undefined, 0)).events, [], 'the older run was dropped');
  });

  it('attachBus ships bus-worthy events only (never progress), and stop() ends every bus it attached', async () => {
    const inspector = createInspector();
    const sent: FactoryEvent[][] = [];
    const sink: BusSink = { name: 'mem', send: async (b) => void sent.push(b) };
    const bus = inspector.attachBus(sink, 60_000);
    inspector.publishRun({ runId: 'r1', agentId: 'agent-a', state: 'FAILED', trigger: 'api', updatedAt: 't' });
    inspector.reportProgress([report('r1')], () => true);
    await bus.flush();
    assert.deepEqual(sent.map((b) => b.map((e) => e.kind)), [['run']]);
    inspector.stop();
    inspector.publishRun({ runId: 'r2', agentId: 'agent-a', state: 'FAILED', trigger: 'api', updatedAt: 't' });
    await bus.flush();
    assert.equal(sent.length, 1, 'nothing queued after stop');
  });
});
