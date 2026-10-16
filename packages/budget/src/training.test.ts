import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chargeTraining } from './training.js';

describe('skill training account', () => {
  it('refuses a charge with no cap and a charge past the cap', () => {
    assert.deepEqual(chargeTraining(undefined, 1), { ok: false, error: 'training_budget_required' });
    const open = chargeTraining({ capUsd: 2, spentUsd: 0 }, 1);
    assert.equal(open.ok, true);
    if (!open.ok) return;
    assert.deepEqual(chargeTraining(open.account, 1.01), { ok: false, error: 'training_budget_exceeded' });
    const full = chargeTraining(open.account, 1);
    assert.equal(full.ok && full.account.spentUsd, 2);
  });
});
