import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BenchCase } from '@beercanlabs/factory-contract';
import { grade, matrix, recommend, runBench, runCase, summarize, type FactoryClient, type RunView } from './index.js';

const c = (expect: BenchCase['expect'], id = 'c1'): BenchCase => ({ id, input: 'x', expect, timeoutSeconds: 5 });
const run = (state: string, result?: unknown): RunView => ({ runId: 'r', state, result, createdAt: '', updatedAt: '' });

describe('grade', () => {
  it('checks state, equality, substrings (case-insensitive) and regex', () => {
    assert.equal(grade(c({ status: 'DONE' }), run('FAILED')).pass, false);
    assert.equal(grade(c({ status: 'DONE', equals: { a: 1 } }), run('DONE', { a: 1 })).pass, true);
    assert.equal(grade(c({ status: 'DONE', equals: { a: 1 } }), run('DONE', { a: 2 })).pass, false);
    assert.equal(grade(c({ status: 'DONE', contains: ['Gateway'] }), run('DONE', 'the gateway meters')).pass, true);
    assert.equal(grade(c({ status: 'DONE', contains: ['budget'] }), run('DONE', 'the gateway meters')).pass, false);
    assert.equal(grade(c({ status: 'DONE', matches: '^.{1,5}$' }), run('DONE', 'too long text')).pass, false);
    assert.equal(grade(c({ status: 'FAILED' }), run('FAILED')).pass, true);
  });
});

function fakeClient(script: Record<string, { states: string[]; result?: unknown; cost: number }>): FactoryClient & { runs: string[] } {
  const runs: string[] = [];
  const polls = new Map<string, number>();
  const byRun = new Map<string, string>();
  return {
    runs,
    async createRun(_agent, body) {
      const runId = `run-${runs.length + 1}`;
      runs.push(`${body.model}:${JSON.stringify(body.input)}`);
      byRun.set(runId, body.model);
      polls.set(runId, 0);
      return { status: 202, run: { runId, state: 'WORKING', createdAt: '', updatedAt: '' } };
    },
    async getRun(runId) {
      const s = script[byRun.get(runId)!];
      const i = Math.min((polls.get(runId) ?? 0) + 1, s.states.length - 1);
      polls.set(runId, i);
      return { runId, state: s.states[i], result: s.result, createdAt: '', updatedAt: '' };
    },
    async costOf(_agent, runId) {
      return script[byRun.get(runId)!].cost;
    },
    async getPolicy() {
      return {};
    },
    async putPolicy() {
      return 200;
    },
  };
}

describe('runBench', () => {
  it('runs every case for every model, pinning the model, and collects cost', async () => {
    const client = fakeClient({
      big: { states: ['WORKING', 'DONE'], result: 'mentions gateway', cost: 0.02 },
      small: { states: ['WORKING', 'DONE'], result: 'nope', cost: 0.002 },
    });
    const suite = { cases: [c({ status: 'DONE', contains: ['gateway'] }, 'a'), c({ status: 'DONE' }, 'b')] };
    const results = await runBench(client, 'agent', suite, ['big', 'small'], { pollMs: 1 });
    assert.equal(client.runs.length, 4);
    assert.ok(client.runs[0].startsWith('big:'));
    const s = summarize(results);
    const big = s.find((x) => x.model === 'big')!;
    const small = s.find((x) => x.model === 'small')!;
    assert.equal(big.passRate, 1);
    assert.equal(small.passRate, 0.5);
    assert.equal(big.costUsd, 0.04);
  });

  it('a blocked run fails its case with the block reason instead of hanging', async () => {
    const client = fakeClient({ m: { states: ['WORKING', 'BLOCKED_BUDGET_EXCEEDED'], cost: 1 } });
    const r = await runCase(client, 'agent', 'm', c({ status: 'DONE' }), { pollMs: 1 });
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'BLOCKED_BUDGET_EXCEEDED');
  });

  it('times out a run that never finishes', async () => {
    let t = 0;
    const client = fakeClient({ m: { states: ['WORKING', 'WORKING'], cost: 0 } });
    const r = await runCase(client, 'agent', 'm', { ...c({ status: 'DONE' }), timeoutSeconds: 1 }, { pollMs: 1, now: () => (t += 400) });
    assert.equal(r.reason, 'timed out');
  });
});

describe('matrix and recommendation', () => {
  const summaries = [
    { model: 'opus-like', cases: 50, passed: 49, passRate: 0.98, costUsd: 10, avgCostUsd: 0.2, maxCostUsd: 0.3, avgSeconds: 9 },
    { model: 'haiku-like', cases: 50, passed: 40, passRate: 0.8, costUsd: 1, avgCostUsd: 0.02, maxCostUsd: 0.03, avgSeconds: 2 },
  ];

  it('renders cost vs quality with a monthly projection', () => {
    const m = matrix(summaries, 10_000);
    assert.match(m, /\| opus-like \| 98% \(49\/50\) \| \$0\.2000 \| \$2000 \|/);
    assert.match(m, /\| haiku-like \| 80% \(40\/50\) \| \$0\.0200 \| \$200 \|/);
  });

  it('recommends the cheapest model that clears the bar, with a budget from observed cost', () => {
    assert.equal(recommend(summaries, { minPassRate: 0.9 })?.model, 'opus-like');
    const cheap = recommend(summaries, { minPassRate: 0.75 })!;
    assert.equal(cheap.model, 'haiku-like');
    assert.deepEqual(cheap.policyPatch, { models: ['haiku-like'], budgetUsd: { perRun: 0.06 } });
    assert.equal(recommend(summaries, { minPassRate: 0.99 }), null);
  });
});
