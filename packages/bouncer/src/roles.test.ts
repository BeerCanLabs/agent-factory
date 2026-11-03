import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Principal, Role } from '@beercanlabs/factory-auth';
import {
  GrantStore,
  PRIVILEGES,
  authorize,
  authorizeIngress,
  type AuthorizeResource,
  type Privilege,
} from './index.js';
import { AGENT_SCOPED, SKILL_SCOPED, DERIVED_ROLE_PRIVILEGES } from './privileges.js';

const OWNER_RIGHTS: Privilege[] = [
  'agents.models.read',
  'agents.models.set',
  'config.read',
  'config.export.agent',
  'credentials.agent.read',
  'credentials.agent.set',
  'connections.start',
  'connections.import',
  'agents.wake',
  'agents.pause',
  'agents.resume',
  'skills.adopt.request',
  'skills.adopt.remove',
  'skills.decide.private',
  'skills.training.fund',
  'skills.training.run',
  'agents.roles.read',
  'agents.settings.read',
  'agents.settings.set',
  'agents.roles.assign',
  'approvals.decide',
  'agents.update.read',
  'agents.update.install',
];

const as = (actor: string, roles: Role[] = []): Principal => ({ actor, roles });
const on = (agentId: string, owners: string[], requester?: AuthorizeResource['requester'], memberRoles?: string[]): AuthorizeResource => ({
  agentId,
  owners,
  ...(requester ? { requester } : {}),
  ...(memberRoles ? { memberRoles } : {}),
});
const allowed = (p: Principal, privilege: Privilege, resource?: AuthorizeResource) => authorize({ principal: p, privilege, resource }).allowed;

describe('agent-owner and requester', () => {
  it('the owner of an agent holds exactly the rights Dale listed on that agent', () => {
    const alice = as('cloudflare:alice@example.com');
    const held = PRIVILEGES.filter((p) => allowed(alice, p, on('a', ['cloudflare:alice@example.com'])));
    assert.deepEqual([...held].sort(), [...OWNER_RIGHTS].sort());
  });

  it('holds none of them on another agent, and none without a resource', () => {
    const alice = as('cloudflare:alice@example.com');
    for (const p of PRIVILEGES) {
      assert.equal(allowed(alice, p, on('b', ['cloudflare:bob@example.com'])), false, p);
      assert.equal(allowed(alice, p), false, p);
    }
  });

  it('matches the owner ignoring case', () => {
    assert.ok(allowed(as('Cloudflare:Alice@Example.com'), 'agents.wake', on('a', ['cloudflare:alice@example.com'])));
    assert.ok(allowed(as('cloudflare:alice@example.com'), 'agents.wake', on('a', ['CLOUDFLARE:ALICE@EXAMPLE.COM'])));
  });

  it('never takes agent-owner or requester from the roles', () => {
    const forged = as('cloudflare:mallory@example.com', ['agent-owner', 'requester'] as unknown as Role[]);
    for (const p of PRIVILEGES) assert.equal(allowed(forged, p, on('a', [], { actor: 'cloudflare:bob@example.com' })), false, p);
  });

  it('the owner never holds isolate, cancel, converse or a fleet-wide privilege', () => {
    const alice = as('cloudflare:alice@example.com');
    const r = on('a', ['cloudflare:alice@example.com']);
    for (const p of ['agents.isolate', 'runs.cancel', 'agents.converse', 'registry.purge', 'policy.set', 'config.export', 'agents.owners.set', 'credentials.outstanding.read', 'skills.adopt.decide', 'skills.retire'] as Privilege[]) {
      assert.equal(allowed(alice, p, r), false, p);
    }
  });

  it('every derived row holds only agent-scoped or skill-scoped privileges', () => {
    for (const [role, row] of Object.entries(DERIVED_ROLE_PRIVILEGES)) {
      if (role === 'skill-owner') {
        for (const p of row) assert.ok(SKILL_SCOPED.has(p), p);
      } else {
        for (const p of row) assert.ok(AGENT_SCOPED.has(p), p);
      }
    }
    assert.deepEqual([...DERIVED_ROLE_PRIVILEGES['agent-owner']].sort(), [...OWNER_RIGHTS].sort());
  });

  it('the requester decides its own run; an owner does not when a requester exists', () => {
    const owners = ['cloudflare:owner@example.com'];
    const requester = { actor: 'cloudflare:alice@example.com' };
    assert.ok(allowed(as('cloudflare:alice@example.com'), 'approvals.decide', on('a', owners, requester)));
    assert.equal(allowed(as('cloudflare:owner@example.com'), 'approvals.decide', on('a', owners, requester)), false);
    assert.equal(allowed(as('cloudflare:other@example.com'), 'approvals.decide', on('a', owners, requester)), false);
  });

  it('the requester holds nothing but approvals.decide', () => {
    const alice = as('cloudflare:alice@example.com');
    const r = on('a', [], { actor: 'cloudflare:alice@example.com' });
    assert.deepEqual(PRIVILEGES.filter((p) => allowed(alice, p, r)), ['approvals.decide']);
  });

  it('an owner decides when the run has no requesting user', () => {
    assert.ok(allowed(as('cloudflare:owner@example.com'), 'approvals.decide', on('a', ['cloudflare:owner@example.com'])));
  });

  it('a requester who is not linked to anyone lets no owner decide', () => {
    const owners = ['cloudflare:owner@example.com'];
    assert.equal(allowed(as('cloudflare:owner@example.com'), 'approvals.decide', on('a', owners, {})), false);
  });

  it('admin still decides any agent, with or without a resource; approver no longer does (S4, D29)', () => {
    const admin = as('token:x', ['admin']);
    assert.ok(allowed(admin, 'approvals.decide'));
    assert.ok(allowed(admin, 'approvals.decide', on('a', [], {})));
    const approver = as('token:x', ['approver']);
    assert.equal(allowed(approver, 'approvals.decide'), false);
    assert.equal(allowed(approver, 'approvals.decide', on('a', [], {})), false);
  });

  it('a denial still names the role the route names today', () => {
    const alice = as('cloudflare:alice@example.com');
    const r = on('b', ['cloudflare:bob@example.com']);
    assert.deepEqual(authorize({ principal: alice, privilege: 'agents.wake', resource: r }), { allowed: false, required: 'operator' });
    assert.deepEqual(authorize({ principal: alice, privilege: 'approvals.decide', resource: r }), { allowed: false, required: 'admin' });
    assert.deepEqual(authorize({ principal: alice, privilege: 'credentials.agent.set', resource: r }), { allowed: false, required: 'admin' });
  });
});

