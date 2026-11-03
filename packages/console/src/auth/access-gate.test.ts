import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canManagePeople, hasAnyAccess, validActAs } from './access-gate.js';

describe('S9 console gating from whoami (#374)', () => {
  it('S9 AC1: zero-grant user sees only the no-access screen; granted user sees permitted views; admin sees People', () => {
    assert.equal(hasAnyAccess(undefined), false, 'no anonymous viewer while loading or signed out');
    const zero = { actor: 'user:zed', roles: [], grants: [], privileges: { fleet: [], agents: {}, skills: {} } };
    assert.equal(hasAnyAccess(zero), false);
    const owner = { actor: 'user:alice', roles: [], grants: [{}], privileges: { fleet: [], agents: { 'alice-bot': ['agents.read'] } } };
    assert.equal(hasAnyAccess(owner), true);
    assert.equal(canManagePeople(owner), false);
    const admin = { actor: 'user:dale', roles: ['admin'], privileges: { fleet: ['grants.manage', 'agents.read'] } };
    assert.equal(canManagePeople(admin), true);
  });

  it('S9: act-as accepts only a user principal', () => {
    assert.equal(validActAs('user:alice'), true);
    for (const bad of ['alice', 'service:ci', 'user:', 'user:a b']) assert.equal(validActAs(bad), false, bad);
  });
});
