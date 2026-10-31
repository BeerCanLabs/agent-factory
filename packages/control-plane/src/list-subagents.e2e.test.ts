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

// E1.3 (#294): an agent lists only the helpers its admin-set policy allows; none without an allow-list entry.
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

describe('list_subagents (E1.3)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('list-subagents-run-token-key-0123456789ab');
  const registryDir = mkdtempSync(join(tmpdir(), 'list-subagents-e2e-'));
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
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    for (const id of ['reviewer', 'other']) {
      state.agents.set(id, { id, name: id, state: 'ACTIVE', roles: [], requires: [] } as any);
      const run = state.runs.create({ agentId: id, state: 'WORKING', actor: 'test', trigger: 'api' } as any);
      runs[id] = { runId: run.runId, token: await tokens.mint({ runId: run.runId, agentId: id }) };
    }
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    for (const id of ['juror', 'scout']) assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id, name: id.toUpperCase(), prompt: 'secret prompt' })).status, 201);
    assert.equal((await call(port, '/api/v1/agents/reviewer/policy', 'PUT', ADMIN, { routes: [], subagents: ['juror', 'not-registered'] })).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const mcp = async (id: string) => {
    const r = await call(port, '/mcp', 'POST', runs[id].token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_subagents', arguments: {} } });
    return JSON.parse(r.body.result.content[0].text);
  };

  it('an allowed agent gets exactly its allowed, registered helpers (no prompts) over REST and MCP', async () => {
    const r = await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET', runs.reviewer.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { subagents: [{ id: 'juror', name: 'JUROR' }] });
    assert.deepEqual(await mcp('reviewer'), r.body);
    assert.doesNotMatch(JSON.stringify(r.body), /secret prompt/);
  });

  it('an agent with no allow-list entry gets an empty list', async () => {
    const r = await call(port, `/api/v1/runs/${runs.other.runId}/subagents`, 'GET', runs.other.token);
    assert.deepEqual(r.body, { subagents: [] });
    assert.deepEqual(await mcp('other'), { subagents: [] });
  });

  it('the run MCP lists the tool; a wrong or missing run token is refused', async () => {
    const list = await call(port, '/mcp', 'POST', runs.other.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.body.result.tools.some((t: any) => t.name === 'list_subagents'));
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET')).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET', runs.other.token)).status, 401);
  });

  it('a policy with a malformed subagents list is refused', async () => {
    assert.equal((await call(port, '/api/v1/agents/other/policy', 'PUT', ADMIN, { routes: [], subagents: 'juror' })).status, 400);
  });
});
