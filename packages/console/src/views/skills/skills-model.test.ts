// TSK-160 (DESIGN_AUTHORITY.md §6.14 SK1 to SK7): what the skills screen shows and offers. The console has no component
// test runner, so the screen's logic is here and tested; the components only draw it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillAction, SkillAdopter, SkillSummary, SkillVersion } from '../../api/types.js';
import {
  actionCounts,
  adopterCounts,
  adopterRows,
  adoptionRequestCount,
  canRetire,
  decisionLabel,
  filterSkills,
  holdKind,
  holdLabel,
  key,
  openByDefault,
  queueCount,
  retireConfirmed,
  retireEffect,
  retireImpact,
  shortSha,
  sortActions,
  sourceLinks,
  statusOf,
  visibilityCounts,
  visibilityOf,
} from './skills-model.js';

const version = (over: Partial<SkillVersion> = {}): SkillVersion => ({
  id: 's', version: '1.0.0', repo: 'https://github.com/x/s', path: '.', commit: 'a'.repeat(40), status: 'pending', tests: 'pending-build', registeredBy: 'a', registeredAt: 't', ...over,
});
const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  id: 'tavily-search', name: 'Tavily Search', description: 'Real-time web search.', latestApproved: null, requires: { routes: [], connections: [], credentials: [], models: [] }, versions: [], ...over,
});
const adopter = (over: Partial<SkillAdopter> = {}): SkillAdopter => ({ agentId: 'higgins', version: '0.1.0', state: 'approved', ...over });

describe('a version’s status (SK1, SK6)', () => {
  it('is its decision once decided, else where its checks are', () => {
    assert.equal(statusOf(version({ status: 'approved', tests: 'passed' })), 'approved');
    assert.equal(statusOf(version({ status: 'rejected' })), 'rejected');
    assert.equal(statusOf(version({ status: 'rejected', revoked: true })), 'revoked');
    assert.equal(statusOf(version({ tests: 'passed' })), 'passed');
    assert.equal(statusOf(version({ tests: 'failed' })), 'failed');
    assert.equal(statusOf(version({ tests: 'pending-build' })), 'pending');
    assert.equal(statusOf(version({ tests: 'pending-build', checkRun: { id: 'r', checker: 'c', startedAt: 't', startedBy: 'a' } })), 'running');
  });

  it('names the decision, not the retirement, so a retired version is not "retired by" whoever approved it', () => {
    assert.equal(decisionLabel(version({ status: 'approved', retired: true })), 'Approved');
    assert.equal(decisionLabel(version({ status: 'rejected' })), 'Rejected');
    assert.equal(decisionLabel(version({ status: 'rejected', revoked: true })), 'Revoked');
    assert.equal(decisionLabel(version({ status: 'pending' })), 'Pending');
  });

  it('says retired for a retired version, whatever it was before', () => {
    for (const status of ['approved', 'pending', 'rejected'] as const) assert.equal(statusOf(version({ status, retired: true })), 'retired', status);
  });
});

describe('public and private (SK1, SK7)', () => {
  it('treats a skill that says nothing as public', () => {
    assert.equal(visibilityOf({}), 'public');
    assert.equal(visibilityOf({ visibility: 'public' }), 'public');
    assert.equal(visibilityOf({ visibility: 'private' }), 'private');
  });

  const catalog = [
    skill({ id: 'tavily-search', name: 'Tavily Search' }),
    skill({ id: 'print', name: 'Print', description: 'Prints a page.', visibility: 'private', owner: 'higgins' }),
    skill({ id: 'notes', name: 'Notes', description: 'Takes notes for Higgins.', visibility: 'public' }),
  ];

  it('counts each kind', () => {
    assert.deepEqual(visibilityCounts(catalog), { all: 3, public: 2, private: 1 });
    assert.deepEqual(visibilityCounts([]), { all: 0, public: 0, private: 0 });
  });

  it('filters by visibility', () => {
    assert.deepEqual(filterSkills(catalog, 'all', '').map((s) => s.id), ['tavily-search', 'print', 'notes']);
    assert.deepEqual(filterSkills(catalog, 'public', '').map((s) => s.id), ['tavily-search', 'notes']);
    assert.deepEqual(filterSkills(catalog, 'private', '').map((s) => s.id), ['print']);
  });

  it('searches id, name, description and owner, ignoring case and surrounding space', () => {
    assert.deepEqual(filterSkills(catalog, 'all', '  TAVILY ').map((s) => s.id), ['tavily-search']);
    assert.deepEqual(filterSkills(catalog, 'all', 'prints a').map((s) => s.id), ['print']);
    assert.deepEqual(filterSkills(catalog, 'all', 'higgins').map((s) => s.id), ['print', 'notes'], 'the owner of one, the description of another');
    assert.deepEqual(filterSkills(catalog, 'private', 'higgins').map((s) => s.id), ['print'], 'both together');
    assert.deepEqual(filterSkills(catalog, 'all', 'nothing like this'), []);
  });
});

