import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skillDesignIssues, validateSkillManifest, type SkillManifest } from './skill.js';

const base = {
  id: 'discord-progress',
  version: '1.0.0',
  name: 'Discord progress',
  description: 'Renders a run’s progress as one live message.',
  language: 'python',
  entry: 'discord_progress',
};

const post = { id: 'post-message', route: 'discord', method: 'POST', path: '/channels/{id}/messages', hold: true };

function parse(over: Record<string, unknown> = {}): SkillManifest {
  const r = validateSkillManifest({ ...base, ...over });
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
  return r.manifest;
}

describe('skill manifest: visibility, owner and actions (SK1, SK2)', () => {
  it('a manifest written before this change still validates: public, no owner, no actions', () => {
    const m = parse({ requires: { routes: ['discord'] } });
    assert.equal(m.visibility, 'public');
    assert.equal(m.owner, undefined);
    assert.deepEqual(m.actions, []);
    assert.deepEqual(skillDesignIssues(m), []);
  });

  it('accepts a private skill with an owner and actions that go through declared routes', () => {
    const m = parse({
      visibility: 'private',
      owner: 'higgins',
      requires: { routes: ['discord'] },
      actions: [post, { id: 'read-channel', route: 'discord', method: 'GET', path: '/channels/{id}', hold: false }],
    });
    assert.equal(m.visibility, 'private');
    assert.equal(m.owner, 'higgins');
    assert.deepEqual(m.actions.map((a) => [a.id, a.hold]), [['post-message', true], ['read-channel', false]]);
    assert.deepEqual(skillDesignIssues(m), []);
  });

  it('refuses an unknown visibility and a malformed owner', () => {
    assert.equal(validateSkillManifest({ ...base, visibility: 'shared' }).ok, false);
    assert.equal(validateSkillManifest({ ...base, visibility: 'private', owner: 'Not An Agent' }).ok, false);
  });

  it('refuses a private skill without an owner and a public skill with one', () => {
    const noOwner = skillDesignIssues(parse({ visibility: 'private' }));
    assert.ok(noOwner.some((i) => i.path === 'owner' && /must name its owner/.test(i.message)));
    const owned = skillDesignIssues(parse({ owner: 'higgins' }));
    assert.ok(owned.some((i) => i.path === 'owner' && /public skill has no owner/.test(i.message)));
  });

  it('refuses an action that declares no hold: there is no default (E9)', () => {
    const { hold: _hold, ...noHold } = post;
    const r = validateSkillManifest({ ...base, requires: { routes: ['discord'] }, actions: [noHold] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.issues.some((i) => i.path === 'actions.0.hold' && /no default/.test(i.message)), JSON.stringify(r.issues));
    assert.equal(validateSkillManifest({ ...base, actions: [{ ...post, hold: 'yes' }] }).ok, false);
  });

  it('refuses a malformed action: method, path, id and unknown keys', () => {
    for (const bad of [
      { ...post, method: 'FETCH' },
      { ...post, method: 'post' },
      { ...post, path: 'channels/1' },
      { ...post, path: '//discord.com/api' },
      { ...post, path: '/channels?x=1' },
      { ...post, path: '/a b' },
      { ...post, id: 'Post Message' },
      { ...post, token: 'abc' },
    ]) {
      assert.equal(validateSkillManifest({ ...base, actions: [bad] }).ok, false, JSON.stringify(bad));
    }
  });

  it('refuses an action through a route the skill does not declare', () => {
    const issues = skillDesignIssues(parse({ requires: { routes: ['github'] }, actions: [post] }));
    assert.ok(issues.some((i) => i.path === 'actions.0.route' && /does not declare/.test(i.message)));
  });

  it('refuses an action path that is a URL, and duplicate action ids', () => {
    const url = skillDesignIssues(parse({ requires: { routes: ['discord'] }, actions: [{ ...post, path: '/https://discord.com/x' }] }));
    assert.ok(url.some((i) => i.path === 'actions.0.path' && /URL/.test(i.message)));
    const dup = skillDesignIssues(parse({ requires: { routes: ['discord'] }, actions: [post, { ...post, method: 'PUT' }] }));
    assert.ok(dup.some((i) => i.path === 'actions' && /more than once/.test(i.message)));
  });

  it('SK1 L4 skill manifest smoke check schema and design issues', () => {
    // Optional on raw manifest: legacy/empty smoke still parses
    const mWithoutSmoke = parse({});
    assert.equal(mWithoutSmoke.smoke, undefined);

    // Valid smoke check
    const mWithSmoke = parse({
      smoke: { action: 'ping-pong', input: { count: 1 }, dryRun: true },
    });
    assert.deepEqual(mWithSmoke.smoke, { action: 'ping-pong', input: { count: 1 }, dryRun: true });

    // Invalid smoke check: non-kebab-case action
    assert.equal(validateSkillManifest({ ...base, smoke: { action: 'PingPong' } }).ok, false);

    // Actions declared, but smoke action not in actions
    const undeclaredAction = skillDesignIssues(parse({
      actions: [post],
      requires: { routes: ['discord'] },
      smoke: { action: 'unknown-action' },
    }));
    assert.ok(undeclaredAction.some((i) => i.path === 'smoke.action' && /not declared in actions/.test(i.message)));

    // Smoke action has hold: true but dryRun is not true
    const holdWithoutDryRun = skillDesignIssues(parse({
      actions: [post],
      requires: { routes: ['discord'] },
      smoke: { action: 'post-message' },
    }));
    assert.ok(holdWithoutDryRun.some((i) => i.path === 'smoke.dryRun' && /requires dryRun: true/.test(i.message)));

    // Smoke action has hold: true WITH dryRun: true
    const holdWithDryRun = skillDesignIssues(parse({
      actions: [post],
      requires: { routes: ['discord'] },
      smoke: { action: 'post-message', dryRun: true },
    }));
    assert.deepEqual(holdWithDryRun, []);

    // Smoke action with 0 declared actions is allowed
    const noActionsSmoke = skillDesignIssues(parse({
      smoke: { action: 'ping-pong' },
    }));
    assert.deepEqual(noActionsSmoke, []);
  });
});

