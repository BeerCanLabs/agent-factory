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
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
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

/** A deployment's existing gatekeeper-egress routes, as FACTORY_SYSTEMS_IMPORT would carry them (GAP-068). */
const DEPLOYMENT_ROUTES = [
  { id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: 'https://api.anthropic.com', credential: { secret: 'ANTHROPIC_API_KEY', header: 'x-api-key' } },
  { id: 'models', kind: 'models' },
  { id: 'discord', kind: 'http', upstream: 'https://discord.com/api/v10', credential: { secret: '{agent}_DISCORD_BOT_TOKEN', header: 'authorization', format: 'Bot {}' }, stripSignInLinks: true },
  { id: 'github', kind: 'http', upstream: 'https://api.github.com', credential: { secret: '{agent}_GITHUB_TOKEN', header: 'authorization', format: 'Bearer {}', fallback: false } },
  { id: 'linkedin', kind: 'http', upstream: 'https://api.linkedin.com', connection: 'linkedin', hold: { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], preview: 'linkedin-post' } },
  { id: 'private-service', kind: 'http', upstream: 'https://private.example.com', credential: { secret: 'PRIVATE_TOKEN', header: 'x-api-token' } },
  { id: 'broken', kind: 'http', upstream: 'http://insecure.example.com' },
];

describe('systems as factory data (E10)', () => {
  let importResult: { imported: string[]; skipped: string[] };
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
    importResult = await store.importRoutes(DEPLOYMENT_ROUTES, 'migration:landing-zone');

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

  it('imports the deployment\'s non-model routes once, as approved and ledgered systems (GAP-068)', async () => {
    assert.deepEqual(importResult.imported, ['discord', 'github', 'linkedin', 'private-service']);
    assert.equal(importResult.skipped.length, 1);
    assert.match(importResult.skipped[0], /^broken: /);
    const res = await call(port, '/api/v1/systems', 'GET', VIEWER);
    assert.equal(res.status, 200);
    const systems = res.body.systems as Array<{ id: string; status: string }>;
    assert.deepEqual(systems.map((x) => x.id).sort(), ['discord', 'github', 'linkedin', 'private-service']);
    assert.ok(systems.every((x) => x.status === 'approved'));
    const rows = ledger.events.filter((e) => e.action === 'SYSTEM_IMPORTED');
    assert.equal(rows.length, 4);
    assert.ok(rows.every((e) => e.actor === 'migration:landing-zone'));
  });

  it('re-importing never overwrites a system the store already has (E10)', async () => {
    const store = state.systems!;
    const again = await store.importRoutes([{ id: 'discord', kind: 'http', upstream: 'https://evil.example.com' }], 'migration:landing-zone');
    assert.deepEqual(again.imported, []);
    assert.equal(store.get('discord')?.upstream, 'https://discord.com/api/v10');
  });

  it('a store opened without an import holds no systems: the platform code carries none (E10)', async () => {
    const empty = await SystemsStore.open(join(tmp, 'empty-systems'));
    assert.deepEqual(empty.list(), []);
  });

  it('serves active routes to gatekeeper-egress via /api/v1/gatekeeper-egress/routes', async () => {
    const res = await call(port, '/api/v1/gatekeeper-egress/routes', 'GET', EGRESS);
    assert.equal(res.status, 200);
    const routes = res.body.routes as Array<{ id: string; upstream?: string; credential?: any; hold?: any }>;
    assert.ok(routes.some((r) => r.id === 'discord' && r.upstream === 'https://discord.com/api/v10'));
    assert.ok(routes.some((r) => r.id === 'github' && r.credential?.secret === '{agent}_GITHUB_TOKEN'));
    assert.ok(routes.some((r) => r.id === 'linkedin' && r.hold?.methods?.includes('POST')));
    assert.ok(routes.some((r) => r.id === 'private-service'));
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

  it('TSK-067 OAuth providers come from the deployment once: new ones imported, imported-only systems gain oauth, admin-edited ones untouched', async () => {
    const store = state.systems!;
    assert.equal(store.getConnectionProvider('google'), undefined, 'no provider exists until a deployment defines one');
    const LI_OAUTH = { kind: 'oauth-user', authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', clientSecret: 'LINKEDIN_OAUTH_CLIENT', authParams: {}, refresh: false };
    // An admin edits github (a new approved version), so a later import may not change it.
    const edited = await call(port, '/api/v1/systems', 'POST', ADMIN, { id: 'github', name: 'GitHub', kind: 'http', upstream: 'https://api.github.com', credential: { secret: '{agent}_GITHUB_TOKEN', header: 'authorization', format: 'Bearer {}', fallback: false } });
    assert.equal(edited.status, 201);
    assert.equal((await call(port, '/api/v1/systems/github/approve', 'POST', ADMIN, {})).status, 200);
    const result = await store.importRoutes([
      { id: 'google', name: 'Google (OAuth)', kind: 'http', upstream: 'https://accounts.google.com', oauth: { kind: 'oauth-user', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', clientSecret: 'GOOGLE_OAUTH_CLIENT' } },
      { ...DEPLOYMENT_ROUTES.find((r) => r.id === 'linkedin')!, oauth: LI_OAUTH },
      { ...DEPLOYMENT_ROUTES.find((r) => r.id === 'github')!, oauth: LI_OAUTH },
    ], 'migration:landing-zone');
    assert.deepEqual(result.imported.sort(), ['google', 'linkedin']);
    assert.equal(store.getConnectionProvider('google')?.clientSecret, 'GOOGLE_OAUTH_CLIENT');
    const linkedin = store.getConnectionProvider('linkedin');
    assert.equal(linkedin?.kind, 'oauth-user');
    assert.equal(linkedin?.kind === 'oauth-user' && linkedin.refresh, false);
    assert.equal(store.history('linkedin').length, 2, 'the provider facts are a new, ledgered version');
    assert.equal(store.get('linkedin')?.hold?.methods.includes('POST'), true, 'the route settings are kept');
    assert.equal(store.get('github')?.oauth, undefined, 'a system an admin changed is never touched by an import');
    assert.equal(store.getConnectionProvider('discord'), undefined);
  });

  it('TSK-067 a provider defined without entry names gets Keymaster-named ones (K5.1)', async () => {
    const store = state.systems!;
    await store.importRoutes([
      { id: 'microsoft', name: 'Microsoft', kind: 'http', upstream: 'https://login.microsoftonline.com', oauth: { kind: 'oauth-user', authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' } },
      { id: 'acme-sa', name: 'Acme', kind: 'http', upstream: 'https://auth.acme.example', oauth: { kind: 'jwt-bearer', tokenUrl: 'https://auth.acme.example/token' } },
    ], 'migration:test');
    const ms = store.getConnectionProvider('microsoft');
    assert.equal(ms?.kind === 'oauth-user' && ms.clientSecret, 'shared/microsoft/oauth-client');
    const sa = store.getConnectionProvider('acme-sa');
    assert.equal(sa?.kind === 'jwt-bearer' && sa.keySecret, 'shared/acme-sa/service-account-key');
  });

});

