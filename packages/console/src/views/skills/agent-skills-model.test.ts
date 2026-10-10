// TSK-161 (DESIGN_AUTHORITY.md §6.14 SK3, SK4, SK5): what the per-agent Skills tab shows and offers. The console has no
// component test runner, so this is where it is proved.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSkills } from '../../api/types.js';
import { actorOf, agentSkillRows, choosableVersions, compareVersions, isOwnerOf, isRollBack, permsFor, rebuildState, rebuildText } from './agent-skills-model.js';

const ADMIN = permsFor({ isAdmin: true, isOwner: false });
const OWNER = permsFor({ isAdmin: false, isOwner: true });
const VIEWER = permsFor({ isAdmin: false, isOwner: false });
const requires = { systems: [], secrets: [], routes: [] } as never;
const avail = (id: string, version: string) => ({ id, name: id, description: '', visibility: 'public' as const, version, requires });
const data = (over: Partial<AgentSkills> = {}): AgentSkills => ({ agentId: 'higgins', adopted: [], requests: [], revoked: [], available: [], ...over });

describe('who is an owner', () => {
  it('knows a Cloudflare e-mail by the principal the factory uses, ignoring case and spaces', () => {
    assert.equal(actorOf(' Dale@Example.com '), 'cloudflare:dale@example.com');
    assert.equal(actorOf(undefined), undefined);
    assert.equal(actorOf(''), undefined);
    assert.equal(isOwnerOf(['cloudflare:dale@example.com'], 'DALE@example.com'), true);
    assert.equal(isOwnerOf(['cloudflare:dale@example.com'], 'aiden@example.com'), false);
    assert.equal(isOwnerOf([], 'dale@example.com'), false);
    assert.equal(isOwnerOf(['cloudflare:Dale@Example.com'], 'dale@example.com'), true, 'an owner saved in mixed case');
    assert.equal(isOwnerOf(['cloudflare:dale@example.com'], undefined), false);
  });
});

describe('comparing versions', () => {
  it('orders by number, not by text', () => {
    assert.ok(compareVersions('0.1.9', '0.1.10')! < 0);
    assert.ok(compareVersions('1.0.0', '0.9.9')! > 0);
    assert.equal(compareVersions('2.3.4', '2.3.4'), 0);
    assert.equal(compareVersions('2.3.4+build5', '2.3.4'), 0);
  });
  it('puts a pre-release before its own release, and says nothing about what is not a version', () => {
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0')! < 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.1')! > 0);
    assert.equal(compareVersions('latest', '1.0.0'), undefined);
    assert.equal(compareVersions('1.0', '1.0.0'), undefined);
  });
});

describe('the lists', () => {
  const base = data({
    adopted: [
      { id: 'tavily-search', version: '0.1.0', approvedBy: 'cloudflare:dale@example.com', requestedBy: 'cloudflare:dale@example.com' },
      { id: 'print', version: '0.1.1', approvedBy: 'cloudflare:dale@example.com', auto: true },
    ],
    requests: [{ agentId: 'higgins', skillId: 'notes', version: '1.0.0', state: 'requested', requestedBy: 'cloudflare:aiden@example.com', reason: 'for lists' }],
    revoked: [{ agentId: 'higgins', skillId: 'old-private', version: '1.0.0', state: 'revoked' }],
    available: [avail('tavily-search', '0.2.0'), avail('print', '0.1.1'), avail('notes', '1.0.0'), avail('calendar', '2.0.0')],
  });

  it('offers an update only when a newer approved version exists, never for the same or an older one', () => {
    const rows = agentSkillRows(base, ADMIN).adopted;
    assert.deepEqual(rows.map((r) => [r.id, r.updateTo ?? null]), [['print', null], ['tavily-search', '0.2.0']]);
    const older = agentSkillRows(data({ adopted: [{ id: 'x', version: '2.0.0' }], available: [avail('x', '1.0.0')] }), ADMIN).adopted[0];
    assert.equal(older.updateTo, undefined, 'the newest approved is older than what runs: no update');
    assert.equal(older.offer.upgrade, false);
    const odd = agentSkillRows(data({ adopted: [{ id: 'x', version: 'weird' }], available: [avail('x', '1.0.0')] }), ADMIN).adopted[0];
    assert.equal(odd.updateTo, undefined, 'a version that cannot be compared is never called newer');
  });

  it('leaves what the agent runs and what it has asked for out of the available list', () => {
    assert.deepEqual(agentSkillRows(base, ADMIN).available.map((s) => s.id), ['calendar']);
  });

  it('says who put a skill there', () => {
    const rows = agentSkillRows(base, ADMIN).adopted;
    assert.equal(rows.find((r) => r.id === 'print')!.source, 'adopted for its owner, approved by cloudflare:dale@example.com');
    assert.equal(rows.find((r) => r.id === 'tavily-search')!.source, 'approved by cloudflare:dale@example.com');
    assert.equal(agentSkillRows(data({ adopted: [{ id: 'a', version: '1.0.0', approvedBy: 'cloudflare:x@e.com', requestedBy: 'cloudflare:y@e.com' }] }), ADMIN).adopted[0].source, 'approved by cloudflare:x@e.com, asked by cloudflare:y@e.com');
    assert.equal(agentSkillRows(data({ adopted: [{ id: 'a', version: '1.0.0' }] }), ADMIN).adopted[0].source, 'in its configuration');
  });

  it('lists the pending requests and the removed private skills', () => {
    const r = agentSkillRows(base, ADMIN);
    assert.deepEqual(r.pending.map((p) => [p.skillId, p.requestedBy, p.reason]), [['notes', 'cloudflare:aiden@example.com', 'for lists']]);
    assert.deepEqual(r.refused.map((p) => p.skillId), ['old-private']);
  });

  it('lets an admin do everything, an owner ask and remove but not decide, and a viewer nothing', () => {
    const offers = (p: typeof ADMIN) => {
      const r = agentSkillRows(base, p);
      return { adopted: r.adopted.find((a) => a.id === 'tavily-search')!.offer, pending: r.pending[0].offer, available: r.available[0].offer };
    };
    assert.deepEqual(offers(ADMIN), { adopted: { upgrade: true, rollBack: true, remove: true }, pending: { cancel: true, approve: true, reject: true }, available: { request: true } });
    assert.deepEqual(offers(OWNER), { adopted: { upgrade: true, rollBack: true, remove: true }, pending: { cancel: true, approve: false, reject: false }, available: { request: true } });
    assert.deepEqual(offers(VIEWER), { adopted: { upgrade: false, rollBack: false, remove: false }, pending: { cancel: false, approve: false, reject: false }, available: { request: false } });
  });

  it('sorts each list by skill id and handles an agent with nothing', () => {
    assert.deepEqual(agentSkillRows(data(), ADMIN), { adopted: [], pending: [], available: [], refused: [] });
    const r = agentSkillRows(data({ available: [avail('b', '1.0.0'), avail('a', '1.0.0')] }), ADMIN);
    assert.deepEqual(r.available.map((s) => s.id), ['a', 'b']);
  });
});

