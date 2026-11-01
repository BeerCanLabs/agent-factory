import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, finishRun, noopRuntime } from '@beercanlabs/factory-property-manager';
import { readdirSync } from 'node:fs';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E1.4 (#295): an allowed agent starts a stripped-down, ephemeral helper run pinned to an approved model.
const MODELS_332 = ['grok-4', 'claude-sonnet'];
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

describe('helper approved model list (#332)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('spawn-subagent-run-token-key-0123456789abc');
  const registryDir = mkdtempSync(join(tmpdir(), 'spawn-subagent-e2e-'));
  const runs: Record<string, { runId: string; token: string }> = {};

  before(async () => {
    state = {
      registryDir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      approvals: new ApprovalStore(),
      policies: new PolicyStore(join(registryDir, 'policies')),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: { 'grok-4': {}, 'claude-sonnet': {} },
      sharedRuntime: { repo: 'BeerCanLabs/agent-factory', commit: 'a'.repeat(40), image: 'runtime:test', updatedAt: '', updatedBy: 'test' },
    } as unknown as FactoryState;
    for (const id of ['reviewer', 'other']) {
      state.agents.set(id, { id, name: id, state: 'WORKING', roles: [], requires: [] } as any);
      const run = state.runs.create({ agentId: id, state: 'WORKING', actor: 'test', trigger: 'api' } as any);
      runs[id] = { runId: run.runId, token: await tokens.mint({ runId: run.runId, agentId: id }) };
    }
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', prompt: 'You are a juror.' })).status, 201);
    assert.equal((await call(port, '/api/v1/registry/subagents/juror/models', 'PUT', ADMIN, { approvedModels: MODELS_332 })).status, 200);
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'scout', prompt: 'You scout.' })).status, 201);
    assert.equal((await call(port, '/api/v1/registry/subagents/scout/models', 'PUT', ADMIN, { approvedModels: MODELS_332 })).status, 200);
    assert.equal((await call(port, '/api/v1/agents/reviewer/policy', 'PUT', ADMIN, { routes: [], subagents: ['juror'] })).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const spawn = (who: string, body: unknown) => call(port, `/api/v1/runs/${runs[who].runId}/subagents/spawn`, 'POST', runs[who].token, body);
  const put = (id: string, approvedModels: unknown) => call(port, `/api/v1/registry/subagents/${id}/models`, 'PUT', ADMIN, { approvedModels });
  const mcp = (who: string, name: string, args: Record<string, unknown>) =>
    call(port, '/mcp', 'POST', runs[who].token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).then((r) => JSON.parse(r.body.result.content[0].text));

  it('a name the factory does not offer is rejected with model_not_offered', async () => {
    const r = await put('juror', ['grok-4', 'gpt-9']);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'model_not_offered');
    assert.equal(r.body.model, 'gpt-9');
    assert.equal((await put('nobody', ['grok-4'])).status, 404);
  });

  it('only a model on the helper list starts it; an offered model off the list is model_not_approved', async () => {
    assert.equal((await put('juror', ['grok-4'])).status, 200);
    const off = await spawn('reviewer', { subagent: 'juror', model: 'claude-sonnet', prompt: 'x' });
    assert.equal(off.status, 400);
    assert.equal(off.body.error, 'model_not_approved');
    const on = await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.ok(on.status < 300, JSON.stringify(on.body));
    await finishRun(state, on.body.runId, 'DONE', { actor: 'test' });
  });

  it('the parent reads the helper list, not every admitted model', async () => {
    assert.equal((await put('juror', ['grok-4'])).status, 200);
    const listed = await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET', runs.reviewer.token);
    assert.deepEqual(listed.body.subagents.find((h: any) => h.id === 'juror').approvedModels, ['grok-4']);
    assert.deepEqual((await mcp('reviewer', 'list_models', { subagent: 'juror' })).models, ['grok-4']);
    assert.equal((await mcp('reviewer', 'list_models', { subagent: 'scout' })).error, 'subagent_not_allowed');
  });

  it('an empty list (and a new helper) cannot be started on any model', async () => {
    assert.equal((await put('juror', [])).status, 200);
    const r = await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.equal(r.body.error, 'model_not_approved');
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'fresh', prompt: 'p' })).status, 201);
    assert.deepEqual((await call(port, '/api/v1/registry/subagents/fresh', 'GET', ADMIN)).body.approvedModels, []);
  });

  it('re-registering keeps the list, it survives a reload, and a definition may not carry one', async () => {
    assert.equal((await put('juror', ['claude-sonnet', 'grok-4'])).status, 200);
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', prompt: 'You are a juror, v2.' })).status, 200);
    state.subagents = undefined;
    assert.deepEqual((await call(port, '/api/v1/registry/subagents/juror', 'GET', ADMIN)).body.approvedModels, ['claude-sonnet', 'grok-4']);
    const bad = await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', prompt: 'p', approvedModels: ['grok-4'] });
    assert.equal(bad.status, 400);
  });

  it('a viewer cannot set a helper list', async () => {
    assert.equal((await call(port, '/api/v1/registry/subagents/juror/models', 'PUT', undefined, { approvedModels: [] })).status, 401);
  });
});
