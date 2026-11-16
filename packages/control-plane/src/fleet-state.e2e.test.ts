// DESIGN_AUTHORITY.md GAP-260: the fleet's go/stop state is one factory resource. It reads paused until an admin sets
// it, any live run reads it with its run token (a fleet's SDLC_GLOBAL_STATE_URL), and only an admin changes it.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, handleRunMcp, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { FleetStateStore, FLEET_STATUSES, OPS_STATES, auditFleetStateLoad, effectiveOf, opsStep, sanitizeReason, setFleetOpsState } from './fleet-state.js';
import { handleMcp } from './mcp.js';

const VIEWER = 'viewer-fleet-state-e2e';
const OPERATOR = 'operator-fleet-state-e2e';
const ADMIN = 'admin-fleet-state-e2e';

describe('GAP-260 fleet go/stop state', { concurrency: false }, () => {
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
    for (const bad of [{}, { status: 'go' }, { status: 'running', coder_app_ready: 'yes' }, { status: 'running', reason: 42 }, { status: 'deploying' }, { status: 'rolled-back' }, { status: 'running', 'Bad-Flag': 1 }, { status: 'running', deep: { a: 1 } }]) {
      assert.equal((await call('PUT', ADMIN, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
  });

  it('MCP reads and sets it with the same rules', async () => {
    const rpc = async (name: string, args: Record<string, unknown>, roles: string[]) =>
      (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { actor: 'mcp-user', roles } as never)) as {
        result?: { content: Array<{ text: string }>; isError?: boolean };
        error?: { message: string };
      };
    const set = await rpc('set_fleet_state', { status: 'paused', reason: 'Holiday' }, ['admin']);
    assert.equal(JSON.parse(set.result!.content[0].text).status, 'paused');
    assert.equal(JSON.parse((await rpc('get_fleet_state', {}, ['viewer'])).result!.content[0].text).reason, 'Holiday');
    assert.match((await rpc('set_fleet_state', { status: 'running' }, ['operator'])).error!.message, /forbidden/);
    // A refused change is an MCP error, and the state is unchanged: a typo never reads as success.
    const typo = await rpc('set_fleet_state', { status: 'pasued' }, ['admin']);
    assert.equal(typo.result!.isError, true);
    assert.match(JSON.parse(typo.result!.content[0].text).error, /status must be one of/);
    assert.equal(JSON.parse((await rpc('get_fleet_state', {}, ['viewer'])).result!.content[0].text).status, 'paused');
    assert.equal(set.result!.isError, undefined);
  });

  it('a legacy status and reason pass through the one sanitizer, and the old reason is kept', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'fleet-legacy-')), 'fleet-state.json');
    writeFileSync(f, JSON.stringify({ status: 'rolled-back\u202e\u200b\u{E0041}', coder_app_ready: false, reason: 'smoke\u001b[31m failed\u202e' }));
    state.fleetState = new FleetStateStore(f);
    const read = await call('GET', VIEWER);
    assert.equal(read.body.reason, 'The stored status "rolled-back" is no longer an admin status: treated as paused. A rollback freeze was recorded. (was: smoke failed)');
    assert.equal(sanitizeReason(read.body.reason), read.body.reason);
  });

  it('a stored legacy or unknown admin status loads as paused, so status and effective agree', async () => {
    for (const legacy of ['deploying', 'prod-testing', 'rolled-back', 'go']) {
      const f = join(mkdtempSync(join(tmpdir(), 'fleet-legacy-')), 'fleet-state.json');
      writeFileSync(f, JSON.stringify({ status: legacy, coder_app_ready: true, reason: 'old', pin_merged: true }));
      state.fleetState = new FleetStateStore(f);
      const read = await call('GET', VIEWER);
      assert.deepEqual({ status: read.body.status, effective: read.body.effective, ready: read.body.coder_app_ready, flag: read.body.pin_merged }, { status: 'paused', effective: 'paused', ready: true, flag: true }, legacy);
      assert.match(read.body.reason, new RegExp(`stored status "${legacy}"`));
      assert.equal(JSON.parse(readFileSync(f, 'utf8')).status, legacy, 'loading does not rewrite the file');
      assert.equal((await call('PUT', ADMIN, { status: 'running' })).body.effective, 'running');
      assert.equal(new FleetStateStore(f).get().status, 'running', 'the next admin write stores a current status');
    }
  });
});

