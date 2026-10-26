import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupStore } from './group-store.js';

describe('GroupStore (H6, A10, A17)', () => {
  it('creates, retrieves, and persists groups across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store1 = await GroupStore.open(dir);
      assert.equal(store1.listGroups().length, 0);

      const created = store1.createGroup({
        id: 'engineering',
        name: 'Engineering Team',
        description: 'Core backend and systems engineers',
        roles: ['skill-owner'],
        members: ['alice@example.com', 'bob@example.com'],
      });

      assert.equal(created.id, 'engineering');
      assert.equal(created.name, 'Engineering Team');
      assert.deepEqual(created.roles, ['skill-owner']);
      assert.deepEqual(created.members, ['alice@example.com', 'bob@example.com']);
      assert.ok(created.createdAt);
      assert.ok(created.updatedAt);

      // Verify retrieval from memory
      const fetched = store1.getGroup('engineering');
      assert.ok(fetched);
      assert.equal(fetched.name, 'Engineering Team');

      // Verify persistence across restart
      const store2 = await GroupStore.open(dir);
      const reloaded = store2.getGroup('engineering');
      assert.ok(reloaded);
      assert.equal(reloaded.id, 'engineering');
      assert.equal(reloaded.name, 'Engineering Team');
      assert.deepEqual(reloaded.roles, ['skill-owner']);
      assert.deepEqual(reloaded.members, ['alice@example.com', 'bob@example.com']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate group ID creation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      store.createGroup({ id: 'security', name: 'Security' });
      assert.throws(() => {
        store.createGroup({ id: 'security', name: 'Duplicate' });
      }, /already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces A17 role restrictions on creation and update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      // Built-in factory roles forbidden on create
      assert.throws(() => {
        store.createGroup({ id: 'admins-group', name: 'Admins', roles: ['admin'] });
      }, /built-in factory role forbidden/);
      assert.throws(() => {
        store.createGroup({ id: 'operators-group', name: 'Operators', roles: ['operator'] });
      }, /built-in factory role forbidden/);
      assert.throws(() => {
        store.createGroup({ id: 'approvers-group', name: 'Approvers', roles: ['approver'] });
      }, /built-in factory role forbidden/);
      assert.throws(() => {
        store.createGroup({ id: 'viewers-group', name: 'Viewers', roles: ['viewer'] });
      }, /built-in factory role forbidden/);

      // Unknown roles forbidden on create
      assert.throws(() => {
        store.createGroup({ id: 'custom-group', name: 'Custom', roles: ['unknown-role'] });
      }, /allowed roles are skill-owner, skills.register/);

      // Create valid group with allowed roles (skill-owner, skills.register)
      store.createGroup({ id: 'devs', name: 'Developers', roles: ['skills.register'] });

      // Built-in factory roles forbidden on update
      assert.throws(() => {
        store.updateGroup('devs', { roles: ['admin'] });
      }, /built-in factory role forbidden/);
      assert.throws(() => {
        store.updateGroup('devs', { roles: ['approver'] });
      }, /built-in factory role forbidden/);
      assert.throws(() => {
        store.updateGroup('devs', { roles: ['operator'] });
      }, /built-in factory role forbidden/);

      // Unknown roles forbidden on update
      assert.throws(() => {
        store.updateGroup('devs', { roles: ['nonexistent-role'] });
      }, /allowed roles are skill-owner, skills.register/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates name, description, and roles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      const created = store.createGroup({ id: 'product', name: 'Product' });
      const origUpdatedAt = created.updatedAt;

      const updated = store.updateGroup('product', {
        name: 'Product & Design',
        description: 'Product managers and UX designers',
        roles: ['skills.register'],
      });

      assert.equal(updated.name, 'Product & Design');
      assert.equal(updated.description, 'Product managers and UX designers');
      assert.deepEqual(updated.roles, ['skills.register']);
      assert.ok(updated.updatedAt >= origUpdatedAt);

      // Verify update on non-existent group fails
      assert.throws(() => {
        store.updateGroup('non-existent', { name: 'Foo' });
      }, /not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes groups and cleans up persisted file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      store.createGroup({ id: 'temp-group', name: 'Temporary' });
      assert.ok(store.getGroup('temp-group'));

      const deleted = store.deleteGroup('temp-group');
      assert.equal(deleted, true);
      assert.equal(store.getGroup('temp-group'), undefined);

      // Deleting again returns false
      assert.equal(store.deleteGroup('temp-group'), false);

      // Persists deletion across reload
      const store2 = await GroupStore.open(dir);
      assert.equal(store2.getGroup('temp-group'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds and removes group members', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      store.createGroup({ id: 'core', name: 'Core Team', members: ['alice@example.com'] });

      // Add bob
      const withBob = store.addMember('core', 'bob@example.com');
      assert.deepEqual(withBob.members, ['alice@example.com', 'bob@example.com']);

      // Adding bob again is idempotent
      const bobAgain = store.addMember('core', 'bob@example.com');
      assert.deepEqual(bobAgain.members, ['alice@example.com', 'bob@example.com']);

      // Remove alice
      const withoutAlice = store.removeMember('core', 'alice@example.com');
      assert.deepEqual(withoutAlice.members, ['bob@example.com']);

      // Removing alice again is idempotent
      const withoutAliceAgain = store.removeMember('core', 'alice@example.com');
      assert.deepEqual(withoutAliceAgain.members, ['bob@example.com']);

      // Error on non-existent group
      assert.throws(() => {
        store.addMember('non-existent', 'carol@example.com');
      }, /not found/);
      assert.throws(() => {
        store.removeMember('non-existent', 'bob@example.com');
      }, /not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aggregates user groups and consolidated roles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      store.createGroup({
        id: 'team-a',
        name: 'Team A',
        roles: ['skill-owner'],
        members: ['dave@example.com'],
      });
      store.createGroup({
        id: 'team-b',
        name: 'Team B',
        roles: ['skills.register'],
        members: ['dave@example.com', 'eve@example.com'],
      });

      const daveGroups = store.listUserGroups('dave@example.com');
      assert.equal(daveGroups.length, 2);
      assert.deepEqual(daveGroups.map((g) => g.id).sort(), ['team-a', 'team-b']);

      const daveRoles = store.getUserRoles('dave@example.com');
      assert.deepEqual(daveRoles, ['skill-owner', 'skills.register']);

      const eveRoles = store.getUserRoles('eve@example.com');
      assert.deepEqual(eveRoles, ['skills.register']);

      const unknownRoles = store.getUserRoles('stranger@example.com');
      assert.deepEqual(unknownRoles, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('safely handles prototype names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-store-test-'));
    try {
      const store = await GroupStore.open(dir);
      assert.equal(store.getGroup('constructor'), undefined);
      assert.equal(store.getGroup('__proto__'), undefined);
      assert.equal(store.deleteGroup('__proto__'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
