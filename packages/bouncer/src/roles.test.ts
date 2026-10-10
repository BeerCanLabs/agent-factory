import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Principal, Role } from '@beercanlabs/factory-auth';
import { PRIVILEGES, authorize, type AuthorizeResource, type Privilege } from './index.js';
import { AGENT_SCOPED, DERIVED_ROLE_PRIVILEGES } from './privileges.js';

const OWNER_RIGHTS: Privilege[] = [
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
  'approvals.decide',
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

  it('every derived row holds only agent-scoped privileges', () => {
    for (const row of Object.values(DERIVED_ROLE_PRIVILEGES)) for (const p of row) assert.ok(AGENT_SCOPED.has(p), p);
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

  it('admin and approver still decide any agent, with or without a resource', () => {
    for (const role of ['admin', 'approver'] as Role[]) {
      const p = as('token:x', [role]);
      assert.ok(allowed(p, 'approvals.decide'));
      assert.ok(allowed(p, 'approvals.decide', on('a', [], {})));
    }
  });

  it('a denial still names the role the route names today', () => {
    const alice = as('cloudflare:alice@example.com');
    const r = on('b', ['cloudflare:bob@example.com']);
    assert.deepEqual(authorize({ principal: alice, privilege: 'agents.wake', resource: r }), { allowed: false, required: 'operator' });
    assert.deepEqual(authorize({ principal: alice, privilege: 'approvals.decide', resource: r }), { allowed: false, required: 'approver' });
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
