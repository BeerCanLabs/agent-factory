import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  attributeCompute,
  budgetCrossings,
  buildSpendReport,
  hourlyUsd,
  periodWindow,
  summarizeCloud,
  TtlCache,
  validateFactoryBudgets,
  type CloudCostSnapshot,
} from './cloud.js';
import { SpendTracker } from './spend.js';

// October 2026 month-to-date, as Cost Explorer returned it for the BeerCanLabs account (rounded).
const OCT: CloudCostSnapshot = {
  provider: 'aws',
  start: '2026-10-01',
  end: '2026-10-09',
  lines: [
    { recordType: 'Usage', service: 'Amazon Virtual Private Cloud', usd: 21.44 },
    { recordType: 'Usage', service: 'Amazon Elastic Container Service', usd: 14.23 },
    { recordType: 'Usage', service: 'AmazonCloudWatch', usd: 9.39 },
    { recordType: 'Usage', service: 'Claude Opus 4.6 (Amazon Bedrock Edition)', usd: 3.65 },
    { recordType: 'Usage', service: 'Amazon Bedrock', usd: 0.01 },
    { recordType: 'Credit', service: 'Amazon Virtual Private Cloud', usd: -21.44 },
    { recordType: 'Credit', service: 'Amazon Elastic Container Service', usd: -14.23 },
    { recordType: 'Credit', service: 'AmazonCloudWatch', usd: -9.39 },
    { recordType: 'Credit', service: 'Claude Opus 4.6 (Amazon Bedrock Edition)', usd: -3.65 },
    { recordType: 'Credit', service: 'Amazon Bedrock', usd: -0.01 },
  ],
  usage: [
    { service: 'Amazon Virtual Private Cloud', usageType: 'USE1-VpcEndpoint-Hours', usd: 15.88, quantity: 1588 },
    { service: 'Claude Opus 4.6 (Amazon Bedrock Edition)', usageType: 'USE1-MP:USE1_InputTokenCount-Units', usd: 2.64, quantity: 0.5 },
    { service: 'AmazonCloudWatch', usageType: 'CW:MetricMonitorUsage', usd: 9.39, quantity: 41.3 },
    { service: 'AWS Secrets Manager', usageType: 'USE1-AWSSecretsManagerAPIRequest', usd: 0.004, quantity: 800 },
  ],
};

describe('periodWindow', () => {
  it('current is the UTC month to date, with tomorrow as the exclusive end', () => {
    const w = periodWindow(new Date('2026-10-08T06:00:00Z'));
    assert.equal(w.start, '2026-10-01');
    assert.equal(w.end, '2026-10-09');
    assert.equal(w.month, '2026-10');
    assert.equal(w.partial, true);
    assert.ok(Math.abs(w.elapsedFraction - (7.25 / 31)) < 1e-9);
  });
  it('last is the whole previous month, across a year boundary', () => {
    const w = periodWindow(new Date('2026-01-15T00:00:00Z'), 'last');
    assert.deepEqual([w.start, w.end, w.month, w.partial, w.label], ['2025-12-01', '2026-01-01', '2025-12', false, 'December 2025']);
  });
});

describe('summarizeCloud', () => {
  it('credits never hide gross usage, and model inference is split out of infrastructure', () => {
    const s = summarizeCloud(OCT);
    assert.equal(s.grossUsd, 48.72);
    assert.equal(s.creditsUsd, -48.72);
    assert.equal(s.netUsd, 0);
    assert.equal(s.aiBilledByCloudUsd, 3.66);
    assert.equal(s.infraGrossUsd, 45.06);
    assert.deepEqual(s.infraByService.map((x) => x.service), ['Amazon Virtual Private Cloud', 'Amazon Elastic Container Service', 'AmazonCloudWatch']);
    assert.ok(!s.topInfraUsageTypes.some((u) => /Bedrock/.test(u.service)), 'model usage types are AI, not infrastructure');
    assert.ok(!s.topInfraUsageTypes.some((u) => u.usd < 0.01), 'sub-cent lines are noise');
  });
});

