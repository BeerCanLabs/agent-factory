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
import { SystemsStore } from '@beercanlabs/factory-registrar';
import { seedBuiltinAiProviders } from './ai-providers.js';
import { relinkVendorModels } from './app.js';

const ADMIN = 'admin-model-token';
const VIEWER = 'viewer-model-token';
const EGRESS = 'egress-model-token';
const OWNER = 'owner-model-token';
const OTHER = 'other-model-token';

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
        ['donna', { id: 'donna', name: 'Donna', repo: 'https://github.com/beercanlabs/SM-donna', state: 'SLEEPING', category: 'agent', owners: ['token:alice'] } as any],
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
        { name: 'alice', token: OWNER, roles: ['viewer'] },
        { name: 'bob', token: OTHER, roles: ['viewer'] },
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

    // GAP-181: the policy change is recorded like any other policy change.
    const updated = state.ledger.query({ agent: 'donna' }).filter((e: any) => e.action === 'POLICY_UPDATED');
    assert.equal(updated.length, 1, 'retiring a model records POLICY_UPDATED for each affected agent');
    assert.equal(updated[0].actor, 'token:admin');
    assert.equal(state.ledger.query().filter((e: any) => e.action === 'MODEL_RETIRED' && e.model === 'grok-2').length, 1);
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

  it('7. PUT /api/v1/models/default and MCP set_default_model update default model with ledger audit', async () => {
    // Admit a model first
    const admitRes = await call(port, '/api/v1/models/admit', 'POST', ADMIN, {
      name: 'claude-sonnet-4-6',
      provider: 'bedrockConverse',
      id: 'us.anthropic.claude-sonnet-4-6',
    });
    assert.equal(admitRes.status, 201);

    // Viewer is rejected with 403
    const viewerRes = await call(port, '/api/v1/models/default', 'PUT', VIEWER, { model: 'claude-sonnet-4-6' });
    assert.equal(viewerRes.status, 403);

    // Missing model returns 400
    const missingRes = await call(port, '/api/v1/models/default', 'PUT', ADMIN, {});
    assert.equal(missingRes.status, 400);

    // Unadmitted model returns 400
    const unadmittedRes = await call(port, '/api/v1/models/default', 'PUT', ADMIN, { model: 'nonexistent-model' });
    assert.equal(unadmittedRes.status, 400);

    // Successfully sets default via REST
    const setRes = await call(port, '/api/v1/models/default', 'PUT', ADMIN, { model: 'claude-sonnet-4-6' });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.ok, true);
    assert.equal(setRes.body.default, 'claude-sonnet-4-6');

    // GET /api/v1/models returns new default
    const listRes = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.equal(listRes.body.default, 'claude-sonnet-4-6');

    // GET /api/v1/models/internal/catalog returns new default
    const internalRes = await call(port, '/api/v1/models/internal/catalog', 'GET', EGRESS);
    assert.equal(internalRes.body.default, 'claude-sonnet-4-6');

    // Ledger has MODEL_DEFAULT_UPDATED row
    const ledgerRows = state.ledger.query({ action: 'MODEL_DEFAULT_UPDATED' });
    assert.ok(ledgerRows.length >= 1);
    assert.equal(ledgerRows[ledgerRows.length - 1].model, 'claude-sonnet-4-6');

    // Now set back via MCP tool set_default_model
    const mcpSet = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'set_default_model',
        arguments: { model: 'claude-haiku-4-5' },
      },
    });
    assert.equal(mcpSet.status, 200);
    const mcpSetBody = JSON.parse(mcpSet.body.result.content[0].text);
    assert.equal(mcpSetBody.ok, true);
    assert.equal(mcpSetBody.default, 'claude-haiku-4-5');

    // MCP list_model_catalog reflects updated default
    const mcpList = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'list_model_catalog', arguments: {} },
    });
    const catalogParsed = JSON.parse(mcpList.body.result.content[0].text);
    assert.equal(catalogParsed.default, 'claude-haiku-4-5');
  });

  it('9. MCP retire_vendor_or_model records the policy change like REST (GAP-181)', async () => {
    state.modelStore.admit({ name: 'mcp-retire-me', provider: 'openai', id: 'mcp-retire-me' });
    state.policies.set('finley', { routes: [], models: ['mcp-retire-me', 'other-model'] });
    const res = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'retire_vendor_or_model', arguments: { name: 'mcp-retire-me' } },
    });
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body.result.content[0].text);
    assert.deepEqual(out.affectedAgents, ['finley']);
    assert.deepEqual(state.policies.get('finley').models, ['other-model']);
    const updated = state.ledger.query({ agent: 'finley' }).filter((e: any) => e.action === 'POLICY_UPDATED');
    assert.equal(updated.length, 1);
  });
});

