import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeIngress, IdentityLinkStore } from './identity.js';

describe('Bouncer authorizeIngress', () => {
  it('allows internal actions with no requestedBy when not ingress caller', () => {
    const res = authorizeIngress({ agentId: 'donna' });
    assert.deepEqual(res, { allowed: true });
  });

  it('rejects an external ingress caller with missing requestedBy (fail closed)', () => {
    const res = authorizeIngress({ agentId: 'donna', isIngressCaller: true });
    assert.equal(res.allowed, false);
    if (!res.allowed) {
      assert.equal(res.error, 'unauthorized_caller');
      assert.match(res.reason, /missing requestedBy for external ingress caller/);
    }
  });

  it('rejects an unmapped external identity with unauthorized_caller', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'unknown_user_999' },
      agentId: 'donna',
      link: undefined,
    });
    assert.equal(res.allowed, false);
    if (!res.allowed) {
      assert.equal(res.error, 'unauthorized_caller');
      assert.match(res.reason, /unmapped external identity: discord:unknown_user_999/);
    }
  });

  it('rejects an external caller with insufficient roles', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'viewer_user' },
      agentId: 'donna',
      owners: ['cloudflare:admin@example.com'],
      link: {
        actor: 'cloudflare:stranger@example.com',
        roles: ['viewer'],
      },
    });
    assert.equal(res.allowed, false);
    if (!res.allowed) {
      assert.equal(res.error, 'unauthorized_caller');
      assert.equal(res.required, 'operator');
    }
  });

  it('authorizes a mapped admin user across all agents and returns caller metadata', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: '123456789' },
      agentId: 'donna',
      owners: ['cloudflare:other@example.com'],
      link: {
        actor: 'cloudflare:admin@example.com',
        name: 'Admin User',
        roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.deepEqual(res.caller, {
        actor: 'cloudflare:admin@example.com',
        name: 'Admin User',
        role: 'admin',
        roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'],
        agentRoles: [],
        isOwner: false,
        provider: 'discord',
        id: '123456789',
      });
    }
  });

  it('resolves legacy link via adminEmails when link has no explicit roles', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'admin_disc' },
      agentId: 'donna',
      adminEmails: ['legacy_admin@example.com'],
      link: {
        actor: 'cloudflare:legacy_admin@example.com',
        name: 'Legacy Admin',
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.role, 'admin');
      assert.deepEqual(res.caller?.roles, ['admin']);
    }
  });

  it('reports the satisfying role when a user has multiple roles (viewer, operator)', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'slack', id: 'U_MULTI' },
      agentId: 'donna',
      link: {
        actor: 'cloudflare:user@example.com',
        name: 'Multi Role User',
        roles: ['viewer', 'operator'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      // Must report 'operator' since operator satisfied agents.wake, not 'viewer'
      assert.equal(res.caller?.role, 'operator');
      assert.deepEqual(res.caller?.roles, ['viewer', 'operator']);
    }
  });

  it('authorizes an agent owner via derived agent-owner role', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'slack', id: 'U123456' },
      agentId: 'archie',
      owners: ['cloudflare:alice@example.com'],
      link: {
        actor: 'cloudflare:alice@example.com',
        name: 'Alice',
        roles: ['viewer'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.role, 'agent-owner');
      assert.equal(res.caller?.name, 'Alice');
      assert.equal(res.caller?.provider, 'slack');
      assert.equal(res.caller?.isOwner, true);
      assert.deepEqual(res.caller?.agentRoles, ['Owner']);
    }
  });

  it('populates agentRoles mapped for a specific agent', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'steph_disc' },
      agentId: 'donna',
      link: {
        actor: 'cloudflare:stephanie@example.com',
        name: 'Stephanie',
        roles: ['operator'],
        agentRoles: {
          donna: ['Family'],
          higgins: ['Realtor'],
        },
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.name, 'Stephanie');
      assert.equal(res.caller?.isOwner, false);
      assert.deepEqual(res.caller?.agentRoles, ['Family']);
    }
  });

  describe('a person who holds only an agent role (E12, GAP-127)', () => {
    const stephanie = (agentRoles: Record<string, string[]> | undefined, roles?: readonly ('viewer' | 'operator')[]) => ({
      actor: 'cloudflare:stephanie@example.com',
      name: 'Stephanie',
      ...(roles ? { roles } : {}),
      ...(agentRoles ? { agentRoles } : {}),
    });
    const ask = (agentId: string, link: ReturnType<typeof stephanie>, privilege: 'agents.wake' | 'agents.converse' = 'agents.wake') =>
      authorizeIngress({ requestedBy: { provider: 'discord', id: 'steph' }, agentId, privilege, owners: ['cloudflare:dale@example.com'], link, isIngressCaller: true });

    it('is admitted to start a run and to converse with the agent she holds the role on, with no factory role', () => {
      for (const privilege of ['agents.wake', 'agents.converse'] as const) {
        const res = ask('donna', stephanie({ donna: ['Family'] }), privilege);
        assert.equal(res.allowed, true, privilege);
        if (res.allowed) {
          assert.equal(res.caller?.role, 'agent-member');
          assert.deepEqual(res.caller?.roles, [], 'she holds no factory role, and the badge says so');
          assert.deepEqual(res.caller?.agentRoles, ['Family']);
          assert.equal(res.caller?.isOwner, false);
        }
      }
    });

    it('is refused on an agent she holds no role on, even though she holds one on another', () => {
      const res = ask('higgins', stephanie({ donna: ['Family'] }));
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /does not hold agents\.wake on agent 'higgins'/);
    });

    it('is refused with no role, an empty list, a blank name or only the reserved Owner (no role of hers is a role)', () => {
      for (const agentRoles of [undefined, {}, { donna: [] }, { donna: [''] }, { donna: ['  '] }, { donna: ['Owner'] }, { donna: ['owner'] }]) {
        assert.equal(ask('donna', stephanie(agentRoles as Record<string, string[]> | undefined)).allowed, false, JSON.stringify(agentRoles));
      }
    });

    it('is refused when she is not mapped at all: a stranger’s message is not delivered', () => {
      const res = authorizeIngress({ requestedBy: { provider: 'discord', id: 'a-stranger' }, agentId: 'donna', isIngressCaller: true, link: undefined });
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /unmapped external identity/);
    });

    it('does not let a role name collide with prototype keys to admit someone', () => {
      const link = stephanie(Object.create(null));
      assert.equal(ask('constructor', link).allowed, false);
      assert.equal(ask('__proto__', link).allowed, false);
    });

    it('still reports a factory role first when she also holds one that satisfies the privilege', () => {
      const res = ask('donna', stephanie({ donna: ['Family'] }, ['operator']));
      assert.equal(res.allowed, true);
      if (res.allowed) assert.equal(res.caller?.role, 'operator');
    });

    it('with only a viewer role and an agent role, is admitted as a member (viewer cannot wake)', () => {
      const res = ask('donna', stephanie({ donna: ['Family'] }, ['viewer']));
      assert.equal(res.allowed, true);
      if (res.allowed) {
        assert.equal(res.caller?.role, 'agent-member');
        assert.deepEqual(res.caller?.roles, ['viewer']);
      }
    });
  });

  it('rejects un-roled link without explicit roles when not admin or owner (clean slate: zero grandfathering)', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'unroled_user' },
      agentId: 'donna',
      link: {
        actor: 'cloudflare:unroled_user@example.com',
        name: 'Unroled User',
      },
    });
    assert.equal(res.allowed, false);
    if (!res.allowed) {
      assert.equal(res.error, 'unauthorized_caller');
      assert.equal(res.required, 'operator');
    }
  });

  it('authorizes un-roled link if caller is agent owner (derived agent-owner role)', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'owner_user' },
      agentId: 'donna',
      owners: ['cloudflare:owner@example.com'],
      link: {
        actor: 'cloudflare:owner@example.com',
        name: 'Agent Owner',
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.role, 'agent-owner');
      assert.deepEqual(res.caller?.roles, []);
    }
  });

  it('rejects un-roled agent owner on agents.converse (owner rights apply to wake, not converse)', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'owner_user' },
      agentId: 'donna',
      privilege: 'agents.converse',
      owners: ['cloudflare:owner@example.com'],
      link: {
        actor: 'cloudflare:owner@example.com',
        name: 'Agent Owner',
      },
    });
    assert.equal(res.allowed, false);
    if (!res.allowed) {
      assert.equal(res.error, 'unauthorized_caller');
      assert.equal(res.required, 'operator');
    }
  });

  it('authorizes conversation mid-run with agents.converse privilege', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'op_user' },
      agentId: 'donna',
      privilege: 'agents.converse',
      link: {
        actor: 'token:ops',
        name: 'Operator',
        roles: ['operator'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.role, 'operator');
    }
  });
});

