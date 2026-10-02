// DESIGN_AUTHORITY.md §6.3.1 E9 (GAP-066, GAP-017): the control plane keeps a reviewable copy of a held request,
// approvers decide on it with notes, the decision goes to the agent, and no run waits for it.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';

const VIEWER = 'viewer-held-e2e';
const APPROVER = 'approver-held-e2e';
const GATEKEEPER_EGRESS = 'gatekeeper-egress-held-e2e';
const SECRET = 'example-fake-masked-value-123456';

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

const POST = JSON.stringify({ author: 'urn:li:person:abc', commentary: `Shipping the factory. ${SECRET}`, visibility: 'PUBLIC' });
const sha = (n: number) => n.toString(16).padStart(64, '0');

describe('E9 held requests in the control plane', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const started: string[] = [];

  const hold = (runId: string, argsSha256 = sha(1), body = POST) =>
    call(port, '/api/v1/gatekeeper-egress/holds', 'POST', GATEKEEPER_EGRESS, {
      runId,
      route: 'linkedin',
      argsSha256,
      request: { method: 'post', path: '/rest/posts', headers: { 'content-type': 'application/json' }, body, bodyEncoding: 'utf8', preview: 'linkedin-post' },
    });
  const decide = (id: string, decision: string, notes?: string, token = APPROVER) => call(port, `/api/v1/approvals/${id}`, 'POST', token, { decision, notes });
  const liveRun = () => state.runs.create({ agentId: 'castle', state: 'WORKING', actor: 'test', trigger: 'discord' });

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'dale', token: APPROVER, roles: ['viewer', 'approver'] },
        { name: 'gatekeeper-egress', token: GATEKEEPER_EGRESS, roles: ['gatekeeper-egress'] },
      ]),
      version: '0.1.0-test',
      providers: [],
      runtime: { ...noopRuntime(), async start(_agent: unknown, run: { runId: string }) { started.push(run.runId); } },
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('held-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>([SECRET]),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  beforeEach(() => {
    state.agents.set('castle', { id: 'castle', name: 'Castle', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/castle' } as never);
    state.runs = new MemoryRunStore();
    state.approvals = new ApprovalStore();
    state.mailboxes = new Map();
    started.length = 0;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('E9 GAP-017 approvers can read exactly what would be sent, with known secrets masked, and the run is not blocked', async () => {
    const run = liveRun();
    const created = await hold(run.runId);
    assert.equal(created.status, 201);
    assert.equal(created.body.state, 'pending');
    const list = await call(port, '/api/v1/approvals?state=pending', 'GET', VIEWER);
    assert.equal(list.body.length, 1);
    const [a] = list.body;
    assert.equal(a.kind, 'held');
    assert.equal(a.agentId, 'castle');
    assert.equal(a.tool, 'POST /rest/posts');
    assert.equal(a.request.method, 'POST');
    assert.equal(a.request.preview, 'linkedin-post');
    assert.ok(a.request.body.includes('Shipping the factory.'));
    assert.ok(!a.request.body.includes(SECRET), 'a known secret value is masked in the copy');
    assert.equal(state.runs.get(run.runId)?.state, 'WORKING', 'no run waits for the review');
    assert.ok(state.ledger.query({}).some((e) => e.action === 'REQUEST_HELD'));
  });

  it('E9 the identical request finds its hold, across runs of the same agent; another agent gets its own', async () => {
    const first = await hold(liveRun().runId);
    const again = await hold(liveRun().runId);
    assert.equal(again.status, 200);
    assert.equal(again.body.approvalId, first.body.approvalId);
    const other = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'test', trigger: 'test' });
    const theirs = await hold(other.runId);
    assert.notEqual(theirs.body.approvalId, first.body.approvalId);
  });

  it('E9 only an approver decides; approval is delivered to the live run\'s mailbox and released once', async () => {
    const run = liveRun();
    const { body } = await hold(run.runId);
    assert.equal((await decide(body.approvalId, 'approve', undefined, VIEWER)).status, 403);
    const ok = await decide(body.approvalId, 'approve');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.delivered, 'mailbox');
    const msg = state.mailboxes!.get('castle')!.messages[0].payload as Record<string, unknown>;
    assert.equal(msg.type, 'approval');
    assert.equal(msg.decision, 'approved');
    assert.equal(msg.approvalId, body.approvalId);

    const ready = await hold(run.runId);
    assert.equal(ready.body.state, 'approved');
    const consume = (id: string) => call(port, `/api/v1/gatekeeper-egress/approvals/${id}/consume`, 'POST', GATEKEEPER_EGRESS);
    assert.equal((await consume(body.approvalId)).status, 200);
    assert.equal((await consume(body.approvalId)).status, 409, 'released once');
    const next = await hold(run.runId);
    assert.equal(next.status, 201, 'the same request after release is a new hold');
  });

  it('E9 a decision with no live run wakes the agent with it; notes travel with a rejection', async () => {
    const run = liveRun();
    const { body } = await hold(run.runId);
    state.runs.update(run.runId, { state: 'DONE' });
    const out = await decide(body.approvalId, 'reject', 'Too salesy. Lead with the outage story.');
    assert.equal(out.status, 200);
    assert.equal(out.body.delivered, 'run');
    const woke = state.runs.list({ agentId: 'castle' }).find((r) => r.trigger === 'approval');
    assert.ok(woke, 'a new run carries the decision');
    const input = woke!.input as Record<string, unknown>;
    assert.equal(input.decision, 'rejected');
    assert.equal(input.notes, 'Too salesy. Lead with the outage story.');

    const refused = await hold(liveRun().runId);
    assert.equal(refused.body.state, 'rejected', 'the identical rejected request stays refused');
    assert.equal(refused.body.notes, 'Too salesy. Lead with the outage story.');
    const revised = await hold(liveRun().runId, sha(2));
    assert.equal(revised.status, 201, 'a revised request is a new hold');
  });

  it('E9 refuses malformed holds and callers other than the gatekeeper-egress', async () => {
    const run = liveRun();
    assert.equal((await call(port, '/api/v1/gatekeeper-egress/holds', 'POST', VIEWER, {})).status, 403);
    const bad = await call(port, '/api/v1/gatekeeper-egress/holds', 'POST', GATEKEEPER_EGRESS, { runId: run.runId, route: 'linkedin', argsSha256: 'nope', request: {} });
    assert.equal(bad.status, 400);
    assert.equal((await decide('missing', 'maybe')).status, 400);
  });
});
