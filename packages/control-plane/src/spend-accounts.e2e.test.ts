// DESIGN_AUTHORITY.md GAP-253: spend is charged to a plan through the runs a conductor wakes, and the conductor hears
// `budget-update {repo, pr, spent_usd}` when the plan crosses a spend step or a charged run ends. No timer, no poll.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, finishRun, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendAccountStore } from './spend-accounts.js';

const EGRESS = 'egress-spend-accounts';
const PLAN = 'plan:BeerCanLabs/plan-intake#12';

async function call(port: number, path: string, method: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('GAP-253 per-plan spend and budget-update', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('spend-accounts-run-token-key-0123456789abcd');
  const dir = mkdtempSync(join(tmpdir(), 'spend-accounts-e2e-'));
  let conductor: { runId: string; token: string };

  const spend = (agentId: string, runId: string, usd: number) =>
    call(port, '/api/v1/ledger', 'POST', EGRESS, { agentId, runId, type: 'llm', actor: `run:${agentId}`, model: 'grok-4', inputTokens: 10, outputTokens: 10, costUsd: usd });
  const wake = (from: { runId: string; token: string }, target: string, extra: Record<string, unknown> = {}) =>
    call(port, `/api/v1/runs/${from.runId}/wake/${target}`, 'POST', from.token, { input: { message: 'go' }, ...extra });
  const tokenOf = async (runId: string, agentId: string) => ({ runId, token: await tokens.mint({ runId, agentId }) });
  const updates = () => state.ledger.query({}).filter((e) => e.action === 'BUDGET_UPDATE_SENT');

  before(async () => {
    state = {
      registryDir: dir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      approvals: new ApprovalStore(),
      policies: new PolicyStore(join(dir, 'policies')),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: { 'grok-4': {} },
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  beforeEach(async () => {
    for (const id of ['conductor', 'coder', 'reviewer']) state.agents.set(id, { id, name: id, state: 'SLEEPING', roles: [], requires: [] } as never);
    state.policies.set('conductor', { routes: [], wakeAgents: ['coder', 'reviewer'] } as never);
    state.policies.set('coder', { routes: [], wakeAgents: ['reviewer'] } as never);
    state.runs = new MemoryRunStore();
    state.mailboxes = new Map();
    state.spendAccounts = new SpendAccountStore(join(dir, `accounts-${Math.random()}.json`));
    state.ledger = new MemoryLedger();
    const run = state.runs.create({ agentId: 'conductor', state: 'WORKING', actor: 'test', trigger: 'webhook' } as never);
    conductor = await tokenOf(run.runId, 'conductor');
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('a woken run is charged to the plan its waker names; crossing a $5 step tells the live conductor in its mailbox', async () => {
    const woke = await wake(conductor, 'coder', { spendAccount: PLAN });
    assert.ok(woke.status < 300, JSON.stringify(woke.body));
    const coderRun = woke.body.runId as string;
    await spend('coder', coderRun, 3);
    assert.equal(updates().length, 0, 'under a step: nothing yet');
    await spend('coder', coderRun, 2.5);
    const [mail] = state.mailboxes!.get('conductor')!.messages;
    assert.deepEqual((mail.payload as { event: unknown }).event, { type: 'budget-update', repo: 'BeerCanLabs/plan-intake', pr: 12, spent_usd: 5.5 });
    assert.match((mail.payload as { message: string }).message, /budget-update/);
    assert.equal(updates()[0].requestId, PLAN);
    assert.equal(updates()[0].costUsd, 5.5);
    assert.equal(state.spend.get('coder', coderRun).day, 5.5, 'the agent is still charged as before');
  });

  it('runs a charged run wakes inherit the plan; a charged run that ends reports once, as a new conductor run when none is live', async () => {
    const coder = await wake(conductor, 'coder', { spendAccount: PLAN });
    const coderTok = await tokenOf(coder.body.runId, 'coder');
    state.runs.update(coder.body.runId, { state: 'WORKING' });
    const reviewer = await wake(coderTok, 'reviewer');
    assert.ok(reviewer.status < 300, JSON.stringify(reviewer.body));
    await spend('reviewer', reviewer.body.runId, 1.25);
    await finishRun(state, conductor.runId, 'DONE', { actor: 'test' });
    const reviewerTok = await tokenOf(reviewer.body.runId, 'reviewer');
    state.runs.update(reviewer.body.runId, { state: 'WORKING' });
    assert.equal((await call(port, `/api/v1/runs/${reviewer.body.runId}/result`, 'POST', reviewerTok.token, { status: 'succeeded', output: 'ok' })).status, 200);
    const started = state.runs.list({ agentId: 'conductor' }).find((r) => r.trigger === 'spend');
    assert.ok(started, 'the conductor is woken with the update');
    assert.deepEqual((started!.input as { event: unknown }).event, { type: 'budget-update', repo: 'BeerCanLabs/plan-intake', pr: 12, spent_usd: 1.25 });
    // Nothing new: the coder's end reports nothing.
    state.runs.update(coder.body.runId, { state: 'WORKING' });
    await call(port, `/api/v1/runs/${coder.body.runId}/result`, 'POST', coderTok.token, { status: 'succeeded', output: 'ok' });
    assert.equal(updates().length, 1);
  });

  it('an uncharged wake changes nothing; a bad account is refused; spend survives a restart', async () => {
    const plain = await wake(conductor, 'coder');
    await spend('coder', plain.body.runId, 9);
    assert.equal(updates().length, 0);
    for (const bad of ['plan:nope', 'feature:o/r#1', 'plan:o/r#0', 42]) assert.equal((await wake(conductor, 'coder', { spendAccount: bad })).status, 400, String(bad));
    const file = join(dir, 'restart.json');
    state.spendAccounts = new SpendAccountStore(file);
    const woke = await wake(conductor, 'coder', { spendAccount: PLAN });
    await spend('coder', woke.body.runId, 2);
    const again = new SpendAccountStore(file);
    assert.equal(again.get(PLAN)?.spentUsd, 2);
    assert.equal(again.accountOf(woke.body.runId)?.owner, 'conductor');
  });
});
