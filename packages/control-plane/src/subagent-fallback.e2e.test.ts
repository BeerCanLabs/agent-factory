import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// #312: a fallback or global policy that lists helpers never grants them to an agent with no policy of its own.
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

describe('helper allow-list fails closed without an agent policy (#312)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('subagent-fallback-run-token-key-0123456789');
  const registryDir = mkdtempSync(join(tmpdir(), 'subagent-fallback-e2e-'));
  let run = { runId: '', token: '' };

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
      // The store's fallback carries a helper list, as a misconfigured default would.
      policies: new PolicyStore(undefined, { routes: ['models'], subagents: ['juror'] }),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      approvedModels: ['grok-test'],
    } as unknown as FactoryState;
    state.agents.set('loner', { id: 'loner', name: 'loner', state: 'ACTIVE', roles: [], requires: [] } as any);
    const r = state.runs.create({ agentId: 'loner', state: 'WORKING', actor: 'test', trigger: 'api' } as any);
    run = { runId: r.runId, token: await tokens.mint({ runId: r.runId, agentId: 'loner' }) };
    cp = createFactoryServer(state);
    await new Promise<void>((res) => cp.listen(0, '127.0.0.1', res));
    port = (cp.address() as { port: number }).port;
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', prompt: 'p' })).status, 201);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('an agent with no policy of its own lists no helpers', async () => {
    const r = await call(port, `/api/v1/runs/${run.runId}/subagents`, 'GET', run.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { subagents: [] });
  });

  it('an agent with no policy of its own may not spawn a helper the fallback lists', async () => {
    const r = await call(port, `/api/v1/runs/${run.runId}/subagents/spawn`, 'POST', run.token, { subagent: 'juror', model: 'grok-test', prompt: 'judge' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'subagent_not_allowed');
  });

  it('a global policy carrying subagents is refused (400) and not stored', async () => {
    const r = await call(port, '/api/v1/policies/budget', 'PUT', ADMIN, { routes: [], subagents: ['juror'] });
    assert.equal(r.status, 400);
    assert.equal(state.policies.has('__global__'), false);
    assert.equal((await call(port, '/api/v1/policies/budget', 'PUT', ADMIN, { routes: [] })).status, 200);
  });
});