// E12 (Dale, 2026-10-10): a person who holds a role on an agent may reach that agent, and nothing else.
describe('agent-member', () => {
  const stephanie = as('cloudflare:stephanie@example.com'); // no factory role at all
  const donna = (roles: string[] = ['Family']) => on('donna', ['cloudflare:dale@example.com'], undefined, roles);

  it('holds exactly the right to start a run and to converse on that agent, and nothing else', () => {
    const held = PRIVILEGES.filter((p) => allowed(stephanie, p, donna()));
    assert.deepEqual([...held].sort(), ['agents.converse', 'agents.wake']);
  });

  it('holds nothing without a role on the agent: no roles, a blank name, or only the reserved Owner', () => {
    for (const roles of [[], [''], ['   '], ['Owner'], ['owner'], ['OWNER', ' '], [' Owner '], [' owner ']]) {
      const held = PRIVILEGES.filter((p) => allowed(stephanie, p, donna(roles)));
      assert.deepEqual(held, [], JSON.stringify(roles));
    }
  });

  it('holds nothing without a resource, so no fleet-wide route can be reached by a role alone', () => {
    for (const p of PRIVILEGES) assert.equal(allowed(stephanie, p), false, p);
  });

  it('never takes agent-member from the roles a credential claims', () => {
    const forged = as('cloudflare:mallory@example.com', ['agent-member', 'Family'] as unknown as Role[]);
    for (const p of PRIVILEGES) assert.equal(allowed(forged, p, on('donna', ['cloudflare:dale@example.com'])), false, p);
  });

  it('is not a way to pause, resume, reset, read configuration, decide or isolate', () => {
    for (const p of ['agents.pause', 'agents.resume', 'agents.reset', 'agents.isolate', 'runs.cancel', 'config.read', 'config.export.agent', 'approvals.decide', 'policy.set', 'registry.deploy', 'identity.links.set', 'skills.adopt.request'] as Privilege[]) {
      assert.equal(allowed(stephanie, p, donna()), false, p);
    }
  });

  it('every privilege it holds is agent-scoped', () => {
    for (const p of DERIVED_ROLE_PRIVILEGES['agent-member']) assert.ok(AGENT_SCOPED.has(p), p);
    assert.deepEqual([...DERIVED_ROLE_PRIVILEGES['agent-member']].sort(), ['agents.converse', 'agents.wake']);
  });

  it('adds nothing to what an owner holds: an owner still cannot converse by ownership alone', () => {
    const owner = as('cloudflare:dale@example.com');
    assert.equal(allowed(owner, 'agents.converse', on('donna', ['cloudflare:dale@example.com'])), false);
    assert.equal(allowed(owner, 'agents.wake', on('donna', ['cloudflare:dale@example.com'])), true);
  });
});