describe('Bouncer IdentityLinkStore', () => {
  it('links, resolves, lists and unlinks external identities', () => {
    const store = new IdentityLinkStore();
    const { link, changed } = store.link('discord', 'disc_123', 'cloudflare:alice@example.com', 'token:admin', {
      name: 'Alice',
      roles: ['operator'],
    });
    assert.equal(changed, true);
    assert.equal(link.provider, 'discord');
    assert.equal(link.actor, 'cloudflare:alice@example.com');
    assert.equal(store.resolve('discord', 'disc_123'), 'cloudflare:alice@example.com');
    assert.equal(store.resolveLink('discord', 'disc_123')?.name, 'Alice');

    // Idempotent link
    const second = store.link('discord', 'disc_123', 'cloudflare:alice@example.com', 'token:admin', {
      name: 'Alice',
      roles: ['operator'],
    });
    assert.equal(second.changed, false);

    assert.equal(store.list().length, 1);
    const unlinked = store.unlink('discord', 'disc_123');
    assert.ok(unlinked);
    assert.equal(store.resolve('discord', 'disc_123'), undefined);
  });

  it('stores and preserves agentRoles mapping', () => {
    const store = new IdentityLinkStore();
    const { link } = store.link('discord', 'steph_1', 'cloudflare:stephanie@example.com', 'token:admin', {
      name: 'Stephanie',
      roles: ['operator'],
      agentRoles: { donna: ['Family'] },
    });
    assert.deepEqual({ ...link.agentRoles }, { donna: ['Family'] });
    const resolved = store.resolveLink('discord', 'steph_1');
    assert.deepEqual({ ...resolved?.agentRoles }, { donna: ['Family'] });
  });

  it('preserves existing agentRoles on re-link when omitted (partial update) for same actor', () => {
    const store = new IdentityLinkStore();
    store.link('discord', 'user_1', 'cloudflare:user1@example.com', 'token:admin', {
      name: 'User One',
      roles: ['operator'],
      agentRoles: { switch: ['Operator'], donna: ['Family'] },
    });

    // Re-link with only updated name; agentRoles should not be clobbered
    const { link: updated } = store.link('discord', 'user_1', 'cloudflare:user1@example.com', 'token:admin', {
      name: 'User One Updated',
      roles: ['operator'],
    });
    assert.equal(updated.name, 'User One Updated');
    assert.deepEqual({ ...updated.agentRoles }, { switch: ['Operator'], donna: ['Family'] });
  });

  it('resets agentRoles when re-pointing link to a different actor and agentRoles is omitted', () => {
    const store = new IdentityLinkStore();
    store.link('discord', 'shared_user', 'cloudflare:alice@example.com', 'token:admin', {
      name: 'Alice',
      roles: ['operator'],
      agentRoles: { switch: ['Operator'] },
    });

    // Re-point link to Bob without agentRoles: Alice's agentRoles must NOT carry over to Bob
    const { link: repointed } = store.link('discord', 'shared_user', 'cloudflare:bob@example.com', 'token:admin', {
      name: 'Bob',
      roles: ['operator'],
    });
    assert.equal(repointed.actor, 'cloudflare:bob@example.com');
    assert.equal(repointed.agentRoles, undefined);
  });

  it('considers reordered agentRoles identical (no spurious change)', () => {
    const store = new IdentityLinkStore();
    store.link('discord', 'user_2', 'cloudflare:user2@example.com', 'token:admin', {
      agentRoles: { switch: ['A', 'B'], donna: ['X', 'Y'] },
    });

    // Re-link with different key and array ordering
    const { changed } = store.link('discord', 'user_2', 'cloudflare:user2@example.com', 'token:admin', {
      agentRoles: { donna: ['Y', 'X'], switch: ['B', 'A'] },
    });
    assert.equal(changed, false);
  });

  it('detects no spurious change when input contains prototype keys', () => {
    const store = new IdentityLinkStore();
    store.link('discord', 'user_spurious', 'cloudflare:user@example.com', 'token:admin', {
      agentRoles: { constructor: ['Role'] as any, donna: ['User'] },
    });

    // Re-link with identical unsanitized input
    const { changed } = store.link('discord', 'user_spurious', 'cloudflare:user@example.com', 'token:admin', {
      agentRoles: { constructor: ['Role'] as any, donna: ['User'] },
    });
    assert.equal(changed, false);
  });

  it('reserves Owner role and derives it strictly from catalog owners', () => {
    const store = new IdentityLinkStore();
    const { link } = store.link('discord', 'user_owner', 'cloudflare:alice@example.com', 'token:admin', {
      agentRoles: { switch: ['Owner', 'Operator'] },
    });
    // 'Owner' should be stripped from stored agentRoles
    assert.deepEqual(link.agentRoles?.switch, ['Operator']);

    // Non-owner gets only non-Owner roles
    const nonOwnerAuth = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'user_owner' },
      agentId: 'switch',
      owners: ['cloudflare:bob@example.com'],
      link: {
        actor: 'cloudflare:alice@example.com',
        roles: ['operator'],
        agentRoles: link.agentRoles,
      },
    });
    assert.equal(nonOwnerAuth.allowed, true);
    if (nonOwnerAuth.allowed) {
      assert.equal(nonOwnerAuth.caller?.isOwner, false);
      assert.deepEqual(nonOwnerAuth.caller?.agentRoles, ['Operator']);
    }

    // Owner gets 'Owner' injected
    const ownerAuth = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'user_owner' },
      agentId: 'switch',
      owners: ['cloudflare:alice@example.com'],
      link: {
        actor: 'cloudflare:alice@example.com',
        roles: ['operator'],
        agentRoles: link.agentRoles,
      },
    });
    assert.equal(ownerAuth.allowed, true);
    if (ownerAuth.allowed) {
      assert.equal(ownerAuth.caller?.isOwner, true);
      assert.deepEqual(ownerAuth.caller?.agentRoles, ['Owner', 'Operator']);
    }
  });

  it('safely handles prototype keys without corrupting lookups or throwing', () => {
    const store = new IdentityLinkStore();
    const { link } = store.link('discord', 'user_3', 'cloudflare:user3@example.com', 'token:admin', {
      agentRoles: { constructor: ['SomeRole'], donna: ['User'] } as any,
    });
    // constructor should not be stored as an own property, and null-prototype avoids inheritance
    assert.equal(Object.hasOwn(link.agentRoles || {}, 'constructor'), false);
    assert.equal(link.agentRoles?.constructor, undefined);
    assert.deepEqual(link.agentRoles?.donna, ['User']);

    // authorizeIngress safe lookup for agentId 'constructor'
    const res = authorizeIngress({
      requestedBy: { provider: 'discord', id: 'user_3' },
      agentId: 'constructor',
      owners: [],
      link: {
        actor: 'cloudflare:user3@example.com',
        roles: ['operator'],
        agentRoles: link.agentRoles,
      },
    });
    // Does not throw and returns empty agentRoles
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.deepEqual(res.caller?.agentRoles, []);
    }
  });
});

