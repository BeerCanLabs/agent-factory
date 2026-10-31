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
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E1.2 (#293): agents and skills read the factory's approved model list (names only), fresh on every call.
const ADMIN = 'admin-token';

async function call(port: number, path: string, method: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('list_models (E1.2)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let tmp = '';
  let state: FactoryState;
  let runId = '';
  let token = '';
  const tokens = new RunTokens('list-models-run-token-key-0123456789ab');

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'list-models-e2e-'));
    state = {
      agents: new Map(),
      modelStore: new ModelStore(join(tmp, 'catalog.json'), {
        'claude-haiku': { provider: 'bedrockConverse', id: 'haiku-id', price: { inputPerMTok: 1, outputPerMTok: 5 } },
        'grok-4': { provider: 'openai', id: 'grok-raw-id', endpoint: 'https://secret.example/v1', price: { inputPerMTok: 3, outputPerMTok: 15 } },
      }),
      defaultModel: 'claude-haiku',
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
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
    } as unknown as FactoryState;
    state.agents.set('alpha', { id: 'alpha', name: 'Alpha', state: 'ACTIVE', roles: [], requires: [] } as any);
    const run = state.runs.create({ agentId: 'alpha', state: 'WORKING', actor: 'test', trigger: 'api' } as any);
    runId = run.runId;
    token = await tokens.mint({ runId, agentId: 'alpha' });
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const expected = { models: ['claude-haiku', 'grok-4'], default: 'claude-haiku' };
  const runMcp = async (t = token) => {
    const r = await call(port, '/mcp', 'POST', t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_models', arguments: {} } });
    return r.status === 200 && r.body.result ? JSON.parse(r.body.result.content[0].text) : r;
  };

  it('REST with a run token returns exactly the approved models, names only', async () => {
    const r = await call(port, `/api/v1/runs/${runId}/approved-models`, 'GET', token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, expected);
    assert.doesNotMatch(JSON.stringify(r.body), /secret\.example|grok-raw-id|haiku-id|price/);
  });

  it('run MCP lists and answers list_models identically', async () => {
    const list = await call(port, '/mcp', 'POST', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.body.result.tools.some((t: any) => t.name === 'list_models'));
    assert.deepEqual(await runMcp(), expected);
  });

  it('person MCP keeps list_model_catalog (models.read); list_models is the run-token view', async () => {
    const r = await call(port, '/mcp', 'POST', ADMIN, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = r.body.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('list_model_catalog'));
  });

  it('a model removed from the catalog is absent on the next call (no cached copy)', async () => {
    assert.equal(state.modelStore!.retire('grok-4'), true);
    const r = await call(port, `/api/v1/runs/${runId}/approved-models`, 'GET', token);
    assert.deepEqual(r.body.models, ['claude-haiku']);
    assert.deepEqual((await runMcp()).models, ['claude-haiku']);
  });

  it('an unauthenticated or wrong-run caller gets 401', async () => {
    assert.equal((await call(port, `/api/v1/runs/${runId}/approved-models`, 'GET')).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${runId}/approved-models`, 'GET', 'garbage')).status, 401);
    const other = state.runs.create({ agentId: 'alpha', state: 'WORKING', actor: 'test', trigger: 'api' } as any);
    const otherToken = await tokens.mint({ runId: other.runId, agentId: 'alpha' });
    assert.equal((await call(port, `/api/v1/runs/${runId}/approved-models`, 'GET', otherToken)).status, 401);
    assert.equal((await call(port, '/mcp', 'POST', undefined, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_models', arguments: {} } })).status, 401);
  });
});