describe('whether the agent is being rebuilt', () => {
  const adopted = [{ id: 'print', version: '0.1.1' }];

  it('says rebuilding while the factory deploys the agent', () => {
    assert.deepEqual(rebuildState({ state: 'DEPLOYING', deployedSkills: [] }, adopted), { kind: 'rebuilding' });
    assert.match(rebuildText({ kind: 'rebuilding' })!, /Rebuilding/);
  });

  it('says nothing when the image holds exactly what the configuration says', () => {
    assert.deepEqual(rebuildState({ state: 'SLEEPING', deployedSkills: [{ id: 'print', version: '0.1.1' }] }, adopted), { kind: 'none' });
    assert.deepEqual(rebuildState({ state: 'SLEEPING' }, []), { kind: 'none' });
    assert.equal(rebuildText({ kind: 'none' }), undefined);
  });

  it('says a change is waiting when the image and the configuration differ and no deploy is running, naming what differs', () => {
    const w = rebuildState({ state: 'SLEEPING', deployedSkills: [{ id: 'old', version: '1.0.0' }, { id: 'print', version: '0.1.0' }] }, adopted);
    assert.deepEqual(w, { kind: 'waiting', missing: ['print@0.1.1'], extra: ['old@1.0.0', 'print@0.1.0'] });
    assert.equal(rebuildText(w), 'Waiting to be applied: the configuration adds print@0.1.1 and removes old@1.0.0, print@0.1.0, and the running image does not have the change yet.');
    assert.equal(rebuildState({ state: 'SLEEPING' }, adopted).kind, 'waiting', 'an image with no recorded skills is not the one with print in it');
  });

  it('never says waiting for a built-in agent, which has no composed image, but still says rebuilding', () => {
    assert.deepEqual(rebuildState({ state: 'SLEEPING', isBuiltin: true }, adopted), { kind: 'none' });
    assert.deepEqual(rebuildState({ state: 'DEPLOYING', isBuiltin: true }, adopted), { kind: 'rebuilding' });
  });
});

describe('moving to another version', () => {
  const versions = [
    { version: '0.1.0', status: 'approved' }, { version: '0.2.0', status: 'approved' }, { version: '0.10.0', status: 'approved' },
    { version: '0.3.0', status: 'rejected' }, { version: '0.4.0', status: 'pending' }, { version: '0.0.9', status: 'approved', retired: true },
  ];
  it('offers approved, unretired versions, newest first, without the one that runs', () => {
    assert.deepEqual(choosableVersions(versions, '0.2.0'), ['0.10.0', '0.1.0']);
    assert.deepEqual(choosableVersions(versions), ['0.10.0', '0.2.0', '0.1.0']);
    assert.deepEqual(choosableVersions([], '1.0.0'), []);
  });
  it('calls going to an older version a roll back, and nothing else', () => {
    assert.equal(isRollBack('0.2.0', '0.1.0'), true);
    assert.equal(isRollBack('0.2.0', '0.10.0'), false);
    assert.equal(isRollBack('0.2.0', '0.2.0'), false);
    assert.equal(isRollBack('weird', '0.1.0'), false);
  });
});
