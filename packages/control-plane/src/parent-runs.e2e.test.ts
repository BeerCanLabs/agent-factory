import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, createRun, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E1.5 (#296): a helper run records its parent run and agent, from the server's own records, on the run and its ledger rows.
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

describe('parent link on runs (E1.5)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  let parentRunId = '';
  let childRunId = '';
  let plainRunId = '';

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] },
      ]),
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
    for (const id of ['reviewer', 'juror']) state.agents.set(id, { id, name: id, state: 'SLEEPING', roles: [], requires: [] } as any);
    const parent = await createRun(state as any, 'reviewer', { actor: 'test', trigger: 'api' });
    parentRunId = (parent.body as any).runId;
    const child = await createRun(state as any, 'juror', { actor: 'test', trigger: 'api', parentRunId });
    childRunId = (child.body as any).runId;
    const plain = await createRun(state as any, 'juror', { actor: 'test', trigger: 'api' });
    plainRunId = (plain.body as any).runId;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => { await new Promise<void>((r) => cp.close(() => r())); });

  it('the API shows parentRunId and parentAgentId on a helper run, and none on a plain run', async () => {
    const r = await call(port, `/api/v1/runs/${childRunId}`, 'GET', ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.parentRunId, parentRunId);
    assert.equal(r.body.parentAgentId, 'reviewer');
    const p = await call(port, `/api/v1/runs/${plainRunId}`, 'GET', ADMIN);
    assert.equal('parentRunId' in p.body, false);
  });

  it('an unknown parent run is refused', async () => {
    const out = await createRun(state as any, 'juror', { actor: 'test', trigger: 'api', parentRunId: 'no-such-run' });
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { error: 'parent_run_not_found' });
  });

  it('spend recorded for a helper run carries both parent fields on its ledger row', async () => {
    const r = await call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId: 'juror', runId: childRunId, type: 'llm', model: 'm', costUsd: 0.01, inputTokens: 1, outputTokens: 1 });
    assert.equal(r.status, 201);
    const rows = state.ledger.query({}).filter((e: any) => e.type === 'llm' && e.runId === childRunId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].parentRunId, parentRunId);
    assert.equal(rows[0].parentAgentId, 'reviewer');
  });

  it('a writer cannot set or forge parent fields on a ledger row', async () => {
    await call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId: 'juror', runId: plainRunId, type: 'llm', model: 'm', costUsd: 0.01, parentRunId: parentRunId, parentAgentId: 'reviewer' });
    const plainRows = state.ledger.query({}).filter((e: any) => e.type === 'llm' && e.runId === plainRunId);
    assert.equal(plainRows.length, 1);
    assert.equal(plainRows[0].parentRunId, undefined);
    await call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId: 'juror', runId: childRunId, type: 'llm', model: 'm', costUsd: 0.01, parentRunId: 'forged', parentAgentId: 'forged' });
    const childRows = state.ledger.query({}).filter((e: any) => e.type === 'llm' && e.runId === childRunId);
    assert.equal(childRows.at(-1).parentRunId, parentRunId);
    assert.equal(childRows.at(-1).parentAgentId, 'reviewer');
  });
});
