// DESIGN_AUTHORITY.md §6.15 (Treasurer), GAP-083: the budget rule exists once, in packages/budget.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

/** A spend figure compared to a limit, or a limit compared to a figure: what `exceededWindow` and `checkStanding` do. */
const SPEND_VERSUS_LIMIT = [
  /\.(?:run|day|month)\s*(?:>=|<=|>|<)(?!=)/,
  /(?:>=|<=|>|<)\s*[\w.?]*(?:budgetUsd|limits?|budget)\??\.(?:perRun|perDay|perMonth)\b/,
  /\b(?:perRun|perDay|perMonth)\s*(?:>=|<=|>|<)(?!=)/,
];

const comparisons = (src: string) => src.split('\n').flatMap((line, i) => (SPEND_VERSUS_LIMIT.some((re) => re.test(line)) ? [`${i + 1}: ${line.trim()}`] : []));

describe('Treasurer: one copy of the budget rule', () => {
  it('the pattern recognizes the comparisons it exists to forbid', () => {
    assert.equal(comparisons('if (spend.day >= policy.budgetUsd.perDay) return "perDay";').length, 1);
    assert.equal(comparisons('const over = limits.perMonth <= s.month;').length, 1);
    assert.equal(comparisons('if (b.perRun !== undefined && perRun < spend) x();').length, 1);
    assert.equal(comparisons('if (r.events.length > this.perRun) r.events.splice(0);').length, 0, 'a ring size is not a budget');
    assert.equal(comparisons('const window = checkStanding({ limits, spend });').length, 0);
  });

  it('gatekeeper-egress and control-plane source do not compare spend with a limit themselves', () => {
    const found = files('packages', (p) => /^packages\/(gatekeeper-egress|control-plane)\/src\/.*\.ts$/.test(p) && !p.endsWith('.test.ts')).flatMap((f) =>
      comparisons(read(f)).map((c) => `${f}:${c}`),
    );
    assert.deepEqual(found, [], 'ask the Treasurer: call checkStanding or exceededWindow from @beercanlabs/factory-budget');
  });
});
