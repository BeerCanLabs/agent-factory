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

// #318: a parent run token reads only the helper runs it started.
const ADMIN = 'admin-token';

async function call(port: number, path: string, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('parent reads its helper runs (#318)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('helper-runs-run-token-key-0123456789abcdef');
  const registryDir = mkdtempSync(join(tmpdir(), 'helper-runs-e2e-'));
  const runs: Record<string, { runId: string; token: string }> = {};
  let mine = '';
  let theirs = '';
  let plain = '';

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
    const helper = (parent: string) =>
      state.runs.create({ agentId: 'juror-x', state: 'SUCCEEDED', actor: 'test', trigger: 'api', result: { response: 'keep' }, parentRunId: runs[parent].runId, parentAgentId: parent } as any).runId;
    mine = helper('reviewer');
    theirs = helper('other');
    plain = state.runs.create({ agentId: 'other', state: 'WORKING', actor: 'test', trigger: 'api' } as any).runId;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const path = (helperRun: string) => `/api/v1/runs/${runs.reviewer.runId}/subagents/runs/${helperRun}`;

  it('a parent run token reads its own helper run (200, state and result)', async () => {
    const r = await call(port, path(mine), runs.reviewer.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.runId, mine);
    assert.equal(r.body.state, 'SUCCEEDED');
    assert.deepEqual(r.body.result, { response: 'keep' });
    assert.equal(r.body.input, undefined);
  });

  it("another run's helper, a non-helper run and an unknown id are refused alike (403)", async () => {
    for (const id of [theirs, plain, 'no-such-run']) assert.equal((await call(port, path(id), runs.reviewer.token)).status, 403, id);
  });

  it("another run's token, an admin token or no token is refused (401)", async () => {
    assert.equal((await call(port, path(mine), runs.other.token)).status, 401);
    assert.equal((await call(port, path(mine), ADMIN)).status, 401);
    assert.equal((await call(port, path(mine))).status, 401);
  });
});
