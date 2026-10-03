import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBudgetLimits } from './limits.js';

describe('validateBudgetLimits', () => {
  it('rejects a non-object', () => {
    assert.deepEqual(validateBudgetLimits(null), { ok: false, error: 'budgetUsd must be an object' });
    assert.deepEqual(validateBudgetLimits(1), { ok: false, error: 'budgetUsd must be an object' });
    assert.deepEqual(validateBudgetLimits('perDay'), { ok: false, error: 'budgetUsd must be an object' });
  });

  it('rejects an unknown window', () => {
    assert.deepEqual(validateBudgetLimits({ perWeek: 1 }), { ok: false, error: 'unknown budget window perWeek' });
  });

  it('rejects a window that is not a finite number >= 0', () => {
    assert.deepEqual(validateBudgetLimits({ perDay: -1 }), { ok: false, error: 'budgetUsd.perDay must be >= 0' });
    assert.deepEqual(validateBudgetLimits({ perRun: Number.NaN }), { ok: false, error: 'budgetUsd.perRun must be >= 0' });
    assert.deepEqual(validateBudgetLimits({ perMonth: '5' }), { ok: false, error: 'budgetUsd.perMonth must be >= 0' });
  });

  it('accepts a valid object, including a limit of 0 and an empty object', () => {
    assert.deepEqual(validateBudgetLimits({ perRun: 0, perDay: 1.5, perMonth: 10 }), {
      ok: true,
      limits: { perRun: 0, perDay: 1.5, perMonth: 10 },
    });
    assert.deepEqual(validateBudgetLimits({}), { ok: true, limits: {} });
  });
});
