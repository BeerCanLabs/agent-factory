import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { ModelStore } from './models.js';
import { MemoryRunStore, noopRuntime, type Run } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';

const KEY = 'agent-models-run-token-key-0123456789';
const ADMIN = 'admin-token';
const OPERATOR = 'operator-token';
const INGRESS = 'ingress-token';

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

describe('Agent Run-Token Model Management E2E (TSK-287, GAP-210, M2, E7)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let tmp: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  const tokens = new RunTokens(KEY);

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-models-e2e-'));
    ledger = new MemoryLedger();
    const catalogPath = join(tmp, 'catalog.json');
    const modelStore = new ModelStore(catalogPath, {
      'claude-haiku': { provider: 'bedrockConverse', id: 'haiku-id', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      'claude-sonnet': { provider: 'bedrockConverse', id: 'sonnet-id', price: { inputPerMTok: 3, outputPerMTok: 15 } },
      'claude-opus': { provider: 'bedrockConverse', id: 'opus-id', price: { inputPerMTok: 15, outputPerMTok: 75 } },
    });

    state = {
      agents: new Map(),
      modelStore,
      defaultModel: 'claude-haiku',
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'ingress', token: INGRESS, roles: ['operator', 'gatekeeper-ingress'] },
      ]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(tmp, 'identity')),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(tmp, 'configs')));

    // Agent alpha: owned by alice
    state.agents.set('alpha', {
      id: 'alpha',
      name: 'Alpha',
      state: 'ACTIVE',
      roles: [{ name: 'Owner', description: 'Owner', grants: ['*'] }],
    } as any);
    await state.configs.put({
      agentId: 'alpha',
      owners: ['cloudflare:alice@example.com'],
    }, { actor: 'cloudflare:alice@example.com', reason: 'initial' });

    // Agent beta: owned by bob
    state.agents.set('beta', {
      id: 'beta',
      name: 'Beta',
      state: 'ACTIVE',
      roles: [],
    } as any);
    await state.configs.put({
      agentId: 'beta',
      owners: ['cloudflare:bob@example.com'],
    }, { actor: 'cloudflare:bob@example.com', reason: 'initial' });

    // Policy for alpha
    state.policies.set('alpha', {
      models: ['claude-haiku', 'claude-sonnet', 'claude-opus'],
      primaryModel: 'claude-haiku',
      currentModel: 'claude-haiku',
      secondaryModel: 'claude-sonnet',
    });

    // Policy for beta
    state.policies.set('beta', {
      models: ['claude-haiku', 'claude-sonnet'],
      primaryModel: 'claude-haiku',
      currentModel: 'claude-haiku',
    });

    // Link discord user 101 to alice (owner)
    state.identityLinks.link('discord', '101', 'cloudflare:alice@example.com', 'admin');
    // Link discord user 202 to eve (operator, but non-owner guest)
    state.identityLinks.link('discord', '202', 'cloudflare:eve@example.com', 'admin', { roles: ['operator'] });

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /api/v1/runs/:id/models reads effective model slots and canManageModels', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    const res = await call(port, `/api/v1/runs/${run.runId}/models`, 'GET', token);
    assert.equal(res.status, 200);
    assert.equal(res.body.agentId, 'alpha');
    assert.deepEqual(res.body.approvedModels, ['claude-haiku', 'claude-sonnet', 'claude-opus']);
    assert.equal(res.body.currentModel, 'claude-haiku');
    assert.equal(res.body.primaryModel, 'claude-haiku');
    assert.equal(res.body.secondaryModel, 'claude-sonnet');
    assert.equal(res.body.canManageModels, true);
  });

  it('PUT /api/v1/runs/:id/models switches model slots for verified owner and ledgers changes', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    const res = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      currentModel: 'claude-sonnet',
      primaryModel: 'claude-sonnet',
      secondaryModel: 'claude-opus',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.currentModel, 'claude-sonnet');
    assert.equal(res.body.primaryModel, 'claude-sonnet');
    assert.equal(res.body.secondaryModel, 'claude-opus');

    // Policy verified
    const pol = state.policies.get('alpha');
    assert.equal(pol?.currentModel, 'claude-sonnet');
    assert.equal(pol?.primaryModel, 'claude-sonnet');
    assert.equal(pol?.secondaryModel, 'claude-opus');

    // Run model pin updated
    const updatedRun = state.runs.get(run.runId);
    assert.equal(updatedRun?.model, 'claude-sonnet');

    // Ledger verified
    const events = ledger.query({ agent: 'alpha' });
    const switchEv = events.find((e) => e.action === 'MODEL_SWITCHED' && e.runId === run.runId);
    assert.ok(switchEv);
    assert.equal(switchEv.model, 'claude-sonnet');
    assert.equal(switchEv.requestedModel, 'claude-haiku');
    assert.equal(switchEv.actor, 'cloudflare:alice@example.com');

    const updateEv = events.find((e) => e.action === 'POLICY_UPDATED' && e.runId === run.runId);
    assert.ok(updateEv);
  });

  it('PUT /api/v1/runs/:id/models works for identity linked owner', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'discord:101',
      requestedBy: { provider: 'discord', id: '101' },
      trigger: 'conversation',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    const res = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      currentModel: 'claude-opus',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.currentModel, 'claude-opus');
    assert.equal(state.policies.get('alpha')?.currentModel, 'claude-opus');
  });

  it('enforces prompt-injection ceiling: rejects approvedModels mutation with 403', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    const res = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      approvedModels: ['claude-haiku', 'claude-sonnet', 'claude-opus', 'rogue-model'],
      currentModel: 'claude-haiku',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'approved_models_ceiling');
  });

  it('rejects selection outside approvedModels with 400 invalid_model_selection', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    const res = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      currentModel: 'gpt-4o-unapproved',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_model_selection');
  });

  it('rejects non-owner operator or guest with 403 and ledgers MODEL_SWITCH_DENIED', async () => {
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'discord:202',
      requestedBy: { provider: 'discord', id: '202' },
      trigger: 'conversation',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    // GET reports canManageModels: false
    const getRes = await call(port, `/api/v1/runs/${run.runId}/models`, 'GET', token);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.canManageModels, false);

    // PUT is refused
    const putRes = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      currentModel: 'claude-haiku',
    });
    assert.equal(putRes.status, 403);
    assert.equal(putRes.body.error, 'requester_unauthorized_for_model_switch');

    const denied = ledger.query({ agent: 'alpha' }).find((e) => e.action === 'MODEL_SWITCH_DENIED' && e.runId === run.runId);
    assert.ok(denied);
    assert.equal(denied.action, 'MODEL_SWITCH_DENIED');
  });

  it('enforces cross-agent isolation: run token for alpha cannot read or modify beta', async () => {
    const runB = state.runs.create({
      agentId: 'beta',
      state: 'WORKING',
      actor: 'cloudflare:bob@example.com',
      trigger: 'manual',
    });
    const runA = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const tokenAlpha = await tokens.mint({ runId: runA.runId, agentId: 'alpha' });

    const getRes = await call(port, `/api/v1/runs/${runB.runId}/models`, 'GET', tokenAlpha);
    assert.equal(getRes.status, 401);

    const putRes = await call(port, `/api/v1/runs/${runB.runId}/models`, 'PUT', tokenAlpha, { currentModel: 'claude-sonnet' });
    assert.equal(putRes.status, 401);
  });

  it('warm-run taint protection: non-manager turn taints warm run against model management', async () => {
    for (const r of state.runs.list({ agentId: 'alpha', active: true })) {
      state.runs.update(r.runId, { state: 'DONE' } as any);
    }
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    // Initially manager can manage
    const initGet = await call(port, `/api/v1/runs/${run.runId}/models`, 'GET', token);
    assert.equal(initGet.body.canManageModels, true);

    // Non-manager guest '202' delivers turn to warm run
    const convRes = await call(port, '/api/v1/agents/alpha/conversation', 'POST', INGRESS, {
      message: 'Hello from guest',
      requestedBy: { provider: 'discord', id: '202' },
    });
    assert.equal(convRes.status, 202);

    // Warm run is now tainted
    const taintedGet = await call(port, `/api/v1/runs/${run.runId}/models`, 'GET', token);
    assert.equal(taintedGet.body.canManageModels, false);

    const taintedPut = await call(port, `/api/v1/runs/${run.runId}/models`, 'PUT', token, {
      currentModel: 'claude-haiku',
    });
    assert.equal(taintedPut.status, 403);
    assert.equal(taintedPut.body.error, 'requester_unauthorized_for_model_switch');
  });

  it('MCP run-token parity on POST /mcp: tools/list and tools/call', async () => {
    // 1. Authorized run
    const run = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'cloudflare:alice@example.com',
      trigger: 'manual',
    });
    const token = await tokens.mint({ runId: run.runId, agentId: 'alpha' });

    // initialize
    const initRes = await call(port, '/mcp', 'POST', token, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(initRes.status, 200);
    assert.equal(initRes.body.result?.serverInfo?.name, 'agent-factory');

    // ping
    const pingRes = await call(port, '/mcp', 'POST', token, { jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(pingRes.status, 200);
    assert.deepEqual(pingRes.body.result, {});

    // tools/list: exposed both get_agent_models and set_agent_models for manager
    const listRes = await call(port, '/mcp', 'POST', token, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(listRes.status, 200);
    const toolNames = listRes.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(toolNames.includes('get_agent_models'));
    assert.ok(toolNames.includes('set_agent_models'));

    // tools/call get_agent_models
    const callGet = await call(port, '/mcp', 'POST', token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_agent_models', arguments: {} },
    });
    assert.equal(callGet.status, 200);
    const parsedGet = JSON.parse(callGet.body.result.content[0].text);
    assert.equal(parsedGet.agentId, 'alpha');
    assert.equal(parsedGet.canManageModels, true);

    // tools/call set_agent_models
    const callSet = await call(port, '/mcp', 'POST', token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'set_agent_models', arguments: { currentModel: 'claude-haiku' } },
    });
    assert.equal(callSet.status, 200);
    const parsedSet = JSON.parse(callSet.body.result.content[0].text);
    assert.equal(parsedSet.currentModel, 'claude-haiku');

    // tools/call forbidden tool
    const callForbidden = await call(port, '/mcp', 'POST', token, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'wake_agent', arguments: { id: 'beta' } },
    });
    assert.equal(callForbidden.status, 200);
    assert.equal(callForbidden.body.error?.code, -32001);

    // 2. Unauthorized run
    const guestRun = state.runs.create({
      agentId: 'alpha',
      state: 'WORKING',
      actor: 'discord:202',
      requestedBy: { provider: 'discord', id: '202' },
      trigger: 'conversation',
    });
    const guestToken = await tokens.mint({ runId: guestRun.runId, agentId: 'alpha' });

    // tools/list: only get_agent_models
    const guestList = await call(port, '/mcp', 'POST', guestToken, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    const guestToolNames = guestList.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(guestToolNames.includes('get_agent_models'));
    assert.ok(!guestToolNames.includes('set_agent_models'));

    // Calling set_agent_models directly returns error
    const guestCallSet = await call(port, '/mcp', 'POST', guestToken, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'set_agent_models', arguments: { currentModel: 'claude-sonnet' } },
    });
    assert.equal(guestCallSet.body.error?.code, -32001);
  });
});
