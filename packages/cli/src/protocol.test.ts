import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseManagerReply } from './protocol.js';

describe('§6.17 CL4 the manager protocol', () => {
  it('CL4 reads a message, tool requests and a connect request', () => {
    assert.deepEqual(parseManagerReply('{"type":"message","text":"hi"}'), { type: 'message', text: 'hi' });
    assert.deepEqual(parseManagerReply('{"type":"connect","agent":"donna","text":"ok"}'), { type: 'connect', agent: 'donna', text: 'ok' });
    assert.deepEqual(parseManagerReply('{"type":"tool_calls","calls":[{"id":"1","name":"list_agents"}]}'), {
      type: 'tool_calls',
      calls: [{ id: '1', name: 'list_agents', arguments: {} }],
    });
  });

  it('CL7 shows anything that is not protocol as plain text, so a platform notice still reaches the person', () => {
    const notice = '⚠️ Action unverified: nothing was executed.';
    assert.deepEqual(parseManagerReply(notice), { type: 'message', text: notice });
    assert.deepEqual(parseManagerReply('{"type":"tool_calls","calls":[{"name":"x"}]}').type, 'message');
    assert.deepEqual(parseManagerReply('{"type":"connect"}').type, 'message');
    assert.deepEqual(parseManagerReply('[1]').type, 'message');
  });
});
