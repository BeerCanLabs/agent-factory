import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStanding, ZERO_BUDGET_LIMITS } from './standing.js';
import { isZeroPrice, ZERO_PRICE } from './pricing.js';

describe('checkStanding', () => {
  const limits = { perRun: 1, perDay: 5, perMonth: 20 };
  const spend = { run: 0.4, day: 4.5, month: 19 };

  it('is in good standing when spend, including pending, is under every limit', () => {
    assert.deepEqual(checkStanding({ limits, spend, pendingUsd: 0.4 }), { inGoodStanding: true });
    assert.deepEqual(checkStanding({ limits, spend }), { inGoodStanding: true });
  });

  it('pending spend can tip each window, in perRun, perDay, perMonth order', () => {
    assert.deepEqual(checkStanding({ limits, spend, pendingUsd: 0.6 }), { inGoodStanding: false, window: 'perRun' });
    assert.deepEqual(
      checkStanding({ limits: { perDay: 5, perMonth: 20 }, spend, pendingUsd: 0.5 }),
      { inGoodStanding: false, window: 'perDay' },
    );
    assert.deepEqual(
      checkStanding({ limits: { perMonth: 20 }, spend: { run: 0, day: 0, month: 19.5 }, pendingUsd: 0.5 }),
      { inGoodStanding: false, window: 'perMonth' },
    );
  });

  it('treats a missing limit object as good standing', () => {
    assert.deepEqual(checkStanding({ limits: undefined, spend, pendingUsd: 100 }), { inGoodStanding: true });
  });

  it('M5(8), D25: ZERO_BUDGET_LIMITS ({ perDay: 0, perMonth: 0 }) denies >$0 models at $0 spend while allowing $0-priced entries', () => {
    const zeroSpend = { run: 0, day: 0, month: 0 };
    assert.deepEqual(ZERO_BUDGET_LIMITS, { perDay: 0, perMonth: 0 });
    assert.deepEqual(checkStanding({ limits: ZERO_BUDGET_LIMITS, spend: zeroSpend }), {
      inGoodStanding: false,
      window: 'perDay',
    });
    assert.deepEqual(
      checkStanding({ limits: ZERO_BUDGET_LIMITS, spend: zeroSpend, selectedModelIsZeroPrice: true }),
      { inGoodStanding: true },
    );
    assert.equal(isZeroPrice(ZERO_PRICE), true);
    assert.equal(isZeroPrice({ inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }), true);
    assert.equal(isZeroPrice(undefined), false);
    assert.equal(isZeroPrice({ inputPerMTok: 0, outputPerMTok: 0.01 }), false);
    assert.equal(isZeroPrice({ inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0.5 }), false);
  });
});
