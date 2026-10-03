import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget, calculateTokenCost, DEFAULT_MODEL_PRICING } from './index.js';

describe('Treasurer Budget Engine', () => {
  it('allows spend when no limits are set', () => {
    const res = checkBudget(undefined, { runUsd: 100, dayUsd: 500 });
    assert.equal(res.allowed, true);
    assert.equal(res.circuitBroken, false);
  });

  it('enforces perRun budget limit', () => {
    const limits = { perRun: 1.0 };

    // Within limit
    const ok = checkBudget(limits, { runUsd: 0.5 }, 0.2);
    assert.equal(ok.allowed, true);
    assert.equal(ok.circuitBroken, false);

    // Over limit
    const breach = checkBudget(limits, { runUsd: 0.9 }, 0.2);
    assert.equal(breach.allowed, false);
    assert.equal(breach.circuitBroken, true);
    assert.ok(breach.reason?.includes('Run budget exceeded'));
  });

  it('enforces perDay budget limit and reports remaining daily balance', () => {
    const limits = { perDay: 10.0 };

    const ok = checkBudget(limits, { dayUsd: 6.0 }, 1.5);
    assert.equal(ok.allowed, true);
    assert.equal(ok.circuitBroken, false);
    assert.equal(ok.remainingDailyBudgetUsd, 2.5);

    const breach = checkBudget(limits, { dayUsd: 9.5 }, 1.0);
    assert.equal(breach.allowed, false);
    assert.equal(breach.circuitBroken, true);
    assert.ok(breach.reason?.includes('Daily budget exceeded'));
  });

  it('enforces perMonth budget limit', () => {
    const limits = { perMonth: 100.0 };

    const breach = checkBudget(limits, { monthUsd: 99.5 }, 1.0);
    assert.equal(breach.allowed, false);
    assert.equal(breach.circuitBroken, true);
    assert.ok(breach.reason?.includes('Monthly budget exceeded'));
  });

  it('calculates token costs correctly across models', () => {
    // 1000 input, 1000 output for Haiku ($1 / $5 per M)
    const haikuCost = calculateTokenCost('claude-haiku-4-5', 1_000, 1_000);
    // (1000 / 1M * 1) + (1000 / 1M * 5) = 0.001 + 0.005 = 0.006
    assert.equal(haikuCost, 0.006);

    // 1000 input, 1000 output for Sonnet ($3 / $15 per M)
    const sonnetCost = calculateTokenCost('claude-sonnet-4-6', 1_000, 1_000);
    // 0.003 + 0.015 = 0.018
    assert.equal(sonnetCost, 0.018);

    // Custom catalog override
    const customCost = calculateTokenCost('my-custom-model', 1_000_000, 1_000_000, {
      'my-custom-model': { inputPerMillion: 10.0, outputPerMillion: 20.0 },
    });
    assert.equal(customCost, 30.0);
  });
});
