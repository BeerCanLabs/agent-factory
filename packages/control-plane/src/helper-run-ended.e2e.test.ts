// #481 (F1 of agentic-sdlc#101): a helper's end wakes its parent agent once (trigger helper-run-ended, ids only), and any
// run of that agent reads the helper's result. No timers and no polling in the factory: the wake is the run's end.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { HelperWakeLog, resumeHelperWakes, wakeParentOfHelper } from './helper-wakes.js';
import { MemoryRunStore, applyKillSwitch, finishRun, noopRuntime, type Run } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

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
/** Lets the run-end hook's createRun settle (test-only; the factory itself waits on nothing). */
const settled = async (done: () => boolean = () => false) => {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('helper-run-ended wakes the parent agent (#481)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('helper-run-ended-token-key-0123456789abcdef');
  const registryDir = mkdtempSync(join(tmpdir(), 'helper-run-ended-e2e-'));
  const wakeFile = join(registryDir, 'helper-wakes.json');

  const runOf = async (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'api' } as never);
    return { runId: run.runId, token: await tokens.mint({ runId: run.runId, agentId }) };
  };
  const wakes = (agentId = 'reviewer') => state.runs.list({ agentId }).filter((r) => r.trigger === 'helper-run-ended');
  const rows = () => (state.ledger as MemoryLedger).query({}).filter((e) => e.action === 'HELPER_RUN_ENDED_WAKE');
  const rowFor = (helperRunId: string) => rows().filter((e) => e.mcpName?.startsWith(`helper-run-ended:${helperRunId}:`));
  const spawn = async (parent: { runId: string; token: string }) => {
    const r = await call(port, `/api/v1/runs/${parent.runId}/subagents/spawn`, 'POST', parent.token, { subagent: 'juror', model: 'grok-4', prompt: 'vote' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    return state.runs.get(r.body.runId)!;
  };
  const read = (reader: { runId: string; token: string }, helperRunId: string) => call(port, `/api/v1/runs/${reader.runId}/subagents/runs/${helperRunId}`, 'GET', reader.token);
  const reset = (id: string) => {
    const a = state.agents.get(id)!;
    a.state = 'SLEEPING';
    for (const r of state.runs.list({ agentId: id, active: true })) state.runs.update(r.runId, { state: 'DONE' });
  };

  before(async () => {
    state = {
      registryDir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      approvals: new ApprovalStore(),
      policies: new PolicyStore(join(registryDir, 'policies')),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      modelCatalog: { 'grok-4': {} },
      sharedRuntime: { repo: 'BeerCanLabs/agent-factory', commit: 'a'.repeat(40), image: 'runtime:test', updatedAt: '', updatedBy: 'test' },
      helperWakes: new HelperWakeLog(wakeFile),
    } as unknown as FactoryState;
    for (const id of ['reviewer', 'other']) state.agents.set(id, { id, name: id, state: 'SLEEPING', roles: [], requires: [], triggers: [] } as never);
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id: 'juror', prompt: 'You are a juror.' })).status, 201);
    assert.equal((await call(port, '/api/v1/registry/subagents/juror/models', 'PUT', ADMIN, { approvedModels: ['grok-4'] })).status, 200);
    state.policies.set('reviewer', { routes: [], subagents: ['juror'], budgetUsd: { perDay: 1 } } as never);
    state.policies.set('other', { routes: [], wakeAgents: ['reviewer'] } as never);
  });
  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('DONE, FAILED, TIMED_OUT and CANCELLED each wake the parent agent exactly once, with ids and no result', async () => {
    for (const end of ['DONE', 'FAILED', 'TIMED_OUT', 'CANCELLED'] as const) {
      reset('reviewer');
      const parent = await runOf('reviewer');
      const helper = await spawn(parent);
      await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
      await settled();
      const before = wakes().length;
      await finishRun(state, helper.runId, end, { actor: 'test', result: { vote: 'approve' } });
      await settled(() => rowFor(helper.runId).length > 0);
      const now = wakes();
      assert.equal(now.length, before + 1, end);
      const woken = now.at(-1)!;
      assert.deepEqual(woken.input, { event: { type: 'helper-run-ended', parentRunId: parent.runId, helperRunId: helper.runId, subagent: 'juror', state: end } }, end);
      assert.equal(woken.actor, 'factory:helper-run-ended');
      assert.equal(rowFor(helper.runId).length, 1);
      const row = rowFor(helper.runId)[0];
      assert.deepEqual({ a: row.agentId, p: row.parentRunId, pa: row.parentAgentId, r: row.runId, m: row.mcpName }, { a: 'reviewer', p: parent.runId, pa: 'reviewer', r: woken.runId, m: `helper-run-ended:${helper.runId}:${end}:woken` });
      // A second end report (TIMED_OUT then DONE) and a resume start nothing more.
      await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
      await resumeHelperWakes(state);
      await settled();
      assert.equal(wakes().length, before + 1, `${end}: once`);
      assert.equal(rowFor(helper.runId).length, 1);
    }
  });

  it('the woken run reads the result with its own token; another agent and an unknown id get the same 403', async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const helper = await spawn(parent);
    await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
    await finishRun(state, helper.runId, 'DONE', { actor: 'test', result: { vote: 'approve' } });
    await settled(() => rowFor(helper.runId).length > 0);
    const woken = wakes().find((r) => (r.input as { event: { helperRunId: string } }).event.helperRunId === helper.runId)!;
    const token = await tokens.mint({ runId: woken.runId, agentId: 'reviewer' });
    state.runs.update(woken.runId, { state: 'WORKING' });
    const got = await read({ runId: woken.runId, token }, helper.runId);
    assert.equal(got.status, 200);
    assert.deepEqual({ runId: got.body.runId, state: got.body.state, result: got.body.result }, { runId: helper.runId, state: 'DONE', result: { vote: 'approve' } });
    for (const k of Object.keys(got.body)) assert.ok(['runId', 'agentId', 'state', 'result', 'error', 'startedAt', 'updatedAt'].includes(k), `unchanged shape: ${k}`);
    const b = await runOf('other');
    const theirs = await read(b, helper.runId);
    const unknown = await read(b, '00000000-0000-4000-8000-000000000000');
    assert.deepEqual([theirs.status, theirs.body], [403, { error: 'not_your_helper_run' }]);
    assert.deepEqual([unknown.status, unknown.body], [theirs.status, theirs.body]);
    const notAHelper = await read({ runId: woken.runId, token }, parent.runId);
    assert.deepEqual([notAHelper.status, notAHelper.body], [403, { error: 'not_your_helper_run' }], 'a run that is not a helper is not readable');
  });

  it('jury #486 B1: only the spawning run, or its helper-run-ended wake, reads its helpers (siblings too); not other runs of the agent', async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const jurors = [await spawn(parent), await spawn(parent), await spawn(parent)];
    const otherParent = await runOf('reviewer');
    const stranger = await spawn(otherParent);
    for (const [i, j] of jurors.entries()) await finishRun(state, j.runId, 'DONE', { actor: 'test', result: { vote: `v${i}` } });
    await settled(() => jurors.every((j) => rowFor(j.runId).length > 0));
    const wakeOf = (h: Run) => wakes().find((r) => (r.input as { event: { helperRunId: string } }).event.helperRunId === h.runId)!;
    const third = wakeOf(jurors[2]);
    state.runs.update(third.runId, { state: 'WORKING' });
    const w = { runId: third.runId, token: await tokens.mint({ runId: third.runId, agentId: 'reviewer' }) };
    for (const [i, j] of jurors.entries()) assert.deepEqual((await read(w, j.runId)).body.result, { vote: `v${i}` }, `the wake reads sibling ${i}`);
    for (const [i, j] of jurors.entries()) assert.equal((await read(parent, j.runId)).status, 200, `the spawning run reads ${i}`);
    const deny = [403, { error: 'not_your_helper_run' }];
    const r = await read(w, stranger.runId);
    assert.deepEqual([r.status, r.body], deny, "a wake cannot read another spawning run's helper");
    const webhook = state.runs.create({ agentId: 'reviewer', state: 'WORKING', actor: 'test', trigger: 'webhook', input: { event: { type: 'helper-run-ended', parentRunId: parent.runId } } } as never);
    const wh = { runId: webhook.runId, token: await tokens.mint({ runId: webhook.runId, agentId: 'reviewer' }) };
    const r2 = await read(wh, jurors[0].runId);
    assert.deepEqual([r2.status, r2.body], deny, 'a non-wake run of the same agent (even with a look-alike input) gets 403');
    const r3 = await read(otherParent, jurors[0].runId);
    assert.deepEqual([r3.status, r3.body], deny, 'another run of the same agent gets 403');
    await finishRun(state, stranger.runId, 'DONE', { actor: 'test' });
    await settled(() => rowFor(stranger.runId).length > 0);
  });

  it("another agent's wake never produces helper-run-ended, whatever its input says", async () => {
    reset('reviewer');
    const b = await runOf('other');
    const mimic = { event: { type: 'helper-run-ended', parentRunId: 'x', helperRunId: 'y', subagent: 'juror', state: 'DONE' } };
    const before = wakes().length;
    const r = await call(port, `/api/v1/runs/${b.runId}/wake/reviewer`, 'POST', b.token, { input: mimic });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    assert.equal(state.runs.get(r.body.runId)!.trigger, 'agent');
    assert.equal(wakes().length, before);
  });

  it("a helper outlives its parent run and is still charged to the parent's budget", async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const helper = await spawn(parent);
    await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
    assert.equal(state.runs.get(helper.runId)!.state === 'DONE', false, 'the helper keeps running');
    const before = state.spend.get('reviewer', parent.runId).day;
    const spent = await call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId: helper.agentId, runId: helper.runId, type: 'llm', actor: `run:${helper.agentId}`, model: 'grok-4', inputTokens: 1, outputTokens: 1, costUsd: 0.05 });
    assert.equal(spent.status, 201);
    assert.equal(state.spend.get('reviewer', parent.runId).day, before + 0.05);
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
    await settled(() => rowFor(helper.runId).length > 0);
  });

  it('a restart between the end and the wake wakes once; a claimed wake whose run exists is not repeated', async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const helper = await spawn(parent);
    await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
    // The process "stops" as the helper ends: the hook never runs.
    const hook = state.onRunEnded;
    state.onRunEnded = undefined;
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
    state.onRunEnded = hook;
    await settled();
    const before = wakes().length;
    assert.equal(new HelperWakeLog(wakeFile).get(helper.runId)?.status, 'pending', 'noted on disk at spawn');
    // The next process reads the same file.
    state.helperWakes = new HelperWakeLog(wakeFile);
    await resumeHelperWakes(state);
    assert.equal(wakes().length, before + 1);
    state.helperWakes = new HelperWakeLog(wakeFile);
    await resumeHelperWakes(state);
    assert.equal(wakes().length, before + 1, 'never two');
    // Claimed (saved) but the process stopped before it learned the run id: the existing run is found, nothing new.
    const saved = JSON.parse(JSON.stringify(state.helperWakes.list().find(([id]) => id === helper.runId)![1]));
    const raw = new HelperWakeLog(join(registryDir, 'w2.json'));
    raw.note(helper.runId, saved);
    raw.claim(helper.runId, saved);
    state.helperWakes = new HelperWakeLog(join(registryDir, 'w2.json'));
    const n = rowFor(helper.runId).length;
    await resumeHelperWakes(state);
    assert.equal(wakes().length, before + 1);
    assert.equal(state.helperWakes.get(helper.runId)?.status, 'woken');
    const rec = rowFor(helper.runId).slice(n);
    assert.deepEqual(rec.map((e) => [e.mcpName, e.runId]), [[`helper-run-ended:${helper.runId}:DONE:recovered`, wakes().at(-1)!.runId]], 'jury #486 B3: the settle path writes its one row');
    state.helperWakes = new HelperWakeLog(wakeFile);
  });

  it('jury #486 B2: a wake refused while paused, isolated or out of budget stays owed; RESUME or the next start wakes once', async () => {
    for (const how of ['PAUSE', 'ISOLATE', 'budget'] as const) {
      reset('reviewer');
      state.policies.set('reviewer', { routes: [], subagents: ['juror'], budgetUsd: { perDay: 1 } } as never);
      const parent = await runOf('reviewer');
      const helper = await spawn(parent);
      await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
      if (how === 'budget') state.policies.set('reviewer', { routes: [], subagents: ['juror'], budgetUsd: { perDay: 0 } } as never);
      else assert.equal((await applyKillSwitch(state, 'reviewer', how, 'test')).status, 200);
      const before = wakes().length;
      await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
      await settled(() => rowFor(helper.runId).length > 0);
      const why = how === 'budget' ? 'budget_exceeded' : how === 'PAUSE' ? 'agent_paused' : 'agent_isolated';
      assert.deepEqual(rowFor(helper.runId).map((e) => e.mcpName), [`helper-run-ended:${helper.runId}:DONE:deferred:${why}`], how);
      assert.equal(state.helperWakes!.get(helper.runId)?.status, 'owed');
      assert.equal(wakes().length, before, `${how}: nothing started`);
      await settled();
      assert.equal(rowFor(helper.runId).length, 1, `${how}: no retry loop`);
      // A start while the cause is still there: one more attempt, ledgered, still owed.
      await resumeHelperWakes(state);
      assert.equal(rowFor(helper.runId).length, 2);
      assert.equal(state.helperWakes!.get(helper.runId)?.status, 'owed');
      if (how === 'budget') {
        // #490: RESUME is refused for an agent that is not paused or isolated, and delivers nothing.
        const r = await call(port, '/api/v1/agents/reviewer/resume', 'POST', ADMIN);
        assert.deepEqual([r.status, r.body.error, state.agents.get('reviewer')!.state], [409, 'agent_not_paused', 'SLEEPING']);
        await settled();
        assert.equal(rowFor(helper.runId).length, 2, 'a refused RESUME retries nothing');
        // A budget write still over the limit: one more attempt, still owed (no loop).
        assert.equal((await call(port, '/api/v1/budget/agents/reviewer', 'PUT', ADMIN, { budgetUsd: { perDay: 0 } })).status, 200);
        await settled(() => rowFor(helper.runId).length > 2);
        assert.equal(rowFor(helper.runId).at(-1)!.mcpName, `helper-run-ended:${helper.runId}:DONE:deferred:budget_exceeded`);
        assert.equal(state.helperWakes!.get(helper.runId)?.status, 'owed');
        // #490: raising the budget delivers the owed wake itself, without RESUME or a restart.
        assert.equal((await call(port, '/api/v1/budget/agents/reviewer', 'PUT', ADMIN, { budgetUsd: { perDay: 1 } })).status, 200);
        await settled(() => rowFor(helper.runId).length > 3);
      } else {
        assert.equal((await applyKillSwitch(state, 'reviewer', 'RESUME', 'test')).status, 200);
        await settled(() => rowFor(helper.runId).length > 2);
      }
      assert.equal(wakes().length, before + 1, `${how}: exactly one wake`);
      assert.equal(rowFor(helper.runId).at(-1)!.mcpName, `helper-run-ended:${helper.runId}:DONE:woken`);
      assert.equal(state.helperWakes!.get(helper.runId)?.status, 'woken');
      await applyKillSwitch(state, 'reviewer', 'PAUSE', 'test');
      await applyKillSwitch(state, 'reviewer', 'RESUME', 'test');
      await call(port, '/api/v1/budget/agents/reviewer', 'PUT', ADMIN, { budgetUsd: { perDay: 1 } });
      await resumeHelperWakes(state);
      await settled();
      assert.equal(wakes().length, before + 1, `${how}: once`);
      assert.equal(rowFor(helper.runId).length, how === 'budget' ? 4 : 3);
    }
  });

  it('#490: a budget raise retries only the wakes refused for the budget, never a paused or isolated one', async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const helper = await spawn(parent);
    await finishRun(state, parent.runId, 'DONE', { actor: 'test' });
    assert.equal((await applyKillSwitch(state, 'reviewer', 'PAUSE', 'test')).status, 200);
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
    await settled(() => rowFor(helper.runId).length > 0);
    assert.equal(state.helperWakes!.get(helper.runId)?.refused, 'agent_paused');
    assert.equal((await call(port, '/api/v1/budget/agents/reviewer', 'PUT', ADMIN, { budgetUsd: { perDay: 2 } })).status, 200);
    await settled();
    assert.equal(rowFor(helper.runId).length, 1, 'a budget change does not retry a paused wake');
    assert.equal((await call(port, '/api/v1/agents/reviewer/resume', 'POST', ADMIN)).status, 200);
    await settled(() => rowFor(helper.runId).length > 1);
    assert.equal(rowFor(helper.runId).at(-1)!.mcpName, `helper-run-ended:${helper.runId}:DONE:woken`);
    state.policies.set('reviewer', { routes: [], subagents: ['juror'], budgetUsd: { perDay: 1 } } as never);
  });

  it('#490: RESUME is 409 unless the agent is PAUSED or ISOLATED; nothing changes and nothing is ledgered', async () => {
    const refused = ['SLEEPING', 'WORKING', 'RUNNING', 'PENDING_BUDGET', 'PENDING_DEPLOY', 'DEPLOYING', 'ERROR', 'RETIRED_PENDING_PURGE', 'PURGED', 'OUT_OF_BUDGET', 'BLOCKED_FOR_HUMAN', 'TRAINING'];
    const resumes = () => (state.ledger as MemoryLedger).query({}).filter((e) => e.agentId === 'other' && e.action === 'RESUME').length;
    reset('other');
    const agent = state.agents.get('other')!;
    for (const from of refused) {
      agent.state = from as never;
      const n = resumes();
      const r = await call(port, '/api/v1/agents/other/resume', 'POST', ADMIN);
      assert.deepEqual([r.status, r.body.error, r.body.state], [409, 'agent_not_paused', from], from);
      assert.equal(agent.state, from, `${from}: state unchanged`);
      assert.equal(/\/reset\b/.test(r.body.message), from === 'ERROR', `${from}: points to reset only for ERROR`);
      assert.equal(resumes(), n, `${from}: no RESUME row`);
      assert.equal((await applyKillSwitch(state, 'other', 'RESUME', 'test')).status, 409, `${from}: the function refuses too`);
    }
    for (const from of ['PAUSED', 'ISOLATED']) {
      agent.state = from as never;
      const n = resumes();
      const r = await call(port, '/api/v1/agents/other/resume', 'POST', ADMIN);
      assert.deepEqual([r.status, agent.state, resumes()], [200, 'SLEEPING', n + 1], from);
    }
  });

  it('a helper never wakes a helper: helpers start no helpers, and a helper parent is refused', async () => {
    reset('reviewer');
    const parent = await runOf('reviewer');
    const helper = await spawn(parent);
    const helperToken = await tokens.mint({ runId: helper.runId, agentId: helper.agentId });
    const nested = await call(port, `/api/v1/runs/${helper.runId}/subagents/spawn`, 'POST', helperToken, { subagent: 'juror', model: 'grok-4', prompt: 'x' });
    assert.equal(nested.status, 403);
    const n = rows().length;
    const fake = { ...state.runs.get(helper.runId)!, runId: '11111111-1111-4111-8111-111111111111', state: 'DONE', parentAgentId: helper.agentId, parentRunId: helper.runId } as Run;
    await wakeParentOfHelper(state, fake);
    assert.equal(state.runs.list({ agentId: helper.agentId }).filter((r) => r.trigger === 'helper-run-ended').length, 0);
    assert.match(rows().at(-1)!.mcpName!, /:refused:helpers_start_no_helpers$/);
    assert.equal(rows().length, n + 1);
    await resumeHelperWakes(state);
    await applyKillSwitch(state, 'reviewer', 'RESUME', 'test');
    await settled();
    assert.equal(rows().filter((e) => e.mcpName?.startsWith(`helper-run-ended:${fake.runId}:`)).length, 1, 'a final refusal is not retried');
    await finishRun(state, helper.runId, 'DONE', { actor: 'test' });
    await settled(() => rowFor(helper.runId).length > 0);
  });
});
