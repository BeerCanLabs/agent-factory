import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { createInspector } from '@beercanlabs/factory-inspector';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

describe('Group routes (/api/v1/groups) (H6, A10, A17, A26)', () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  let tmpDir: string;
  let ledger: MemoryLedger;

  const ADMIN_TOKEN = 'admin-groups-token';
  const VIEWER_TOKEN = 'viewer-groups-token';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cp-groups-test-'));
    ledger = new MemoryLedger();

    state = {
      agents: new Map(),
      ledger,
      inspector: createInspector(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN_TOKEN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER_TOKEN, roles: ['viewer'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('test-key-01234567890123456789012345678901'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      groups: await GroupStore.open(join(tmpDir, 'groups')),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    const addr = cp.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  after(async () => {
    if (cp) {
      await new Promise<void>((r) => cp.close(() => r()));
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function request(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      let data: string | undefined;
      if (body !== undefined) {
        data = JSON.stringify(body);
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(data));
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers,
        },
        (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => {
            let parsed: any = null;
            try {
              parsed = buf ? JSON.parse(buf) : null;
            } catch {
              parsed = buf;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  it('rejects unauthenticated and unauthorized requests', async () => {
    // 401 without token
    const noAuth = await request('GET', '/api/v1/groups');
    assert.equal(noAuth.status, 401);

    // 403 with viewer token (groups.manage requires admin)
    const viewerRes = await request('GET', '/api/v1/groups', VIEWER_TOKEN);
    assert.equal(viewerRes.status, 403);
  });

  it('performs full group lifecycle with membership and ledger audit trail', async () => {
    // 1. Initial list empty
    const listInitial = await request('GET', '/api/v1/groups', ADMIN_TOKEN);
    assert.equal(listInitial.status, 200);
    assert.deepEqual(listInitial.body.groups, []);

    // 2. Reject invalid group creations
    const badRole = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'admins',
      name: 'Admins',
      roles: ['admin'],
    });
    assert.equal(badRole.status, 400);
    assert.match(badRole.body.message, /built-in factory role forbidden/);

    const badApprover = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'approvers',
      name: 'Approvers',
      roles: ['approver'],
    });
    assert.equal(badApprover.status, 400);
    assert.match(badApprover.body.message, /built-in factory role forbidden/);

    const badOperator = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'operators',
      name: 'Operators',
      roles: ['operator'],
    });
    assert.equal(badOperator.status, 400);
    assert.match(badOperator.body.message, /built-in factory role forbidden/);

    const badUnknown = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'custom-role',
      name: 'Custom',
      roles: ['super-power'],
    });
    assert.equal(badUnknown.status, 400);
    assert.match(badUnknown.body.message, /allowed roles are/);

    const badId = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'invalid id with spaces',
      name: 'Spaces',
    });
    assert.equal(badId.status, 400);

    // 3. Create valid group
    const created = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'platform-team',
      name: 'Platform Engineering',
      description: 'Engineers managing platform capabilities',
      roles: ['skills.register', 'skill-owner'],
      members: ['alice@example.com'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.group.id, 'platform-team');
    assert.equal(created.body.group.name, 'Platform Engineering');
    assert.deepEqual(created.body.group.roles, ['skill-owner', 'skills.register']);
    assert.deepEqual(created.body.group.members, ['alice@example.com']);

    // Verify ledger row for creation
    const creationRow = ledger.query().find((r: any) => r.action === 'GROUP_CREATED');
    assert.ok(creationRow, 'GROUP_CREATED ledger event should be emitted');
    assert.ok(creationRow.payloadSha256);

    // 4. Duplicate ID returns 409
    const dup = await request('POST', '/api/v1/groups', ADMIN_TOKEN, {
      id: 'platform-team',
      name: 'Platform Engineering Duplicate',
    });
    assert.equal(dup.status, 409);

    // 5. Get group by ID
    const getRes = await request('GET', '/api/v1/groups/platform-team', ADMIN_TOKEN);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.group.name, 'Platform Engineering');

    const getMissing = await request('GET', '/api/v1/groups/non-existent', ADMIN_TOKEN);
    assert.equal(getMissing.status, 404);

    const getBadId = await request('GET', '/api/v1/groups/bad%20id', ADMIN_TOKEN);
    assert.equal(getBadId.status, 400);
    assert.equal(getBadId.body.error, 'invalid_group_id');

    // Case-insensitive lookup works on GET
    const getUpper = await request('GET', '/api/v1/groups/PLATFORM-TEAM', ADMIN_TOKEN);
    assert.equal(getUpper.status, 200);
    assert.equal(getUpper.body.group.id, 'platform-team');

    // 6. Update group
    const badUpdateRole = await request('PUT', '/api/v1/groups/platform-team', ADMIN_TOKEN, {
      roles: ['admin'],
    });
    assert.equal(badUpdateRole.status, 400);

    const badUpdateApprover = await request('PUT', '/api/v1/groups/platform-team', ADMIN_TOKEN, {
      roles: ['approver'],
    });
    assert.equal(badUpdateApprover.status, 400);

    const updated = await request('PUT', '/api/v1/groups/platform-team', ADMIN_TOKEN, {
      name: 'Platform & Infrastructure',
      description: 'Platform and infra engineers',
      roles: ['skills.register'],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.group.name, 'Platform & Infrastructure');
    assert.deepEqual(updated.body.group.roles, ['skills.register']);

    // Verify ledger row for update
    const updateRow = ledger.query().find((r: any) => r.action === 'GROUP_UPDATED');
    assert.ok(updateRow, 'GROUP_UPDATED ledger event should be emitted');

    // 7. Add member
    const badGroupAddMem = await request('POST', '/api/v1/groups/bad%20id/members', ADMIN_TOKEN, {
      member: 'bob@example.com',
    });
    assert.equal(badGroupAddMem.status, 400);
    assert.equal(badGroupAddMem.body.error, 'invalid_group_id');

    const addMem = await request('POST', '/api/v1/groups/platform-team/members', ADMIN_TOKEN, {
      member: 'bob@example.com',
    });
    assert.equal(addMem.status, 200);
    assert.deepEqual(addMem.body.group.members, ['alice@example.com', 'bob@example.com']);

    const addMemRow = ledger.query().find((r: any) => r.action === 'GROUP_MEMBER_ADDED');
    assert.ok(addMemRow, 'GROUP_MEMBER_ADDED ledger event should be emitted');

    // 8. Filter groups by member query
    const filterAlice = await request('GET', '/api/v1/groups?member=alice@example.com', ADMIN_TOKEN);
    assert.equal(filterAlice.status, 200);
    assert.equal(filterAlice.body.groups.length, 1);
    assert.equal(filterAlice.body.groups[0].id, 'platform-team');

    const filterCharlie = await request('GET', '/api/v1/groups?member=charlie@example.com', ADMIN_TOKEN);
    assert.equal(filterCharlie.status, 200);
    assert.equal(filterCharlie.body.groups.length, 0);

    // 9. Remove member via path
    const badGroupRmMem = await request('DELETE', '/api/v1/groups/bad%20id/members/bob@example.com', ADMIN_TOKEN);
    assert.equal(badGroupRmMem.status, 400);
    assert.equal(badGroupRmMem.body.error, 'invalid_group_id');

    const rmMem = await request('DELETE', '/api/v1/groups/platform-team/members/bob@example.com', ADMIN_TOKEN);
    assert.equal(rmMem.status, 200);
    assert.deepEqual(rmMem.body.group.members, ['alice@example.com']);

    const rmMemRow = ledger.query().find((r: any) => r.action === 'GROUP_MEMBER_REMOVED');
    assert.ok(rmMemRow, 'GROUP_MEMBER_REMOVED ledger event should be emitted');

    // 10. Delete group
    const delRes = await request('DELETE', '/api/v1/groups/platform-team', ADMIN_TOKEN);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);

    const delRow = ledger.query().find((r: any) => r.action === 'GROUP_DELETED');
    assert.ok(delRow, 'GROUP_DELETED ledger event should be emitted');

    // 11. Confirm deleted
    const getAfterDel = await request('GET', '/api/v1/groups/platform-team', ADMIN_TOKEN);
    assert.equal(getAfterDel.status, 404);
  });

  it('returns 503 when groups store is unavailable', async () => {
    const savedGroups = state.groups;
    state.groups = undefined;
    try {
      const res = await request('GET', '/api/v1/groups', ADMIN_TOKEN);
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'groups_unavailable');
    } finally {
      state.groups = savedGroups;
    }
  });
});
