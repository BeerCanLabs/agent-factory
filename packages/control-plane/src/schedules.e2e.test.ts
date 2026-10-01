// DESIGN_AUTHORITY.md GAP-061, TSK-058 (E7, S1): a run reads, creates and deletes only its own agent's schedules;
// operators keep fleet access. Creates and deletes are ledgered without the prompt text.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { BUILTIN_SYSTEM_AGENTS, type AgentRecord } from './catalog.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { ScheduleStore, cronIssue, scheduleLedgerHash, type ScheduledAction } from './schedules.js';

const KEY = 'schedules-e2e-run-token-key-0123456789abcdef';
const OPERATOR = 'operator-schedules-e2e'; // secret-scan:allow (test fixture)
const VIEWER = 'viewer-schedules-e2e'; // secret-scan:allow (test fixture)
const PROMPT = 'Send Dale the daily finance report with the overnight spend';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function agent(id: string): AgentRecord {
  const base = structuredClone(BUILTIN_SYSTEM_AGENTS[0]);
  return { ...base, id, name: id } as AgentRecord;
}

describe('GAP-061 schedules are scoped to the calling agent', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const runTokens = new RunTokens(KEY);

  const liveRun = async (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'test' });
    return { run, token: await runTokens.mint({ runId: run.runId, agentId }) };
  };
  const seed = (agentId: string, id = `sched-${agentId}-seed`): ScheduledAction => {
    const s: ScheduledAction = { id, agentId, name: `${agentId} seed`, cron: '0 6 * * *', timezone: 'America/Los_Angeles', prompt: 'seeded', enabled: true, createdAt: new Date().toISOString() };
    state.schedules!.save(s);
    return s;
  };
  const rows = (action: string) => state.ledger.query().filter((e) => (e as { action?: string }).action === action) as Array<Record<string, unknown>>;

  before(async () => {
    state = {
      agents: new Map(['finley', 'donna', 'higgins'].map((id) => [id, agent(id)])),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'operator', token: OPERATOR, roles: ['operator', 'viewer'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      schedules: new ScheduleStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  beforeEach(() => {
    state.schedules = new ScheduleStore();
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('own-agent create: a run creates a schedule for its own agent, with or without agentId in the body', async () => {
    const { token } = await liveRun('finley');
    const bare = await call(port, '/api/v1/schedules', 'POST', token, { name: 'Daily report', cron: '0 6 * * *', prompt: PROMPT, timezone: 'America/New_York', channelId: 'c-1' });
    assert.equal(bare.status, 200);
    assert.equal(bare.body.ok, true);
    assert.equal(bare.body.schedule.agentId, 'finley');
    assert.equal(bare.body.schedule.cron, '0 6 * * *');
    assert.equal(bare.body.schedule.timezone, 'America/New_York');
    assert.equal(bare.body.schedule.channelId, 'c-1');
    assert.equal(bare.body.schedule.prompt, PROMPT);
    assert.equal(bare.body.schedule.enabled, true);
    assert.match(bare.body.schedule.id, /^sched-/);
    const named = await call(port, '/api/v1/schedules', 'POST', token, { agentId: 'finley', cron: '30 7 * * 1-5', prompt: PROMPT });
    assert.equal(named.status, 200);
    assert.equal(named.body.schedule.agentId, 'finley');
    assert.equal(named.body.schedule.timezone, 'America/Los_Angeles', 'the default time zone is kept');
    assert.equal(state.schedules!.list({ agentId: 'finley' }).length, 2);
  });

  it('cross-agent create refused: a run naming another agent in the body gets 403 and nothing is stored', async () => {
    const { token } = await liveRun('finley');
    const r = await call(port, '/api/v1/schedules', 'POST', token, { agentId: 'donna', cron: '0 6 * * *', prompt: PROMPT });
    assert.equal(r.status, 403);
    assert.equal(state.schedules!.list().length, 0);
    assert.equal(rows('SCHEDULE_CREATED').filter((e) => e.agentId === 'donna').length, 0);
  });

  it('cross-agent create refused: a run cannot choose an id, so it can never overwrite another agent\'s schedule', async () => {
    const theirs = seed('donna', 'sched-shared-id');
    const { token } = await liveRun('finley');
    const r = await call(port, '/api/v1/schedules', 'POST', token, { id: theirs.id, cron: '0 6 * * *', prompt: PROMPT });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.schedule.id, theirs.id);
    assert.equal(state.schedules!.get(theirs.id)?.agentId, 'donna');
    assert.equal(state.schedules!.get(theirs.id)?.prompt, 'seeded');
  });

  it('own-agent list: a run lists only its own agent\'s schedules', async () => {
    seed('finley');
    seed('donna');
    seed('higgins');
    const { token } = await liveRun('finley');
    const r = await call(port, '/api/v1/schedules', 'GET', token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.schedules.map((s: ScheduledAction) => s.agentId), ['finley']);
  });

  it('cross-agent list refused: a run filtering on another agent still sees only its own schedules', async () => {
    seed('finley');
    seed('donna');
    const { token } = await liveRun('finley');
    const r = await call(port, '/api/v1/schedules?agent=donna', 'GET', token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.schedules.map((s: ScheduledAction) => s.agentId), ['finley']);
  });

  it('compatibility: the legacy agentId= query (higgins) is now harmlessly scoped to the calling agent', async () => {
    seed('higgins');
    seed('donna');
    seed('finley');
    const { token } = await liveRun('higgins');
    const own = await call(port, '/api/v1/schedules?agentId=higgins', 'GET', token);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.schedules.map((s: ScheduledAction) => s.agentId), ['higgins']);
    const other = await call(port, '/api/v1/schedules?agentId=donna', 'GET', token);
    assert.deepEqual(other.body.schedules.map((s: ScheduledAction) => s.agentId), ['higgins']);
  });

  it('compatibility: donna\'s and higgins\' current requests (own agentId, channelId null, agent= filter) keep their response shapes', async () => {
    const { token } = await liveRun('donna');
    const created = await call(port, '/api/v1/schedules', 'POST', token, {
      agentId: 'donna', name: 'Morning brief', cron: '0 6 * * *', prompt: 'brief me', timezone: 'America/Los_Angeles', channelId: null,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(typeof created.body.schedule.id, 'string');
    assert.equal(created.body.schedule.channelId, undefined);
    const listed = await call(port, '/api/v1/schedules?agent=donna', 'GET', token);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body.schedules));
    assert.equal(listed.body.schedules[0].id, created.body.schedule.id);
    const deleted = await call(port, `/api/v1/schedules/${encodeURIComponent(created.body.schedule.id)}`, 'DELETE', token);
    assert.deepEqual(deleted.body, { ok: true, deleted: true });
  });

  it('own-agent delete: a run deletes its own agent\'s schedule', async () => {
    const mine = seed('finley');
    const { token } = await liveRun('finley');
    const r = await call(port, `/api/v1/schedules/${mine.id}`, 'DELETE', token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, deleted: true });
    assert.equal(state.schedules!.get(mine.id), undefined);
  });

  it('cross-agent delete refused: another agent\'s schedule is a 404, identical to a missing one, and stays', async () => {
    const theirs = seed('donna');
    const { token } = await liveRun('finley');
    const deletesBefore = rows('SCHEDULE_DELETED').length;
    const foreign = await call(port, `/api/v1/schedules/${theirs.id}`, 'DELETE', token);
    const missing = await call(port, '/api/v1/schedules/sched-does-not-exist', 'DELETE', token);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign, missing, 'an existing foreign id must be indistinguishable from a missing one');
    assert.ok(state.schedules!.get(theirs.id));
    assert.equal(rows('SCHEDULE_DELETED').length, deletesBefore, 'a refused delete writes no SCHEDULE_DELETED row');
  });

  it('a run token whose run has ended is refused', async () => {
    const { run, token } = await liveRun('finley');
    state.runs.update(run.runId, { state: 'DONE' });
    assert.equal((await call(port, '/api/v1/schedules', 'GET', token)).status, 401);
    assert.equal((await call(port, '/api/v1/schedules', 'POST', token, { cron: '0 6 * * *', prompt: PROMPT })).status, 401);
  });

  it('operator fleet access: an operator lists every agent or filters with agent=, creates for any agent and deletes any schedule', async () => {
    seed('finley');
    const donnas = seed('donna');
    const all = await call(port, '/api/v1/schedules', 'GET', OPERATOR);
    assert.equal(all.body.schedules.length, 2);
    const filtered = await call(port, '/api/v1/schedules?agent=donna', 'GET', OPERATOR);
    assert.deepEqual(filtered.body.schedules.map((s: ScheduledAction) => s.agentId), ['donna']);
    const created = await call(port, '/api/v1/schedules', 'POST', OPERATOR, { agentId: 'higgins', id: 'sched-op-chosen', cron: '0 9 * * 1', prompt: PROMPT });
    assert.equal(created.status, 200);
    assert.equal(created.body.schedule.agentId, 'higgins');
    assert.equal(created.body.schedule.id, 'sched-op-chosen');
    const del = await call(port, `/api/v1/schedules/${donnas.id}`, 'DELETE', OPERATOR);
    assert.deepEqual(del.body, { ok: true, deleted: true });
    const again = await call(port, `/api/v1/schedules/${donnas.id}`, 'DELETE', OPERATOR);
    assert.deepEqual(again.body, { ok: true, deleted: false }, 'operators keep the existing missing-id response');
    assert.equal((await call(port, '/api/v1/schedules', 'POST', OPERATOR, { agentId: 'nobody', cron: '0 6 * * *', prompt: PROMPT })).status, 400);
  });

  it('operator fleet access: a viewer may list but not create or delete; no credential gets 401', async () => {
    const s = seed('donna');
    assert.equal((await call(port, '/api/v1/schedules', 'GET', VIEWER)).status, 200);
    assert.equal((await call(port, '/api/v1/schedules', 'POST', VIEWER, { agentId: 'donna', cron: '0 6 * * *', prompt: PROMPT })).status, 403);
    assert.equal((await call(port, `/api/v1/schedules/${s.id}`, 'DELETE', VIEWER)).status, 403);
    assert.ok(state.schedules!.get(s.id));
    assert.equal((await call(port, '/api/v1/schedules', 'GET')).status, 401);
  });

  it('invalid cron: an expression the scheduler cannot evaluate is refused with 400 and nothing is stored', async () => {
    const { token } = await liveRun('finley');
    for (const cron of ['0 6 * *', '61 * * * *', '0 24 * * *', '0 6 32 * *', '0 6 * 13 *', '0 6 * * 8', '0 6 * * MON', '5-2 * * * *', '*/0 * * * *', 'every day', '0 6 * * 1-5/2']) {
      const r = await call(port, '/api/v1/schedules', 'POST', token, { cron, prompt: PROMPT });
      assert.equal(r.status, 400, `accepted invalid cron "${cron}"`);
      assert.equal(r.body.error, cron === '' ? 'missing_cron' : 'invalid_cron');
    }
    assert.equal((await call(port, '/api/v1/schedules', 'POST', token, { cron: '0 6 * * *' })).body.error, 'missing_prompt');
    assert.equal((await call(port, '/api/v1/schedules', 'POST', token, { cron: '0 6 * * *', prompt: PROMPT, timezone: 'Mars/Olympus' })).body.error, 'invalid_timezone');
    assert.equal(state.schedules!.list().length, 0);
  });

  it('invalid cron: cronIssue accepts exactly the forms the scheduler evaluates', () => {
    for (const ok of ['* * * * *', '0 6 * * *', '30 7 * * 1-5', '0 9 * * 1', '*/15 * * * *', '0 0 1,15 * *', '0 8 * * 0,6', '0 8 * * 7', '59 23 31 12 *']) {
      assert.equal(cronIssue(ok), null, `refused valid cron "${ok}"`);
    }
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* * 0 * *', '* * * 0 *', '1-60 * * * *', 'a * * * *', '-1 * * * *', '*/x * * * *']) {
      assert.notEqual(cronIssue(bad), null, `accepted invalid cron "${bad}"`);
    }
  });

  it('ledger rows: create and delete record SCHEDULE_CREATED and SCHEDULE_DELETED with actor and agent, never the prompt text', async () => {
    const { run, token } = await liveRun('finley');
    const created = await call(port, '/api/v1/schedules', 'POST', token, { cron: '0 6 * * *', prompt: PROMPT, name: 'Daily report' });
    const id = created.body.schedule.id as string;
    await call(port, `/api/v1/schedules/${id}`, 'DELETE', token);
    const hash = scheduleLedgerHash(created.body.schedule);
    const c = rows('SCHEDULE_CREATED').find((e) => e.payloadSha256 === hash);
    const d = rows('SCHEDULE_DELETED').find((e) => e.payloadSha256 === hash);
    assert.ok(c && d);
    for (const row of [c, d]) {
      assert.equal(row.agentId, 'finley');
      assert.equal(row.runId, run.runId);
      assert.equal(row.actor, `run:finley:${run.runId}`);
      assert.ok(!JSON.stringify(row).includes(PROMPT), 'the prompt text must never reach the ledger');
    }
    const op = await call(port, '/api/v1/schedules', 'POST', OPERATOR, { agentId: 'donna', cron: '0 6 * * *', prompt: PROMPT });
    const opRow = rows('SCHEDULE_CREATED').find((e) => e.payloadSha256 === scheduleLedgerHash(op.body.schedule));
    assert.equal(opRow?.agentId, 'donna');
    assert.equal(opRow?.actor, 'token:operator');
    assert.equal(opRow?.runId, undefined);
  });
});
