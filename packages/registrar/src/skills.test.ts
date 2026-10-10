// TSK-127 (GAP-098): the skill registry's records on disk, the skill folder rule and reading skill.yaml at a commit,
// exactly as the control plane did them before the move. The control plane's e2e tests cover the routes.
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillManifest } from '@beercanlabs/factory-contract';
import {
  SkillRegistry,
  availableTo,
  canAdopt,
  checkSkillPath,
  compareSemver,
  fetchManifest,
  ownerOf,
  skillVisibleTo,
  summarizeSkill,
  visibilityOf,
  type SkillVersionRecord,
} from './skills.js';
import { SourceError, type SkillSource } from './source.js';

const SHA = 'c'.repeat(40);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'registrar-skills-'));
}

const manifest = (version: string): SkillManifest =>
  ({
    id: 'discord-progress',
    version,
    name: 'Discord progress',
    description: 'Renders run progress.',
    language: 'node',
    entry: 'src/index.ts',
    requires: { routes: [], connections: [], credentials: [], models: [] },
  }) as unknown as SkillManifest;

const record = (version: string, over: Partial<SkillVersionRecord> = {}): SkillVersionRecord => ({
  id: 'discord-progress',
  version,
  repo: 'https://github.com/x/skill',
  path: '.',
  commit: SHA,
  manifest: manifest(version),
  status: 'pending',
  tests: 'pending-build',
  registeredBy: 'admin',
  registeredAt: '2026-10-08T00:00:00.000Z',
  ...over,
});

