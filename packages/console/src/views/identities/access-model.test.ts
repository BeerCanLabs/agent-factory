// TSK-173 (DESIGN_AUTHORITY.md E12): what the Identities screen shows and sends for a person's agent roles. The console has
// no component test runner, so this is where it is proved. What a set of roles may use is the factory's to say; this only
// puts it into words.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EffectiveAccess, SkillAccess } from '../../api/types.js';
import { accessSentence, canonicalRoles, describeAccess, factoryRoleWarnings, sameRoles, summarizeRoles, unassignedAgents, withRole, withoutAgent } from './access-model.js';

const eff = (skills: Array<[string, SkillAccess]>, held = ['Family'], unknownRoles: string[] = []): EffectiveAccess => ({
  held,
  unknownRoles,
  skills: skills.map(([skill, access]) => ({ skill, access, routes: [] })),
  routes: {},
});

describe('a person’s agent roles as the screen holds and sends them', () => {
  it('puts the map in one form: agents and roles sorted, unique, blanks and empty lists dropped', () => {
    assert.deepEqual(canonicalRoles({ higgins: ['Realtor', 'Family', 'Family', ' '], donna: ['Family'], ghost: [], empty: [''] }), { donna: ['Family'], higgins: ['Family', 'Realtor'] });
    assert.deepEqual(canonicalRoles(undefined), {});
    assert.deepEqual(canonicalRoles({}), {});
  });

  it('compares two maps by what they hold, not by how they are ordered', () => {
    assert.equal(sameRoles({ donna: ['B', 'A'] }, { donna: ['A', 'B'] }), true);
    assert.equal(sameRoles({ donna: ['A'], ghost: [] }, { donna: ['A'] }), true);
    assert.equal(sameRoles({ donna: ['A'] }, { donna: ['A', 'B'] }), false);
    assert.equal(sameRoles(undefined, {}), true);
    assert.equal(sameRoles({ donna: ['A'] }, undefined), false);
  });

  it('gives a role, and takes it away, without touching the rest, and without changing its input', () => {
    const before = { donna: ['Family'], higgins: ['Realtor'] };
    const added = withRole(before, 'donna', 'Aunt', true);
    assert.deepEqual(added, { donna: ['Aunt', 'Family'], higgins: ['Realtor'] });
    assert.deepEqual(withRole(added, 'donna', 'Aunt', false), before);
    assert.deepEqual(before, { donna: ['Family'], higgins: ['Realtor'] });
    assert.deepEqual(withRole(before, 'donna', 'Family', true), before, 'giving a role twice changes nothing');
  });

  it('drops an agent once its last role is taken away, so the person is saved holding nothing there', () => {
    assert.deepEqual(withRole({ donna: ['Family'], higgins: ['Realtor'] }, 'donna', 'Family', false), { higgins: ['Realtor'] });
    assert.deepEqual(withRole(undefined, 'donna', 'Family', true), { donna: ['Family'] });
    assert.deepEqual(withRole(undefined, 'donna', 'Family', false), {});
  });

  it('takes away every role on one agent at once', () => {
    assert.deepEqual(withoutAgent({ donna: ['Family', 'Aunt'], higgins: ['Realtor'] }, 'donna'), { higgins: ['Realtor'] });
    assert.deepEqual(withoutAgent({ donna: ['Family'] }, 'nobody'), { donna: ['Family'] });
  });

  it('lists the agents a person holds nothing on, in order, leaving out those already chosen', () => {
    const agents = [{ id: 'higgins' }, { id: 'donna' }, { id: 'castle' }];
    assert.deepEqual(unassignedAgents(agents, { donna: ['Family'] }).map((a) => a.id), ['castle', 'higgins']);
    assert.deepEqual(unassignedAgents(agents, { donna: ['Family'] }, ['castle']).map((a) => a.id), ['higgins']);
    assert.deepEqual(unassignedAgents(agents, undefined).map((a) => a.id), ['castle', 'donna', 'higgins']);
    assert.deepEqual(unassignedAgents(agents, { constructor: ['x'] } as never).map((a) => a.id).length, 3, 'a map key that is a prototype name is not an agent');
  });

  it('summarizes for a table cell: role on agent, one per role', () => {
    assert.deepEqual(summarizeRoles({ higgins: ['Realtor', 'Family'], donna: ['Family'] }), ['Family on donna', 'Family on higgins', 'Realtor on higgins']);
    assert.deepEqual(summarizeRoles(undefined), []);
    assert.deepEqual(summarizeRoles({ donna: [] }), []);
  });
});

