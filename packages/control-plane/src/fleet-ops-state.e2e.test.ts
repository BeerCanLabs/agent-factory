// DESIGN_AUTHORITY.md GAP-268: the fleet's ops leader (an agent an admin lists in `opsAgents`) reports deploy states with
// its live run token, kept apart from the admin's status; a read adds `effective`. Only an admin clears `rolled-back`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, handleRunMcp, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { FleetStateStore, FLEET_STATUSES, OPS_STATES, effectiveOf } from './fleet-state.js';
import { handleMcp } from './mcp.js';

const VIEWER = 'viewer-fleet-ops-e2e';
const OPERATOR = 'operator-fleet-ops-e2e';
const ADMIN = 'admin-fleet-ops-e2e';

describe('GAP-268 fleet ops state', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const ops = (token: string | undefined, body: unknown) => call('PUT', '/api/v1/fleet/state/ops', token, body);
  const admin = (body: unknown) => call('PUT', '/api/v1/fleet/state', ADMIN, body);
  const read = async () => (await call('GET', '/api/v1/fleet/state', VIEWER)).body;
  const runOf = async (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'webhook' } as never);
    return { run, token: await state.runTokens!.mint({ runId: run.runId, agentId }) };
  };
  const rows = (action: string) => state.ledger.query({}).filter((e) => e.action === action);

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'dale', token: ADMIN, roles: ['admin'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('fleet-ops-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      fleetState: new FleetStateStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    const addr = await new Promise<http.Server>((r) => cp.listen(0, '127.0.0.1', () => r(cp)));
    const a = addr.address();
    if (!a || typeof a === 'string') throw new Error('no port');
    port = a.port;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('effective: paused unless the admin status is running, then what ops reports', () => {
    for (const status of FLEET_STATUSES) {
      for (const o of [undefined, ...OPS_STATES]) {
        const want = status !== 'running' ? 'paused' : o === 'rolled-back' ? 'deploy-freeze' : o === 'deploying' || o === 'prod-testing' ? o : 'running';
        const fs = { status, ...(o ? { ops: { state: o, by: 'x', at: 'now', reason: null } } : {}) };
        assert.equal(effectiveOf(fs), want, `${status} + ${o ?? 'none'}`);
      }
    }
  });

  it('an admin lists the ops agents; a malformed list is refused', async () => {
    const set = await admin({ status: 'running', opsAgents: ['ops-leader', 'ops-leader'] });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.opsAgents, ['ops-leader']);
    assert.equal(set.body.effective, 'running');
    assert.equal(rows('FLEET_OPS_AGENTS_SET').length, 1);
    for (const bad of [{ status: 'running', opsAgents: 'ops-leader' }, { status: 'running', opsAgents: ['bad id'] }, { status: 'running', ops: { state: 'running' } }]) {
      assert.equal((await admin(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('PUT', '/api/v1/fleet/state', OPERATOR, { status: 'running', opsAgents: ['coder'] })).status, 403);
    assert.deepEqual((await read()).opsAgents, ['ops-leader']);
  });

  it('refuses everyone but a live run of a listed agent: 403 for people and other agents, 401 for a bad or ended token', async () => {
    const other = await runOf('coder');
    const before = rows('FLEET_OPS_STATE_SET').length;
    const denied = await ops(other.token, { state: 'deploying' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'not_an_ops_agent');
    assert.equal(rows('FLEET_OPS_STATE_DENIED').at(-1)?.agentId, 'coder');
    for (const person of [VIEWER, OPERATOR, ADMIN]) assert.equal((await ops(person, { state: 'deploying' })).status, 403, person);
    assert.equal((await ops(undefined, { state: 'deploying' })).status, 401);
    assert.equal((await ops('not-a-token', { state: 'deploying' })).status, 401);
    const leader = await runOf('ops-leader');
    state.runs.update(leader.run.runId, { state: 'DONE' });
    assert.equal((await ops(leader.token, { state: 'deploying' })).status, 401, 'an ended run reports nothing');
    assert.equal(rows('FLEET_OPS_STATE_SET').length, before);
    assert.deepEqual((await read()).ops, { state: 'idle', by: null, at: null, reason: null }, 'idle, by nobody, until reported');
  });

  it('a read carries the ops record top-level beside status and effective, to a run and to a reader', async () => {
    const { token } = await runOf('ops-leader');
    await ops(token, { state: 'deploying', reason: 'v9' });
    for (const who of [token, VIEWER]) {
      const r = (await call('GET', '/api/v1/fleet/state', who)).body;
      assert.deepEqual(Object.keys(r.ops).sort(), ['at', 'by', 'reason', 'state']);
      assert.deepEqual({ state: r.ops.state, by: r.ops.by, reason: r.ops.reason }, { state: 'deploying', by: 'ops-leader', reason: 'v9' });
      assert.ok(!Number.isNaN(Date.parse(r.ops.at)));
      assert.deepEqual({ status: r.status, effective: r.effective }, { status: 'running', effective: 'deploying' });
    }
    await ops(token, { state: 'idle' });
  });

  it('the ops leader reports deploying and prod-testing; status is unchanged and each change is audited once', async () => {
    const { token } = await runOf('ops-leader');
    const dep = await ops(token, { state: 'deploying', reason: 'v1.2.3' });
    assert.equal(dep.status, 200);
    assert.deepEqual({ state: dep.body.ops.state, by: dep.body.ops.by, reason: dep.body.ops.reason }, { state: 'deploying', by: 'ops-leader', reason: 'v1.2.3' });
    assert.ok(dep.body.ops.at);
    const r = await read();
    assert.equal(r.status, 'running', 'old readers see the admin status');
    assert.equal(r.effective, 'deploying');
    const n = rows('FLEET_OPS_STATE_SET').length;
    assert.equal((await ops(token, { state: 'deploying', reason: 'v1.2.3' })).status, 200);
    assert.equal(rows('FLEET_OPS_STATE_SET').length, n, 'the same report again is not a change');
    assert.equal((await ops(token, { state: 'prod-testing' })).body.effective, 'prod-testing');
    assert.equal(rows('FLEET_OPS_STATE_SET').at(-1)?.mcpName, 'fleet-ops:deploying->prod-testing');
    assert.equal((await ops(token, { state: 'idle' })).body.effective, 'running');
    assert.deepEqual({ state: (await read()).ops.state, by: (await read()).ops.by }, { state: 'idle', by: 'ops-leader' });
  });

  it('a run token can never set or clear an admin state', async () => {
    const { token } = await runOf('ops-leader');
    for (const body of [{ state: 'running' }, { state: 'paused' }, { state: 'deploy-freeze' }, { status: 'paused' }, { state: 'idle', status: 'running' }]) {
      const out = await ops(token, body);
      assert.equal(out.status, 403, JSON.stringify(body));
      assert.equal(out.body.error, 'admin_state');
    }
    assert.equal((await call('PUT', '/api/v1/fleet/state', token, { status: 'paused' })).status, 401, 'the admin path takes no run token');
    for (const body of [{}, { state: 'go' }, { state: 'idle', reason: 'x'.repeat(501) }, { state: 'idle', extra: 1 }]) {
      assert.equal((await ops(token, body)).status, 400, JSON.stringify(body));
    }
    await admin({ status: 'paused' });
    assert.equal((await ops(token, { state: 'deploying' })).body.effective, 'paused', 'the admin pause wins');
    assert.equal((await read()).status, 'paused');
    await admin({ status: 'running', ops: null });
  });

  it('rolled-back freezes the fleet until an admin clears it', async () => {
    const { token } = await runOf('ops-leader');
    const rb = await ops(token, { state: 'rolled-back', reason: 'smoke test failed' });
    assert.equal(rb.body.effective, 'deploy-freeze');
    assert.equal((await read()).status, 'running');
    for (const s of ['deploying', 'prod-testing', 'idle']) {
      const out = await ops(token, { state: s });
      assert.equal(out.status, 409, s);
      assert.equal(out.body.error, 'rolled_back_requires_admin');
    }
    assert.equal((await ops(token, { state: 'rolled-back', reason: 'still failing' })).status, 200, 'rolled-back again is allowed');
    assert.equal((await read()).ops.state, 'rolled-back');
    assert.equal((await read()).ops.reason, 'still failing');
    assert.equal((await call('PUT', '/api/v1/fleet/state', OPERATOR, { status: 'running', ops: null })).status, 403);
    const cleared = await admin({ status: 'running', ops: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual({ state: cleared.body.ops.state, by: cleared.body.ops.by }, { state: 'idle', by: 'token:dale' }, 'idle written by an admin');
    assert.equal(cleared.body.effective, 'running');
    const row = rows('FLEET_OPS_STATE_SET').at(-1);
    assert.deepEqual({ actor: row?.actor, name: row?.mcpName }, { actor: 'token:dale', name: 'fleet-ops:rolled-back->idle' });
    assert.equal((await ops(token, { state: 'deploying' })).status, 200, 'after the admin clears it the leader reports again');
  });

  it('run MCP: only an ops agent sees set_fleet_ops_state; refusals are errors; admin MCP manages the list', async () => {
    const leader = await runOf('ops-leader');
    const other = await runOf('coder');
    const list = async (run: unknown) =>
      ((await handleRunMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, run as never)) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    const tool = async (run: unknown, args: Record<string, unknown>) =>
      (await handleRunMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_fleet_ops_state', arguments: args } }, run as never)) as {
        result?: { content: Array<{ text: string }>; isError?: boolean };
        error?: { code: number; message: string };
      };
    assert.ok((await list(leader.run)).includes('set_fleet_ops_state'));
    assert.ok(!(await list(other.run)).includes('set_fleet_ops_state'));
    assert.equal(JSON.parse((await tool(leader.run, { state: 'prod-testing' })).result!.content[0].text).effective, 'prod-testing');
    assert.match((await tool(other.run, { state: 'idle' })).error!.message, /not_an_ops_agent/);
    assert.match((await tool(leader.run, { state: 'paused' })).error!.message, /admin_state/);
    assert.equal((await tool(leader.run, { state: 'nope' })).result!.isError, true);
    await tool(leader.run, { state: 'rolled-back' });
    assert.match((await tool(leader.run, { state: 'idle' })).error!.message, /rolled_back_requires_admin/);

    const rpc = async (args: Record<string, unknown>, roles: string[]) =>
      (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_fleet_state', arguments: args } }, { actor: 'mcp-admin', roles } as never)) as {
        result?: { content: Array<{ text: string }>; isError?: boolean };
        error?: { message: string };
      };
    const set = JSON.parse((await rpc({ status: 'running', ops: null, opsAgents: [] }, ['admin'])).result!.content[0].text);
    assert.equal(set.effective, 'running');
    assert.equal(set.opsAgents, undefined);
    assert.equal((await ops(leader.token, { state: 'deploying' })).status, 403, 'off the list, refused');
    assert.match((await rpc({ status: 'running', opsAgents: ['coder'] }, ['operator'])).error!.message, /forbidden/);
  });
});