describe('actions and holds (SK2, E9)', () => {
  const actions: SkillAction[] = [
    { id: 'read', route: 'discord', method: 'GET', path: '/channels/{id}', hold: false },
    { id: 'post', route: 'discord', method: 'POST', path: '/channels/{id}/messages', hold: true },
    { id: 'delete', route: 'discord', method: 'DELETE', path: '/channels/{id}/messages/{m}', hold: true },
    { id: 'search', route: 'tavily', method: 'POST', path: '/search', hold: false },
  ];

  it('names a hold in words a person would use', () => {
    assert.deepEqual([holdKind({ hold: true }), holdKind({ hold: false })], ['hitl', 'autonomous']);
    assert.deepEqual([holdLabel({ hold: true }), holdLabel({ hold: false })], ['Human approval', 'Autonomous']);
  });

  it('counts held and autonomous actions, and none for a skill with no actions', () => {
    assert.deepEqual(actionCounts(actions), { hitl: 2, autonomous: 2 });
    assert.deepEqual(actionCounts([]), { hitl: 0, autonomous: 0 });
    assert.deepEqual(actionCounts(undefined), { hitl: 0, autonomous: 0 });
  });

  it('lists held actions first, then by route and path, without changing the input', () => {
    const before = actions.map((a) => a.id);
    assert.deepEqual(sortActions(actions).map((a) => a.id), ['post', 'delete', 'read', 'search']);
    assert.deepEqual(actions.map((a) => a.id), before);
    assert.deepEqual(sortActions(undefined), []);
  });
});

describe('what an admin may do to an adopter (SK3, SK5, SK6)', () => {
  it('offers nothing to someone who cannot decide', () => {
    const rows = adopterRows([adopter({ upgradeAvailable: true }), adopter({ agentId: 'donna', state: 'requested' })], skill(), { canDecide: false });
    for (const r of rows) assert.deepEqual(r.offer, { approve: false, reject: false, remove: false, upgrade: false });
  });

  it('offers approve and reject for a request, and remove (and upgrade when one exists) for an adoption', () => {
    const rows = adopterRows(
      [adopter({ agentId: 'castle', state: 'approved' }), adopter({ agentId: 'donna', state: 'requested' }), adopter({ agentId: 'higgins', state: 'approved', upgradeAvailable: true })],
      skill(),
      { canDecide: true },
    );
    const by = Object.fromEntries(rows.map((r) => [r.agentId, r.offer]));
    assert.deepEqual(by.donna, { approve: true, reject: true, remove: false, upgrade: false });
    assert.deepEqual(by.castle, { approve: false, reject: false, remove: true, upgrade: false });
    assert.deepEqual(by.higgins, { approve: false, reject: false, remove: true, upgrade: true });
  });

  it('lists requests first, then agents in order', () => {
    const rows = adopterRows([adopter({ agentId: 'castle' }), adopter({ agentId: 'donna', state: 'requested' }), adopter({ agentId: 'archie' }), adopter({ agentId: 'nick', state: 'requested' })], skill(), { canDecide: true });
    assert.deepEqual(rows.map((r) => r.agentId), ['donna', 'nick', 'archie', 'castle']);
  });

  it('offers no approval and no upgrade for a retired skill, but still lets an admin decline a request or remove an adoption', () => {
    const rows = adopterRows([adopter({ state: 'requested' }), adopter({ agentId: 'donna', upgradeAvailable: true })], skill({ retired: true }), { canDecide: true });
    const by = Object.fromEntries(rows.map((r) => [r.agentId, r.offer]));
    assert.deepEqual(by.higgins, { approve: false, reject: true, remove: false, upgrade: false });
    assert.deepEqual(by.donna, { approve: false, reject: false, remove: true, upgrade: false });
  });

  it('copes with a skill nobody has adopted', () => {
    assert.deepEqual(adopterRows(undefined, skill(), { canDecide: true }), []);
    assert.deepEqual(adopterCounts(undefined), { approved: 0, requested: 0 });
    assert.deepEqual(adopterCounts([adopter(), adopter({ state: 'requested' }), adopter({ state: 'requested', agentId: 'x' })]), { approved: 1, requested: 2 });
  });
});

