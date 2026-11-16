import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateMindPrefixes, effectiveMindPrefix, MindPrefixRefusedError, ownMindPrefix } from './mind-prefix.js';

describe('mind prefixes name exactly one agent (GAP-263)', () => {
  const agents = [{ id: 'archie', memoryPrefix: 'archie-state' }, { id: 'castle' }, { id: 'donna' }];
  const refused = (re: RegExp) => (e: unknown) => e instanceof MindPrefixRefusedError && re.test(e.message);

  it('grants an agent its own or a free valid prefix, default its id', () => {
    assert.deepEqual(agents.map(effectiveMindPrefix), ['archie-state', 'castle', 'donna']);
    assert.equal(ownMindPrefix(agents, { id: 'archie', memoryPrefix: 'archie-state' }), 'archie-state');
    assert.equal(ownMindPrefix(agents, { id: 'newbie' }), 'newbie');
  });

  it('treats an empty prefix as set, and invalid, as task definitions do (??, not ||)', () => {
    assert.equal(effectiveMindPrefix({ id: 'donna', memoryPrefix: '' }), '');
    assert.throws(() => ownMindPrefix(agents, { id: 'm', memoryPrefix: '' }), refused(/invalid mind prefix/));
  });

  it('refuses a prefix another agent holds, explicitly or by default, and an invalid one', () => {
    assert.throws(() => ownMindPrefix(agents, { id: 'm', memoryPrefix: 'archie-state' }), refused(/already belongs to agent archie/));
    assert.throws(() => ownMindPrefix(agents, { id: 'm', memoryPrefix: 'castle' }), refused(/agent castle/));
    assert.throws(() => ownMindPrefix(agents, { id: 'archie-state' }), refused(/agent archie/));
    for (const bad of ['archie-state/x', '*', '..']) assert.throws(() => ownMindPrefix(agents, { id: 'm', memoryPrefix: bad }), refused(/invalid mind prefix/), bad);
  });

  it('finds prefixes registered agents share', () => {
    assert.deepEqual([...duplicateMindPrefixes([...agents, { id: 'x', memoryPrefix: 'castle' }])], [['castle', ['castle', 'x']]]);
  });
});
