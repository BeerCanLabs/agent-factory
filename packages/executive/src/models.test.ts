import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalog, toConverse } from './models.js';

describe('model catalog and translation', () => {
  it('rejects a malformed catalog', () => {
    assert.throws(() => parseModelCatalog('[]'));
    assert.throws(() => parseModelCatalog('{"x":{"provider":"bedrock-converse"}}'), /needs provider and id/);
    assert.deepEqual(parseModelCatalog(undefined), {});
  });

  it('merges consecutive same-role turns for Converse', () => {
    const body = toConverse({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    });
    assert.deepEqual(body, {
      messages: [
        { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
        { role: 'assistant', content: [{ text: 'c' }] },
      ],
    });
  });
});
