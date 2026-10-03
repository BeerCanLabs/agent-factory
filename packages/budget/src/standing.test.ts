import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStanding } from './standing.js';

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
});
