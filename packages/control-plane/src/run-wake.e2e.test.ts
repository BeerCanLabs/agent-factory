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

// #319: a run wakes only the named agents on its own admin-set `wakeAgents` allow-list; never through the fallback.
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

describe('run-token wake allow-list (#319)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('run-wake-run-token-key-0123456789abcdefgh');
  const registryDir = mkdtempSync(join(tmpdir(), 'run-wake-e2e-'));
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
      // A misconfigured fallback that lists the reviewer must never grant a wake.
      policies: new PolicyStore(undefined, { routes: [], wakeAgents: ['pr-reviewer'] }),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    for (const id of ['conductor', 'pr-reviewer', 'coder', 'loner']) state.agents.set(id, { id, name: id, state: 'ACTIVE', roles: [], requires: [] } as any);
    for (const id of ['conductor', 'loner']) {
      const run = state.runs.create({ agentId: id, state: 'WORKING', actor: 'test', trigger: 'api' } as any);
      runs[id] = { runId: run.runId, token: await tokens.mint({ runId: run.runId, agentId: id }) };
    }
    const helper = state.runs.create({ agentId: 'conductor', state: 'WORKING', actor: 'test', trigger: 'api', parentRunId: runs.conductor.runId, parentAgentId: 'conductor' } as any);
    runs.helper = { runId: helper.runId, token: await tokens.mint({ runId: helper.runId, agentId: 'conductor' }) };
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    assert.equal((await call(port, '/api/v1/agents/conductor/policy', 'PUT', ADMIN, { routes: [], wakeAgents: ['pr-reviewer'] })).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const wake = (who: string, target: string, body: unknown = { input: { pr: 5 } }) => call(port, `/api/v1/runs/${runs[who].runId}/wake/${target}`, 'POST', runs[who].token, body);

  it('an allowed target is woken with the input, actor naming the waking run', async () => {
    const r = await wake('conductor', 'pr-reviewer');
    assert.ok(r.status === 200 || r.status === 202, `status ${r.status}`);
    const run = state.runs.get(r.body.runId)!;
    assert.equal(run.agentId, 'pr-reviewer');
    assert.deepEqual(run.input, { pr: 5 });
    assert.equal(run.actor, `run:conductor:${runs.conductor.runId}`);
  });

  it('a target not on the list, or itself, is refused (403) and ledgered', async () => {
    assert.equal((await wake('conductor', 'coder')).status, 403);
    assert.equal((await wake('conductor', 'conductor')).status, 403);
    assert.ok(state.ledger.query({}).some((e: any) => e.action === 'RUN_WAKE_REFUSED' && e.agentId === 'coder'));
  });

  it('no default-policy fallback: an agent without its own policy is refused (403)', async () => {
    assert.equal((await wake('loner', 'pr-reviewer')).status, 403);
  });

  it('a helper run may not wake anyone (403)', async () => {
    assert.equal((await wake('helper', 'pr-reviewer')).status, 403);
  });

  it('a wrong token is 401; a global policy with wakeAgents is 400; a bad list is 400', async () => {
    assert.equal((await call(port, `/api/v1/runs/${runs.conductor.runId}/wake/pr-reviewer`, 'POST', ADMIN, {})).status, 401);
    assert.equal((await call(port, '/api/v1/policies/budget', 'PUT', ADMIN, { routes: [], wakeAgents: ['pr-reviewer'] })).status, 400);
    assert.equal((await call(port, '/api/v1/agents/conductor/policy', 'PUT', ADMIN, { routes: [], wakeAgents: [3] })).status, 400);
  });
});