describe('skill-owner and groups', () => {
  const alice = as('cloudflare:alice@example.com');
  const bob = as('cloudflare:bob@example.com');
  const charlie = as('cloudflare:charlie@example.com');

  const onSkill = (skillOwner?: string, groupRoles?: readonly string[]): AuthorizeResource => ({
    skillId: 'web-search',
    ...(skillOwner ? { skillOwner } : {}),
    ...(groupRoles ? { groupRoles } : {}),
  });

  it('human owner holds all skill-owner privileges and skills.transfer', () => {
    const res = onSkill('cloudflare:alice@example.com');
    for (const p of DERIVED_ROLE_PRIVILEGES['skill-owner']) {
      assert.equal(allowed(alice, p, res), true, p);
    }
    assert.equal(allowed(alice, 'skills.transfer', res), true);
  });

  it('human owner does not hold fleet-wide or agent-scoped privileges by skill ownership', () => {
    const res = onSkill('cloudflare:alice@example.com');
    for (const p of ['policy.set', 'skills.decide', 'agents.wake', 'groups.manage', 'skills.retire.force'] as Privilege[]) {
      assert.equal(allowed(alice, p, res), false, p);
    }
  });

  it('another user holds nothing on the skill', () => {
    const res = onSkill('cloudflare:alice@example.com');
    for (const p of SKILL_SCOPED) {
      assert.equal(allowed(bob, p, res), false, p);
    }
  });

  it('group member with skill-owner holds skill-owner privileges but NOT skills.transfer (A9)', () => {
    const res = onSkill('cloudflare:alice@example.com', ['skill-owner']);
    for (const p of DERIVED_ROLE_PRIVILEGES['skill-owner']) {
      assert.equal(allowed(bob, p, res), true, p);
    }
    assert.equal(allowed(bob, 'skills.transfer', res), false);
  });

  it('skills.register is held by admin, agent owner, or group role (H3, A8, A17)', () => {
    assert.equal(allowed(as('token:admin', ['admin']), 'skills.register'), true);
    assert.equal(allowed(alice, 'skills.register', { ownsAnyAgent: true }), true);
    assert.equal(allowed(bob, 'skills.register', { groupRoles: ['skills.register'] }), true);
    assert.equal(allowed(charlie, 'skills.register'), false);
    assert.equal(allowed(charlie, 'skills.register', { ownsAnyAgent: false, groupRoles: [] }), false);
  });
});

