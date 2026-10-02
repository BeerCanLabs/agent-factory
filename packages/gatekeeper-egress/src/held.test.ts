// DESIGN_AUTHORITY.md §6.3.1 E9: a request an agent makes in a person's name is held for that person. Nothing is sent
// until an approver approves the reviewable copy; then the identical request is released once.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, HELD_BODY_LIMIT, type ControlClient, type HoldOutcome, type HoldRequest, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('gatekeeper-egress-held-test-run-token-key-0123');
const ACCESS = 'linkedin-access-value-for-tests';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, opts: { token: string; method?: string; body?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; json: () => any }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${opts.token}`, ...(opts.headers ?? {}) };
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

type Hold = HoldRequest & HoldOutcome & { agentId: string };

describe('E9 held requests: the gatekeeper-egress holds what an agent sends in a person\'s name', { concurrency: false }, () => {
  const seen: Array<{ method: string; path: string; auth?: string; body: string }> = [];
  const holds: Hold[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  let upstream: http.Server;
  let gk: http.Server;
  let bare: http.Server;
  let port = 0;
  let barePort = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;

  // The control plane's hold semantics (policy.ts ApprovalStore.hold), in memory.
  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      return { approvalId: 'unused', state: 'pending' };
    },
    async holdRequest(req) {
      const agentId = ctx.run.agentId;
      const same = holds.filter((h) => h.agentId === agentId && h.route === req.route && h.argsSha256 === req.argsSha256);
      const open = same.find((h) => h.state === 'pending' || h.state === 'approved');
      if (open) return { approvalId: open.approvalId, state: open.state };
      const rejected = same.find((h) => h.state === 'rejected');
      if (rejected) return { approvalId: rejected.approvalId, state: 'rejected', notes: rejected.notes };
      const h: Hold = { ...structuredClone(req), agentId, approvalId: `hold-${holds.length + 1}`, state: 'pending' };
      holds.push(h);
      return { approvalId: h.approvalId, state: 'pending' };
    },
    async consumeApproval(id) {
      const h = holds.find((x) => x.approvalId === id);
      if (h?.state !== 'approved') return false;
      h.state = 'consumed';
      return true;
    },
    async connectionToken() {
      return { ok: true, accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async ledger(event) {
      ledger.push(event);
    },
  };
  const decide = (id: string, state: 'approved' | 'rejected', notes?: string) => {
    const h = holds.find((x) => x.approvalId === id)!;
    h.state = state;
    if (notes) h.notes = notes;
  };
  const post = JSON.stringify({ author: 'urn:li:person:abc', commentary: 'Shipping the factory.', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
  const route = (upPort: number) => ({
    id: 'linkedin',
    kind: 'http' as const,
    upstream: `http://127.0.0.1:${upPort}`,
    connection: 'linkedin',
    hold: { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], preview: 'linkedin-post' },
  });

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
        res.writeHead(201, { 'content-type': 'application/json', 'x-restli-id': 'urn:li:share:1' });
        res.end('{}');
      });
    });
    const upPort = await listen(upstream);
    gk = createGatekeeperEgress({ routes: [route(upPort)], prices: {}, runTokens: tokens, control, providers: [], contextTtlMs: 0 });
    port = await listen(gk);
    const { holdRequest: _omit, ...withoutHolds } = control;
    bare = createGatekeeperEgress({ routes: [route(upPort)], prices: {}, runTokens: tokens, control: withoutHolds, providers: [], contextTtlMs: 0 });
    barePort = await listen(bare);
  });

  after(async () => {
    for (const s of [gk, bare, upstream]) await new Promise<void>((r) => s.close(() => r()));
  });

  beforeEach(async () => {
    seen.length = 0;
    holds.length = 0;
    ledger.length = 0;
    const runId = `held-run-${++seq}`;
    ctx = {
      run: { runId, agentId: 'castle', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['linkedin'] },
      spend: { run: 0, day: 0, month: 0 },
    };
    token = await tokens.mint({ runId, agentId: 'castle' });
  });

  it('E9 a write on a held route is held: 202, nothing is sent, and the reviewable copy is exactly the request', async () => {
    const r = await call(port, '/linkedin/rest/posts', { token, body: post, headers: { 'linkedin-version': '202509', 'x-restli-protocol-version': '2.0.0' } });
    assert.equal(r.status, 202);
    assert.equal(r.json().status, 'held');
    assert.equal(r.json().approvalId, 'hold-1');
    assert.equal(seen.length, 0, 'nothing reached LinkedIn');
    const [h] = holds;
    assert.equal(h.request.method, 'POST');
    assert.equal(h.request.path, '/rest/posts');
    assert.equal(h.request.body, post);
    assert.equal(h.request.bodyEncoding, 'utf8');
    assert.equal(h.request.preview, 'linkedin-post');
    assert.equal(h.request.headers['linkedin-version'], '202509');
    assert.ok(!JSON.stringify(h).includes(ACCESS), 'the copy never carries the credential');
    assert.ok(ledger.some((e) => e.action === 'HELD_FOR_APPROVAL' && e.approvalId === 'hold-1'));
  });

  it('E9 asking again before a decision returns the same hold, still sending nothing', async () => {
    await call(port, '/linkedin/rest/posts', { token, body: post });
    const again = await call(port, '/linkedin/rest/posts', { token, body: post });
    assert.equal(again.status, 202);
    assert.equal(again.json().approvalId, 'hold-1');
    assert.equal(holds.length, 1);
    assert.equal(seen.length, 0);
  });

  it('E9 reads are not held: a GET goes straight through with the injected credential', async () => {
    const r = await call(port, '/linkedin/v2/userinfo', { token, method: 'GET' });
    assert.equal(r.status, 201);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, `Bearer ${ACCESS}`);
    assert.equal(holds.length, 0);
  });

  it('E9 approval releases the identical request once, with the credential injected only then', async () => {
    const held = await call(port, '/linkedin/rest/posts', { token, body: post });
    decide(held.json().approvalId, 'approved');
    const released = await call(port, '/linkedin/rest/posts', { token, body: post });
    assert.equal(released.status, 201);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, post);
    assert.equal(seen[0].auth, `Bearer ${ACCESS}`);
    assert.ok(ledger.some((e) => e.action === 'HELD_REQUEST_RELEASED' && e.approvalId === 'hold-1'));

    // Once: the same post again is a new request, held again.
    const twice = await call(port, '/linkedin/rest/posts', { token, body: post });
    assert.equal(twice.status, 202);
    assert.equal(twice.json().approvalId, 'hold-2');
    assert.equal(seen.length, 1);
  });

  it('E9 an approval is for what was reviewed: a changed body, path or operation header is held, never released', async () => {
    const held = await call(port, '/linkedin/rest/posts', { token, body: post });
    decide(held.json().approvalId, 'approved');
    const edited = await call(port, '/linkedin/rest/posts', { token, body: post.replace('Shipping', 'Selling') });
    assert.equal(edited.status, 202);
    const elsewhere = await call(port, '/linkedin/rest/posts?x=1', { token, body: post });
    assert.equal(elsewhere.status, 202);
    const asDelete = await call(port, '/linkedin/rest/posts', { token, body: post, headers: { 'x-restli-method': 'DELETE' } });
    assert.equal(asDelete.status, 202);
    assert.equal(seen.length, 0);
    assert.equal(holds.find((h) => h.approvalId === 'hold-1')?.state, 'approved', 'the approved request is still waiting to be sent');
  });

  it('E9 rejection sends nothing and returns the approver\'s notes; the identical request stays refused', async () => {
    const held = await call(port, '/linkedin/rest/posts', { token, body: post });
    decide(held.json().approvalId, 'rejected', 'Too salesy. Lead with the outage story.');
    const r = await call(port, '/linkedin/rest/posts', { token, body: post });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, 'rejected_by_approver');
    assert.equal(r.json().notes, 'Too salesy. Lead with the outage story.');
    assert.equal(seen.length, 0);
  });

  it('E9 fails closed: with no way to hold, or a body too large to review, nothing is sent', async () => {
    const noHolds = await call(barePort, '/linkedin/rest/posts', { token, body: post });
    assert.equal(noHolds.status, 503);
    assert.equal(noHolds.json().error, 'hold_unavailable');
    const huge = await call(port, '/linkedin/rest/posts', { token, body: JSON.stringify({ commentary: 'x'.repeat(HELD_BODY_LIMIT) }) });
    assert.equal(huge.status, 413);
    assert.equal(seen.length, 0);
  });
});
