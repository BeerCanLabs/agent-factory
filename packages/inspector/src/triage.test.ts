import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { incidentsFromRuns, type TriageRun } from './triage.js';

const run = (runId: string, fields: Partial<TriageRun> = {}): TriageRun => ({ runId, agentId: 'a', state: 'FAILED', updatedAt: 'u', ...fields });

describe('§6.5 triage rule: incidents from runs', () => {
  it('skips runs that neither failed nor carry an error, and keeps the order given', () => {
    const out = incidentsFromRuns([run('11111111-aaaa'), run('22222222-bbbb', { state: 'SUCCEEDED' }), run('33333333-cccc', { state: 'SUCCEEDED', error: 'warn' })]);
    assert.deepEqual(out.map((i) => i.id), ['inc-11111111', 'inc-33333333']);
  });

  it('severity is CRITICAL only when the error mentions OOM; category is decided missing, then timeout, else CRASH_LOOP', () => {
    const cat = (f: Partial<TriageRun>) => {
      const [i] = incidentsFromRuns([run('r1234567', f)]);
      return [i.severity, i.category];
    };
    assert.deepEqual(cat({}), ['ERROR', 'CRASH_LOOP']);
    assert.deepEqual(cat({ error: 'OOM killed' }), ['CRITICAL', 'CRASH_LOOP']);
    assert.deepEqual(cat({ error: 'timeout' }), ['ERROR', 'TIMEOUT']);
    assert.deepEqual(cat({ error: 'OOM timeout' }), ['CRITICAL', 'TIMEOUT']);
    assert.deepEqual(cat({ missing: ['X'], error: 'timeout' }), ['ERROR', 'SECRET_MISSING'], 'a missing secret wins over a timeout');
    assert.deepEqual(cat({ missing: [] }), ['ERROR', 'SECRET_MISSING'], 'GAP-108: an empty list still counts');
    assert.deepEqual(cat({ error: 'Timeout' }), ['ERROR', 'CRASH_LOOP'], 'the match is case-sensitive');
  });

  it('the message is the error, else a fixed line; the timestamp falls back through startedAt, createdAt, then now', () => {
    const [a, b, c, d] = incidentsFromRuns(
      [run('r1', { error: 'boom' }), run('r2', { updatedAt: '', startedAt: 's' }), run('r3', { updatedAt: '', createdAt: 'c' }), run('r4', { updatedAt: '' })],
      () => 'NOW',
    );
    assert.equal(a.message, 'boom');
    assert.equal(b.message, 'Run terminated with failure state');
    assert.deepEqual([a.timestamp, b.timestamp, c.timestamp, d.timestamp], ['u', 's', 'c', 'NOW']);
  });
});
