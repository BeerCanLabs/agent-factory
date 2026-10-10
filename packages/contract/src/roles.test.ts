// TSK-172 (DESIGN_AUTHORITY.md E12, GAP-129): the roles a cartridge declares, and the routes a skill uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cartridgeRoleIssues, cartridgeRoleProblems, cartridgeSchema, roleSchema } from './schema.js';

// The shape Donna's cartridge.yaml has: Owner may do everything; Family may use the calendar and not Gmail.
const donna = {
  id: 'donna',
  skills: [
    { id: 'google-calendar', system: 'Google Calendar API', hold: 'none', routes: ['google-calendar'] },
    { id: 'gmail', system: 'Gmail API', hold: 'none', routes: ['google-gmail'] },
    { id: 'print', system: 'Print Service REST API', hold: 'required', routes: ['print'] },
  ],
  roles: {
    Owner: { description: 'Agent owner', skills: { '*': { allow: ['*'] } } },
    Family: {
      description: 'Immediate family',
      skills: { 'google-calendar': { allow: ['*'] }, print: { allow: ['*'] }, gmail: { deny: ['*'] } },
    },
  },
};

describe('roles a cartridge declares (E12)', () => {
  it('accepts a cartridge shaped like Donna’s, and keeps what it declared', () => {
    const r = cartridgeSchema.safeParse(donna);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
    if (r.success) {
      assert.deepEqual(Object.keys(r.data.roles!), ['Owner', 'Family']);
      assert.deepEqual(r.data.roles!.Family.skills.gmail, { deny: ['*'] });
      assert.deepEqual(r.data.skills![0].routes, ['google-calendar']);
    }
  });

  it('still accepts a cartridge with no roles and no routes (nothing existing is forced to declare them)', () => {
    assert.equal(cartridgeSchema.safeParse({ id: 'plain', skills: [{ id: 'notes' }] }).success, true);
    assert.equal(cartridgeSchema.safeParse({ id: 'plain' }).success, true);
  });

  it('accepts a role that lists no skills (it may use none)', () => {
    const r = cartridgeSchema.safeParse({ id: 'a', roles: { Guest: { description: 'nothing yet' } } });
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.data.roles!.Guest.skills, {});
  });

  it('refuses the wrong shape: unknown keys, a rule that says nothing, a bad role name', () => {
    const bad = (roles: unknown) => cartridgeSchema.safeParse({ ...donna, roles }).success;
    assert.equal(bad({ Family: { skills: { gmail: { deny: ['*'] } }, extra: 1 } }), false, 'unknown key on a role');
    assert.equal(bad({ Family: { skills: { gmail: { deny: ['*'], block: true } } } }), false, 'unknown key on a rule');
    assert.equal(bad({ Family: { skills: { gmail: {} } } }), false, 'an empty rule');
    assert.equal(bad({ Family: { skills: { gmail: { allow: [], deny: [] } } } }), false, 'a rule with empty lists');
    assert.equal(bad({ 'Not A Role': { skills: {} } }), false, 'a name with spaces');
    assert.equal(bad({ ['x'.repeat(65)]: { skills: {} } }), false, 'a name over 64 characters');
    assert.equal(bad({ Family: { skills: { gmail: { allow: [''] } } } }), false, 'an empty action name');
    assert.equal(bad([]), false, 'a list instead of a map');
  });

  it('refuses a role that names a skill the cartridge does not declare, naming where', () => {
    const r = cartridgeSchema.safeParse({ ...donna, roles: { Family: { skills: { 'home-print': { allow: ['*'] }, 'google-calendar': { allow: ['*'] } } } } });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      assert.deepEqual(msgs, ['roles.Family.skills.home-print: role "Family" names skill "home-print", which the cartridge does not declare in skills[]']);
    }
  });

  it('allows the "*" skill without declaring it, and a cartridge that declares no skills at all', () => {
    assert.deepEqual(cartridgeRoleIssues({ roles: { Owner: { skills: { '*': { allow: ['*'] } } } } }), []);
    assert.equal(cartridgeSchema.safeParse({ id: 'a', roles: { Owner: { skills: { '*': { allow: ['*'] } } } } }).success, true);
  });

  it('refuses two roles that differ only in case: one role under two names', () => {
    const issues = cartridgeRoleIssues({ ...donna, roles: { Family: { skills: {} }, family: { skills: {} } } });
    assert.deepEqual(issues.map((i) => i.message), ['role "family" is the same role as "Family": role names differ by more than case']);
  });

  it('reports every problem at once, and nothing for a cartridge with no roles', () => {
    const issues = cartridgeRoleIssues({ skills: [{ id: 'a' }], roles: { X: { skills: { b: { allow: ['*'] }, c: { allow: ['*'] }, a: { allow: ['*'] } } } } });
    assert.deepEqual(issues.map((i) => i.path.join('.')), ['roles.X.skills.b', 'roles.X.skills.c']);
    assert.deepEqual(cartridgeRoleIssues({}), []);
    assert.deepEqual(cartridgeRoleIssues({ roles: null }), []);
    assert.deepEqual(cartridgeRoleIssues({ roles: [] }), []);
  });

  it('survives a skills list that is malformed or holds non-objects', () => {
    assert.deepEqual(cartridgeRoleIssues({ skills: 'nope', roles: { A: { skills: { b: { allow: ['*'] } } } } }).map((i) => i.path.join('.')), ['roles.A.skills.b']);
    assert.deepEqual(cartridgeRoleIssues({ skills: [null, 3, 'x', { id: 'b' }], roles: { A: { skills: { b: { allow: ['*'] } } } } }), []);
  });

  it('a role is just its shape: the role schema alone defaults skills to none', () => {
    assert.deepEqual(roleSchema.parse({}), { skills: {} });
  });
});

