import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeIngress } from './identity.js';

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