describe('attributeCompute', () => {
  const size = () => ({ vcpu: 0.25, memoryGb: 0.5 });
  it('prices run task-hours clipped to the window; an open run counts up to now', () => {
    const now = new Date('2026-10-08T06:00:00Z');
    const out = attributeCompute(
      [
        { agentId: 'archie', start: '2026-09-30T23:00:00Z', end: '2026-10-01T01:00:00Z' }, // 1h inside October
        { agentId: 'archie', start: '2026-10-05T00:00:00Z', end: '2026-10-05T02:00:00Z' }, // 2h
        { agentId: 'donna', start: '2026-10-08T05:00:00Z' }, // open: 1h to now
        { agentId: 'castle', start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' }, // outside
      ],
      { start: '2026-10-01', end: '2026-10-09' },
      size,
      now,
    );
    const hourly = hourlyUsd(0.25, 0.5, false);
    assert.equal(out.archie.hours, 3);
    assert.ok(Math.abs(out.archie.usd - 3 * hourly) < 1e-4);
    assert.equal(out.donna.hours, 1);
    assert.equal(out.castle, undefined);
  });
  it('Spot is priced below on-demand', () => {
    assert.ok(hourlyUsd(1, 2, true) < hourlyUsd(1, 2, false) / 2);
  });
});

describe('factory budgets', () => {
  it('validates fields and rejects unknown ones', () => {
    assert.deepEqual(validateFactoryBudgets({ totalMonthUsd: 300 }), { ok: true, budgets: { totalMonthUsd: 300 } });
    assert.deepEqual(validateFactoryBudgets({ totalMonthUsd: 300, alertAt: [1, 0.5, 1] }), { ok: true, budgets: { totalMonthUsd: 300, alertAt: [0.5, 1] } });
    assert.equal(validateFactoryBudgets({ totalMonthUsd: -1 }).ok, false);
    assert.equal(validateFactoryBudgets({ monthly: 5 }).ok, false);
    assert.equal(validateFactoryBudgets([]).ok, false);
    assert.equal(validateFactoryBudgets({ alertAt: [] }).ok, false);
  });
  it('reports each threshold once per month, on actual gross spend', () => {
    const b = { totalMonthUsd: 300, infraMonthUsd: 50 };
    const spent = { ai: 6, infra: 54, total: 60 };
    const first = budgetCrossings(b, spent, []);
    assert.deepEqual(first.map((c) => c.key), ['infra:0.8', 'infra:1']);
    assert.deepEqual(budgetCrossings(b, spent, first.map((c) => c.key)), []);
    assert.deepEqual(budgetCrossings(b, { ai: 6, infra: 54, total: 250 }, first.map((c) => c.key)).map((c) => c.key), ['total:0.8']);
  });
});

describe('buildSpendReport', () => {
  const window = periodWindow(new Date('2026-10-08T06:00:00Z'));
  it('splits AI, infrastructure and per-agent spend without counting AI twice, and judges budgets on gross', () => {
    const r = buildSpendReport({
      window,
      aiByAgent: { archie: 3.63, donna: 1.6 },
      cloud: summarizeCloud(OCT),
      computeByAgent: { archie: { hours: 10, usd: 0.12 }, finley: { hours: 2, usd: 0.02 } },
      budgets: { totalMonthUsd: 300 },
      asOf: '2026-10-08T06:00:00Z',
    });
    assert.equal(r.totals.aiUsd, 5.23);
    assert.equal(r.totals.infraGrossUsd, 45.06);
    assert.equal(r.totals.grossUsd, 50.29);
    assert.equal(r.totals.creditsUsd, -48.72);
    assert.equal(r.totals.netUsd, 1.57, 'the ledger-metered AI beyond what the cloud credited still shows as net');
    assert.equal(r.infra.agentComputeUsd, 0.14);
    assert.equal((r.infra as { overheadUsd: number }).overheadUsd, 44.92);
    assert.deepEqual(r.agents.map((a) => a.agentId), ['archie', 'donna', 'finley']);
    assert.equal(r.agents[0].totalUsd, 3.75);
    assert.equal(r.budgets.total?.spentUsd, 50.29);
    assert.ok((r.budgets.total?.projectedUsd ?? 0) > 200, 'run-rate projection over a partial month');
    assert.deepEqual(r.reconciliation, { aiLedgerUsd: 5.23, aiBilledByCloudUsd: 3.66 });
  });
  it('without the cloud bill, AI and per-agent AI are still reported and only the AI budget is judged', () => {
    const r = buildSpendReport({
      window,
      aiByAgent: { archie: 3.63 },
      cloud: { unavailable: 'no cloud cost adapter on this landing zone' },
      computeByAgent: {},
      budgets: { aiMonthUsd: 20, totalMonthUsd: 300 },
      asOf: 'x',
    });
    assert.equal(r.totals.aiUsd, 3.63);
    assert.equal(r.totals.grossUsd, 'unavailable');
    assert.ok(r.budgets.ai);
    assert.equal(r.budgets.total, undefined);
    assert.match(String((r.infra as { unavailable: string }).unavailable), /no cloud cost adapter/);
  });
});

describe('SpendTracker.monthByAgent', () => {
  it('totals model spend per agent for one month', () => {
    const t = new SpendTracker();
    t.add('archie', 'r1', 1, '2026-09-30T23:59:00Z');
    t.add('archie', 'r2', 2, '2026-10-01T00:00:00Z');
    t.add('donna', 'r3', 0.5, '2026-10-02T00:00:00Z');
    assert.deepEqual(t.monthByAgent('2026-10'), { archie: 2, donna: 0.5 });
    assert.deepEqual(t.monthByAgent('2026-09'), { archie: 1 });
  });
});

describe('TtlCache', () => {
  it('serves a hit within the TTL and drops a failed load', async () => {
    let now = 0;
    let loads = 0;
    const c = new TtlCache<number>(1000, () => now);
    const load = async () => ++loads;
    assert.equal(await c.get('k', load), 1);
    assert.equal(await c.get('k', load), 1);
    now = 1001;
    assert.equal(await c.get('k', load), 2);
    await assert.rejects(c.get('bad', async () => { throw new Error('x'); }));
    assert.equal(await c.get('bad', async () => 7), 7);
  });
});
