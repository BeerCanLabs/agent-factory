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
import { ModelsStore } from './models.js';

const ADMIN = 'admin-models-token';
const VIEWER = 'viewer-models-token';
const EGRESS = 'egress-models-token';

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

describe('models as factory data (M3)', () => {
  let tmp: string;
  let server: http.Server;
  let port: number;
  let ledger: MemoryLedger;
  let state: FactoryState;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'models-test-'));
    ledger = new MemoryLedger();
    const modelsDir = join(tmp, 'models');
    const store = await ModelsStore.open(modelsDir, ledger);

    state = {
      agents: new Map(),
      registryDir: join(tmp, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress', 'run'] },
      ]),
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('models-secret-token-key-1234567890'),
      version: '0.1.0-test',
      providers: [],
      callbacks: { allowedUrls: () => true },
      policies: new PolicyStore(join(tmp, 'policies')),
      approvals: new ApprovalStore(join(tmp, 'approvals')),
      spend: SpendTracker.fromLedger(ledger.query(), () => true),
      models: store,
    };

    server = createFactoryServer(state);
    port = await listen(server);
  });

  after(() => {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('seeds baseline models automatically and exposes them via GET /api/v1/models', async () => {
    const res = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.equal(res.status, 200);
    assert.equal(res.body.default, 'claude-haiku-4-5');
    const names = res.body.models.map((m: { name: string }) => m.name);
    assert.ok(names.includes('claude-sonnet-4-5'));
    assert.ok(names.includes('claude-haiku-4-5'));

    // Verify viewer format: provider model ids and regions are NOT leaked to viewer
    const sonnet = res.body.models.find((m: { name: string }) => m.name === 'claude-sonnet-4-5');
    assert.equal(sonnet.provider, 'bedrock-converse');
    assert.equal(sonnet.id, undefined);
    assert.deepEqual(sonnet.price, { inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('serves dynamic catalog to gatekeeper-egress via GET /api/v1/gatekeeper-egress/models', async () => {
    const res = await call(port, '/api/v1/gatekeeper-egress/models', 'GET', EGRESS);
    assert.equal(res.status, 200);
    assert.equal(res.body.default, 'claude-haiku-4-5');
    assert.ok(res.body.catalog['claude-sonnet-4-5']);
    assert.equal(res.body.catalog['claude-sonnet-4-5'].id, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(res.body.catalog['claude-sonnet-4-5'].region, 'us-east-1');
  });

  it('allows admin to propose, approve, and update model offerings', async () => {
    // 1. Propose new model
    const proposal = {
      name: 'gpt-4o',
      provider: 'openai',
      id: 'gpt-4o-2024-08-06',
      price: {
        inputPerMTok: 2.5,
        outputPerMTok: 10,
      },
      description: 'OpenAI GPT-4o flagship model',
      isDefault: false,
    };

    const proposeRes = await call(port, '/api/v1/models/propose', 'POST', ADMIN, proposal);
    assert.equal(proposeRes.status, 201);
    assert.equal(proposeRes.body.status, 'proposed');
    assert.equal(proposeRes.body.version, 1);

    // Proposed model is not yet in offered models list
    const viewerRes1 = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.ok(!viewerRes1.body.models.some((m: { name: string }) => m.name === 'gpt-4o'));

    // 2. Approve the model
    const approveRes = await call(port, '/api/v1/models/gpt-4o/approve', 'POST', ADMIN, { version: 1 });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, 'approved');

    // Now it appears in offered models and in gatekeeper-egress catalog
    const viewerRes2 = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.ok(viewerRes2.body.models.some((m: { name: string }) => m.name === 'gpt-4o'));

    const egressRes = await call(port, '/api/v1/gatekeeper-egress/models', 'GET', EGRESS);
    assert.ok(egressRes.body.catalog['gpt-4o']);
    assert.equal(egressRes.body.catalog['gpt-4o'].id, 'gpt-4o-2024-08-06');
    assert.equal(egressRes.body.catalog['gpt-4o'].provider, 'openai');
  });

  it('rejects invalid proposals and unauthenticated calls', async () => {
    // Unauthenticated propose
    const unauth = await call(port, '/api/v1/models/propose', 'POST', undefined, { name: 'bad' });
    assert.equal(unauth.status, 401);

    // Viewer proposing (forbidden)
    const viewerPropose = await call(port, '/api/v1/models/propose', 'POST', VIEWER, {
      name: 'bad-model',
      provider: 'openai',
      id: 'bad',
      price: { inputPerMTok: 1, outputPerMTok: 1 },
    });
    assert.equal(viewerPropose.status, 403);

    // Admin proposing invalid body
    const badBody = await call(port, '/api/v1/models/propose', 'POST', ADMIN, {
      name: 'INVALID NAME!',
      provider: 'openai',
      id: 'bad',
      price: { inputPerMTok: -5, outputPerMTok: 1 },
    });
    assert.equal(badBody.status, 400);
  });

  it('persists model offerings and recovers them on reload (R1)', async () => {
    const modelsDir = join(tmp, 'models');
    const store2 = await ModelsStore.open(modelsDir, ledger);
    const catalog = store2.getApprovedCatalog();
    assert.ok(catalog['claude-sonnet-4-5']);
    assert.ok(catalog['claude-haiku-4-5']);
    assert.ok(catalog['gpt-4o']);
  });
});
