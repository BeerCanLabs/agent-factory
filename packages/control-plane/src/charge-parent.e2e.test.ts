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
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E2.1 (#297): a helper's model spend is its parent's: debited to the parent, refused when the parent is out of budget.
const MODELS_332 = ['grok-4', 'claude-sonnet'];
const ADMIN = 'admin-token';
const EGRESS = 'egress-token';

async function call(port: number, path: string, method: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('helper spend charges the parent (E2.1)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('charge-parent-run-token-key-0123456789abcd');
  const registryDir = mkdtempSync(join(tmpdir(), 'charge-parent-e2e-'));
  const runs: Record<string, { runId: string; token: string }> = {};

  before(async () => {
    state = {
      registryDir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
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
    state.policies.set('reviewer', { routes: [], subagents: ['juror'], budgetUsd: { perDay: 1 } } as any);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const spawn = (body: unknown) => call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents/spawn`, 'POST', runs.reviewer.token, body);
  const spend = (agentId: string, runId: string, usd: number) =>
    call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId, runId, type: 'llm', actor: `run:${agentId}`, model: 'grok-4', inputTokens: 10, outputTokens: 10, costUsd: usd });

  it('a helper run spends the parent budget: the parent is debited, no helper line item, and the egress sees the parent', async () => {
    const r = await spawn({ subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    const helper = state.runs.get(r.body.runId)!;
    assert.equal((await spend(helper.agentId, helper.runId, 0.4)).status, 201);
    assert.equal(state.spend.get('reviewer', runs.reviewer.runId).day, 0.4);
    assert.equal(state.spend.get(helper.agentId, helper.runId).day, 0);
    assert.ok(!Object.keys(state.spend.report().agents).some((id) => id.includes('.helper.')));
    const ctx = await call(port, `/api/v1/gatekeeper-egress/runs/${helper.runId}`, 'GET', EGRESS);
    assert.equal(ctx.body.budgetOf, 'parent');
    assert.deepEqual(ctx.body.policy.budgetUsd, { perDay: 1 });
    assert.equal(ctx.body.spend.day, 0.4);

    // the parent runs out mid-run: the live helper run is blocked, so its next model call is refused (by the egress)
    assert.equal((await spend(helper.agentId, helper.runId, 0.7)).status, 201);
    assert.equal(state.runs.get(helper.runId)!.state, 'BLOCKED_BUDGET_EXCEEDED');
    await finishRun(state, helper.runId, 'CANCELLED', { actor: 'test' });
  });

  it('a parent out of budget starts no helper: 402 supervising_agent_out_of_budget', async () => {
    const r = await spawn({ subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.equal(r.status, 402);
    assert.equal(r.body.error, 'supervising_agent_out_of_budget');
  });

  it('a helper whose parent agent is gone gets no egress context (fail closed)', async () => {
    state.policies.set('reviewer', { routes: [], subagents: ['juror'] } as any);
    const r = await spawn({ subagent: 'juror', model: 'grok-4', prompt: 'x' });
    const helper = state.runs.get(r.body.runId)!;
    const parent = state.agents.get('reviewer')!;
    state.agents.delete('reviewer');
    try {
      assert.equal((await call(port, `/api/v1/gatekeeper-egress/runs/${helper.runId}`, 'GET', EGRESS)).status, 404);
    } finally {
      state.agents.set('reviewer', parent);
      await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
    }
  });
});
