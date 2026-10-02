import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore, RunTokens } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { SystemsStore } from './systems.js';

const ADMIN = 'admin-systems-token';
const VIEWER = 'viewer-systems-token';
const EGRESS = 'egress-systems-token';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('systems as factory data (E10)', () => {
  let tmp: string;
  let server: http.Server;
  let port: number;
  let ledger: MemoryLedger;
  let state: FactoryState;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'systems-test-'));
    ledger = new MemoryLedger();
    const systemsDir = join(tmp, 'systems');
    const store = await SystemsStore.open(systemsDir, ledger);

    state = {
      agents: new Map(),
      registryDir: join(tmp, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] },
      ]),
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('systems-secret-token-key-1234567890'),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      systems: store,
    };

    server = createFactoryServer(state);
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('auto-seeds baseline definitions on open', async () => {
    const res = await call(port, '/api/v1/systems', 'GET', VIEWER);
    assert.equal(res.status, 200);
    const systems = res.body.systems as Array<{ id: string; status: string }>;
    assert.ok(systems.length >= 13, `expected at least 13 baseline systems, got ${systems.length}`);
    const discord = systems.find((s) => s.id === 'discord');
    assert.ok(discord);
    assert.equal(discord?.status, 'approved');
    const github = systems.find((s) => s.id === 'github');
    assert.ok(github);
    assert.equal(github?.status, 'approved');
    const closingClimb = systems.find((s) => s.id === 'closing-climb');
    assert.ok(closingClimb);
    assert.equal(closingClimb?.status, 'approved');
  });

  it('serves active routes to gatekeeper-egress via /api/v1/gatekeeper-egress/routes', async () => {
    const res = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    assert.equal(res.status, 200);
    const routes = res.body.routes as Array<{ id: string; upstream?: string; credential?: any; hold?: any }>;
    assert.ok(routes.some((r) => r.id === 'discord' && r.upstream === 'https://discord.com/api/v10'));
    assert.ok(routes.some((r) => r.id === 'github' && r.credential?.secret === '{agent}_GITHUB_TOKEN'));
    assert.ok(routes.some((r) => r.id === 'linkedin' && r.hold?.methods?.includes('POST')));
    assert.ok(routes.some((r) => r.id === 'closing-climb'));
  });

  it('proposes a new system definition and allows admin approval', async () => {
    // 1. Propose
    const propRes = await call(port, '/api/v1/systems', 'POST', VIEWER, {
      id: 'custom-crm',
      name: 'Custom CRM',
      description: 'Internal CRM API',
      kind: 'http',
      upstream: 'https://crm.internal.example.com',
      credential: {
        secret: 'CRM_API_KEY',
        header: 'x-api-key',
      },
    });
    assert.equal(propRes.status, 201);
    assert.equal(propRes.body.system.id, 'custom-crm');
    assert.equal(propRes.body.system.version, 1);
    assert.equal(propRes.body.system.status, 'proposed');

    // Not yet active in routes
    const r1 = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    assert.ok(!r1.body.routes.some((r: any) => r.id === 'custom-crm'));

    // 2. Viewer cannot approve
    const failApprove = await call(port, '/api/v1/systems/custom-crm/approve', 'POST', VIEWER);
    assert.equal(failApprove.status, 403);

    // 3. Admin approves
    const appRes = await call(port, '/api/v1/systems/custom-crm/approve', 'POST', ADMIN, {
      reason: 'Approved for production use',
    });
    assert.equal(appRes.status, 200);
    assert.equal(appRes.body.system.status, 'approved');

    // 4. Now active in routes
    const r2 = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    const customRoute = r2.body.routes.find((r: any) => r.id === 'custom-crm');
    assert.ok(customRoute);
    assert.equal(customRoute.upstream, 'https://crm.internal.example.com');
    assert.equal(customRoute.credential.secret, 'CRM_API_KEY');

    // 5. Ledger has entries
    const entries = ledger.events.filter((e) => e.route === 'custom-crm' || (typeof e.agentId === 'string' && e.agentId.startsWith('system:custom-crm')));
    assert.ok(entries.some((e) => e.action === 'SYSTEM_PROPOSED'));
    assert.ok(entries.some((e) => e.action === 'SYSTEM_APPROVED'));
  });


  it('supports versioned edits and admin rejection', async () => {
    // 1. Edit custom-crm upstream (propose version 2)
    const editRes = await call(port, '/api/v1/systems', 'POST', VIEWER, {
      id: 'custom-crm',
      name: 'Custom CRM v2',
      kind: 'http',
      upstream: 'https://crm-v2.internal.example.com',
      credential: {
        secret: 'CRM_API_KEY_V2',
        header: 'x-api-key',
      },
    });
    assert.equal(editRes.status, 201);
    assert.equal(editRes.body.system.version, 2);
    assert.equal(editRes.body.system.status, 'proposed');

    // Active route is still version 1
    const r1 = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    const active1 = r1.body.routes.find((r: any) => r.id === 'custom-crm');
    assert.equal(active1.upstream, 'https://crm.internal.example.com');

    // Admin rejects version 2
    const rejRes = await call(port, '/api/v1/systems/custom-crm/reject', 'POST', ADMIN, {
      version: 2,
      reason: 'v2 endpoint not ready yet',
    });
    assert.equal(rejRes.status, 200);
    assert.equal(rejRes.body.system.status, 'rejected');

    // Active route remains version 1
    const r2 = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    const active2 = r2.body.routes.find((r: any) => r.id === 'custom-crm');
    assert.equal(active2.upstream, 'https://crm.internal.example.com');

    // Propose version 3 and approve
    const v3Res = await call(port, '/api/v1/systems', 'POST', VIEWER, {
      id: 'custom-crm',
      name: 'Custom CRM v3',
      kind: 'http',
      upstream: 'https://crm-v3.internal.example.com',
      credential: {
        secret: 'CRM_API_KEY_V3',
        header: 'x-api-key',
      },
    });
    assert.equal(v3Res.status, 201);
    assert.equal(v3Res.body.system.version, 3);

    const appV3 = await call(port, '/api/v1/systems/custom-crm/approve', 'POST', ADMIN, {
      version: 3,
    });
    assert.equal(appV3.status, 200);
    assert.equal(appV3.body.system.status, 'approved');

    // Now active route is version 3
    const r3 = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    const active3 = r3.body.routes.find((r: any) => r.id === 'custom-crm');
    assert.equal(active3.upstream, 'https://crm-v3.internal.example.com');
    assert.equal(active3.credential.secret, 'CRM_API_KEY_V3');
  });

  it('rejects an invalid proposal', async () => {
    const res = await call(port, '/api/v1/systems', 'POST', VIEWER, {
      id: 'bad-system',
      name: 'Bad',
      upstream: 'not-a-url',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_system_proposal');
  });
});

