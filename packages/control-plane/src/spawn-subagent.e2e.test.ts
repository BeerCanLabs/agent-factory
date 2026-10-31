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

describe('spawn_subagent (E1.4)', { concurrency: false }, () => {
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
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'scout', prompt: 'You scout.' })).status, 201);
    assert.equal((await call(port, '/api/v1/agents/reviewer/policy', 'PUT', ADMIN, { routes: [], subagents: ['juror'] })).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const spawn = (who: string, body: unknown) => call(port, `/api/v1/runs/${runs[who].runId}/subagents/spawn`, 'POST', runs[who].token, body);
  const helperIds = () => [...state.agents.keys()].filter((k) => k.includes('.helper.'));

  it('an allowed agent starts a helper pinned to the model, linked to its parent, stripped down', async () => {
    const r = await spawn('reviewer', { subagent: 'juror', model: 'claude-sonnet', prompt: 'judge F1' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    const run = state.runs.get(r.body.runId)!;
    assert.equal(run.model, 'claude-sonnet');
    assert.equal(run.parentRunId, runs.reviewer.runId);
    assert.equal(run.parentAgentId, 'reviewer');
    assert.deepEqual(run.input, { subagent: 'juror', instructions: 'You are a juror.', prompt: 'judge F1' });
    const agent = state.agents.get(run.agentId)!;
    assert.deepEqual(agent.requires, []);
    assert.equal(agent.artifact, 'runtime:test');
    assert.deepEqual(state.policies.get(run.agentId), { routes: ['models'], models: ['claude-sonnet'] });
    // never saved: no registry file and no policy file for the helper
    assert.ok(!readdirSync(registryDir).some((f) => f.includes('.helper.')));
    assert.ok(!readdirSync(join(registryDir, 'policies')).some((f) => f.includes('.helper.')));
    // hidden from agent lists
    const list = await call(port, '/api/v1/registry/agents', 'GET', ADMIN);
    assert.ok(!list.body.some((a: any) => a.id === run.agentId));
    // torn down at the end
    await finishRun(state, run.runId, 'DONE', { actor: 'test' });
    assert.equal(state.agents.has(run.agentId), false);
    assert.equal(state.policies.has(run.agentId), false);
  });

  it('the run MCP tool starts a helper the same way', async () => {
    const list = await call(port, '/mcp', 'POST', runs.reviewer.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.body.result.tools.some((t: any) => t.name === 'spawn_subagent'));
    const r = await call(port, '/mcp', 'POST', runs.reviewer.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spawn_subagent', arguments: { subagent: 'juror', model: 'grok-4', prompt: 'x' } } });
    const out = JSON.parse(r.body.result.content[0].text);
    assert.ok(out.status < 300);
    assert.equal(state.runs.get(out.runId)!.model, 'grok-4');
    await finishRun(state, out.runId, 'FAILED', { actor: 'test' });
    assert.deepEqual(helperIds(), []);
  });

  it('403 without an allow-list entry, for a helper not on the list, and for a helper starting a helper', async () => {
    assert.equal((await spawn('other', { subagent: 'juror', model: 'grok-4', prompt: 'x' })).status, 403);
    assert.equal((await spawn('reviewer', { subagent: 'scout', model: 'grok-4', prompt: 'x' })).status, 403);
    const r = await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: 'x' });
    const child = state.runs.get(r.body.runId)!;
    const childToken = await tokens.mint({ runId: child.runId, agentId: child.agentId });
    const nested = await call(port, `/api/v1/runs/${child.runId}/subagents/spawn`, 'POST', childToken, { subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.equal(nested.status, 403);
    assert.equal(nested.body.error, 'helper_cannot_spawn');
    await finishRun(state, child.runId, 'DONE', { actor: 'test' });
  });

  it('400 model_not_approved, model_required, prompt_required; nothing is left behind', async () => {
    const bad = await spawn('reviewer', { subagent: 'juror', model: 'gpt-9', prompt: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'model_not_approved');
    assert.equal((await spawn('reviewer', { subagent: 'juror', prompt: 'x' })).body.error, 'model_required');
    assert.equal((await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: ' ' })).body.error, 'prompt_required');
    assert.deepEqual(helperIds(), []);
  });

  it('a deploy provider gets one shared helper compute per helper and image; one without it refuses (501)', async () => {
    const made: string[] = [];
    state.deployProvider = { provisionHelperCompute: async (id: string, image: string) => void made.push(`${id}@${image}`) } as any;
    try {
      for (let i = 0; i < 2; i++) {
        const r = await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: 'x' });
        assert.equal(state.agents.get(state.runs.get(r.body.runId)!.agentId)!.computeId, '__helper_juror');
        await finishRun(state, r.body.runId, 'DONE', { actor: 'test' });
      }
      assert.deepEqual(made, ['__helper_juror@runtime:test']);
      state.deployProvider = {} as any;
      const no = await spawn('reviewer', { subagent: 'juror', model: 'grok-4', prompt: 'x' });
      assert.equal(no.status, 501);
      assert.deepEqual(helperIds(), []);
    } finally {
      delete (state as any).deployProvider;
    }
  });

  it('a missing or wrong run token is refused', async () => {
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents/spawn`, 'POST', undefined, {})).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents/spawn`, 'POST', runs.other.token, {})).status, 401);
  });
});
