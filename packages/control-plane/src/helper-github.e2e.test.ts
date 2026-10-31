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

// E3.2 (#299): a helper gets GitHub only through its parent: the route when the parent has it, never a key of its own.
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

describe('helper GitHub through the parent (E3.2)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('helper-github-run-token-key-0123456789abcd');
  const registryDir = mkdtempSync(join(tmpdir(), 'helper-github-e2e-'));
  const runs: Record<string, { runId: string; token: string }> = {};
  const started: Array<Record<string, string>> = [];

  before(async () => {
    state = {
      registryDir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [],
      runtime: { ...noopRuntime(), async start(_a: unknown, env: Record<string, string>, c: { runEnv: Record<string, string> }) { started.push({ ...env, ...c.runEnv }); return { handle: 'h' }; } },
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
    state.policies.set('reviewer', { routes: ['github'], subagents: ['juror'] } as any);
    state.policies.set('other', { routes: [], subagents: ['juror'] } as any);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const spawn = (who: string) => call(port, `/api/v1/runs/${runs[who].runId}/subagents/spawn`, 'POST', runs[who].token, { subagent: 'juror', model: 'grok-4', prompt: 'x' });

  it('a parent with GitHub gives the helper the github route; the egress context names the parent; no key in the env', async () => {
    started.length = 0;
    const r = await spawn('reviewer');
    assert.ok(r.status < 300, JSON.stringify(r.body));
    const helper = state.runs.get(r.body.runId)!;
    assert.deepEqual(state.policies.get(helper.agentId).routes, ['models', 'github']);
    const ctx = await call(port, `/api/v1/gatekeeper-egress/runs/${helper.runId}`, 'GET', EGRESS);
    assert.equal(ctx.body.helperOf, 'reviewer');
    assert.equal(started.length, 1);
    assert.ok(!Object.keys(started[0]).some((k) => /GITHUB|GH_TOKEN/i.test(k)), Object.keys(started[0]).join(','));
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
  });

  it('a parent without GitHub gives the helper no github route', async () => {
    const r = await spawn('other');
    const helper = state.runs.get(r.body.runId)!;
    assert.deepEqual(state.policies.get(helper.agentId).routes, ['models']);
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
  });
});
