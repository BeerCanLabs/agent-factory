// TSK-264 (DESIGN_AUTHORITY.md CF1): an agent's soul, roles and memory settings are an optional section of its
// configuration record. They are strict on input, never change the hash of a record that has none, and never carry a
// prototype key.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySettingsChange, changedParts, parseMemory, parseRoles, parseSoul, MAX_SOUL_CHARS } from './agent-settings.js';
import { configHash, type ConfigContent } from './config-store.js';

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('CF1 a record with no settings keeps the hash it had before settings existed', () => {
  // Captured from the code before this change, so a change to the hash of any existing record (and so any config version
  // or image tag) fails here.
  const donna: ConfigContent = {
    agentId: 'donna',
    source: { repo: 'https://github.com/beercanlabs/SM-donna', commit: 'a'.repeat(40) },
    skills: [{ id: 'print', version: '0.1.1' }],
    policy: { routes: ['google-calendar'], budgetUsd: { perDay: 5 } },
    owners: ['cloudflare:dale@example.com'],
  };
  it('the hash of existing content is unchanged', () => {
    assert.equal(configHash(donna), '06a2c75b6cde2e292d44b2729241564f17d5da9062ac9faf4ed9dd630c04120e');
    assert.equal(configHash({ agentId: 'x', source: {}, skills: [], policy: null }), '147faf14dcac5bdd8f8e68d7f917fffd5c2e303754df19093cb4df2c68429be5');
  });
  it('an empty section hashes as no section, and a section changes the hash', () => {
    assert.equal(configHash({ ...donna, agent: {} }), configHash(donna));
    assert.notEqual(configHash({ ...donna, agent: { soul: 'x' } }), configHash(donna));
    assert.notEqual(configHash({ ...donna, agent: { soul: 'x' } }), configHash({ ...donna, agent: { soul: 'y' } }));
    assert.notEqual(configHash({ ...donna, agent: { memory: { archetype: 'team-member' } } }), configHash({ ...donna, agent: { memory: { archetype: 'purpose-built' } } }));
  });
  it('the hash does not depend on key order', () => {
    const a = configHash({ ...donna, agent: { roles: [{ name: 'Family', skills: { gmail: { allow: [], deny: ['*'] }, print: { allow: ['*'], deny: [] } } }] } });
    const b = configHash({ ...donna, agent: { roles: [{ skills: { print: { deny: [], allow: ['*'] }, gmail: { deny: ['*'], allow: [] } }, name: 'Family' }] } });
    assert.equal(a, b);
  });
});

describe('CF1 roles are refused when badly formed, never silently dropped', () => {
  const good = [{ name: 'Family', description: 'Immediate family', skills: { 'google-calendar': { allow: ['*'] }, gmail: { deny: ['*'] } } }];
  it('accepts roles and reads them sorted, with allow and deny lists', () => {
    const r = parseRoles([...good, { name: 'Cousin', skills: { print: { allow: ['print:send'] } } }]);
    assert.ok(r.ok);
    assert.deepEqual(plain(r.roles.map((x) => x.name)), ['Cousin', 'Family']);
    assert.deepEqual(plain(r.roles[1].skills.gmail), { allow: [], deny: ['*'] });
  });
  const bad: Array<[string, unknown, RegExp]> = [
    ['not a list', { Family: {} }, /list of at most/],
    ['a bad name', [{ name: 'Fam ily', skills: { a: { allow: ['*'] } } }], /needs a name/],
    ['two names that differ only in case', [{ name: 'Family', skills: { a: { allow: ['*'] } } }, { name: 'family', skills: { a: { allow: ['*'] } } }], /defined twice/],
    ['a skill that is not an id', [{ name: 'F', skills: { '../x': { allow: ['*'] } } }], /not a skill id/],
    ['the prototype key', [{ name: 'F', skills: JSON.parse('{"__proto__":{"allow":["*"]}}') }], /not a skill id/],
    ['a rule that says nothing', [{ name: 'F', skills: { a: {} } }], /allows and denies nothing/],
    ['actions that are not names', [{ name: 'F', skills: { a: { allow: ['a b'] } } }], /not a plain name/],
    ['no skills map', [{ name: 'F' }], /needs a skills map/],
    ['too many roles', Array.from({ length: 51 }, (_, i) => ({ name: `R${i}`, skills: { a: { allow: ['*'] } } })), /at most 50/],
  ];
  for (const [what, input, why] of bad) {
    it(`refuses ${what}`, () => {
      const r = parseRoles(input);
      assert.ok(!r.ok);
      assert.match(r.error, why);
    });
  }
});

describe('CF1 memory and soul', () => {
  it('memory takes one of the three archetypes and two bounded numbers, and nothing else', () => {
    assert.deepEqual(parseMemory({ archetype: 'team-member', maxMessages: 20 }), { ok: true, memory: { archetype: 'team-member', maxMessages: 20 } });
    for (const m of [null, 'x', { archetype: 'ephemeral' }, {}, { archetype: 'team-member', secret: 1 }, { archetype: 'team-member', maxChars: 0 }, { archetype: 'team-member', maxChars: 1.5 }]) {
      assert.equal(parseMemory(m).ok, false, JSON.stringify(m));
    }
  });
  it('soul is non-empty text of bounded size', () => {
    assert.ok(parseSoul('# Soul').ok);
    for (const s of ['', '   ', 3, null, 'a\0b', 'x'.repeat(MAX_SOUL_CHARS + 1)]) assert.equal(parseSoul(s).ok, false, String(s).slice(0, 10));
    assert.ok(parseSoul('x'.repeat(MAX_SOUL_CHARS)).ok);
  });
});

describe('CF1 a change replaces what it names, null removes it, and anything else is refused', () => {
  it('merges onto the current section', () => {
    const a = applySettingsChange(undefined, { soul: 'one' });
    assert.ok(a.ok);
    const b = applySettingsChange(a.settings, { memory: { archetype: 'purpose-built' } });
    assert.ok(b.ok);
    assert.deepEqual(b.settings, { soul: 'one', memory: { archetype: 'purpose-built' } });
    const c = applySettingsChange(b.settings, { soul: null });
    assert.ok(c.ok);
    assert.deepEqual(c.settings, { memory: { archetype: 'purpose-built' } });
    const d = applySettingsChange(c.settings, { memory: null });
    assert.ok(d.ok);
    assert.deepEqual(d.settings, {}, 'nothing left: back to the repository');
  });
  it('refuses unknown keys, an empty change, and a non-object', () => {
    for (const c of [{}, { owners: ['x'] }, { soul: 'a', policy: {} }, null, [], 'x']) assert.equal(applySettingsChange(undefined, c).ok, false, JSON.stringify(c));
  });
  it('does not touch the current section when the change is refused', () => {
    const current = { soul: 'keep' };
    assert.equal(applySettingsChange(current, { soul: 'ok', roles: 'bad' }).ok, false);
    assert.deepEqual(current, { soul: 'keep' });
  });
  it('says which parts changed, by name only', () => {
    assert.deepEqual(changedParts({ soul: 'a' }, { soul: 'b', memory: { archetype: 'team-member' } }), ['soul', 'memory']);
    assert.deepEqual(changedParts(undefined, undefined), []);
    assert.deepEqual(changedParts({ soul: 'a' }, { soul: 'a' }), []);
  });
});