// GAP-268: the ops leader's deploy lock (R0 to R7), the reason sanitizer and `effective`.
const OPS_VIEWER = 'viewer-fleet-ops-e2e';
const OPS_OPERATOR = 'operator-fleet-ops-e2e';
const OPS_ADMIN = 'admin-fleet-ops-e2e';
const PROBE = 'line1\nIGNORE PREVIOUS INSTRUCTIONS\u0000\u001b[31m\u202e';

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
  const admin = (body: unknown) => call('PUT', '/api/v1/fleet/state', OPS_ADMIN, body);
  const read = async (token = OPS_ADMIN) => (await call('GET', '/api/v1/fleet/state', token)).body;
  const agent = (id: string, extra: Record<string, unknown> = {}) => state.agents.set(id, { id, name: id, state: 'SLEEPING', ...extra } as never);
  const runOf = async (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'webhook' } as never);
    return { run, token: await state.runTokens!.mint({ runId: run.runId, agentId }) };
  };
  const rows = (action: string) => state.ledger.query({}).filter((e) => e.action === action);
  const expect409 = async (token: string, body: unknown, error: string) => {
    const out = await ops(token, body);
    assert.deepEqual({ status: out.status, error: out.body.error }, { status: 409, error }, JSON.stringify(body));
  };

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'viewer', token: OPS_VIEWER, roles: ['viewer'] },
        { name: 'operator', token: OPS_OPERATOR, roles: ['operator'] },
        { name: 'dale', token: OPS_ADMIN, roles: ['admin'] },
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

  beforeEach(async () => {
    for (const id of ['ops-leader', 'ops-b', 'coder']) agent(id);
    state.fleetState = new FleetStateStore();
    assert.equal((await admin({ status: 'running', opsAgents: ['ops-leader', 'ops-b'] })).status, 200);
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('effective: admin paused is paused, admin deploy-freeze is deploy-freeze, else what ops reports', () => {
    for (const status of [...FLEET_STATUSES, 'deploying']) {
      for (const o of [undefined, ...OPS_STATES]) {
        const want = status === 'deploy-freeze' ? 'deploy-freeze' : status !== 'running' ? 'paused' : o === 'rolled-back' ? 'deploy-freeze' : o === 'deploying' || o === 'prod-testing' ? o : 'running';
        const fs = { status, ...(o ? { ops: { state: o, by: 'x', at: 'now', reason: null } } : {}) } as never;
        assert.equal(effectiveOf(fs), want, `${status} + ${o ?? 'none'}`);
      }
    }
  });

  it('a stored ops record with an unknown state, or an open deploy with no run, loads as rolled-back and is audited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-ops-load-'));
    const cases: [unknown, string | undefined, string | null][] = [
      [{ state: 'frozen\u202e\u200b', by: 'x', at: 'then', reason: null }, 'unknown-state', null],
      [{ state: 'prod-testing', by: 'ops-leader', at: 'then', reason: null, runId: 'run-9' }, 'unknown-state', 'run-9'],
      [{ state: 'deploying', by: 'ops-leader', at: 'then', reason: null }, 'no-run', null],
      [{ state: 'prod-testing', by: 'dale', at: 'then', reason: null, runId: null }, 'no-run', null],
      ['deploying', 'unknown-state', null],
      [{ state: 'deploying', by: 'ops-leader', at: 'then', reason: null, runId: 'run-1' }, undefined, 'run-1'],
      [{ state: 'idle', by: null, at: null, reason: null, runId: null }, undefined, null],
      [undefined, undefined, null],
    ];
    cases[1][0] = { ...(cases[1][0] as object), state: 7 };
    for (const [i, [stored, issue, runId]] of cases.entries()) {
      const f = join(dir, `fleet-state-${i}.json`);
      writeFileSync(f, JSON.stringify({ status: 'running', coder_app_ready: true, reason: null, opsAgents: ['ops-leader'], ...(stored === undefined ? {} : { ops: stored }) }));
      const before = rows('FLEET_OPS_STATE_INVALID').length;
      state.fleetState = new FleetStateStore(f);
      auditFleetStateLoad(state);
      const view = await read();
      const label = JSON.stringify(stored);
      assert.equal(state.fleetState.opsIssue, issue, label);
      if (!issue) {
        assert.notEqual(view.ops.state, 'rolled-back', label);
        assert.equal(rows('FLEET_OPS_STATE_INVALID').length, before, label);
        continue;
      }
      assert.deepEqual({ state: view.ops.state, runId: view.ops.runId, effective: view.effective }, { state: 'rolled-back', runId, effective: 'deploy-freeze' }, label);
      assert.equal(sanitizeReason(view.ops.reason), view.ops.reason);
      assert.match(view.ops.reason, issue === 'no-run' ? /has no holding run: treated as rolled-back\.$/ : /is not an ops state: treated as rolled-back\.$/);
      const audit = rows('FLEET_OPS_STATE_INVALID').slice(before);
      assert.deepEqual(audit.map((e) => [e.actor, e.mcpName]), [['system:fleet-state-load', `fleet-ops:invalid:${issue}->rolled-back`]], label);
    }
    // Fail closed: no run can open a deploy over it; an admin clears it without force (no live holder).
    state.fleetState = new FleetStateStore(join(dir, 'fleet-state-2.json'));
    const { token } = await runOf('ops-leader');
    await expect409(token, { state: 'deploying' }, 'rolled_back_requires_admin');
    assert.equal((await admin({ status: 'running', ops: null })).status, 200);
    assert.equal((await read()).effective, 'running');
  });

  it('text on a valid stored record (reason, ops.reason, ops.by) is cleaned on load; the file is not rewritten', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'fleet-ops-text-')), 'fleet-state.json');
    const dirty = (w: string) => `${w}\u202e\u200b\u{E0041}\u2066 ok`;
    const stored = JSON.stringify({ status: 'running', coder_app_ready: true, reason: dirty('maintenance'), opsAgents: ['ops-leader'], ops: { state: 'idle', by: dirty('ops-leader'), at: 'then', reason: dirty('deployed'), runId: null } });
    writeFileSync(f, stored);
    state.fleetState = new FleetStateStore(f);
    for (const who of [OPS_ADMIN, OPS_VIEWER]) {
      const view = await read(who);
      assert.deepEqual([view.reason, view.ops.reason, view.ops.by], ['maintenance ok', 'deployed ok', 'ops-leader ok'], who);
    }
    assert.equal(state.fleetState.opsIssue, undefined, 'a valid record is not repaired or audited');
    assert.equal(readFileSync(f, 'utf8'), stored, 'the file is not rewritten on load');
    writeFileSync(f, JSON.stringify({ status: 'running', coder_app_ready: true, reason: 7, ops: { state: 'idle', by: { x: 1 }, at: null, reason: ['x'] } }));
    const odd = new FleetStateStore(f).get();
    assert.deepEqual([odd.reason, odd.ops?.reason, odd.ops?.by], [null, null, null], 'not text reads as null');
    writeFileSync(f, JSON.stringify({ status: 'running', coder_app_ready: true, reason: null, ops: { by: 'x' } }));
    assert.match(new FleetStateStore(f).get().ops?.reason ?? '', /stored ops state "missing" is not an ops state/);
    writeFileSync(f, JSON.stringify({ status: 'running', coder_app_ready: true, reason: null, ops: { state: 'deploying', by: 'x', at: null, reason: null, runId: 'r', deployId: 'p@abc\u202e' } }));
    assert.equal(new FleetStateStore(f).get().ops?.deployId, null, 'a stored deployId that is not a deploy id reads as null (#482)');
  });

  it('R0: only registered, non-helper, non-retired agents can be listed (400 unknown_agent)', async () => {
    agent('retired-one', { state: 'RETIRED_PENDING_PURGE' });
    agent('helper-1', { ephemeral: { subagent: 'h', parentRunId: 'r' } });
    for (const id of ['ghost', 'retired-one', 'helper-1']) {
      const out = await admin({ status: 'running', opsAgents: ['ops-leader', id] });
      assert.deepEqual({ status: out.status, error: out.body.error, agent: out.body.agent }, { status: 400, error: 'unknown_agent', agent: id });
    }
    assert.deepEqual((await read()).opsAgents, ['ops-b', 'ops-leader']);
    assert.equal((await call('PUT', '/api/v1/fleet/state', OPS_OPERATOR, { status: 'running', opsAgents: ['coder'] })).status, 403);
  });

  it('R0: retire and purge take an agent off the list (audited); reinstating or re-creating does not put it back', async () => {
    agent('ops-x');
    await admin({ status: 'running', opsAgents: ['ops-leader', 'ops-x'] });
    assert.equal((await call('POST', '/api/v1/registry/agents/ops-x/retire', OPS_ADMIN)).status, 200);
    assert.deepEqual((await read()).opsAgents, ['ops-leader']);
    assert.equal(rows('FLEET_OPS_AGENTS_SET').at(-1)?.mcpName, 'fleet-ops-agents:-ops-x:retired');
    assert.equal((await call('POST', '/api/v1/registry/agents/ops-x/reinstate', OPS_ADMIN)).status, 200);
    assert.deepEqual((await read()).opsAgents, ['ops-leader']);
    await admin({ status: 'running', opsAgents: ['ops-leader', 'ops-x'] });
    assert.equal((await call('POST', '/api/v1/registry/agents/ops-x/purge', OPS_ADMIN)).status, 200);
    assert.equal(rows('FLEET_OPS_AGENTS_SET').at(-1)?.mcpName, 'fleet-ops-agents:-ops-x:purged');
    agent('ops-x');
    assert.deepEqual((await read()).opsAgents, ['ops-leader'], 'a re-created id inherits nothing');
    const { token } = await runOf('ops-x');
    assert.equal((await ops(token, { state: 'deploying' })).body.error, 'not_an_ops_agent');
  });

  it('R0 on write: a listed agent that is no longer current is refused (403, audited)', async () => {
    const { token } = await runOf('ops-b');
    agent('ops-b', { state: 'RETIRED_PENDING_PURGE' });
    assert.equal((await ops(token, { state: 'deploying' })).status, 403);
    assert.equal(rows('FLEET_OPS_STATE_DENIED').at(-1)?.mcpName, 'fleet-ops:not_an_ops_agent');
  });

  it('refuses people and unlisted agents (403) and bad or ended tokens (401)', async () => {
    const other = await runOf('coder');
    assert.equal((await ops(other.token, { state: 'deploying' })).body.error, 'not_an_ops_agent');
    for (const person of [OPS_VIEWER, OPS_OPERATOR, OPS_ADMIN]) assert.equal((await ops(person, { state: 'deploying' })).status, 403, person);
    assert.equal((await ops(undefined, { state: 'deploying' })).status, 401);
    assert.equal((await ops('not-a-token', { state: 'deploying' })).status, 401);
    const leader = await runOf('ops-leader');
    state.runs.update(leader.run.runId, { state: 'DONE' });
    assert.equal((await ops(leader.token, { state: 'deploying' })).status, 401);
    assert.deepEqual((await read(OPS_VIEWER)).ops, { state: 'idle', by: null, at: null, reason: null, deployId: null });
  });

  it('R1: of concurrent deploying writes exactly one holds the lock and gets its runId back', async () => {
    const runs = await Promise.all([runOf('ops-leader'), runOf('ops-leader'), runOf('ops-b')]);
    const outs = await Promise.all(runs.map((r) => ops(r.token, { state: 'deploying', reason: 'v1' })));
    const won = outs.filter((o) => o.status === 200);
    assert.equal(won.length, 1);
    assert.deepEqual(outs.filter((o) => o.status === 409).map((o) => o.body.error), ['deploy_in_progress', 'deploy_in_progress']);
    const holder = runs[outs.indexOf(won[0])];
    assert.equal(won[0].body.ops.runId, holder.run.runId);
    assert.equal(won[0].body.effective, 'deploying');
    const a = await read();
    assert.deepEqual({ runId: a.ops.runId, live: a.ops.runLive }, { runId: holder.run.runId, live: true }, 'an admin sees the holder');
    const v = await read(OPS_VIEWER);
    assert.equal('runId' in v.ops, false);
    const r = await read(holder.token);
    assert.equal('runId' in r.ops, false);
    assert.equal('opsAgents' in r, false, 'runs do not see the ops list');
  });

  it('R1/R6: deploying while not running is 409 fleet_not_running, and un-pausing revives nothing', async () => {
    const { token } = await runOf('ops-leader');
    for (const status of ['paused', 'deploy-freeze']) {
      await admin({ status });
      await expect409(token, { state: 'deploying' }, 'fleet_not_running');
    }
    await admin({ status: 'running' });
    assert.equal((await read()).effective, 'running');
    assert.equal((await read()).ops.state, 'idle');
  });

  it('R2: only the holding run advances or closes a deploy; its retries are 200', async () => {
    const a = await runOf('ops-leader');
    const b = await runOf('ops-b');
    await ops(a.token, { state: 'deploying', reason: 'v2' });
    await expect409(b.token, { state: 'prod-testing' }, 'not_the_deploying_run');
    await expect409(b.token, { state: 'idle' }, 'not_the_deploying_run');
    await expect409(b.token, { state: 'rolled-back' }, 'not_the_deploying_run');
    await expect409(b.token, { state: 'deploying' }, 'deploy_in_progress');
    const n = rows('FLEET_OPS_STATE_SET').length;
    const retry = await ops(a.token, { state: 'deploying' });
    assert.deepEqual({ status: retry.status, runId: retry.body.ops.runId, reason: retry.body.ops.reason }, { status: 200, runId: a.run.runId, reason: 'v2' });
    assert.equal(rows('FLEET_OPS_STATE_SET').length, n, 'a retry is not a change');
    assert.equal((await ops(a.token, { state: 'prod-testing' })).body.effective, 'prod-testing');
    assert.equal((await ops(a.token, { state: 'prod-testing', reason: 'smoke 2/3' })).body.ops.reason, 'smoke 2/3');
    await expect409(b.token, { state: 'prod-testing' }, 'not_the_deploying_run');
    const done = await ops(a.token, { state: 'idle' });
    assert.deepEqual({ effective: done.body.effective, runId: done.body.ops.runId }, { effective: 'running', runId: null });
    assert.equal((await ops(b.token, { state: 'idle' })).status, 200, 'idle to idle with no deploy open changes nothing');
    assert.equal((await ops(b.token, { state: 'deploying' })).status, 200, 'after the close the next run takes the lock');
  });

  it('R3: no skipped or backward moves, and no rolled-back from idle (409 invalid_transition)', async () => {
    const { token } = await runOf('ops-leader');
    await expect409(token, { state: 'prod-testing' }, 'invalid_transition');
    await expect409(token, { state: 'rolled-back' }, 'invalid_transition');
    await ops(token, { state: 'deploying' });
    await ops(token, { state: 'prod-testing' });
    await expect409(token, { state: 'deploying' }, 'invalid_transition');
  });

  it('R4/R5: rolled-back keeps its first reason; only an admin leaves it, with force while the run is live (R7)', async () => {
    const a = await runOf('ops-leader');
    const b = await runOf('ops-b');
    await ops(a.token, { state: 'deploying' });
    const rb = await ops(a.token, { state: 'rolled-back', reason: 'smoke test failed' });
    assert.equal(rb.body.effective, 'deploy-freeze');
    for (const s of ['deploying', 'prod-testing', 'idle']) await expect409(a.token, { state: s }, 'rolled_back_requires_admin');
    await expect409(b.token, { state: 'rolled-back', reason: 'all good actually' }, 'rolled_back_requires_admin');
    const again = await ops(a.token, { state: 'rolled-back', reason: 'all good actually' });
    assert.deepEqual({ status: again.status, reason: again.body.ops.reason }, { status: 200, reason: 'smoke test failed' });
    assert.equal(rows('FLEET_OPS_STATE_RETRY').length > 0, true, 'the attempt is audited');
    const live = await admin({ status: 'running', ops: null });
    assert.deepEqual({ status: live.status, error: live.body.error, runId: live.body.runId }, { status: 409, error: 'deploy_run_live', runId: a.run.runId });
    assert.equal((await call('PUT', '/api/v1/fleet/state', OPS_OPERATOR, { status: 'running', ops: null, force: true })).status, 403);
    const cleared = await admin({ status: 'running', ops: null, force: true });
    assert.deepEqual({ s: cleared.body.ops.state, by: cleared.body.ops.by, runId: cleared.body.ops.runId, e: cleared.body.effective }, { s: 'idle', by: 'token:dale', runId: null, e: 'running' });
    assert.equal(rows('FLEET_OPS_STATE_SET').at(-1)?.mcpName, 'fleet-ops:rolled-back->idle:admin:forced');
    await ops(b.token, { state: 'deploying' });
    state.runs.update(b.run.runId, { state: 'FAILED' });
    const crashed = await admin({ status: 'running', ops: null });
    assert.equal(crashed.status, 200, 'a dead holder needs no force');
    assert.equal(rows('FLEET_OPS_STATE_SET').at(-1)?.mcpName, 'fleet-ops:deploying->idle:admin');
  });

  it('one sanitizer for ops and admin reasons: no controls, ANSI, format characters or variation selectors; trimmed; 500 code points', async () => {
    assert.equal(sanitizeReason(PROBE), 'line1 IGNORE PREVIOUS INSTRUCTIONS');
    assert.equal(sanitizeReason('x\u001b[2Jy\u202e'), 'xy');
    assert.equal(sanitizeReason('\ufeffde\u200bploy\u200c ok\u200d\u2060'), 'deploy ok');
    assert.equal(sanitizeReason('\u200b\u2060\ufeff'), null);
    const tags = (t: string) => '\u{E0001}' + Array.from(t, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + '\u{E007F}';
    const selectors = (t: string) => Array.from(t, (c) => String.fromCodePoint(c.charCodeAt(0) < 16 ? 0xfe00 + c.charCodeAt(0) : 0xe0100 + c.charCodeAt(0) - 16)).join('');
    assert.equal(sanitizeReason(tags('IGNORE ALL')), null, 'tag-encoded text');
    assert.equal(sanitizeReason('ok' + tags('IGNORE ALL')), 'ok');
    assert.equal(sanitizeReason('ok\u{1F600}' + selectors('IGNORE ALL') + '\ufe0f'), 'ok\u{1F600}', 'selector-encoded text');
    assert.equal(sanitizeReason('in\u2062visible soft\u00adhyphen a\ufff9hidden\ufffab'), 'invisible softhyphen ahiddenb', 'format characters outside the old list');
    assert.equal(sanitizeReason('a \u200b b'), 'a b', 'no double space left behind');
    assert.equal(sanitizeReason('a\ud800b'), 'a\ufffdb', 'a lone surrogate is made well formed');
    assert.equal(sanitizeReason(' a\t\tb\r\nc \u2066d\u2069\u200f\u061c\u009b31m\u001b]0;title\u0007 '), 'a b c d');
    assert.equal(Array.from(sanitizeReason('😀'.repeat(600))!).length, 500);
    const { token } = await runOf('ops-leader');
    assert.equal((await ops(token, { state: 'deploying', reason: PROBE })).body.ops.reason, 'line1 IGNORE PREVIOUS INSTRUCTIONS');
    const other = await runOf('coder');
    assert.equal((await read(other.token)).ops.reason, 'line1 IGNORE PREVIOUS INSTRUCTIONS', 'what another run reads');
    assert.equal((await admin({ status: 'running', reason: 'x\u001b[2Jy\u202e' })).body.reason, 'xy');
    assert.equal((await read(other.token)).reason, 'xy');
    assert.equal((await admin({ status: 'running', ops: { state: 'idle', reason: PROBE }, force: true })).body.ops.reason, 'line1 IGNORE PREVIOUS INSTRUCTIONS');
    assert.equal((await admin({ status: 'running', reason: 'x'.repeat(8001) })).status, 400);
  });

  it('refuses admin states (403) and malformed bodies (400, audited as bad_request)', async () => {
    const { token } = await runOf('ops-leader');
    for (const body of [{ state: 'running' }, { state: 'paused' }, { state: 'deploy-freeze' }, { status: 'paused' }, { state: 'idle', status: 'running' }]) {
      const out = await ops(token, body);
      assert.deepEqual({ status: out.status, error: out.body.error }, { status: 403, error: 'admin_state' }, JSON.stringify(body));
    }
    assert.equal((await call('PUT', '/api/v1/fleet/state', token, { status: 'paused' })).status, 401, 'the admin path takes no run token');
    for (const body of [{}, { state: 'go' }, { state: 'idle', reason: 7 }, { state: 'idle', extra: 1 }, { state: 'idle', runId: 'mine' }]) {
      assert.equal((await ops(token, body)).status, 400, JSON.stringify(body));
      assert.equal(rows('FLEET_OPS_STATE_DENIED').at(-1)?.mcpName, 'fleet-ops:bad_request');
    }
    for (const status of ['deploying', 'prod-testing', 'rolled-back']) assert.equal((await admin({ status })).status, 400, status);
  });

  it('run MCP: only a current ops agent sees set_fleet_ops_state; refusals are errors; admin MCP manages the list', async () => {
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
    const took = JSON.parse((await tool(leader.run, { state: 'deploying' })).result!.content[0].text);
    assert.equal(took.ops.runId, leader.run.runId);
    assert.match((await tool(other.run, { state: 'idle' })).error!.message, /not_an_ops_agent/);
    assert.match((await tool(leader.run, { state: 'paused' })).error!.message, /admin_state/);
    assert.match((await tool(leader.run, { state: 'idle', runId: 'x' })).result!.content[0].text, /unknown field/);
    const leaderB = await runOf('ops-b');
    assert.match((await tool(leaderB.run, { state: 'deploying' })).error!.message, /deploy_in_progress/);

    const rpc = async (name: string, args: Record<string, unknown>, roles: string[]) =>
      (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { actor: 'mcp-admin', roles } as never)) as {
        result?: { content: Array<{ text: string }>; isError?: boolean };
        error?: { message: string };
      };
    assert.equal(JSON.parse((await rpc('get_fleet_state', {}, ['admin'])).result!.content[0].text).ops.runId, leader.run.runId);
    assert.equal('runId' in JSON.parse((await rpc('get_fleet_state', {}, ['viewer'])).result!.content[0].text).ops, false);
    assert.match((await rpc('set_fleet_state', { status: 'running', ops: null }, ['admin'])).result!.content[0].text, /deploy_run_live/);
    const set = JSON.parse((await rpc('set_fleet_state', { status: 'running', ops: null, force: true, opsAgents: [] }, ['admin'])).result!.content[0].text);
    assert.deepEqual({ e: set.effective, list: set.opsAgents }, { e: 'running', list: undefined });
    assert.equal((await ops(leader.token, { state: 'deploying' })).status, 403, 'off the list, refused');
  });

  describe('#482: a later run of the same ops agent takes over its own deploy lock once the holder has ended', () => {
    const end = (runId: string) => state.runs.update(runId, { state: 'DONE' });
    const opened = async (deployId?: string) => {
      const r1 = await runOf('ops-leader');
      const out = await ops(r1.token, { state: 'deploying', ...(deployId ? { deployId } : {}) });
      assert.equal(out.status, 200);
      assert.equal(out.body.ops.deployId, deployId ?? null);
      return r1;
    };

    it('R2 of X takes over after R1 ends: 200 with ops.runId R2, ledgered; R1 is then not the holder; R2 writes on without takeover', async () => {
      const r1 = await opened('p@abc');
      assert.equal((await read()).ops.deployId, 'p@abc', 'every view shows the deploy id');
      assert.equal((await read(OPS_VIEWER)).ops.deployId, 'p@abc');
      end(r1.run.runId);
      const r2 = await runOf('ops-leader');
      const out = await ops(r2.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' });
      assert.deepEqual({ status: out.status, runId: out.body.ops.runId, state: out.body.ops.state, deployId: out.body.ops.deployId }, { status: 200, runId: r2.run.runId, state: 'prod-testing', deployId: 'p@abc' });
      const t = rows('FLEET_OPS_LOCK_TAKEOVER').slice(-1);
      assert.deepEqual(t.map((e) => [e.agentId, e.runId, e.mcpName]), [['ops-leader', r2.run.runId, `fleet-ops-takeover:${r1.run.runId}->${r2.run.runId}:p@abc:prod-testing`]]);
      // R1's token has ended, so it cannot call; were it to write, the lock is no longer its own.
      const late = setFleetOpsState(state, { state: 'idle' }, { runId: r1.run.runId, agentId: 'ops-leader' });
      assert.deepEqual({ status: late.status, error: (late.body as { error: string }).error }, { status: 409, error: 'not_the_deploying_run' });
      assert.equal((await ops(r2.token, { state: 'prod-testing', reason: 'smoke 1/3' })).status, 200);
      const done = await ops(r2.token, { state: 'idle' });
      assert.deepEqual({ s: done.body.ops.state, runId: done.body.ops.runId, deployId: done.body.ops.deployId }, { s: 'idle', runId: null, deployId: null });
    });

    it('refusals: holder live, another agent, wrong or missing deployId, no open deploy; each 409 and ledgered', async () => {
      const r1 = await opened('p@abc');
      const r2 = await runOf('ops-leader');
      const y = await runOf('ops-b');
      const denied = () => rows('FLEET_OPS_STATE_DENIED').length;
      const n = denied();
      const taken = rows('FLEET_OPS_LOCK_TAKEOVER').length;
      await expect409(r2.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' }, 'deploy_in_progress');
      end(r1.run.runId);
      await expect409(y.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' }, 'not_the_deploying_run');
      await expect409(r2.token, { state: 'prod-testing', takeover: true, deployId: 'p@def' }, 'deploy_id_mismatch');
      await expect409(r2.token, { state: 'prod-testing', takeover: true }, 'deploy_id_mismatch');
      assert.equal(denied(), n + 4);
      assert.equal(rows('FLEET_OPS_STATE_DENIED').at(-1)?.mcpName, 'fleet-ops:deploy_id_mismatch');
      assert.equal(rows('FLEET_OPS_LOCK_TAKEOVER').length, taken);
      assert.equal((await ops(r2.token, { state: 'idle', takeover: true, deployId: 'p@abc' })).body.ops.deployId, null, 'a takeover into idle clears the deploy');
      await expect409(r2.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' }, 'invalid_transition');
      for (const bad of [{ deployId: '' }, { deployId: 'x'.repeat(129) }, { deployId: 'a b' }, { takeover: false }, { takeover: 'yes' }]) {
        assert.equal((await ops(r2.token, { state: 'deploying', ...bad })).status, 400, JSON.stringify(bad));
      }
    });

    it('a takeover into rolled-back works; none out of rolled-back; no takeover without a deployId', async () => {
      for (const from of ['deploying', 'prod-testing']) {
        await admin({ status: 'running', ops: null, force: true });
        const r1 = await opened('p@abc');
        if (from === 'prod-testing') await ops(r1.token, { state: 'prod-testing' });
        end(r1.run.runId);
        const r2 = await runOf('ops-leader');
        const rb = await ops(r2.token, { state: 'rolled-back', reason: 'smoke failed', takeover: true, deployId: 'p@abc' });
        assert.deepEqual({ status: rb.status, s: rb.body.ops.state, runId: rb.body.ops.runId, e: rb.body.effective }, { status: 200, s: 'rolled-back', runId: r2.run.runId, e: 'deploy-freeze' }, from);
        end(r2.run.runId);
        const r3 = await runOf('ops-leader');
        await expect409(r3.token, { state: 'rolled-back', reason: 'smoke failed', takeover: true, deployId: 'p@abc' }, 'rolled_back_requires_admin');
        await expect409(r3.token, { state: 'idle', takeover: true, deployId: 'p@abc' }, 'rolled_back_requires_admin');
      }
      await admin({ status: 'running', ops: null });
      const r1 = await opened();
      end(r1.run.runId);
      const r2 = await runOf('ops-leader');
      await expect409(r2.token, { state: 'prod-testing', takeover: true }, 'deploy_id_mismatch');
      await expect409(r2.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' }, 'deploy_id_mismatch');
      await expect409(r2.token, { state: 'prod-testing' }, 'not_the_deploying_run');
    });

    it('two concurrent takeovers by two runs of X: exactly one gets 200', async () => {
      const r1 = await opened('p@abc');
      end(r1.run.runId);
      const taken = rows('FLEET_OPS_LOCK_TAKEOVER').length;
      const rs = await Promise.all([runOf('ops-leader'), runOf('ops-leader')]);
      const outs = await Promise.all(rs.map((r) => ops(r.token, { state: 'prod-testing', takeover: true, deployId: 'p@abc' })));
      const won = outs.filter((o) => o.status === 200);
      assert.equal(won.length, 1);
      assert.deepEqual(outs.filter((o) => o.status !== 200).map((o) => [o.status, o.body.error]), [[409, 'deploy_in_progress']]);
      assert.equal((await read()).ops.runId, rs[outs.indexOf(won[0])].run.runId);
      assert.equal(rows('FLEET_OPS_LOCK_TAKEOVER').length, taken + 1);
    });

    it('unit: takeover into the current state rebinds the lock; without takeover nothing changes', () => {
      const prior = { status: 'running', coder_app_ready: false, reason: null, ops: { state: 'deploying', by: 'x', at: 't', reason: 'v2', runId: 'r1', deployId: 'p@abc' } } as never;
      const same = opsStep(prior, 'deploying', 'r2', 'x', undefined, { takeover: true, deployId: 'p@abc', holderLive: false });
      assert.ok(same.ok && same.ops?.runId === 'r2' && same.ops.deployId === 'p@abc' && same.ops.reason === 'v2' && same.takenFrom === 'r1');
      assert.deepEqual(opsStep(prior, 'prod-testing', 'r2', 'x', undefined, { deployId: 'p@abc' }), { ok: false, error: 'not_the_deploying_run' });
      assert.deepEqual(opsStep(prior, 'deploying', 'r2', 'x', undefined, { takeover: true, deployId: 'p@abc', holderLive: true }), { ok: false, error: 'deploy_in_progress' });
    });
  });
});
