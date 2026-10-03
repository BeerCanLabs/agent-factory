import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exceededWindow, type BudgetLimits, type Spend } from './index.js';

describe('exceededWindow', () => {
  const spend: Spend = { run: 1, day: 2, month: 3 };

  it('counts a window at its limit as exceeded', () => {
    assert.equal(exceededWindow({ perRun: 1 }, spend), 'perRun');
    assert.equal(exceededWindow({ perDay: 2 }, spend), 'perDay');
    assert.equal(exceededWindow({ perMonth: 3 }, spend), 'perMonth');
  });

  it('returns undefined when limits are missing or spend is under every set window', () => {
    assert.equal(exceededWindow(undefined, spend), undefined);
    assert.equal(exceededWindow({}, spend), undefined);
    assert.equal(exceededWindow({ perRun: 1.01, perDay: 2.01, perMonth: 3.01 }, spend), undefined);
  });

  it('treats a limit of 0 as exceeded once spend is at or over 0', () => {
    assert.equal(exceededWindow({ perRun: 0 }, { run: 0, day: 0, month: 0 }), 'perRun');
    assert.equal(exceededWindow({ perDay: 0 }, { run: 0, day: 0, month: 0 }), 'perDay');
    assert.equal(exceededWindow({ perMonth: 0 }, { run: 0, day: 0, month: 0 }), 'perMonth');
  });

  it('returns the first matching window in perRun, perDay, perMonth order', () => {
    const limits: BudgetLimits = { perRun: 1, perDay: 2, perMonth: 3 };
    assert.equal(exceededWindow(limits, spend), 'perRun');
    assert.equal(exceededWindow(limits, { run: 0, day: 2, month: 3 }), 'perDay');
    assert.equal(exceededWindow(limits, { run: 0, day: 0, month: 3 }), 'perMonth');
  });
});
