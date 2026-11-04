import { it } from 'node:test';
import assert from 'node:assert/strict';
import { filterAccess, grantsToCreate, groupGrants } from './people-model.js';

const principals = [{ id: 'user:dale', displayName: 'Dale' }, { id: 'user:ada', displayName: 'Ada' }];
const grants = [
  { id: 'g1', subject: 'user:dale', role: 'admin', scope: { kind: 'fleet' } },
  { id: 'g2', subject: 'user:ada', role: 'member', scope: { kind: 'agent', id: 'donna' } },
  { id: 'g3', subject: 'user:ada', role: 'member', scope: { kind: 'agent', id: 'archie' } },
  { id: 'g4', subject: 'user:ada', role: 'accountable-lead', scope: { kind: 'agent', id: 'donna' } },
  { id: 'g5', subject: 'user:ada', role: 'viewer', scope: { kind: 'fleet' }, state: 'revoked' },
];

it('#436: grants group per person by role and scope, with friendly names, active grants only', () => {
  const rows = groupGrants(principals, grants, { donna: 'Donna', archie: 'Archie' });
  assert.deepEqual(rows.map((r) => r.name), ['Ada', 'Dale']);
  const ada = rows[0];
  assert.deepEqual(ada.fleet, [], 'revoked grants are not shown');
  assert.deepEqual(ada.agents.map((r) => [r.role, r.items.map((i) => i.name)]), [['accountable-lead', ['Donna']], ['member', ['Archie', 'Donna']]]);
  assert.deepEqual(rows[1].fleet, [{ role: 'admin', grantId: 'g1' }]);
});

it('#436: search matches names, ids, roles and agents', () => {
  const rows = groupGrants(principals, grants, { donna: 'Donna' });
  assert.deepEqual(filterAccess(rows, 'donna').map((r) => r.subject), ['user:ada']);
  assert.deepEqual(filterAccess(rows, 'ADMIN').map((r) => r.subject), ['user:dale']);
  assert.equal(filterAccess(rows, '').length, 2);
});

it('#436: granting is person → role → scope (fleet, or one grant per chosen agent)', () => {
  assert.deepEqual(grantsToCreate('user:ada', 'operator', 'fleet', []), [{ subject: 'user:ada', role: 'operator', scope: { kind: 'fleet' } }]);
  assert.deepEqual(grantsToCreate('user:ada', 'member', 'agents', ['donna', 'archie', 'donna']).map((g) => g.scope), [{ kind: 'agent', id: 'donna' }, { kind: 'agent', id: 'archie' }]);
  assert.deepEqual(grantsToCreate('user:ada', 'member', 'fleet', []), [], 'agent roles are not fleet roles');
  assert.deepEqual(grantsToCreate('', 'viewer', 'fleet', []), []);
});
