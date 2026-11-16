// DESIGN_AUTHORITY.md GAP-252: the fleet's go/stop state is one factory resource. It reads paused until an admin sets
// it, any live run reads it with its run token (a fleet's SDLC_GLOBAL_STATE_URL), and only an admin changes it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { FleetStateStore } from './fleet-state.js';
import { handleMcp } from './mcp.js';

const VIEWER = 'viewer-fleet-state-e2e';
const OPERATOR = 'operator-fleet-state-e2e';
const ADMIN = 'admin-fleet-state-e2e';

describe('GAP-252 fleet go/stop state', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const file = join(mkdtempSync(join(tmpdir(), 'fleet-state-')), 'fleet-state.json');

  const call = async (method: string, token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/fleet/state`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

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
      runTokens: new RunTokens('fleet-state-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      fleetState: new FleetStateStore(file),
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

  it('reads paused until set, to a live run and to a reader; nobody else', async () => {
    const run = state.runs.create({ agentId: 'conductor', state: 'WORKING', actor: 'test', trigger: 'webhook' } as never);
    const token = await state.runTokens!.mint({ runId: run.runId, agentId: 'conductor' });
    const byRun = await call('GET', token);
    assert.equal(byRun.status, 200);
    assert.equal(byRun.body.status, 'paused');
    assert.equal(byRun.body.coder_app_ready, false);
    assert.ok(byRun.body.reason);
    assert.equal((await call('GET', VIEWER)).body.status, 'paused');
    assert.equal((await call('GET')).status, 401);
    assert.equal((await call('GET', 'not-a-token')).status, 401);
    state.runs.update(run.runId, { state: 'DONE' });
    assert.equal((await call('GET', token)).status, 401, 'an ended run reads nothing');
  });

  it('only an admin sets it; a run token and an operator cannot', async () => {
    const run = state.runs.create({ agentId: 'conductor', state: 'WORKING', actor: 'test', trigger: 'webhook' } as never);
    const token = await state.runTokens!.mint({ runId: run.runId, agentId: 'conductor' });
    assert.equal((await call('PUT', token, { status: 'running' })).status, 401);
    assert.equal((await call('PUT', OPERATOR, { status: 'running' })).status, 403);
    const set = await call('PUT', ADMIN, { status: 'running', coder_app_ready: true, reason: 'Deployed and smoke-tested', pin_merged: false });
    assert.equal(set.status, 200);
    assert.equal(set.body.status, 'running');
    assert.equal(set.body.coder_app_ready, true);
    assert.equal(set.body.pin_merged, false);
    assert.equal(set.body.updatedBy, 'token:dale');
    const read = await call('GET', token);
    assert.deepEqual({ status: read.body.status, ready: read.body.coder_app_ready, reason: read.body.reason }, { status: 'running', ready: true, reason: 'Deployed and smoke-tested' });
    const row = state.ledger.query({}).find((e) => e.action === 'FLEET_STATE_SET');
    assert.equal(row?.actor, 'token:dale');
    assert.equal(row?.mcpName, 'fleet-state:paused->running:coder-ready');
  });

  it('keeps what is not given, clears the reason on a new status, removes a flag set to null, and survives a restart', async () => {
    const frozen = await call('PUT', ADMIN, { status: 'deploy-freeze', pin_merged: null });
    assert.equal(frozen.body.coder_app_ready, true, 'not given: kept');
    assert.equal(frozen.body.reason, null, 'a new status clears the old reason');
    assert.equal('pin_merged' in frozen.body, false);
    assert.equal(new FleetStateStore(file).get().status, 'deploy-freeze');
  });

  it('refuses what is not a state', async () => {
    for (const bad of [{}, { status: 'go' }, { status: 'running', coder_app_ready: 'yes' }, { status: 'running', reason: 'x'.repeat(501) }, { status: 'running', 'Bad-Flag': 1 }, { status: 'running', deep: { a: 1 } }]) {
      assert.equal((await call('PUT', ADMIN, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
  });

  it('MCP reads and sets it with the same rules', async () => {
    const rpc = async (name: string, args: Record<string, unknown>, roles: string[]) =>
      (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { actor: 'mcp-user', roles } as never)) as {
        result?: { content: Array<{ text: string }> };
        error?: { message: string };
      };
    const set = await rpc('set_fleet_state', { status: 'paused', reason: 'Holiday' }, ['admin']);
    assert.equal(JSON.parse(set.result!.content[0].text).status, 'paused');
    assert.equal(JSON.parse((await rpc('get_fleet_state', {}, ['viewer'])).result!.content[0].text).reason, 'Holiday');
    assert.match((await rpc('set_fleet_state', { status: 'running' }, ['operator'])).error!.message, /forbidden/);
  });
});