describe('S2b: personal vs team agent grant authorization (D7, D11, D15, D24, D29)', () => {
  it('personal content-owner holds owner rights + converse + hold clearance, and drops to strictly read-only while pending-revoked', async () => {
    const store = GrantStore.inMemory({
      now: () => new Date('2026-11-02T12:00:00.000Z'),
      agentKindLookup: (id) => (id === 'donna' ? 'personal' : undefined),
    });
    await store.grant({
      subject: 'user:dale',
      scope: { kind: 'agent', id: 'donna' },
      role: 'content-owner',
      by: 'user:dale',
    });
    await store.grant({
      subject: 'user:stephanie',
      scope: { kind: 'agent', id: 'donna' },
      role: 'Family',
      by: 'user:dale',
    });

    const dale = as('user:dale');
    const stephanie = as('user:stephanie');
    const daleActive = store.effectiveGrantsFor({ subject: 'user:dale' });
    const stephActive = store.effectiveGrantsFor({ subject: 'user:stephanie' });

    // Active personal content-owner manages agent, wakes, converses, and clears holds even when a sub-role member triggered the run (D29)
    const donnaRes: AuthorizeResource = {
      agentId: 'donna',
      agentKind: 'personal',
      owners: ['user:dale'],
      requester: { actor: 'user:stephanie' },
      grants: daleActive,
    };
    assert.equal(allowed(dale, 'agents.settings.set', donnaRes), true);
    assert.equal(allowed(dale, 'agents.models.set', donnaRes), true);
    assert.equal(allowed(dale, 'config.export.agent', donnaRes), true);
    assert.equal(allowed(dale, 'agents.converse', donnaRes), true);
    assert.equal(allowed(dale, 'approvals.decide', donnaRes), true);
    assert.equal(allowed(dale, 'skills.register', { grants: daleActive }), true);

    // Personal agent-member (sub-role) can wake & converse, NEVER clear holds even if they triggered the run (D29)
    const stephRes: AuthorizeResource = {
      agentId: 'donna',
      agentKind: 'personal',
      owners: ['user:dale'],
      requester: { actor: 'user:stephanie' },
      grants: stephActive,
    };
    assert.deepEqual(
      PRIVILEGES.filter((p) => allowed(stephanie, p, stephRes)).sort(),
      ['agents.converse', 'agents.wake'],
    );
    assert.equal(allowed(stephanie, 'approvals.decide', stephRes), false);

    // Start ownership transfer: outgoing owner becomes pending-revoked (readOnly: true)
    await store.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'donna' },
      fromSubject: 'user:dale',
      toSubject: 'user:alice',
      by: 'user:dale',
    });
    const dalePending = store.effectiveGrantsFor({ subject: 'user:dale' });
    const alicePending = store.effectiveGrantsFor({ subject: 'user:alice' });
    assert.equal(dalePending[0]?.readOnly, true);
    assert.equal(alicePending.length, 0);

    // Even if stale legacy owners=['user:dale'] is still present, pending-revoked suppresses write fallback!
    const pendingRes: AuthorizeResource = {
      agentId: 'donna',
      agentKind: 'personal',
      owners: ['user:dale'],
      grants: dalePending,
    };
    assert.deepEqual(
      PRIVILEGES.filter((p) => allowed(dale, p, pendingRes)).sort(),
      [...DERIVED_ROLE_PRIVILEGES['content-owner-readonly']].sort(),
    );
    for (const deniedWrite of [
      'agents.settings.set',
      'agents.models.set',
      'credentials.agent.set',
      'config.export.agent',
      'agents.wake',
      'agents.converse',
      'agents.pause',
      'approvals.decide',
    ] as Privilege[]) {
      assert.equal(allowed(dale, deniedWrite, pendingRes), false, deniedWrite);
    }
  });

  it('team accountable-lead and team member hold team privileges and both clear holds, while team agents ignore content-owner/owners', async () => {
    const store = GrantStore.inMemory({
      now: () => new Date('2026-11-02T12:00:00.000Z'),
      agentKindLookup: (id) => (id === 'archie' ? 'team' : undefined),
    });
    await store.grant({
      subject: 'user:sarah',
      scope: { kind: 'agent', id: 'archie' },
      role: 'accountable-lead',
      by: 'user:dale',
    });
    await store.grant({
      subject: 'group:reviewers',
      scope: { kind: 'agent', id: 'archie' },
      role: 'member',
      by: 'user:sarah',
      granterIsAdmin: false,
      granterRole: 'accountable-lead',
      knownGroups: new Set(['reviewers']),
    });

    const sarah = as('user:sarah');
    const geordi = as('user:geordi');
    const sarahGrants = store.effectiveGrantsFor({ subject: 'user:sarah' });
    const geordiGrants = store.effectiveGrantsFor({ subject: 'user:geordi', groupIds: ['reviewers'] });

    const leadRes: AuthorizeResource = {
      agentId: 'archie',
      agentKind: 'team',
      grants: sarahGrants,
    };
    assert.deepEqual(
      [...AGENT_SCOPED].filter((p) => allowed(sarah, p, leadRes)).sort(),
      [...DERIVED_ROLE_PRIVILEGES['accountable-lead']].sort(),
    );
    assert.equal(allowed(sarah, 'skills.register', { grants: sarahGrants }), true);
    assert.equal(allowed(sarah, 'approvals.decide', leadRes), true);
    assert.equal(allowed(sarah, 'agents.roles.assign', leadRes), true);
    assert.equal(allowed(sarah, 'config.export.agent', leadRes), false);

    // Team member (direct or via group) wakes, converses, and clears holds on the team agent (D11, D29)
    const memberRes: AuthorizeResource = {
      agentId: 'archie',
      agentKind: 'team',
      grants: geordiGrants,
    };
    assert.deepEqual(
      PRIVILEGES.filter((p) => allowed(geordi, p, memberRes)).sort(),
      ['agents.converse', 'agents.wake', 'approvals.decide'].sort(),
    );

    // Stale legacy owners on a team agent grant nothing
    const staleOwner = as('user:stale');
    assert.equal(
      allowed(staleOwner, 'agents.settings.set', {
        agentId: 'archie',
        agentKind: 'team',
        owners: ['user:stale'],
      }),
      false,
    );

    // Ingress authorization admits team member via grants without legacy link roles
    const ingress = authorizeIngress({
      requestedBy: { provider: 'discord', id: '999' },
      agentId: 'archie',
      agentKind: 'team',
      privilege: 'agents.converse',
      grants: geordiGrants,
      link: { actor: 'user:geordi', name: 'Geordi' },
      isIngressCaller: true,
    });
    assert.equal(ingress.allowed, true);
    if (ingress.allowed) {
      assert.equal(ingress.caller?.role, 'agent-member');
      assert.equal(ingress.caller?.isOwner, false);
    }
  });
});