describe('the routes a cartridge skill uses (E12)', () => {
  const skill = (routes: unknown) => cartridgeSchema.safeParse({ id: 'a', skills: [{ id: 's', routes }] }).success;

  it('are gatekeeper-egress route ids', () => {
    assert.equal(skill(['google-calendar', 'print_2']), true);
    assert.equal(skill([]), true);
  });

  it('are never a host, a URL, a path or a name with spaces or capitals', () => {
    for (const bad of [['calendar.google.com'], ['https://x'], ['a/b'], ['A'], ['a b'], [''], ['-x'], [3], 'google-calendar']) {
      assert.equal(skill(bad), false, JSON.stringify(bad));
    }
  });
});

describe('every problem with a cartridge body’s roles and routes, as reasons (registration)', () => {
  it('is empty for Donna’s shape, for no roles, and for a body that is not a cartridge', () => {
    assert.deepEqual(cartridgeRoleProblems(donna), []);
    assert.deepEqual(cartridgeRoleProblems({}), []);
    assert.deepEqual(cartridgeRoleProblems({ roles: null }), []);
  });

  it('names each problem where it is: shape, an undeclared skill, a route that is not a route id', () => {
    const reasons = cartridgeRoleProblems({
      skills: [{ id: 'gmail', routes: ['mail.google.com'] }, { id: 'notes', routes: 'notes' }],
      roles: { Family: { skills: { gmail: {}, 'home-print': { allow: ['*'] } } }, 'Bad Name': { skills: {} } },
    });
    assert.ok(reasons.some((r) => /^roles\.Family\.skills\.gmail: a rule must list at least one action/.test(r)), JSON.stringify(reasons));
    assert.ok(reasons.some((r) => /^roles\.Bad Name: a role name is letters/.test(r) || /Bad Name/.test(r)), JSON.stringify(reasons));
    assert.ok(reasons.includes('roles.Family.skills.home-print: role "Family" names skill "home-print", which the cartridge does not declare in skills[]'));
    assert.ok(reasons.includes('skills.gmail.routes: a skill route is a gatekeeper-egress route id (lowercase letters, digits, - and _), never a host'));
    assert.ok(reasons.includes('skills.notes.routes: a skill route is a gatekeeper-egress route id (lowercase letters, digits, - and _), never a host'));
  });
});
