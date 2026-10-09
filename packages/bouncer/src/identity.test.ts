import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeIngress } from './identity.js';

describe('Bouncer authorizeIngress', () => {
  it('allows internal actions with no requestedBy', () => {
    const res = authorizeIngress({ agentId: 'donna' });
    assert.deepEqual(res, { allowed: true });
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
      owners: ['cloudflare:dale.sackrider@gmail.com'],
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
      requestedBy: { provider: 'discord', id: '470400107028938752' },
      agentId: 'donna',
      owners: ['cloudflare:other@example.com'],
      link: {
        actor: 'cloudflare:dale.sackrider@gmail.com',
        name: 'Dale',
        roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.deepEqual(res.caller, {
        actor: 'cloudflare:dale.sackrider@gmail.com',
        name: 'Dale',
        role: 'admin',
        roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'],
        provider: 'discord',
        id: '470400107028938752',
      });
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

  it('authorizes an operator user', () => {
    const res = authorizeIngress({
      requestedBy: { provider: 'teams', id: 'T987' },
      agentId: 'switch',
      owners: ['cloudflare:someone@example.com'],
      link: {
        actor: 'token:ops',
        name: 'Ops Team',
        roles: ['operator'],
      },
    });
    assert.equal(res.allowed, true);
    if (res.allowed) {
      assert.equal(res.caller?.role, 'operator');
    }
  });
});
