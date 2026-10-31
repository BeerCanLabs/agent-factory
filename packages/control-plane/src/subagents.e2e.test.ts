import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E1.1 (#292): admins register prompt-only helpers; each is audited, read-only on github, and hidden from list_agents.
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';

async function call(port: number, path: string, method: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('helper (subagent) registry (E1.1)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'viewer', token: VIEWER, roles: ['viewer'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.agents.set('alpha', { id: 'alpha', name: 'Alpha', state: 'ACTIVE', roles: [], requires: [] } as any);
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => { await new Promise<void>((r) => cp.close(() => r())); });

  it('an admin registers a prompt-only helper and an audit row is written', async () => {
    const r = await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', name: 'Juror', prompt: 'Vote on each finding.' });
    assert.equal(r.status, 201);
    assert.equal(r.body.kind, 'subagent');
    const rows = state.ledger.query({ action: 'SUBAGENT_REGISTERED' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agentId, 'juror');
    assert.equal(rows[0].actor, 'token:admin');
  });

  it('reading the definition shows github read-only and no model list', async () => {
    const r = await call(port, '/api/v1/registry/subagents/juror', 'GET', VIEWER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.egress, { github: { readOnly: true } });
    for (const k of ['model', 'models', 'approvedModels', 'requestedModels', 'memory']) assert.equal(k in r.body, false, k);
    assert.equal((await call(port, '/api/v1/registry/subagents/nope', 'GET', VIEWER)).status, 404);
  });

  it('memory, persistence or a write route is rejected with a field error and nothing is stored', async () => {
    for (const [field, body] of [
      ['memory', { id: 'bad1', prompt: 'p', memory: { enabled: true } }],
      ['persistence', { id: 'bad2', prompt: 'p', persistence: { prefix: 'x' } }],
      ['tools', { id: 'bad3', prompt: 'p', tools: ['create_issue'] }],
      ['egress.github.readOnly', { id: 'bad4', prompt: 'p', egress: { github: { readOnly: false } } }],
    ] as const) {
      const r = await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, body);
      assert.equal(r.status, 400, field);
      assert.ok(r.body.errors.some((e: any) => e.field === field), field);
      assert.equal(state.subagents?.has(body.id), false);
    }
  });

  it('only admins may register; a helper may not take an agent id', async () => {
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', VIEWER, { id: 'x', prompt: 'p' })).status, 403);
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST')).status, 401);
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'alpha', prompt: 'p' })).status, 409);
  });

  it('list_agents and the agent registry never show helpers', async () => {
    const r = await call(port, '/mcp', 'POST', ADMIN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
    const ids = JSON.parse(r.body.result.content[0].text).map((a: any) => a.id);
    assert.deepEqual(ids, ['alpha']);
    const reg = await call(port, '/api/v1/registry/agents', 'GET', ADMIN);
    assert.deepEqual(reg.body.map((a: any) => a.id), ['alpha']);
  });
});
