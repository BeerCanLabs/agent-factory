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

  it('a refused handoff is typed as a handoff and says the message was not delivered', () => {
    const err = wakeFailure(402, JSON.stringify({ error: 'budget_exceeded', window: 'blocked' }), 'handoff');
    assert.ok(err instanceof WakeRefusedError);
    assert.equal((err as WakeRefusedError).kind, 'handoff');
    assert.equal(wakeRefusedText('Donna', 'perMonth', 'handoff'), '🚫 *Donna is over its monthly budget (perMonth), so your message was not delivered.*');
    assert.equal(wakeRefusedText('Donna', 'blocked', 'handoff'), '🚫 *Donna is over its budget, so your message was not delivered.*');
  });
});
