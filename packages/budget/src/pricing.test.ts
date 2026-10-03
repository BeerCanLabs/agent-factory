import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, priceFor } from './pricing.js';

describe('pricing', () => {
  const prices = { 'test-*': { inputPerMTok: 1, outputPerMTok: 2 }, 'test-big': { inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 1 } };

  it('exact match beats prefix; unknown models are unpriced', () => {
    assert.equal(priceFor(prices, 'test-big')?.inputPerMTok, 10);
    assert.equal(priceFor(prices, 'test-small')?.inputPerMTok, 1);
    assert.equal(priceFor(prices, 'other'), undefined);
    assert.equal(priceFor(prices, undefined), undefined);
  });

  it('the longest prefix match wins', () => {
    const prefixed = {
      'claude*': { inputPerMTok: 1, outputPerMTok: 1 },
      'claude-3*': { inputPerMTok: 4, outputPerMTok: 4 },
      'claude-3-5*': { inputPerMTok: 5, outputPerMTok: 5 },
    };
    assert.equal(priceFor(prefixed, 'claude-3-5-sonnet')?.inputPerMTok, 5);
    assert.equal(priceFor(prefixed, 'claude-3-opus')?.inputPerMTok, 4);
    assert.equal(priceFor(prefixed, 'claude-2')?.inputPerMTok, 1);
  });

  it('computes USD from normalized usage', () => {
    const usd = costUsd({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 }, prices['test-big']);
    assert.equal(usd, 10 + 10 + 2);
  });

  it('falls back to the input rate for cache reads and writes', () => {
    const usd = costUsd(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    assert.equal(usd, 3 + 3);
  });

  it('rounds USD to 1e-8', () => {
    const usd = costUsd(
      { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { inputPerMTok: 1.23456789, outputPerMTok: 0 },
    );
    assert.equal(usd, 0.00000123);
  });
});
