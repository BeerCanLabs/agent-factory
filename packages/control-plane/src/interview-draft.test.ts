// Story #367 ([S21] Interview helper, Epic #349).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftFromInterview } from './interview-draft.js';

describe('S21 interview step validation', () => {
  it('a personal agent interview becomes a personal draft with the purpose as its soul', () => {
    const d = draftFromInterview({ name: 'Mail Helper', kind: 'personal', purpose: 'Sorts my email every morning.' });
    assert.ok(d.ok);
    assert.equal(d.content.id, 'mail-helper');
    assert.equal(d.content.kind, 'personal');
    assert.equal(d.content.soul, 'Sorts my email every morning.');
    assert.equal(d.content.accountableLead, undefined);
  });
  it('a team agent needs a lead; a personal one may not name one', () => {
    const team = draftFromInterview({ name: 'Ops', kind: 'team', purpose: 'Watches the deploy queue.' });
    assert.ok(!team.ok && team.errors.some((e) => e.step === 'lead'));
    const ok = draftFromInterview({ name: 'Ops', kind: 'team', lead: 'user:dale', purpose: 'Watches the deploy queue.' });
    assert.ok(ok.ok && ok.content.accountableLead === 'user:dale');
    const personal = draftFromInterview({ name: 'Me', kind: 'personal', lead: 'user:x', purpose: 'Helps me with things.' });
    assert.ok(!personal.ok && personal.errors.some((e) => e.step === 'lead'));
  });
  it('reports every bad step at once and never carries a budget', () => {
    const d = draftFromInterview({ name: '', kind: 'robot', purpose: 'short', skills: ['ok', 'bad id!'] });
    assert.ok(!d.ok);
    assert.deepEqual(d.errors.map((e) => e.step).sort(), ['kind', 'name', 'purpose', 'skills']);
    const good = draftFromInterview({ name: 'X', kind: 'personal', purpose: 'Does a useful thing.', budgetUsd: 5 } as never);
    assert.ok(good.ok && !('budgetUsd' in good.content));
  });
});
