import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { ModelStore } from './models.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';

const ADMIN = 'admin-model-token';
const VIEWER = 'viewer-model-token';
const EGRESS = 'egress-model-token';

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
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: Object.fromEntries(res.headers.entries()) };
}

describe('Model Lifecycle & Dynamic Catalog E2E', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let tmp: string;
  let state: FactoryState;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'model-e2e-'));
    const catalogPath = join(tmp, 'catalog.json');
    const policiesDir = join(tmp, 'policies');
    const approvalsDir = join(tmp, 'approvals');
    const identityDir = join(tmp, 'identity');

    const modelStore = new ModelStore(catalogPath, {
      'claude-haiku-4-5': {
        provider: 'bedrockConverse',
        id: 'us.anthropic.claude-haiku-4-5',
        price: { inputPerMTok: 0.8, outputPerMTok: 4.0 },
      },
    });

    state = {
      agents: new Map([
        ['donna', { id: 'donna', name: 'Donna', repo: 'https://github.com/beercanlabs/SM-donna', state: 'SLEEPING', category: 'agent' } as any],
      ]),
      modelStore,
      modelCatalog: modelStore.toEgressCatalog(),
      defaultModel: 'claude-haiku-4-5',
      registryDir: tmp,
      ledger: new MemoryLedger(),
      policies: new PolicyStore(policiesDir),
      approvals: new ApprovalStore(approvalsDir),
      identityLinks: new IdentityLinkStore(identityDir),
      runs: new MemoryRunStore(),
      runtime: noopRuntime(),
      runTokens: {} as any,
      callbacks: {} as any,
      providers: [],
      spend: SpendTracker.fromLedger([], () => true),
      version: '0.1.0',
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'egress', token: EGRESS, roles: ['gatekeeper-egress'] },
      ]),
    };

    state.policies.set('donna', { routes: [], models: ['claude-haiku-4-5'] });

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('1. GET /api/v1/models lists offered models and templates', async () => {
    const list = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.equal(list.status, 200);
    assert.equal(list.body.models.length, 1);
    assert.equal(list.body.models[0].name, 'claude-haiku-4-5');
    assert.ok(list.body.templates.openai);
  });

  it('2. POST /api/v1/models/scan validates vendor and asks the egress, never a local secret', async () => {
    const badScan = await call(port, '/api/v1/models/scan', 'POST', ADMIN, { vendorId: 'nonexistent-xyz' });
    assert.equal(badScan.status, 400);

    const unconfigured = await call(port, '/api/v1/models/scan', 'POST', ADMIN, { vendorId: 'anthropic' });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.error, 'discovery_unavailable');

    let askedSecret: string | undefined;
    const egress = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { secretName?: string };
        askedSecret = body.secretName;
        assert.equal(req.headers.authorization, 'Bearer egress-discovery-token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }] }));
      });
    });
    await new Promise<void>((r) => egress.listen(0, '127.0.0.1', r));
    const addr = egress.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    state.gatekeeperEgressUrl = `http://127.0.0.1:${addr.port}`;
    state.gatekeeperEgressToken = 'egress-discovery-token';
    let reads = 0;
    state.providers = [{ name: 'mem', async get() { reads += 1; return 'should-not-be-read'; }, async put() {}, async has() { return false; }, async present() { return new Set(); } }];

    const scan = await call(port, '/api/v1/models/scan', 'POST', ADMIN, { vendorId: 'anthropic' });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.staged[0].rawId, 'claude-sonnet-4-5');
    assert.equal(askedSecret, 'ANTHROPIC_API_KEY');
    assert.equal(reads, 0);
    state.gatekeeperEgressUrl = undefined;
    state.gatekeeperEgressToken = undefined;
    state.providers = [];
    await new Promise<void>((r) => egress.close(() => r()));
  });

  it('3. POST /api/v1/models/admit admits a new model and ledgers it', async () => {
    const admit = await call(port, '/api/v1/models/admit', 'POST', ADMIN, {
      name: 'grok-2',
      provider: 'xai',
      id: 'grok-2-1212',
      vendorId: 'xai',
      price: { inputPerMTok: 2.0, outputPerMTok: 10.0 },
    });
    assert.equal(admit.status, 201);
    assert.equal(admit.body.model.name, 'grok-2');

    const admitLedger = state.ledger.query().filter((e: any) => e.action === 'MODEL_ADMITTED');
    assert.equal(admitLedger.length, 1);
    assert.equal((admitLedger[0] as any).model, 'grok-2');
  });

  it('4. GET /api/v1/models/internal/catalog syncs catalog with ETag and egress role', async () => {
    // Viewer should be 403 (does not hold egress.models.read)
    const viewerDenied = await call(port, '/api/v1/models/internal/catalog', 'GET', VIEWER);
    assert.equal(viewerDenied.status, 403);

    // Egress principal succeeds
    const internalCatalog = await call(port, '/api/v1/models/internal/catalog', 'GET', EGRESS);
    assert.equal(internalCatalog.status, 200);
    assert.ok(internalCatalog.headers.etag);
    assert.ok(internalCatalog.body.models['grok-2']);
    assert.ok(internalCatalog.body.models['claude-haiku-4-5']);
  });

  it('5. PUT /api/v1/models/:name/pricing updates token prices', async () => {
    const priceUpdate = await call(port, '/api/v1/models/grok-2/pricing', 'PUT', ADMIN, {
      price: { inputPerMTok: 1.5, outputPerMTok: 7.5 },
    });
    assert.equal(priceUpdate.status, 200);
    assert.deepEqual(priceUpdate.body.model.price, { inputPerMTok: 1.5, outputPerMTok: 7.5 });
  });

  it('6. DELETE /api/v1/models/:name retires model and cleans agent policies with M2 fallback', async () => {
    // Only grok-2 assigned
    state.policies.set('donna', { routes: [], models: ['grok-2'] });

    // Nonexistent 404 does not touch policy
    const notFound = await call(port, '/api/v1/models/nonexistent', 'DELETE', ADMIN);
    assert.equal(notFound.status, 404);
    assert.deepEqual(state.policies.get('donna').models, ['grok-2']);

    const retire = await call(port, '/api/v1/models/grok-2', 'DELETE', ADMIN);
    assert.equal(retire.status, 200);
    assert.equal(retire.body.retired, 'grok-2');
    assert.deepEqual(retire.body.affectedAgents, ['donna']);

    // When policy models array becomes empty, models key must be deleted for M2 default fallback!
    const donnaPolicy = state.policies.get('donna');
    assert.equal(donnaPolicy.models, undefined);
  });

  it('7. MCP tools manage model catalog lifecycle', async () => {
    const mcpList = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_model_catalog', arguments: {} },
    });
    assert.equal(mcpList.status, 200);
    const parsed = JSON.parse(mcpList.body.result.content[0].text);
    assert.equal(parsed.offered.length, 1);

    const mcpAdmit = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'admit_model',
        arguments: {
          name: 'gpt-4o',
          provider: 'openAiCompatible',
          id: 'gpt-4o-2024-08-06',
          inputPerMTok: '2.5',
          outputPerMTok: '10.0',
        },
      },
    });
    assert.equal(mcpAdmit.status, 200);
    const admitted = JSON.parse(mcpAdmit.body.result.content[0].text);
    assert.equal(admitted.model.name, 'gpt-4o');

    const mcpPrice = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'update_model_pricing',
        arguments: {
          name: 'gpt-4o',
          inputPerMTok: '2.0',
          outputPerMTok: '8.0',
        },
      },
    });
    assert.equal(mcpPrice.status, 200);
    const repriced = JSON.parse(mcpPrice.body.result.content[0].text);
    assert.deepEqual(repriced.model.price, { inputPerMTok: 2.0, outputPerMTok: 8.0 });

    const mcpRetire = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'retire_vendor_or_model',
        arguments: { name: 'gpt-4o' },
      },
    });
    assert.equal(mcpRetire.status, 200);
    const retired = JSON.parse(mcpRetire.body.result.content[0].text);
    assert.equal(retired.retired, 'gpt-4o');
  });
});
