import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Principal, Role } from '@beercanlabs/factory-auth';
import { PRIVILEGES, authorize, type Privilege } from './index.js';

const ROLES: readonly Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'admin'];

// The census in DESIGN_AUTHORITY.md: the role each route names today. A literal copy, so this proof does not depend on `auth`.
const CENSUS: Record<string, Role> = {
  'agents.read': 'viewer',
  'policy.read': 'viewer',
  'config.read': 'viewer',
  'runs.read': 'viewer',
  'ledger.read': 'viewer',
  'models.read': 'viewer',
  'metrics.read': 'viewer',
  'triage.read': 'viewer',
  'spend.read': 'viewer',
  'approvals.read': 'viewer',
  'skills.read': 'viewer',
  'skills.register': 'viewer',
  'systems.read': 'viewer',
  'systems.propose': 'viewer',
  'connections.read': 'viewer',
  'credentials.provider.read': 'viewer',
  'events.subscribe': 'viewer',
  'schedules.read': 'viewer',
  'mcp.use': 'viewer',
  'agents.wake': 'operator',
  'agents.pause': 'operator',
  'agents.resume': 'operator',
  'agents.isolate': 'operator',
  'runs.cancel': 'operator',
  'agents.converse': 'operator',
  'hooks.invoke': 'operator',
  'schedules.write': 'operator',
  'approvals.decide': 'approver',
  'ledger.ingest': 'ingest',
  'ledger.attest-run-actor': 'gatekeeper-egress',
  'egress.run.read': 'gatekeeper-egress',
  'egress.approvals.request': 'gatekeeper-egress',
  'egress.holds.create': 'gatekeeper-egress',
  'egress.approvals.consume': 'gatekeeper-egress',
  'egress.keymaster.checkout': 'gatekeeper-egress',
  'egress.progress.report': 'gatekeeper-egress',
  'egress.routes.read': 'gatekeeper-egress',
  'egress.connections.token': 'gatekeeper-egress',
  'registry.register': 'admin',
  'registry.budget.set': 'admin',
  'registry.retire': 'admin',
  'registry.reinstate': 'admin',
  'registry.purge': 'admin',
  'registry.deploy': 'admin',
  'registry.model.set': 'admin',
  'policy.set': 'admin',
  'policy.budget.set': 'admin',
  'config.export': 'admin',
  'agents.owners.set': 'admin',
  'credentials.outstanding.read': 'admin',
  'credentials.platform.read': 'admin',
  'credentials.platform.set': 'admin',
  'credentials.agent.read': 'admin',
  'credentials.agent.set': 'admin',
  'credentials.provider.set': 'admin',
  'connections.start': 'admin',
  'connections.import': 'admin',
  'systems.decide': 'admin',
  'skills.decide': 'admin',
  'skills.checks.run': 'admin',
};
const EXCLUSIVE = new Set(['ledger.attest-run-actor', 'egress.connections.token']);

// The old rule (`hasRole` in auth), copied.
function oldHasRole(roles: Role[], role: Role): boolean {
  if (roles.includes('admin') || roles.includes(role)) return true;
  if (role === 'viewer') return roles.includes('operator') || roles.includes('approver');
  if (role === 'ingest') return roles.includes('gatekeeper-egress');
  return false;
}

// The old call site: the role a route names, plus the inline test for the two exclusive privileges.
function oldAllowed(roles: Role[], privilege: string): boolean {
  if (EXCLUSIVE.has(privilege)) return roles.includes('gatekeeper-egress');
  return oldHasRole(roles, CENSUS[privilege]);
}

const subsets: Role[][] = [];
for (let mask = 0; mask < 1 << ROLES.length; mask++) subsets.push(ROLES.filter((_, i) => mask & (1 << i)));

const principal = (roles: Role[]): Principal => ({ actor: 'test:a', roles });

describe('authorize', () => {
  it('the census has exactly the PRIVILEGES names', () => {
    assert.equal(PRIVILEGES.length, 60);
    assert.deepEqual([...PRIVILEGES].sort(), Object.keys(CENSUS).sort());
  });

  it('matches the old rule for each of the 64 role sets and each privilege', () => {
    assert.equal(subsets.length, 64);
    for (const roles of subsets) {
      for (const privilege of PRIVILEGES) {
        assert.equal(authorize({ principal: principal(roles), privilege }).allowed, oldAllowed(roles, privilege), `[${roles}] ${privilege}`);
      }
    }
  });

  it('names the role the route names today on every denial', () => {
    for (const roles of subsets) {
      for (const privilege of PRIVILEGES) {
        const r = authorize({ principal: principal(roles), privilege });
        if (!r.allowed) assert.equal(r.required, CENSUS[privilege], `[${roles}] ${privilege}`);
      }
    }
  });

  it('an admin does not pass the two exclusive privileges', () => {
    for (const p of EXCLUSIVE) {
      assert.deepEqual(authorize({ principal: principal(['admin']), privilege: p as Privilege }), { allowed: false, required: 'gatekeeper-egress' });
      assert.deepEqual(authorize({ principal: principal(['gatekeeper-egress']), privilege: p as Privilege }), { allowed: true });
    }
  });

  it('keeps the five hasRole assertions from auth, for equivalent privileges', () => {
    assert.ok(authorize({ principal: principal(['admin']), privilege: 'approvals.decide' }).allowed);
    assert.ok(authorize({ principal: principal(['operator']), privilege: 'agents.read' }).allowed);
    assert.ok(!authorize({ principal: principal(['operator']), privilege: 'approvals.decide' }).allowed);
    assert.ok(!authorize({ principal: principal(['ingest']), privilege: 'agents.read' }).allowed);
    assert.ok(!authorize({ principal: principal([]), privilege: 'agents.read' }).allowed);
  });
});
