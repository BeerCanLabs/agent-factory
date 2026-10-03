import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerEvent } from '@beercanlabs/factory-ledger';
import { SpendTracker } from './spend.js';

function row(partial: Partial<LedgerEvent> & Pick<LedgerEvent, 'agentId' | 'type'>): LedgerEvent {
  return { timestamp: '2026-10-03T12:00:00.000Z', ...partial };
}

describe('SpendTracker', () => {
  const now = new Date('2026-10-03T15:00:00.000Z');

  it('attributes spend to the run that incurred it', () => {
    const t = new SpendTracker();
    t.add('ada', 'run-a', 1.25, '2026-10-03T01:00:00.000Z');
    t.add('ada', 'run-b', 2.5, '2026-10-03T02:00:00.000Z');
    t.add('bea', 'run-a', 9, '2026-10-03T03:00:00.000Z');
    assert.deepEqual(t.get('ada', 'run-a', now), { run: 1.25, day: 3.75, month: 3.75 });
    assert.deepEqual(t.get('ada', 'run-b', now), { run: 2.5, day: 3.75, month: 3.75 });
    assert.deepEqual(t.get('ada', undefined, now), { run: 0, day: 3.75, month: 3.75 });
  });

  it('splits UTC day and month boundaries', () => {
    const t = new SpendTracker();
    t.add('ada', 'r', 1, '2026-09-30T23:59:59.000Z');
    t.add('ada', 'r', 2, '2026-10-02T23:59:59.000Z');
    t.add('ada', 'r', 4, '2026-10-03T00:00:00.000Z');
    assert.deepEqual(t.get('ada', 'r', now), { run: 7, day: 4, month: 6 });
    const report = t.report(now);
    assert.equal(report.day, '2026-10-03');
    assert.equal(report.month, '2026-10');
    assert.equal(report.agents.ada.day.usd, 4);
    assert.equal(report.agents.ada.month.usd, 6);
    assert.equal(report.agents.ada.day.calls, 1);
    assert.equal(report.agents.ada.month.calls, 2);
  });

  it('groups the report by model and labels a missing model unknown', () => {
    const t = new SpendTracker();
    t.add('ada', 'r', 1, '2026-10-03T01:00:00.000Z', { model: 'haiku', inputTokens: 10, outputTokens: 1 });
    t.add('ada', 'r', 3, '2026-10-03T02:00:00.000Z', { model: 'haiku', inputTokens: 5, outputTokens: 2 });
    t.add('ada', 'r', 7, '2026-10-03T03:00:00.000Z', { inputTokens: 4 });
    const day = t.report(now).agents.ada.day;
    assert.deepEqual(day.byModel.haiku, { usd: 4, calls: 2, inputTokens: 15, outputTokens: 3 });
    assert.deepEqual(day.byModel.unknown, { usd: 7, calls: 1, inputTokens: 4, outputTokens: 0 });
    assert.equal(day.usd, 11);
    assert.equal(day.inputTokens, 19);
    assert.equal(day.outputTokens, 3);
  });

  it('fromLedger keeps trusted llm rows and ignores every other row', () => {
    const events: LedgerEvent[] = [
      row({ agentId: 'ada', type: 'llm', runId: 'r', costUsd: 1.5, model: 'haiku', inputTokens: 8, outputTokens: 2 }),
      row({ agentId: 'ada', type: 'action', runId: 'r', costUsd: 99, action: 'EGRESS_PROXY' }),
      row({ agentId: 'ada', type: 'llm', runId: 'r', costUsd: 50 }),
      row({ agentId: 'ada', type: 'llm', runId: 'r' }),
    ];
    const trusted = (e: LedgerEvent) => e.costUsd === 1.5;
    const t = SpendTracker.fromLedger(events, trusted);
    assert.deepEqual(t.get('ada', 'r', now), { run: 1.5, day: 1.5, month: 1.5 });
    assert.deepEqual(t.report(now).agents.ada.day.byModel.haiku, { usd: 1.5, calls: 1, inputTokens: 8, outputTokens: 2 });
  });
});
