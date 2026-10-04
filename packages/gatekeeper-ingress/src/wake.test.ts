import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRefusedError, wakeBody, wakeFailure, wakeRefusedText } from './wake.js';

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

describe('wake body', () => {
  const msg = { agentId: 'castle', channelId: 'c1', messageId: 'm1', content: 'hello', authorId: '42' };

  it('carries the message as input and the Discord author as the requester', () => {
    assert.deepEqual(JSON.parse(wakeBody(msg)!), { input: msg, requestedBy: { provider: 'discord', id: '42' } });
  });

  it('has no body without a message, and no requester without an author', () => {
    assert.equal(wakeBody(undefined), undefined);
    assert.deepEqual(JSON.parse(wakeBody({ content: 'hi' })!), { input: { content: 'hi' } });
  });
});