describe('skill registry store', () => {
  it('writes <id>/<version>.json as two-space JSON and leaves no temp file', () => {
    const dir = tmp();
    try {
      const rec = record('1.0.0');
      new SkillRegistry(dir).save(rec);
      assert.equal(readFileSync(join(dir, 'discord-progress', '1.0.0.json'), 'utf8'), JSON.stringify(rec, null, 2));
      assert.deepEqual(readdirSync(join(dir, 'discord-progress')), ['1.0.0.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a new registry over the same directory reads every record back, newest last by semver', () => {
    const dir = tmp();
    try {
      const first = new SkillRegistry(dir);
      first.save(record('1.10.0'));
      first.save(record('1.2.0', { status: 'approved' }));
      first.save(record('1.2.0-rc.1'));
      const again = new SkillRegistry(dir);
      assert.deepEqual(again.ids(), ['discord-progress']);
      assert.deepEqual(again.versions('discord-progress').map((r) => r.version), ['1.2.0-rc.1', '1.2.0', '1.10.0']);
      assert.equal(again.get('discord-progress', '1.2.0')?.status, 'approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves copies, so a caller cannot change a stored record', () => {
    const registry = new SkillRegistry();
    registry.save(record('1.0.0'));
    registry.get('discord-progress', '1.0.0')!.status = 'approved';
    assert.equal(registry.get('discord-progress', '1.0.0')?.status, 'pending');
  });

  it('skips an unreadable record and says so through warn, keeping the others', () => {
    const dir = tmp();
    const warnings: Array<[string, unknown]> = [];
    try {
      new SkillRegistry(dir).save(record('1.0.0'));
      writeFileSync(join(dir, 'discord-progress', '2.0.0.json'), '{ not json');
      writeFileSync(join(dir, 'discord-progress', '3.0.0.json'), JSON.stringify(record('9.9.9')));
      const again = new SkillRegistry(dir, (message, err) => warnings.push([message, err]));
      assert.deepEqual(again.versions('discord-progress').map((r) => r.version), ['1.0.0']);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0][0], /^skipping unreadable skill record .*2\.0\.0\.json:$/);
      assert.match(warnings[1][0], /3\.0\.0\.json:$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no warn given, an unreadable record is logged with a [registrar] prefix', () => {
    const dir = tmp();
    const warn = mock.method(console, 'warn', () => {});
    try {
      new SkillRegistry(dir).save(record('1.0.0'));
      writeFileSync(join(dir, 'discord-progress', '2.0.0.json'), '{ not json');
      new SkillRegistry(dir);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /^\[registrar\] skipping unreadable skill record /);
    } finally {
      warn.mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a folder that is not a skill id, and a missing directory is an empty registry', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'Not_A_Skill'));
      writeFileSync(join(dir, 'Not_A_Skill', '1.0.0.json'), JSON.stringify(record('1.0.0')));
      assert.deepEqual(new SkillRegistry(dir).ids(), []);
      assert.deepEqual(new SkillRegistry(join(dir, 'nope')).ids(), []);
      assert.equal(existsSync(join(dir, 'nope')), false, 'reading never creates the directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skill summary and semver precedence', () => {
  it('SK5 the latest approved version is the highest approved by semver, not the newest registered', () => {
    const registry = new SkillRegistry();
    registry.save(record('1.0.0', { status: 'approved' }));
    registry.save(record('1.10.0', { status: 'approved' }));
    registry.save(record('2.0.0'));
    const summary = summarizeSkill(registry, 'discord-progress')!;
    assert.equal(summary.latestApproved, '1.10.0');
    assert.deepEqual(summary.versions.map((v) => v.version), ['1.0.0', '1.10.0', '2.0.0']);
    assert.equal(summarizeSkill(registry, 'unknown'), undefined);
  });

  it('orders pre-releases below their release and ignores build metadata', () => {
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
    assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  });
});

describe('skill folder rule', () => {
  it('accepts the repository root and a relative folder, and refuses anything that leaves the repository', () => {
    assert.equal(checkSkillPath(undefined), '.');
    assert.equal(checkSkillPath('./'), '.');
    assert.equal(checkSkillPath('skills/progress/'), 'skills/progress');
    for (const bad of ['/etc', '../x', 'a/../b', 'a//b', 'a\\b', 'a b', 42]) assert.equal(checkSkillPath(bad), undefined, String(bad));
  });
});

describe('reading skill.yaml at a commit', () => {
  const source = (over: Partial<SkillSource>): SkillSource => ({
    resolveRef: async () => SHA,
    readFile: async () => 'id: x\n',
    ...over,
  });

  it('resolves a branch or tag, reads <path>/skill.yaml and returns the parsed mapping', async () => {
    const seen: string[] = [];
    const out = await fetchManifest(source({ readFile: async (_r, c, f) => (seen.push(`${c.slice(0, 7)} ${f}`), 'id: x\nversion: 1.0.0\n') }), 'https://h/r', 'skills/a', undefined, 'main');
    assert.deepEqual(out, { commit: SHA, raw: { id: 'x', version: '1.0.0' }, reasons: [] });
    assert.deepEqual(seen, ['ccccccc skills/a/skill.yaml']);
  });

  it('gives a reason the caller can act on for each failure', async () => {
    const noRef = await fetchManifest(source({ resolveRef: async () => undefined }), 'https://h/r', '.', undefined, 'nope');
    assert.match(noRef.reasons[0], /^commit: https:\/\/h\/r has no branch or tag named "nope"$/);
    const none = await fetchManifest(source({ readFile: async () => undefined }), 'https://h/r', '.', SHA, undefined);
    assert.match(none.reasons[0], /^skill\.yaml: there is no skill\.yaml at "\." in https:\/\/h\/r at ccccccccccc/);
    const badYaml = await fetchManifest(source({ readFile: async () => 'a: [unclosed' }), 'https://h/r', '.', SHA, undefined);
    assert.match(badYaml.reasons[0], /is not valid YAML/);
    const list = await fetchManifest(source({ readFile: async () => '- a\n- b\n' }), 'https://h/r', '.', SHA, undefined);
    assert.match(list.reasons[0], /is not a mapping of keys to values/);
    const nothing = await fetchManifest(source({}), 'https://h/r', '.', undefined, undefined);
    assert.deepEqual(nothing, { reasons: [] });
  });

  it('maps a source error to its reason, and reports an unreachable repository through warn', async () => {
    const tooLarge = await fetchManifest(source({ readFile: async () => { throw new SourceError('too_large', 'skill.yaml is too large'); } }), 'https://h/r', '.', SHA, undefined);
    assert.match(tooLarge.reasons[0], /^skill\.yaml: /);
    const warnings: string[] = [];
    const unreachable = await fetchManifest(source({ readFile: async () => { throw new Error('boom'); } }), 'https://h/r', '.', SHA, undefined, (m) => warnings.push(m));
    assert.match(unreachable.reasons[0], /^repo: cannot fetch https:\/\/h\/r;/);
    assert.deepEqual(warnings, ['could not read skill source https://h/r:']);
  });
});

// TSK-157 (§6.14 SK1, SK3, SK6, SK7): visibility, owner and retirement in the registry.
const privateRecord = (id: string, owner: string, version = '1.0.0', over: Partial<SkillVersionRecord> = {}): SkillVersionRecord =>
  record(version, { id, manifest: { ...manifest(version), id, visibility: 'private', owner } as unknown as SkillManifest, ...over });

describe('visibility and owner (SK1)', () => {
  it('a record written before visibility existed is a public skill with no owner', () => {
    const legacy = record('1.0.0');
    assert.equal(legacy.manifest.visibility, undefined);
    assert.equal(visibilityOf(legacy), 'public');
    assert.equal(ownerOf(legacy), undefined);
  });

  it('reads visibility and owner from the manifest, and a public skill has no owner even if one is written', () => {
    const p = privateRecord('print', 'higgins');
    assert.equal(visibilityOf(p), 'private');
    assert.equal(ownerOf(p), 'higgins');
    const odd = record('1.0.0', { manifest: { ...manifest('1.0.0'), visibility: 'public', owner: 'higgins' } as unknown as SkillManifest });
    assert.equal(ownerOf(odd), undefined);
  });

  it('shows visibility and owner in the summary', () => {
    const reg = new SkillRegistry();
    reg.save(record('1.0.0', { status: 'approved' }));
    reg.save(privateRecord('print', 'higgins', '1.0.0', { status: 'approved' }));
    assert.deepEqual([summarizeSkill(reg, 'discord-progress')!.visibility, summarizeSkill(reg, 'discord-progress')!.owner], ['public', undefined]);
    const s = summarizeSkill(reg, 'print')!;
    assert.deepEqual([s.visibility, s.owner, s.retired], ['private', 'higgins', false]);
  });

  it('refuses a version that would change the skill’s visibility or owner, and accepts one that keeps them', () => {
    const reg = new SkillRegistry();
    assert.equal(reg.identityIssue({ id: 'print', visibility: 'private', owner: 'higgins' }), undefined);
    reg.save(privateRecord('print', 'higgins'));
    assert.equal(reg.identityIssue({ id: 'print', visibility: 'private', owner: 'higgins' }), undefined);
    assert.match(reg.identityIssue({ id: 'print', visibility: 'private', owner: 'donna' })!, /private to higgins.*private to donna.*register a new skill/);
    assert.match(reg.identityIssue({ id: 'print', visibility: 'public' })!, /cannot make it public/);
    reg.save(record('1.0.0'));
    assert.match(reg.identityIssue({ id: 'discord-progress', visibility: 'private', owner: 'higgins' })!, /is public/);
    assert.equal(reg.identityIssue({ id: 'discord-progress', visibility: 'public' }), undefined);
  });

  it('who can see a private skill: admins and the owners of its owner agent (SK7)', () => {
    const priv = { visibility: 'private' as const, owner: 'higgins' };
    assert.equal(skillVisibleTo({ visibility: 'public' }, { admin: false, ownedAgents: [] }), true);
    assert.equal(skillVisibleTo(priv, { admin: true, ownedAgents: [] }), true);
    assert.equal(skillVisibleTo(priv, { admin: false, ownedAgents: ['higgins'] }), true);
    assert.equal(skillVisibleTo(priv, { admin: false, ownedAgents: ['donna'] }), false);
    assert.equal(skillVisibleTo(priv, { admin: false, ownedAgents: [] }), false);
  });
});

describe('retirement (SK6)', () => {
  it('retires every version, persists it, and a reload still shows it; retiring again changes nothing', () => {
    const dir = tmp();
    try {
      const reg = new SkillRegistry(dir);
      reg.save(record('1.0.0', { status: 'approved' }));
      reg.save(record('1.1.0', { status: 'approved' }));
      const changed = reg.retire('discord-progress', 'admin', 'replaced', new Date('2026-10-10T00:00:00Z'));
      assert.deepEqual(changed.map((r) => r.version), ['1.0.0', '1.1.0']);
      const again = new SkillRegistry(dir);
      assert.deepEqual(again.get('discord-progress', '1.1.0')!.retired, true);
      assert.deepEqual(
        [again.get('discord-progress', '1.1.0')!.retiredBy, again.get('discord-progress', '1.1.0')!.retiredAt, again.get('discord-progress', '1.1.0')!.retiredReason],
        ['admin', '2026-10-10T00:00:00.000Z', 'replaced'],
      );
      assert.deepEqual(again.retire('discord-progress', 'admin'), []);
      assert.deepEqual(new SkillRegistry().retire('nope', 'admin'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a retired skill has no latest approved version and says so in the summary', () => {
    const reg = new SkillRegistry();
    reg.save(record('1.0.0', { status: 'approved' }));
    assert.equal(summarizeSkill(reg, 'discord-progress')!.latestApproved, '1.0.0');
    reg.retire('discord-progress', 'admin');
    const s = summarizeSkill(reg, 'discord-progress')!;
    assert.equal(s.latestApproved, null);
    assert.equal(s.retired, true);
    assert.equal(s.versions[0].retired, true);
    assert.equal(s.versions[0].status, 'approved');
  });
});

describe('who may adopt what (SK1, SK3)', () => {
  const reg = () => {
    const r = new SkillRegistry();
    r.save(record('1.0.0', { status: 'approved' }));
    r.save(record('1.1.0', { status: 'pending' }));
    r.save(privateRecord('print', 'higgins', '0.1.1', { status: 'approved' }));
    r.save(record('2.0.0', { id: 'old-skill', status: 'approved', manifest: { ...manifest('2.0.0'), id: 'old-skill' } as unknown as SkillManifest }));
    r.retire('old-skill', 'admin');
    return r;
  };

  it('an approved public version can be adopted by any agent', () => {
    const r = reg();
    const c = canAdopt(r, 'donna', 'discord-progress', '1.0.0');
    assert.equal(c.ok, true);
  });

  it('refuses unknown, pending, retired and another agent’s private skill, each with its own reason', () => {
    const r = reg();
    const why = (agent: string, id: string, v: string) => {
      const c = canAdopt(r, agent, id, v);
      return c.ok ? 'ok' : c.error;
    };
    assert.equal(why('donna', 'nope', '1.0.0'), 'not_found');
    assert.equal(why('donna', 'discord-progress', '9.9.9'), 'not_found');
    assert.equal(why('donna', 'discord-progress', '1.1.0'), 'skill_not_approved');
    assert.equal(why('donna', 'old-skill', '2.0.0'), 'skill_retired');
    assert.equal(why('donna', 'print', '0.1.1'), 'skill_private');
    assert.equal(why('higgins', 'print', '0.1.1'), 'ok');
  });

  it('lists for an agent the public skills and its own private skills, never another agent’s, never retired or unapproved ones', () => {
    const r = reg();
    assert.deepEqual(availableTo(r, 'higgins').map((s) => [s.id, s.version]), [['discord-progress', '1.0.0'], ['print', '0.1.1']]);
    assert.deepEqual(availableTo(r, 'donna').map((s) => s.id), ['discord-progress']);
  });
});