describe('saying what a set of roles may use, from what the factory answered', () => {
  it('Family: can use the calendar and printing, refused Gmail: the example this exists for', () => {
    const w = describeAccess(eff([['google-calendar', { kind: 'all' }], ['gmail', { kind: 'none', why: 'denied' }], ['print', { kind: 'all' }]]));
    assert.deepEqual([w.can, w.cannot, w.notTheirs], [['google-calendar', 'print'], ['gmail'], []]);
    assert.equal(accessSentence(w), 'Can use google-calendar, print. Refused gmail.');
  });

  it('separates a skill that is refused from one that is simply not theirs', () => {
    const w = describeAccess(eff([['gmail', { kind: 'none', why: 'denied' }], ['print', { kind: 'none', why: 'unlisted' }], ['notes', { kind: 'all' }]]));
    assert.deepEqual([w.can, w.cannot, w.notTheirs], [['notes'], ['gmail'], ['print']]);
  });

  it('says what an action limit is', () => {
    const w = describeAccess(eff([['gmail', { kind: 'only', actions: ['read', 'send'] }], ['google-calendar', { kind: 'except', actions: ['delete'] }]]));
    assert.deepEqual(w.can, ['gmail (only read, send)', 'google-calendar (not delete)']);
  });

  it('says plainly when someone holds no role, or holds one that allows nothing', () => {
    const none = describeAccess(eff([['gmail', { kind: 'none', why: 'unlisted' }]], []));
    assert.equal(accessSentence(none), 'Holds no role here, so the agent will do nothing for them.');
    const empty = describeAccess(eff([['gmail', { kind: 'none', why: 'unlisted' }]], ['Aunt']));
    assert.equal(accessSentence(empty), 'Can use none of its skills.');
    assert.equal(accessSentence(describeAccess(eff([['gmail', { kind: 'none', why: 'denied' }]], ['Family']))), 'Can use none of its skills. Refused gmail.');
  });

  it('carries a held role the agent no longer declares, so the screen can flag it', () => {
    const w = describeAccess(eff([['print', { kind: 'all' }]], ['Family'], ['Cousin']));
    assert.deepEqual(w.unknownRoles, ['Cousin']);
  });
});

describe('a factory role beside an agent role', () => {
  it('warns that Operator reaches every agent, and what removing it does', () => {
    const w = factoryRoleWarnings(['operator'], { donna: ['Family'] });
    assert.equal(w.length, 1);
    assert.match(w[0], /Operator reaches every agent/);
    assert.match(w[0], /To limit this person to the roles below, remove Operator/);
  });

  it('says how to give access to one agent only, when no agent role is chosen yet', () => {
    assert.match(factoryRoleWarnings(['operator', 'viewer'], {})[0], /To give this person access to one agent only, remove Operator/);
  });

  it('warns that Admin makes agent roles add nothing, and says nothing about Operator then', () => {
    const w = factoryRoleWarnings(['admin', 'operator'], { donna: ['Family'] });
    assert.equal(w.length, 1);
    assert.match(w[0], /Admin can do everything on every agent/);
  });

  it('says nothing for a viewer, an approver, or no role', () => {
    for (const roles of [['viewer'], ['approver'], [], undefined] as const) assert.deepEqual(factoryRoleWarnings(roles as never, { donna: ['Family'] }), []);
  });
});
