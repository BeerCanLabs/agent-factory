import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronIssue, cronMatches } from './index.js';

describe('cronMatches', () => {
  it('matches */1 cron on the current minute', () => {
    assert.equal(cronMatches('* * * * *'), true);
    assert.equal(cronMatches('60 * * * *'), false);
  });

  it('matches comma and range expressions', () => {
    const fixed = { minute: 0, hour: 12, day: 23, month: 9, weekday: 3 };
    assert.equal(cronMatches('0 12 * * *', fixed), true);
    assert.equal(cronMatches('0 10,12,14 * * *', fixed), true);
    assert.equal(cronMatches('0 10-15 * * *', fixed), true);
    assert.equal(cronMatches('0 1-5 * * *', fixed), false);
  });
});

describe('cronIssue', () => {
  it('invalid cron: cronIssue accepts exactly the forms the scheduler evaluates', () => {
    for (const ok of ['* * * * *', '0 6 * * *', '30 7 * * 1-5', '0 9 * * 1', '*/15 * * * *', '0 0 1,15 * *', '0 8 * * 0,6', '0 8 * * 7', '59 23 31 12 *']) {
      assert.equal(cronIssue(ok), null, `refused valid cron "${ok}"`);
    }
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* * 0 * *', '* * * 0 *', '1-60 * * * *', 'a * * * *', '-1 * * * *', '*/x * * * *']) {
      assert.notEqual(cronIssue(bad), null, `accepted invalid cron "${bad}"`);
    }
  });
});
