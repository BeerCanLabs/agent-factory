import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressEmitter, type ProgressEvent } from './progress.js';

describe('§6.5 progress emitter: bounded, batched, best effort', () => {
  const ev = (i: number): ProgressEvent => ({ runId: 'r', agentId: 'a', at: new Date().toISOString(), kind: 'call.start', callId: `c${i}`, route: 'discord' });

  it('§6.5 batches events into one send per flush', async () => {
    const sends: number[] = [];
    const em = new ProgressEmitter(async (b) => void sends.push(b.length), { flushMs: 60_000, batchSize: 50 });
    for (let i = 0; i < 7; i++) em.emit(ev(i));
    await em.flush();
    em.stop();
    assert.deepEqual(sends, [7]);
  });

  it('§6.5 the queue is bounded and drops beyond it with a log line', async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (m: string) => void lines.push(m);
    try {
      const em = new ProgressEmitter(async () => {}, { flushMs: 60_000, batchSize: 1000, maxQueue: 10 });
      for (let i = 0; i < 25; i++) em.emit(ev(i));
      assert.equal(em.pending, 10);
      await em.flush();
      em.stop();
      assert.ok(lines.some((l) => l.includes('dropped 15')), lines.join('\n'));
    } finally {
      console.warn = warn;
    }
  });

  it('§6.5 a failed send drops the batch with a log line and never throws', async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (m: string) => void lines.push(m);
    try {
      const em = new ProgressEmitter(async () => {
        throw new Error('control plane 500');
      }, { flushMs: 60_000 });
      em.emit(ev(1));
      await em.flush();
      em.stop();
      assert.equal(em.pending, 0);
      assert.ok(lines.some((l) => l.includes('dropped 1 event') && l.includes('control plane 500')));
    } finally {
      console.warn = warn;
    }
  });

  it('§6.5 ProgressCall emits inputTokens and outputTokens on call.end when usage is recorded', async () => {
    const emitted: ProgressEvent[] = [];
    const em = new ProgressEmitter(async (b) => void emitted.push(...b), { flushMs: 60_000, batchSize: 50 });
    const { ProgressCall } = await import('./progress.js');
    const call = new ProgressCall(em, 'run-1', 'donna', 'models');
    call.start('claude-sonnet');
    call.usage = { inputTokens: 1500, outputTokens: 250 };
    call.end(200);
    await em.flush();
    em.stop();

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].kind, 'call.start');
    assert.equal(emitted[1].kind, 'call.end');
    assert.equal(emitted[1].inputTokens, 1500);
    assert.equal(emitted[1].outputTokens, 250);
    assert.equal(emitted[1].model, 'claude-sonnet');
    assert.equal(emitted[1].status, 200);
    assert.equal(emitted[1].outcome, 'ok');
  });
});
