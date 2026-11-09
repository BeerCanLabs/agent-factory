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

  it('M5(8): reports subscription tokens per connection and per agent separately from priced spend, with owner scoping and daily token sums', () => {
    const events: LedgerEvent[] = [
      row({
        agentId: 'dale-agent',
        type: 'llm',
        runId: 'r1',
        costUsd: 0,
        model: 'grok-dale-sub',
        credentialMode: 'subscription',
        scope: 'personal',
        connection: 'c-dale',
        inputTokens: 120,
        outputTokens: 30,
        timestamp: '2026-10-03T08:00:00.000Z',
      }),
      row({
        agentId: 'dale-agent',
        type: 'llm',
        runId: 'r1',
        costUsd: 0,
        model: 'gpt-team-sub',
        credentialMode: 'subscription',
        scope: 'factory',
        connection: 'c-team',
        inputTokens: 200,
        outputTokens: 50,
        timestamp: '2026-10-02T10:00:00.000Z',
      }),
      row({
        agentId: 'bob-agent',
        type: 'llm',
        runId: 'r2',
        costUsd: 0,
        model: 'grok-bob-sub',
        credentialMode: 'subscription',
        scope: 'personal',
        connection: 'c-bob',
        inputTokens: 400,
        outputTokens: 100,
        timestamp: '2026-10-03T09:00:00.000Z',
      }),
      row({
        agentId: 'dale-agent',
        type: 'llm',
        runId: 'r1',
        costUsd: 2.5,
        model: 'claude-sonnet',
        credentialMode: 'api-key',
        inputTokens: 1000,
        outputTokens: 250,
        timestamp: '2026-10-03T11:00:00.000Z',
      }),
    ];
    const t = SpendTracker.fromLedger(events, () => true);

    // Priced USD report excludes $0 subscription rows and includes only priced API calls.
    const priced = t.report(now);
    assert.equal(priced.agents['bob-agent'], undefined);
    assert.equal(priced.agents['dale-agent'].day.usd, 2.5);
    assert.equal(priced.agents['dale-agent'].day.calls, 1);
    assert.deepEqual(Object.keys(priced.agents['dale-agent'].day.byModel), ['claude-sonnet']);

    // Fleet-wide subscription report (admin) includes all connections and agents, separate from priced API calls.
    const fullSub = t.subscriptionReport(now);
    assert.deepEqual(Object.keys(fullSub.connections).sort(), ['c-bob', 'c-dale', 'c-team']);
    assert.equal(fullSub.connections['c-dale'].day.totalTokens, 150);
    assert.equal(fullSub.connections['c-team'].day.totalTokens, 0);
    assert.equal(fullSub.connections['c-team'].month.totalTokens, 250);
    assert.equal(fullSub.agents['dale-agent'].day.totalTokens, 150);
    assert.equal(fullSub.agents['dale-agent'].month.totalTokens, 400);

    // Owner-scoped subscription report (user:dale) includes only Dale's personal connection and Dale's owned agent.
    const daleSub = t.subscriptionReport(now, {
      connections: new Set(['c-dale']),
      agents: new Set(['dale-agent']),
    });
    assert.deepEqual(Object.keys(daleSub.connections), ['c-dale']);
    assert.deepEqual(Object.keys(daleSub.agents), ['dale-agent']);
    assert.equal(daleSub.agents['dale-agent'].month.totalTokens, 400);
    assert.equal(daleSub.connections['c-bob'], undefined);
    assert.equal(daleSub.agents['bob-agent'], undefined);

    // Daily token counter per (connection, agent, utcDay).
    assert.equal(t.connectionAgentDayTokens('c-dale', 'dale-agent', '2026-10-03'), 150);
    assert.equal(t.connectionAgentDayTokens('c-dale', 'dale-agent', '2026-10-02'), 0);
    assert.equal(t.connectionAgentDayTokens('c-dale', 'bob-agent', '2026-10-03'), 0);
  });
});
