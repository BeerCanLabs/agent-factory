import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRefusedError, wakeFailure, wakeRefusedText } from './wake.js';

describe('wake refusal', () => {
  it('a 402 budget_exceeded body becomes a typed refusal carrying the window', () => {
    const err = wakeFailure(402, JSON.stringify({ error: 'budget_exceeded', window: 'perDay' }));
    assert.ok(err instanceof WakeRefusedError);
    assert.equal((err as WakeRefusedError).window, 'perDay');
  });

  it('any other failure keeps the generic error', () => {
    for (const [status, body] of [[412, '{}'], [500, ''], [402, 'not json'], [402, JSON.stringify({ error: 'other' })], [402, JSON.stringify({ error: 'budget_exceeded' })]] as const) {
      const err = wakeFailure(status, body);
      assert.ok(!(err instanceof WakeRefusedError), `${status} ${body}`);
      assert.equal(err.message, `factory answered ${status}`);
    }
  });

  it('the channel sentence names the window and carries no spend figures', () => {
    assert.equal(wakeRefusedText('Donna', 'perDay'), '🚫 *Donna is over its daily budget (perDay), so it was not started.*');
    assert.match(wakeRefusedText('Donna', 'perMonth'), /monthly budget \(perMonth\)/);
    assert.doesNotMatch(wakeRefusedText('Donna', 'perDay'), /\$|\d/);
  });
});