describe('where an admin has work (SK1, SK3)', () => {
  const passedPending = version({ tests: 'passed' });
  const queue = [
    skill({ id: 'a', versions: [passedPending, version({ version: '1.1.0', tests: 'failed' })] }),
    skill({ id: 'b', versions: [version({ status: 'approved', tests: 'passed' })], adopters: [adopter({ state: 'requested' }), adopter({ agentId: 'x', state: 'requested' })] }),
    skill({ id: 'c', versions: [version({ status: 'approved', tests: 'passed' })], adopters: [adopter()] }),
    skill({ id: 'd', versions: [version({ tests: 'pending-build' })] }),
  ];

  it('counts versions waiting on a decision, not those whose checks failed or have not run', () => {
    assert.equal(queueCount(queue), 1);
    assert.equal(queueCount([]), 0);
  });

  it('counts adoption requests', () => {
    assert.equal(adoptionRequestCount(queue), 2);
  });

  it('opens, at first load, the skills with a pending version of any kind or a request', () => {
    assert.deepEqual(openByDefault(queue), ['a', 'b', 'd']);
  });
});

describe('retiring a skill (SK6)', () => {
  it('is offered to an admin, once', () => {
    assert.equal(canRetire(skill(), { canRetireSkills: true }), true);
    assert.equal(canRetire(skill(), { canRetireSkills: false }), false);
    assert.equal(canRetire(skill({ retired: true }), { canRetireSkills: true }), false);
  });

  it('names the agents that run it, once each and in order, and counts the requests that would be dropped', () => {
    const impact = retireImpact([adopter({ agentId: 'higgins' }), adopter({ agentId: 'castle' }), adopter({ agentId: 'castle', version: '0.2.0' }), adopter({ agentId: 'donna', state: 'requested' })]);
    assert.deepEqual(impact, { agents: ['castle', 'higgins'], inUse: true, requestsDropped: 1 });
    assert.deepEqual(retireImpact(undefined), { agents: [], inUse: false, requestsDropped: 0 });
    assert.deepEqual(retireImpact([adopter({ state: 'requested' })]), { agents: [], inUse: false, requestsDropped: 1 });
  });

  it('asks for the skill’s id only when agents run it', () => {
    const used = { inUse: true };
    assert.equal(retireConfirmed('', 'tavily-search', used), false);
    assert.equal(retireConfirmed('tavily', 'tavily-search', used), false);
    assert.equal(retireConfirmed('Tavily-Search', 'tavily-search', used), false, 'exact');
    assert.equal(retireConfirmed('  tavily-search ', 'tavily-search', used), true);
    assert.equal(retireConfirmed('', 'tavily-search', { inUse: false }), true);
  });

  it('says what a forced retire will do', () => {
    assert.equal(retireEffect({ agents: [], requestsDropped: 0 }), 'No agent runs this skill.');
    assert.equal(retireEffect({ agents: ['higgins'], requestsDropped: 0 }), 'This will pause higgins, remove the skill from its configuration, and rebuild it without it.');
    assert.equal(retireEffect({ agents: ['castle', 'higgins'], requestsDropped: 2 }), 'This will pause castle, higgins, remove the skill from their configuration, and rebuild them without it and drop 2 pending adoption requests.');
    assert.equal(retireEffect({ agents: [], requestsDropped: 1 }), 'This will drop 1 pending adoption request.');
  });
});

describe('formatting', () => {
  it('keys a version, shortens a SHA, and links the pin on GitHub only', () => {
    assert.equal(key('print', '0.1.1'), 'print@0.1.1');
    assert.equal(shortSha('a'.repeat(40)), 'aaaaaaa');
    const pin = { repo: 'https://github.com/BeerCanLabs/skills.git/', path: 'print', commit: 'b'.repeat(40) };
    assert.deepEqual(sourceLinks(pin), { repo: 'https://github.com/BeerCanLabs/skills', pin: `https://github.com/BeerCanLabs/skills/tree/${'b'.repeat(40)}/print` });
    assert.equal(sourceLinks({ ...pin, path: '.' }).pin, `https://github.com/BeerCanLabs/skills/tree/${'b'.repeat(40)}`);
    assert.deepEqual(sourceLinks({ ...pin, repo: 'https://git.example.test/x/y' }), { repo: 'https://git.example.test/x/y', pin: 'https://git.example.test/x/y' });
    assert.deepEqual(sourceLinks({ ...pin, repo: 'not a url' }), { repo: 'not a url', pin: 'not a url' });
  });
});
