// TSK-173 (DESIGN_AUTHORITY.md E12): what a person who holds some roles on an agent may use. One rule, shared by the screen
// that describes it and the egress that enforces it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccess, type AccessRole } from './access.js';

const rule = (allow: string[] = [], deny: string[] = []) => ({ allow, deny });
const SKILLS = ['google-calendar', 'gmail', 'print'];
const ROUTES = { 'google-calendar': ['google-calendar'], gmail: ['google-gmail'], print: ['print'] };
const kinds = (a: ReturnType<typeof effectiveAccess>) => Object.fromEntries(a.skills.map((s) => [s.skill, s.access.kind === 'none' ? `none:${s.access.why}` : s.access.kind]));

// The shape of Donna's cartridge: Owner may use everything; Family the calendar and printing, never Gmail.
const donna: AccessRole[] = [
  { name: 'Owner', skills: { '*': rule(['*']) } },
  { name: 'Family', skills: { 'google-calendar': rule(['*']), print: rule(['*']), gmail: rule([], ['*']) } },
];

describe('what someone who holds a role may use (E12)', () => {
  it('Family may use the calendar and printing, and is refused Gmail: the example this exists for', () => {
    const a = effectiveAccess(donna, ['Family'], SKILLS, ROUTES);
    assert.deepEqual(kinds(a), { 'google-calendar': 'all', gmail: 'none:denied', print: 'all' });
    assert.deepEqual(a.routes, { 'google-calendar': 'allowed', 'google-gmail': 'denied', print: 'allowed' });
    assert.deepEqual([a.held, a.unknownRoles], [['Family'], []]);
  });

  it('Owner may use everything', () => {
    const a = effectiveAccess(donna, ['Owner'], SKILLS, ROUTES);
    assert.deepEqual(kinds(a), { 'google-calendar': 'all', gmail: 'all', print: 'all' });
    assert.deepEqual(a.routes, { 'google-calendar': 'allowed', 'google-gmail': 'allowed', print: 'allowed' });
  });

  it('someone who holds no role may use nothing: not denied, simply not theirs', () => {
    const a = effectiveAccess(donna, [], SKILLS, ROUTES);
    assert.deepEqual(kinds(a), { 'google-calendar': 'none:unlisted', gmail: 'none:unlisted', print: 'none:unlisted' });
    assert.deepEqual(a.routes, { 'google-calendar': 'denied', 'google-gmail': 'denied', print: 'denied' });
  });

  it('a skill a role does not list is not allowed, whatever it is', () => {
    const a = effectiveAccess([{ name: 'Aunt', skills: { 'google-calendar': rule(['*']) } }], ['Aunt'], SKILLS, ROUTES);
    assert.deepEqual(kinds(a), { 'google-calendar': 'all', gmail: 'none:unlisted', print: 'none:unlisted' });
  });

  it('deny wins when a person holds two roles that disagree', () => {
    const roles: AccessRole[] = [...donna, { name: 'Realtor', skills: { gmail: rule(['*']), 'google-calendar': rule(['*']) } }];
    const a = effectiveAccess(roles, ['Family', 'Realtor'], SKILLS, ROUTES);
    assert.deepEqual(kinds(a), { 'google-calendar': 'all', gmail: 'none:denied', print: 'all' }, 'Family’s denial beats Realtor’s allowance');
    assert.equal(a.routes['google-gmail'], 'denied');
  });

  it('two roles together allow what either allows', () => {
    const roles: AccessRole[] = [{ name: 'A', skills: { gmail: rule(['read']) } }, { name: 'B', skills: { gmail: rule(['send']), print: rule(['*']) } }];
    const a = effectiveAccess(roles, ['A', 'B'], SKILLS, ROUTES);
    assert.deepEqual(a.skills.find((s) => s.skill === 'gmail')!.access, { kind: 'only', actions: ['read', 'send'] });
    assert.deepEqual(a.skills.find((s) => s.skill === 'print')!.access, { kind: 'all' });
  });

  it('lists the actions a role allows when it does not allow all, and the ones it denies when it allows all but some', () => {
    const roles: AccessRole[] = [
      { name: 'Reader', skills: { 'google-calendar': rule(['read', 'list']) } },
      { name: 'NoDelete', skills: { 'google-calendar': rule(['*'], ['delete', 'purge']) } },
    ];
    assert.deepEqual(effectiveAccess(roles, ['Reader'], SKILLS).skills[0].access, { kind: 'only', actions: ['list', 'read'] });
    assert.deepEqual(effectiveAccess(roles, ['NoDelete'], SKILLS).skills[0].access, { kind: 'except', actions: ['delete', 'purge'] });
  });

  it('an action both allowed and denied is denied; all of them denied is a denial', () => {
    const roles: AccessRole[] = [{ name: 'X', skills: { gmail: rule(['read', 'send'], ['send']) } }, { name: 'Y', skills: { print: rule(['go'], ['go']) } }];
    assert.deepEqual(effectiveAccess(roles, ['X'], SKILLS).skills.find((s) => s.skill === 'gmail')!.access, { kind: 'only', actions: ['read'] });
    assert.deepEqual(effectiveAccess(roles, ['Y'], SKILLS).skills.find((s) => s.skill === 'print')!.access, { kind: 'none', why: 'denied' });
  });

  it('a role that only denies some actions grants nothing, and does not block another skill on the same route', () => {
    const roles: AccessRole[] = [{ name: 'Careful', skills: { gmail: rule([], ['delete']), 'gmail-lite': rule(['*']) } }];
    const a = effectiveAccess(roles, ['Careful'], ['gmail', 'gmail-lite'], { gmail: ['google-gmail'], 'gmail-lite': ['google-gmail'] });
    assert.deepEqual(kinds(a), { gmail: 'none:unlisted', 'gmail-lite': 'all' });
    assert.equal(a.routes['google-gmail'], 'allowed', 'nothing was refused outright');
  });

  it('the "*" skill applies to every skill, beside a role’s own entry, and a named denial still wins', () => {
    const roles: AccessRole[] = [{ name: 'AllButMail', skills: { '*': rule(['*']), gmail: rule([], ['*']) } }];
    assert.deepEqual(kinds(effectiveAccess(roles, ['AllButMail'], SKILLS, ROUTES)), { 'google-calendar': 'all', gmail: 'none:denied', print: 'all' });
  });

  it('a route is denied if any skill that uses it is denied outright, even when another allowed skill uses it too', () => {
    const roles: AccessRole[] = [{ name: 'R', skills: { 'gmail-lite': rule(['*']), gmail: rule([], ['*']) } }];
    const a = effectiveAccess(roles, ['R'], ['gmail', 'gmail-lite'], { gmail: ['google-gmail'], 'gmail-lite': ['google-gmail'] });
    assert.equal(a.routes['google-gmail'], 'denied', 'deny wins at the route, which is all the egress can see');
  });

  it('a route is allowed when an allowed skill uses it and the others are only unlisted', () => {
    const roles: AccessRole[] = [{ name: 'R', skills: { 'gmail-lite': rule(['*']) } }];
    const a = effectiveAccess(roles, ['R'], ['gmail', 'gmail-lite'], { gmail: ['google-gmail'], 'gmail-lite': ['google-gmail'] });
    assert.equal(a.routes['google-gmail'], 'allowed');
  });

  it('reports a held role the agent does not declare, and gives it no access', () => {
    const a = effectiveAccess(donna, ['Family', 'Cousin', 'Family'], SKILLS, ROUTES);
    assert.deepEqual([a.held, a.unknownRoles], [['Family'], ['Cousin']]);
    assert.deepEqual(kinds(a), { 'google-calendar': 'all', gmail: 'none:denied', print: 'all' });
  });

  it('keeps the skills in the order given, lists each route once, and a skill with no routes has none', () => {
    const a = effectiveAccess(donna, ['Family'], ['print', 'gmail'], { print: ['print'], gmail: [] });
    assert.deepEqual(a.skills.map((s) => s.skill), ['print', 'gmail']);
    assert.deepEqual(a.routes, { print: 'allowed' });
    assert.deepEqual(a.skills[1].routes, []);
  });

  it('is unaffected by prototype-style names', () => {
    const roles = [{ name: 'Evil', skills: JSON.parse('{"__proto__":{"allow":["*"],"deny":[]}}') }] as AccessRole[];
    const a = effectiveAccess(roles, ['Evil'], ['__proto__', 'gmail'], {});
    assert.equal(({} as Record<string, unknown>).allow, undefined);
    assert.deepEqual(kinds(a).gmail, 'none:unlisted');
  });
});
