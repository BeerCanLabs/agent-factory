import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chargeTraining, outputPasses } from './training.js';

describe('skill training account', () => {
  it('scores an output against the baseline assertions', () => {
    assert.equal(outputPasses('hello world', { contains: 'world' }), true);
    assert.equal(outputPasses('hello', { equals: 'hello' }), true);
    assert.equal(outputPasses('abc-9', { matches: '^abc-\\d$' }), true);
    assert.equal(outputPasses('nope', { contains: 'world' }), false);
    assert.equal(outputPasses('hello', {}), false);
    assert.equal(outputPasses('hello', { matches: '(' }), false);
  });

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
