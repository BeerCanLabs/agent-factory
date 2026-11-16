// DESIGN_AUTHORITY.md GAP-259: a decision an agent asks a person for is a generic approval: published idempotently by the
// agent's run, holding nothing, read back in the shape a fleet conductor expects, decided once with an optional cap, and
// delivered through the existing decision path.
import { describe, it, before, after, beforeEach } from 'node:test';
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
import { ApprovalStore, IdentityLinkStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { handleMcp } from './mcp.js';
import { parseCapUsd } from './decision-holds.js';

const VIEWER = 'viewer-decision-e2e';
const ADMIN = 'admin-decision-e2e';
const SECRET = 'example-fake-masked-value-778899';
const KEY = 'plan-budget:BeerCanLabs/plan-intake#12@0123456789ab';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('GAP-259 decision holds', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const started: Array<{ runId: string }> = [];

  const call = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const holdPath = (agent = 'conductor', key = KEY) => `/api/v1/agents/${agent}/holds/${encodeURIComponent(key)}`;
  const ask = {
    id: KEY,
    kind: 'plan-budget',
    title: 'Plan budget for BeerCanLabs/plan-intake#12',
    summary: `Estimated $1,800 across 6 stories. ${SECRET}`,
    link: 'https://github.com/BeerCanLabs/plan-intake/issues/12',
    budget: 1800,
    target: { repo: 'BeerCanLabs/plan-intake', number: 12 },
    plan_id: 'plan-12',
  };
  const liveRun = async (agentId = 'conductor', extra: Record<string, unknown> = {}) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'test', trigger: 'webhook', ...extra } as never);
    return { run, token: await state.runTokens!.mint({ runId: run.runId, agentId }) };
  };

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'dale', token: ADMIN, roles: ['viewer', 'admin'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: { ...noopRuntime(), async start(_agent: unknown, run: { runId: string }) { started.push(run); } },
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('decision-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      identityLinks: new IdentityLinkStore(join(mkdtempSync(join(tmpdir(), 'decision-holds-')), 'links')),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>([SECRET]),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  beforeEach(() => {
    for (const id of ['conductor', 'other']) {
      state.agents.set(id, { id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: `/agents/${id}` } as never);
    }
    state.runs = new MemoryRunStore();
    state.approvals = new ApprovalStore();
    state.mailboxes = new Map();
    started.length = 0;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('PUT creates a pending decision once, holds no run, and asking again returns the same one unchanged', async () => {
    const { run, token } = await liveRun();
    const first = await call(holdPath(), 'PUT', token, ask);
    assert.equal(first.status, 201);
    assert.equal(first.body.state, 'pending');
    assert.equal(first.body.cap_usd, null);
    assert.equal(first.body.by, null);
    assert.equal(first.body.requestKey, KEY);
    assert.equal(first.body.kind, 'plan-budget');
    assert.deepEqual(first.body.payload, { budget: 1800, target: { repo: 'BeerCanLabs/plan-intake', number: 12 }, plan_id: 'plan-12' });
    assert.ok(!first.body.summary.includes(SECRET), 'a known secret value is masked');
    const again = await call(holdPath(), 'PUT', token, { ...ask, title: 'Something else' });
    assert.equal(again.status, 200);
    assert.equal(again.body.approvalId, first.body.approvalId);
    assert.equal(again.body.title, ask.title, 'asking again never changes what was asked');
    assert.equal(state.runs.get(run.runId)?.state, 'WORKING', 'nothing waits for the decision');
    assert.equal(state.ledger.query({}).filter((e) => e.action === 'DECISION_REQUESTED').length, 1);
  });

  it('GET reads the hold back; 404 before it exists; a person reads it as an approval, by id, and lists filter by kind', async () => {
    const { token } = await liveRun();
    assert.equal((await call(holdPath(), 'GET', token)).status, 404);
    const created = await call(holdPath(), 'PUT', token, ask);
    const read = await call(holdPath(), 'GET', token);
    assert.equal(read.status, 200);
    assert.equal(read.body.state, 'pending');
    assert.equal((await call(holdPath(), 'GET', VIEWER)).body.approvalId, created.body.approvalId);
    const one = await call(`/api/v1/approvals/${created.body.approvalId}`, 'GET', VIEWER);
    assert.equal(one.status, 200);
    assert.equal(one.body.kind, 'decision');
    assert.equal(one.body.hold.requestKey, KEY);
    assert.equal((await call('/api/v1/approvals/nope', 'GET', VIEWER)).status, 404);
    assert.equal((await call('/api/v1/approvals?kind=decision', 'GET', VIEWER)).body.length, 1);
    assert.equal((await call('/api/v1/approvals?kind=held', 'GET', VIEWER)).body.length, 0);
    assert.equal((await call('/api/v1/approvals?kind=bogus', 'GET', VIEWER)).status, 400);
    const mcp = (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_approvals', arguments: { kind: 'decision' } } }, { actor: 'viewer', roles: ['viewer'] })) as {
      result: { content: Array<{ text: string }> };
    };
    assert.equal(JSON.parse(mcp.result.content[0].text).length, 1);
  });

  it('only the agent itself asks, from a live, non-helper run; a person cannot publish; bad holds are refused', async () => {
    const { token } = await liveRun('other');
    assert.equal((await call(holdPath(), 'PUT', token, ask)).status, 403, 'another agent may not ask under this name');
    assert.equal((await call(holdPath(), 'GET', token)).status, 403);
    assert.equal((await call(holdPath(), 'PUT', ADMIN, ask)).status, 401, 'a person does not publish an agent hold');
    assert.equal((await call(holdPath(), 'PUT', 'not-a-token', ask)).status, 401);
    const helper = await liveRun('conductor', { parentRunId: 'run-parent', parentAgentId: 'boss' });
    assert.equal((await call(holdPath(), 'PUT', helper.token, ask)).status, 403);
    const { token: mine } = await liveRun();
    assert.equal((await call(holdPath(), 'PUT', mine, { ...ask, title: '' })).status, 400);
    assert.equal((await call(holdPath(), 'PUT', mine, { ...ask, link: 'http://example.com' })).status, 400);
    assert.equal((await call(holdPath(), 'PUT', mine, { ...ask, id: 'feature:x/y#1' })).status, 400);
    assert.equal((await call(holdPath(), 'PUT', mine, { ...ask, payload: { blob: 'x'.repeat(40_000) } })).status, 400);
    assert.equal((await call(holdPath('conductor', 'bad key with spaces'), 'PUT', mine, ask)).status, 400);
    assert.equal(state.approvals.list({}).length, 0);
  });

  it('approving with a cap records it once, in the ledger, and delivers requestKey, decision and cap to the live run', async () => {
    const { run, token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, ask);
    const decided = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve', notes: 'go', capUsd: '$2,500.00' });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.delivered, 'mailbox');
    assert.equal(state.runs.get(run.runId)?.state, 'WORKING');
    const delivered = JSON.stringify(state.mailboxes!.get('conductor')!.messages);
    for (const s of [KEY, '"capUsd":2500', '"decision":"approved"', '"approval-decided"', '"notes":"go"']) assert.ok(delivered.includes(s), s);
    const row = state.ledger.query({}).find((e) => e.action === 'APPROVAL_GRANTED');
    assert.equal(row?.capUsd, 2500);
    assert.equal(row?.requestId, KEY);
    assert.ok(state.ledger.query({}).some((e) => e.action === 'HOLD_CLEARED'));
    // Decided once.
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'reject' })).status, 409);
    const read = await call(holdPath(), 'GET', token);
    assert.equal(read.body.state, 'approved');
    assert.equal(read.body.cap_usd, 2500);
    assert.equal(read.body.comment, 'go');
    assert.equal(read.body.by, decided.body.decidedBy, 'without a linked GitHub login, by is the principal');
    // With one: `by` is the login a fleet checks its approvers against.
    state.identityLinks!.link('github', 'dsackr', decided.body.decidedBy, 'admin');
    assert.equal((await call(holdPath(), 'GET', token)).body.by, 'dsackr');
    // A decision is read, never spent.
    assert.equal(state.approvals.consume(h.approvalId), undefined);
  });

  it('a decision made after the run ended starts a run with the decision as input; MCP decides with a cap too', async () => {
    const { run, token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, ask);
    state.runs.update(run.runId, { state: 'DONE' });
    const out = (await handleMcp(
      state,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId: h.approvalId, decision: 'approve', capUsd: '1200' } } },
      { actor: 'dale', roles: ['viewer', 'admin'] },
    )) as { result: { content: Array<{ text: string }> } };
    assert.equal(JSON.parse(out.result.content[0].text).delivered, 'run');
    const fresh = state.runs.list().find((r) => r.trigger === 'approval');
    assert.ok(fresh);
    const input = JSON.stringify(fresh!.input);
    for (const s of [KEY, '"capUsd":1200', '"type":"approval-decided"', '"message"']) assert.ok(input.includes(s), s);
    assert.equal((await call(holdPath(), 'GET', token)).status, 401, 'an ended run reads nothing');
    assert.equal((await call(holdPath(), 'GET', VIEWER)).body.cap_usd, 1200);
  });

  it('a cap is refused on a rejection, on anything but a decision, and when it is not an amount', async () => {
    const { token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, ask);
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'reject', capUsd: 10 })).status, 400);
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve', capUsd: 'lots' })).status, 400);
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', VIEWER, { decision: 'approve' })).status, 403, 'deciders stay who they were');
    const rejected = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'reject', notes: 'too much' });
    assert.equal(rejected.status, 200);
    const read = await call(holdPath(), 'GET', token);
    assert.equal(read.body.state, 'rejected');
    assert.equal(read.body.cap_usd, null);
    assert.equal(read.body.comment, 'too much');
  });

  it('parseCapUsd reads the amounts a person types and nothing else', () => {
    assert.equal(parseCapUsd(2500), 2500);
    assert.equal(parseCapUsd('2500'), 2500);
    assert.equal(parseCapUsd('$2,500.50'), 2500.5);
    assert.equal(parseCapUsd('$ 40'), 40);
    for (const bad of [-1, Number.NaN, '2,50', '1e3', '$', 'ten', '2500.123', true]) assert.equal(parseCapUsd(bad), null, String(bad));
  });
});
