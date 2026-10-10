// TSK-172 (DESIGN_AUTHORITY.md E12, GAP-129): the agent record carries the roles a cartridge declares and the routes its
// skills use, read defensively, from a registration and from a cartridge on disk.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, rolesOf, skillIdsOf, skillRoutesOf } from './catalog.js';

// The maps have no prototype on purpose; compare what they hold, not what they inherit.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const donna = {
  skills: [
    { id: 'google-calendar', routes: ['google-calendar'] },
    { id: 'gmail', routes: ['google-gmail', 'google-gmail', 'google-calendar'] },
    { id: 'print' },
  ],
  roles: {
    Owner: { description: 'Agent owner', skills: { '*': { allow: ['*'] } } },
    Family: { skills: { 'google-calendar': { allow: ['*'] }, gmail: { deny: ['*'] } } },
  },
};

describe('the roles a cartridge declares, as the agent record carries them (E12)', () => {
  it('lists each role by name, with what it allows and denies per skill', () => {
    assert.deepEqual(plain(rolesOf(donna).roles), [
      { name: 'Family', skills: { 'google-calendar': { allow: ['*'], deny: [] }, gmail: { allow: [], deny: ['*'] } } },
      { name: 'Owner', description: 'Agent owner', skills: { '*': { allow: ['*'], deny: [] } } },
    ]);
  });

  it('says nothing for a cartridge with no roles, or roles of the wrong kind', () => {
    for (const roles of [undefined, null, [], 'Family', 3]) assert.deepEqual(rolesOf({ roles }), {}, JSON.stringify(roles));
    assert.deepEqual(rolesOf({}), {});
  });

  it('drops what is not valid and keeps the rest: a bad name, a non-role, a rule that says nothing, a name that is not a skill', () => {
    const r = rolesOf({
      roles: {
        'Not A Role': { skills: {} },
        Broken: 'nope',
        Aunt: { skills: { gmail: { allow: ['read'] }, notes: {}, other: { allow: [] }, '../x': { allow: ['*'] }, '': { allow: ['*'] } } },
      },
    });
    assert.deepEqual(plain(r.roles), [{ name: 'Aunt', skills: { gmail: { allow: ['read'], deny: [] } } }]);
  });

  it('can never be reached through a skill id: prototype-style names are not skills', () => {
    const hostile = JSON.parse('{"roles":{"Evil":{"skills":{"__proto__":{"allow":["*"]},"constructor":{"allow":["*"]},"ok":{"allow":["*"]}}}}}');
    const r = rolesOf(hostile);
    assert.deepEqual(Object.keys(r.roles![0].skills).sort(), ['constructor', 'ok'], 'a plain name stays; __proto__ does not');
    assert.equal(({} as Record<string, unknown>).allow, undefined, 'Object.prototype is untouched');
    assert.equal(Object.getPrototypeOf(r.roles![0].skills), null, 'the map has no prototype to pollute');
    assert.ok(!Object.keys(r.roles![0].skills).includes('__proto__'));
  });

  it('keeps Owner as declared (it is declared, never assigned)', () => {
    assert.equal(rolesOf(donna).roles!.some((r) => r.name === 'Owner'), true);
  });
});

describe('the routes a cartridge’s own skills use (E12)', () => {
  it('maps each skill to its routes, once each, and leaves out a skill with none', () => {
    assert.deepEqual({ ...skillRoutesOf(donna).skillRoutes }, { 'google-calendar': ['google-calendar'], gmail: ['google-gmail', 'google-calendar'] });
  });

  it('drops anything that is not a plain route id, and a skill whose id is not one', () => {
    const r = skillRoutesOf({ skills: [{ id: 'a', routes: ['good', 'calendar.google.com', 'https://x', 'A', ''] }, { id: '__proto__', routes: ['x'] }, { id: '*', routes: ['x'] }, { routes: ['x'] }, null, 'a'] });
    assert.deepEqual({ ...r.skillRoutes }, { a: ['good'] });
  });

  it('says nothing for no skills or no routes', () => {
    assert.deepEqual(skillRoutesOf({}), {});
    assert.deepEqual(skillRoutesOf({ skills: 'x' }), {});
    assert.deepEqual(skillRoutesOf({ skills: [{ id: 'a' }] }), {});
  });
});

describe('a cartridge on disk', () => {
  it('is loaded into the catalog with its roles and its skills’ routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'roles-catalog-'));
    try {
      const dir = join(root, 'donna');
      mkdirSync(dir);
      writeFileSync(join(dir, 'cartridge.yaml'), [
        'id: donna',
        'name: Donna',
        'skills:',
        '  - id: google-calendar',
        '    routes: [google-calendar]',
        '  - id: gmail',
        '    routes: [google-gmail]',
        'roles:',
        '  Owner:',
        '    skills:',
        '      "*":',
        '        allow: ["*"]',
        '  Family:',
        '    skills:',
        '      google-calendar:',
        '        allow: ["*"]',
        '      gmail:',
        '        deny: ["*"]',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'soul.md'), '# Donna\n\nMandate: help the family.\n');
      const donnaRecord = loadCatalog(root).find((a) => a.id === 'donna');
      assert.ok(donnaRecord, 'the cartridge is loaded');
      assert.deepEqual(donnaRecord.roles!.map((r) => r.name), ['Family', 'Owner']);
      assert.deepEqual(donnaRecord.roles![0].skills.gmail, { allow: [], deny: ['*'] });
      assert.deepEqual({ ...donnaRecord.skillRoutes }, { 'google-calendar': ['google-calendar'], gmail: ['google-gmail'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is not loaded at all when a role names a skill it does not declare (validation refuses it first)', () => {
    const root = mkdtempSync(join(tmpdir(), 'roles-catalog-bad-'));
    try {
      const dir = join(root, 'bad');
      mkdirSync(dir);
      writeFileSync(join(dir, 'cartridge.yaml'), ['id: bad', 'name: Bad', 'skills:', '  - id: gmail', 'roles:', '  Family:', '    skills:', '      home-print:', '        allow: ["*"]', ''].join('\n'));
      writeFileSync(join(dir, 'soul.md'), '# Bad\n');
      assert.equal(loadCatalog(root).some((a) => a.id === 'bad'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the skills a cartridge declares (E12)', () => {
  it('lists the ids in order, once each, and leaves out what is not a skill id', () => {
    assert.deepEqual(skillIdsOf({ skills: [{ id: 'google-calendar' }, { id: 'gmail' }, { id: 'gmail' }, { id: '__proto__' }, { id: '*' }, { id: '../x' }, { routes: [] }, null, 'x'] }).skillIds, ['google-calendar', 'gmail']);
  });

  it('says nothing for no skills', () => {
    for (const skills of [undefined, null, [], 'x', [{}]]) assert.deepEqual(skillIdsOf({ skills }), {}, JSON.stringify(skills));
  });
});
