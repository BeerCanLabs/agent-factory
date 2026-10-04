import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HELD_BODY_LIMIT, HELD_HEADERS, HELD_STORED_BODY_LIMIT } from './index.js';

describe('E9 limits', () => {
  it('HELD_STORED_BODY_LIMIT is the base64 size of HELD_BODY_LIMIT', () => {
    assert.equal(HELD_STORED_BODY_LIMIT, 262144);
    assert.equal(HELD_STORED_BODY_LIMIT, Math.ceil(HELD_BODY_LIMIT / 3) * 4);
  });

  it('the base64 text of exactly HELD_BODY_LIMIT bytes fits and one more byte does not', () => {
    assert.ok(Buffer.alloc(HELD_BODY_LIMIT).toString('base64').length <= HELD_STORED_BODY_LIMIT);
    assert.ok(Buffer.alloc(HELD_BODY_LIMIT + 1).toString('base64').length > HELD_STORED_BODY_LIMIT);
  });

  it('HELD_HEADERS lists the six names it lists today', () => {
    assert.deepEqual([...HELD_HEADERS], ['content-type', 'x-restli-method', 'x-http-method-override', 'x-http-method', 'x-method-override', 'linkedin-version']);
  });
});
