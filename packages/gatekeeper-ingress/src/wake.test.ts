import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRefusedError, UnauthorizedCallerError, wakeBody, wakeFailure, wakeRefusedText, unauthorizedCallerText } from './wake.js';

describe('wake refusal', () => {
  it('a 402 budget_exceeded body becomes a typed refusal carrying the window', () => {
    const err = wakeFailure(402, JSON.stringify({ error: 'budget_exceeded', window: 'perDay' }));
    assert.ok(err instanceof WakeRefusedError);
    assert.equal((err as WakeRefusedError).window, 'perDay');
  });

  it('a 403 unauthorized_caller body becomes a typed UnauthorizedCallerError', () => {
    const err = wakeFailure(403, JSON.stringify({ error: 'unauthorized_caller', reason: 'Identity link not found' }));
    assert.ok(err instanceof UnauthorizedCallerError);
    assert.equal((err as UnauthorizedCallerError).reason, 'Identity link not found');
  });

  it('any other failure keeps the generic error', () => {
    for (const [status, body] of [[412, '{}'], [500, ''], [402, 'not json'], [402, JSON.stringify({ error: 'other' })], [402, JSON.stringify({ error: 'budget_exceeded' })], [403, 'not json'], [403, JSON.stringify({ error: 'forbidden' })]] as const) {
      const err = wakeFailure(status, body);
      assert.ok(!(err instanceof WakeRefusedError), `${status} ${body}`);
      assert.ok(!(err instanceof UnauthorizedCallerError), `${status} ${body}`);
      assert.equal(err.message, `factory answered ${status}`);
    }
  });

  it('the channel sentence names the window and carries no spend figures', () => {
    assert.equal(wakeRefusedText('Donna', 'perDay'), '🚫 *Donna is over its daily budget (perDay), so it was not started.*');
    assert.match(wakeRefusedText('Donna', 'perMonth'), /monthly budget \(perMonth\)/);
    assert.doesNotMatch(wakeRefusedText('Donna', 'perDay'), /\$|\d/);
  });

  it('the channel sentence for unauthorized caller refuses politely', () => {
    assert.equal(unauthorizedCallerText('Donna'), '⛔ *You are not authorized to interact with Donna. Please contact the factory administrator.*');
  });

  it('a refused handoff is typed as a handoff and says the message was not delivered', () => {
    const err = wakeFailure(402, JSON.stringify({ error: 'budget_exceeded', window: 'blocked' }), 'handoff');
    assert.ok(err instanceof WakeRefusedError);
    assert.equal((err as WakeRefusedError).kind, 'handoff');
    assert.equal(wakeRefusedText('Donna', 'perMonth', 'handoff'), '🚫 *Donna is over its monthly budget (perMonth), so your message was not delivered.*');
    assert.equal(wakeRefusedText('Donna', 'blocked', 'handoff'), '🚫 *Donna is over its budget, so your message was not delivered.*');
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