describe('admitted models take provider, endpoint and credential from their vendor (GAP-182)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let tmp: string;
  let state: FactoryState;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vendor-admit-'));
    const ledger = new MemoryLedger();
    const systems = await SystemsStore.open(join(tmp, 'systems'), ledger);
    await seedBuiltinAiProviders(systems);
    await systems.propose({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'ai-provider',
      upstream: 'https://api.deepseek.example',
      aiProvider: { adapter: 'openAiCompatible', discoveryPath: '/v1/models' },
      credential: { secret: 'DEEPSEEK_API_KEY', header: 'Authorization', format: 'Bearer {}' },
    } as never, 'test');
    await systems.approve('deepseek', undefined, 'test');
    const modelStore = new ModelStore(join(tmp, 'catalog.json'));
    state = {
      agents: new Map(),
      modelStore,
      modelCatalog: modelStore.toEgressCatalog(),
      systems,
      registryDir: tmp,
      ledger,
      policies: new PolicyStore(join(tmp, 'policies')),
      approvals: new ApprovalStore(join(tmp, 'approvals')),
      identityLinks: new IdentityLinkStore(join(tmp, 'identity')),
      runs: new MemoryRunStore(),
      runtime: noopRuntime(),
      runTokens: {} as any,
      callbacks: {} as any,
      providers: [],
      spend: SpendTracker.fromLedger([], () => true),
      version: '0.1.0',
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a custom vendor model gets the vendor adapter, upstream and credential, whatever the caller sends', async () => {
    const res = await call(port, '/api/v1/models/admit', 'POST', ADMIN, {
      name: 'deepseek-chat', id: 'deepseek-chat', vendorId: 'deepseek', provider: 'openAiCompatible', endpoint: 'https://collector.example',
      price: { inputPerMTok: 1, outputPerMTok: 2 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(state.modelStore!.toEgressCatalog()['deepseek-chat'], {
      provider: 'openai', id: 'deepseek-chat', endpoint: 'https://api.deepseek.example', secret: 'DEEPSEEK_API_KEY', price: { inputPerMTok: 1, outputPerMTok: 2 },
    });
  });

  it('a built-in vendor model keeps the adapter default endpoint and carries the vendor credential', async () => {
    const res = await call(port, '/api/v1/models/admit', 'POST', ADMIN, { name: 'gemini-x', id: 'gemini-x', vendorId: 'gemini' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(state.modelStore!.toEgressCatalog()['gemini-x'], { provider: 'google', id: 'gemini-x', secret: 'GEMINI_API_KEY' });
  });

  it('an API-key provider without a vendor implies the built-in vendor; a custom endpoint without one is refused', async () => {
    const implied = await call(port, '/api/v1/models/admit', 'POST', ADMIN, { name: 'claude-x', id: 'claude-x', provider: 'anthropic' });
    assert.equal(implied.status, 201);
    assert.equal(state.modelStore!.toEgressCatalog()['claude-x'].secret, 'ANTHROPIC_API_KEY');
    const refused = await call(port, '/api/v1/models/admit', 'POST', ADMIN, { name: 'x', id: 'x', provider: 'openai', endpoint: 'https://collector.example' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'vendor_required');
  });

  it('a cloud model service keeps the caller provider and region (no key)', async () => {
    const res = await call(port, '/api/v1/models/admit', 'POST', ADMIN, { name: 'claude-bedrock', id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', provider: 'bedrock-converse', region: 'us-east-1' });
    assert.equal(res.status, 201);
    assert.deepEqual(state.modelStore!.toEgressCatalog()['claude-bedrock'], { provider: 'bedrock-converse', id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', region: 'us-east-1' });
  });

  it('the MCP admit tool takes the same path', async () => {
    const res = await call(port, '/mcp', 'POST', ADMIN, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'admit_model', arguments: { name: 'deepseek-coder', id: 'deepseek-coder', vendorId: 'deepseek' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.modelStore!.toEgressCatalog()['deepseek-coder'], { provider: 'openai', id: 'deepseek-coder', endpoint: 'https://api.deepseek.example', secret: 'DEEPSEEK_API_KEY' });
  });

  it('existing admissions are re-linked to their vendor (Quick Admit wrote an adapter type no adapter serves)', () => {
    state.modelStore!.admit({ name: 'grok-old', provider: 'openAiCompatible', id: 'grok-old', vendorId: 'xai' });
    assert.ok(relinkVendorModels(state).includes('grok-old'));
    assert.deepEqual(state.modelStore!.toEgressCatalog()['grok-old'], { provider: 'xai', id: 'grok-old', secret: 'XAI_API_KEY' });
    assert.equal(relinkVendorModels(state).includes('grok-old'), false, 'idempotent');
  });

  it('the routes payload binds each platform credential to its system hosts', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/gatekeeper-egress/routes`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const body = (await r.json()) as { platformCredentialHosts?: Record<string, string[]> };
    assert.deepEqual(body.platformCredentialHosts?.DEEPSEEK_API_KEY, ['api.deepseek.example']);
    assert.deepEqual(body.platformCredentialHosts?.OPENAI_API_KEY, ['api.openai.com']);
  });

  it('a cloud model service keeps its provider even with a vendor label, and relinking is ledgered once (review #197)', () => {
    state.modelStore!.admit({ name: 'claude-on-bedrock', provider: 'bedrock-converse', id: 'us.anthropic.claude-sonnet-4-6', region: 'us-east-1', vendorId: 'anthropic' });
    state.modelStore!.admit({ name: 'xai-old', provider: 'openAiCompatible', id: 'xai-old', vendorId: 'xai' });
    const before = state.ledger.query().filter((e: any) => e.action === 'MODEL_RELINKED').length;
    const changed = relinkVendorModels(state);
    assert.ok(changed.includes('xai-old'));
    assert.equal(changed.includes('claude-on-bedrock'), false);
    assert.deepEqual(state.modelStore!.toEgressCatalog()['claude-on-bedrock'], { provider: 'bedrock-converse', id: 'us.anthropic.claude-sonnet-4-6', region: 'us-east-1' });
    const rows = state.ledger.query().filter((e: any) => e.action === 'MODEL_RELINKED');
    assert.equal(rows.length, before + 1);
    assert.ok((rows.at(-1) as any).models.includes('xai-old'));
  });
});

describe('Model Selection & Persistent Failback E2E (TSK-165, TSK-166, GAP-126)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let tmp: string;
  let state: FactoryState;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'model-selection-e2e-'));
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

    for (const name of ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f', 'model-g']) {
      modelStore.admit({ name, provider: 'openai', id: name, vendorId: 'openai' });
    }

    state = {
      agents: new Map([
        ['donna', { id: 'donna', name: 'Donna', repo: 'https://github.com/beercanlabs/SM-donna', state: 'SLEEPING', category: 'agent', owners: ['token:alice'] } as any],
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
        { name: 'alice', token: OWNER, roles: ['viewer'] },
        { name: 'bob', token: OTHER, roles: ['viewer'] },
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

  it('GET /api/v1/agents/:id/models allows viewer, owner, and admin; returns effective slots', async () => {
    const viewerRes = await call(port, '/api/v1/agents/donna/models', 'GET', VIEWER);
    assert.equal(viewerRes.status, 200);
    assert.equal(viewerRes.body.agentId, 'donna');
    assert.deepEqual(viewerRes.body.approvedModels, ['claude-haiku-4-5']);
    assert.equal(viewerRes.body.currentModel, 'claude-haiku-4-5');
    assert.equal(viewerRes.body.primaryModel, 'claude-haiku-4-5');

    const ownerRes = await call(port, '/api/v1/agents/donna/models', 'GET', OWNER);
    assert.equal(ownerRes.status, 200);

    const adminRes = await call(port, '/api/v1/agents/donna/models', 'GET', ADMIN);
    assert.equal(adminRes.status, 200);

    const notFound = await call(port, '/api/v1/agents/unknown-agent/models', 'GET', VIEWER);
    assert.equal(notFound.status, 404);
  });

  it('PUT /api/v1/agents/:id/models enforces authorization (admin and owner pass; viewer and non-owner fail)', async () => {
    const viewerRes = await call(port, '/api/v1/agents/donna/models', 'PUT', VIEWER, {
      approvedModels: ['claude-haiku-4-5'],
    });
    assert.equal(viewerRes.status, 403);

    const otherRes = await call(port, '/api/v1/agents/donna/models', 'PUT', OTHER, {
      approvedModels: ['claude-haiku-4-5'],
    });
    assert.equal(otherRes.status, 403);

    const anonRes = await call(port, '/api/v1/agents/donna/models', 'PUT', undefined, {
      approvedModels: ['claude-haiku-4-5'],
    });
    assert.equal(anonRes.status, 401);

    // Owner passes
    const ownerRes = await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-a', 'model-b', 'model-c'],
      primaryModel: 'model-a',
      secondaryModel: 'model-b',
      currentModel: 'model-a',
    });
    assert.equal(ownerRes.status, 200, JSON.stringify(ownerRes.body));
    assert.deepEqual(ownerRes.body.approvedModels, ['model-a', 'model-b', 'model-c']);
    assert.equal(ownerRes.body.primaryModel, 'model-a');
    assert.equal(ownerRes.body.secondaryModel, 'model-b');
    assert.equal(ownerRes.body.currentModel, 'model-a');

    // Admin also passes
    const adminRes = await call(port, '/api/v1/agents/donna/models', 'PUT', ADMIN, {
      currentModel: 'model-b',
    });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.body.currentModel, 'model-b');
  });

  it('MCP tools get_agent_models and set_agent_models enforce permissions and work end-to-end', async () => {
    const getRes = await call(port, '/mcp', 'POST', VIEWER, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_agent_models', arguments: { id: 'donna' } },
    });
    assert.equal(getRes.status, 200);
    const getParsed = JSON.parse(getRes.body.result.content[0].text);
    assert.equal(getParsed.agentId, 'donna');
    assert.equal(getParsed.currentModel, 'model-b');

    // Viewer cannot call set_agent_models
    const setViewer = await call(port, '/mcp', 'POST', VIEWER, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'set_agent_models', arguments: { id: 'donna', currentModel: 'model-a' } },
    });
    assert.ok(setViewer.body.error);
    assert.equal(setViewer.body.error.code, -32001);

    // Non-owner cannot call set_agent_models on donna
    const setOther = await call(port, '/mcp', 'POST', OTHER, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'set_agent_models', arguments: { id: 'donna', currentModel: 'model-a' } },
    });
    assert.ok(setOther.body.error);

    // Owner can call set_agent_models on donna
    const setOwner = await call(port, '/mcp', 'POST', OWNER, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'set_agent_models', arguments: { id: 'donna', currentModel: 'model-a' } },
    });
    assert.equal(setOwner.status, 200, JSON.stringify(setOwner.body));
    const ownerParsed = JSON.parse(setOwner.body.result.content[0].text);
    assert.equal(ownerParsed.currentModel, 'model-a');
  });

  it('Adding new approved models leaves slots untouched', async () => {
    // Currently: approved ['model-a', 'model-b', 'model-c'], current: 'model-a', primary: 'model-a', secondary: 'model-b'
    const res = await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-a', 'model-b', 'model-c', 'model-d'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.approvedModels, ['model-a', 'model-b', 'model-c', 'model-d']);
    assert.equal(res.body.currentModel, 'model-a');
    assert.equal(res.body.primaryModel, 'model-a');
    assert.equal(res.body.secondaryModel, 'model-b');
  });

  it('DELETE /api/v1/models/:name performs deterministic model retirement transitions', async () => {
    // Transition 1: current !== primary, retire current -> current becomes primary
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-a', 'model-b', 'model-c'],
      primaryModel: 'model-a',
      currentModel: 'model-b',
      secondaryModel: 'model-c',
    });
    let del = await call(port, '/api/v1/models/model-b', 'DELETE', ADMIN);
    assert.equal(del.status, 200);
    let pol = state.policies.get('donna');
    assert.equal(pol.currentModel, 'model-a');
    assert.equal(pol.primaryModel, 'model-a');
    assert.equal(pol.secondaryModel, 'model-c');

    // Transition 2: primary !== current, retire primary -> primary becomes current (clearing secondary if secondary === current)
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-a', 'model-c', 'model-d'],
      currentModel: 'model-a',
      primaryModel: 'model-c',
      secondaryModel: 'model-a',
    });
    del = await call(port, '/api/v1/models/model-c', 'DELETE', ADMIN);
    assert.equal(del.status, 200);
    pol = state.policies.get('donna');
    assert.equal(pol.primaryModel, 'model-a');
    assert.equal(pol.currentModel, 'model-a');
    assert.equal(pol.secondaryModel, undefined);

    // Transition 3: current === primary, retire it with secondary defined -> promotes secondary to current & primary, leaves secondary unset
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-a', 'model-d', 'model-e'],
      currentModel: 'model-a',
      primaryModel: 'model-a',
      secondaryModel: 'model-d',
    });
    del = await call(port, '/api/v1/models/model-a', 'DELETE', ADMIN);
    assert.equal(del.status, 200);
    pol = state.policies.get('donna');
    assert.equal(pol.currentModel, 'model-d');
    assert.equal(pol.primaryModel, 'model-d');
    assert.equal(pol.secondaryModel, undefined);

    // Transition 4: current === primary, retire it with secondary unset -> both become null (post-retirement unset state)
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-d', 'model-e'],
      currentModel: 'model-d',
      primaryModel: 'model-d',
      secondaryModel: null,
    });
    del = await call(port, '/api/v1/models/model-d', 'DELETE', ADMIN);
    assert.equal(del.status, 200);
    pol = state.policies.get('donna');
    assert.equal(pol.currentModel, null);
    assert.equal(pol.primaryModel, null);
    assert.equal(pol.secondaryModel, undefined);

    // Transition 5: retire secondary -> secondary becomes unset
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-e', 'model-f'],
      currentModel: 'model-e',
      primaryModel: 'model-e',
      secondaryModel: 'model-f',
    });
    del = await call(port, '/api/v1/models/model-f', 'DELETE', ADMIN);
    assert.equal(del.status, 200);
    pol = state.policies.get('donna');
    assert.equal(pol.currentModel, 'model-e');
    assert.equal(pol.primaryModel, 'model-e');
    assert.equal(pol.secondaryModel, undefined);
  });

  it('POST /api/v1/gatekeeper-egress/runs/:id/failover persistently updates currentModel and ledgers MODEL_FAILOVER', async () => {
    // Setup donna policy
    await call(port, '/api/v1/agents/donna/models', 'PUT', OWNER, {
      approvedModels: ['model-e', 'model-g'],
      currentModel: 'model-e',
      primaryModel: 'model-e',
    });

    const run = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'test', trigger: 'conversation' });

    // Non-egress caller fails
    const viewerFail = await call(port, `/api/v1/gatekeeper-egress/runs/${run.runId}/failover`, 'POST', VIEWER, {
      toModel: 'model-g',
      fromModel: 'model-e',
    });
    assert.equal(viewerFail.status, 403);

    // Gatekeeper-egress succeeds
    const egressSuccess = await call(port, `/api/v1/gatekeeper-egress/runs/${run.runId}/failover`, 'POST', EGRESS, {
      toModel: 'model-g',
      fromModel: 'model-e',
      reason: 'upstream 503 error',
    });
    assert.equal(egressSuccess.status, 200, JSON.stringify(egressSuccess.body));
    assert.equal(egressSuccess.body.ok, true);
    assert.equal(egressSuccess.body.agentId, 'donna');
    assert.equal(egressSuccess.body.fromModel, 'model-e');
    assert.equal(egressSuccess.body.toModel, 'model-g');
    assert.equal(egressSuccess.body.currentModel, 'model-g');

    // Verify persistent update in state.policies
    const pol = state.policies.get('donna');
    assert.equal(pol.currentModel, 'model-g');
    assert.equal(pol.primaryModel, 'model-e');

    // Verify ledger entries
    const failoverEntries = state.ledger.query({ agent: 'donna' }).filter((e: any) => e.action === 'MODEL_FAILOVER');
    assert.ok(failoverEntries.length >= 1);
    const lastFailover = failoverEntries.at(-1) as any;
    assert.equal(lastFailover.requestedModel, 'model-e');
    assert.equal(lastFailover.model, 'model-g');
    assert.deepEqual(lastFailover.models, ['model-e', 'model-g']);
  });
});
