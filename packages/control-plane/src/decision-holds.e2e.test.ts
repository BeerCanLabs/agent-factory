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
import { createFactoryServer, decideApproval, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, FileDocBackend, IdentityLinkStore, PrincipalStore, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { handleMcp } from './mcp.js';
import { githubLoginOf, holdDecider, parseCapUsd } from './decision-holds.js';

const VIEWER = 'viewer-decision-e2e';
const ADMIN = 'admin-decision-e2e';
const OPS = 'ops-decision-e2e';
const UNLINKED = 'unlinked-decision-e2e';
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
    approvers: ['DSackr', 'second-approver'],
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
        { name: 'ops', token: OPS, roles: ['viewer', 'admin'] },
        { name: 'unlinked', token: UNLINKED, roles: ['viewer', 'admin'] },
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
    // Dale's one GitHub login is on the holds' approvers; ops is linked to a login that is not; `unlinked` has none.
    state.identityLinks = new IdentityLinkStore(join(mkdtempSync(join(tmpdir(), 'decision-holds-')), 'links'));
    state.identityLinks.link('github', 'dsackr', 'token:dale', 'admin');
    state.identityLinks.link('github', 'ops-person', 'token:ops', 'admin');
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
    assert.equal(read.body.by, 'dsackr', 'by is the GitHub login recorded with the decision');
    // Never recomputed from later links: relinking the login afterwards changes nothing.
    state.identityLinks!.unlink('github', 'dsackr');
    state.identityLinks!.link('github', 'someone-else', 'token:dale', 'admin');
    assert.equal((await call(holdPath(), 'GET', token)).body.by, 'dsackr');
    // A decision is read, never spent.
    assert.equal(state.approvals.consume(h.approvalId), undefined);
  });

  it('a decision made after the run ended starts a run with the decision as input; MCP hands the capped decision to a human (E9)', async () => {
    const { run, token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, ask);
    state.runs.update(run.runId, { state: 'DONE' });
    const mcpRes = (await handleMcp(
      state,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId: h.approvalId, decision: 'approve', capUsd: '1200' } } },
      { actor: 'token:dale', roles: ['viewer', 'admin'] },
    )) as { result: { structuredContent: { status: string; challengeId: string } } };
    assert.equal(mcpRes.result.structuredContent.status, 'human_confirmation_required');
    // The challenge id the model sees is not a credential: replaying it as an argument mints a new challenge, decides nothing.
    const replay = (await handleMcp(
      state,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId: h.approvalId, decision: 'approve', capUsd: '1200', elicitationConfirmationToken: mcpRes.result.structuredContent.challengeId } } },
      { actor: 'token:dale', roles: ['viewer', 'admin'] },
    )) as { result: { structuredContent: { status: string } } };
    assert.equal(replay.result.structuredContent.status, 'human_confirmation_required');
    assert.equal(state.approvals.get(h.approvalId)?.state, 'pending');
    assert.equal(state.runs.list().some((r) => r.trigger === 'approval'), false);
    // The human decides (the confirmation page executes this same route as the signed-in principal).
    const out = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve', capUsd: '1200' });
    assert.equal(out.body.delivered, 'run');
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
  it('only a listed approver decides, by their single linked, non-bot GitHub login', async () => {
    const { token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, ask);
    assert.deepEqual(h.approvers, ['DSackr', 'second-approver']);
    const notListed = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', OPS, { decision: 'approve', capUsd: 10 });
    assert.equal(notListed.status, 403);
    assert.equal(notListed.body.error, 'not_an_approver');
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', UNLINKED, { decision: 'reject' })).status, 403, 'an admin with no linked login');
    const viaMcp = (await handleMcp(
      state,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId: h.approvalId, decision: 'approve', capUsd: 5 } } },
      { actor: 'token:ops', roles: ['viewer', 'admin'] },
    )) as { error?: { message: string }; result?: { isError?: boolean } };
    assert.ok(viaMcp.error || viaMcp.result?.isError, 'a refused decision is an MCP error');
    state.identityLinks!.link('github', 'dsackr-two', 'token:dale', 'admin');
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve' })).status, 403, 'two linked logins: none is the one');
    state.identityLinks!.unlink('github', 'dsackr-two');
    assert.equal(state.approvals.get(h.approvalId)?.state, 'pending', 'a refused decider leaves the hold open for the real approver');
    const ok = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve' });
    assert.equal(ok.status, 200, 'listed (case-insensitive) and linked');
    assert.equal((await call(holdPath(), 'GET', token)).body.by, 'dsackr');
    // A hold must name its approvers, and a bot login is never one.
    const { token: again } = await liveRun();
    for (const approvers of [undefined, [], ['flow-app[bot]'], ['ok', 42]]) {
      assert.equal((await call(holdPath('conductor', 'other-key'), 'PUT', again, { ...ask, id: 'other-key', approvers })).status, 400, JSON.stringify(approvers));
    }
  });

  describe('#524: a GitHub login linked to another actor of the same factory user', () => {
    const admin = (actor: string) => ({ actor, roles: ['viewer', 'admin'] }) as never;
    const mcpDecide = async (actor: string, approvalId: string) =>
      (await handleMcp(
        state,
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId, decision: 'reject' } } },
        admin(actor),
      )) as { result?: { isError?: boolean; structuredContent?: { error?: string; status?: string } } };

    beforeEach(async () => {
      // Production-shaped: the console signs Dale in as `user:dale.sackrider`; `github:dsackr` is linked to his Cloudflare
      // Access actor, an email the principal store has on that user. Eve is another person on file.
      const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(mkdtempSync(join(tmpdir(), 'decision-principals-')), 'principals.json')));
      await principals.create({ id: 'user:dale.sackrider', displayName: 'Dale', emails: ['dale.sackrider@gmail.com', 'dale@beercanlabs.com'], by: 'user:dale.sackrider' });
      await principals.create({ id: 'user:eve', displayName: 'Eve', emails: ['eve@example.com'], by: 'user:dale.sackrider' });
      state.principals = principals;
      state.identityLinks = new IdentityLinkStore(join(mkdtempSync(join(tmpdir(), 'decision-holds-')), 'links'));
      state.identityLinks.link('github', 'dsackr', 'cloudflare:dale.sackrider@gmail.com', 'service:deploy');
      state.identityLinks.link('github', 'ops-person', 'token:ops', 'admin');
    });
    after(() => {
      delete (state as { principals?: unknown }).principals;
    });

    it('the direct link still decides, and the login is found by the exact actor without the store', async () => {
      assert.equal(githubLoginOf(state, 'cloudflare:dale.sackrider@gmail.com'), 'dsackr');
      assert.equal(githubLoginOf(state, 'CLOUDFLARE:Dale.Sackrider@gmail.com'), 'dsackr', 'case-insensitive');
      const { token } = await liveRun();
      const { body: h } = await call(holdPath(), 'PUT', token, ask);
      const out = await decideApproval(state, h.approvalId, 'reject', admin('cloudflare:dale.sackrider@gmail.com'), 'direct link');
      assert.equal(out.status, 200);
      assert.equal((await call(holdPath(), 'GET', token)).body.by, 'dsackr');
    });

    it('the same person signed in as their factory user decides by the login linked to their Cloudflare actor (REST and MCP)', async () => {
      assert.equal(githubLoginOf(state, 'user:dale.sackrider'), 'dsackr');
      assert.equal(githubLoginOf(state, 'cloudflare:dale@beercanlabs.com'), 'dsackr', 'another email on the same user');
      const { token } = await liveRun();
      const { body: h } = await call(holdPath(), 'PUT', token, { ...ask, requiresCap: true });
      const viaMcp = await mcpDecide('user:dale.sackrider', h.approvalId);
      assert.notEqual(viaMcp.result?.structuredContent?.error, 'not_an_approver', 'MCP passes the approver check');
      assert.equal(state.approvals.get(h.approvalId)?.state, 'pending', 'MCP still asks the human to confirm');
      // Reject needs no cap, even on a hold that requires one to approve.
      const out = await decideApproval(state, h.approvalId, 'reject', admin('user:dale.sackrider'), 'not now');
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const read = (await call(holdPath(), 'GET', token)).body;
      assert.equal(read.state, 'rejected');
      assert.equal(read.by, 'dsackr', 'the GitHub login is what is recorded');
      assert.equal(read.decidedBy, 'user:dale.sackrider', 'the signed-in principal is who decided');
    });

    it('an unrelated principal is still refused, as is an actor merely shaped like the same email with no person on file', async () => {
      const { token } = await liveRun();
      const { body: h } = await call(holdPath(), 'PUT', token, ask);
      for (const actor of ['user:eve', 'cloudflare:eve@example.com', 'cloudflare:stranger@example.com', 'user:dale', 'token:ops']) {
        assert.equal(githubLoginOf(state, actor) === 'dsackr', false, actor);
        const out = await decideApproval(state, h.approvalId, 'reject', admin(actor));
        assert.equal(out.status, 403, actor);
        assert.equal((out.body as { error: string }).error, 'not_an_approver', actor);
      }
      const viaMcp = await mcpDecide('user:eve', h.approvalId);
      assert.equal(viaMcp.result?.isError, true);
      assert.equal(viaMcp.result?.structuredContent?.error, 'not_an_approver');
      // No principal record: `cloudflare:<email>` and `user:<email>` are not joined by the fallback id alone.
      state.identityLinks!.link('github', 'ghost-login', 'cloudflare:ghost@example.com', 'admin');
      assert.equal(githubLoginOf(state, 'user:ghost@example.com'), undefined);
      // Without a principal store, only the exact actor counts.
      const saved = state.principals;
      delete (state as { principals?: unknown }).principals;
      assert.equal(githubLoginOf(state, 'user:dale.sackrider'), undefined);
      state.principals = saved;
      assert.equal(state.approvals.get(h.approvalId)?.state, 'pending', 'refusals leave the hold for the real approver');
    });

    it('more than one distinct GitHub login across the same person\'s actors names none', async () => {
      const { token } = await liveRun();
      const { body: h } = await call(holdPath(), 'PUT', token, ask);
      state.identityLinks!.link('github', 'dsackr-alt', 'user:dale.sackrider', 'admin');
      assert.equal(githubLoginOf(state, 'user:dale.sackrider'), undefined);
      assert.equal(githubLoginOf(state, 'cloudflare:dale.sackrider@gmail.com'), undefined, 'ambiguous from either actor');
      const who = holdDecider(state, state.approvals.get(h.approvalId)!, 'user:dale.sackrider');
      assert.equal(who.ok, false);
      const out = await decideApproval(state, h.approvalId, 'reject', admin('user:dale.sackrider'));
      assert.equal(out.status, 403);
      assert.equal((out.body as { error: string }).error, 'not_an_approver');
      state.identityLinks!.unlink('github', 'dsackr-alt');
      assert.equal(githubLoginOf(state, 'user:dale.sackrider'), 'dsackr', 'one login again once the other is unlinked');
    });
  });

  it('a hold that requires a cap is never approved without one', async () => {
    const { token } = await liveRun();
    const { body: h } = await call(holdPath(), 'PUT', token, { ...ask, requiresCap: true });
    assert.equal(h.requiresCap, true);
    const none = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'cap_required');
    assert.equal((await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve', capUsd: 'lots' })).status, 400);
    const capped = await call(`/api/v1/approvals/${h.approvalId}`, 'POST', ADMIN, { decision: 'approve', capUsd: 1800 });
    assert.equal(capped.status, 200);
    assert.equal((await call(holdPath(), 'GET', token)).body.cap_usd, 1800);
    assert.equal((await call(holdPath('conductor', 'k2'), 'PUT', token, { ...ask, id: 'k2', requiresCap: 'yes' })).status, 400);
  });
});
