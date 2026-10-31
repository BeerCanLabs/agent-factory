// E3.2 (#299): a helper's GitHub calls carry its parent's key, added by the gatekeeper, and are read-only whatever the parent may do.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('helper-github-test-run-token-key-0123456789');

function send(port: number, method: string, path: string, token: string, body?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('helper GitHub through the parent (E3.2)', { concurrency: false }, () => {
  const seen: Array<{ method: string; auth?: string }> = [];
  let upstream: http.Server;
  let gk: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;
  const control: ControlClient = {
    async runContext(runId) { return runId === ctx.run.runId ? structuredClone(ctx) : null; },
    async requestApproval() { return { approvalId: 'unused', state: 'pending' }; },
    async consumeApproval() { return false; },
    async ledger() {},
  };
  const secrets: Record<string, string> = { REVIEWER_GITHUB_TOKEN: 'reviewer-key', 'JUROR_HELPER_1_GITHUB_TOKEN': 'helper-own-key' };

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method ?? '', auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = (upstream.address() as { port: number }).port;
    gk = createGatekeeperEgress({
      routes: [
        { id: 'github', kind: 'http', upstream: `http://127.0.0.1:${up}`, credential: { secret: '{agent}_GITHUB_TOKEN', header: 'authorization', format: 'Bearer {}', fallback: false } },
        { id: 'conn', kind: 'http', upstream: `http://127.0.0.1:${up}`, connection: 'github-app' },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 't', async get(n) { return secrets[n]; } }],
      contextTtlMs: 0,
    });
    await new Promise<void>((r) => gk.listen(0, '127.0.0.1', r));
    port = (gk.address() as { port: number }).port;
  });
  after(async () => { for (const s of [gk, upstream]) await new Promise<void>((r) => s.close(() => r())); });
  const helper = async (parent: string, routes = ['github', 'conn']) => {
    seen.length = 0;
    const runId = `helper-run-${++seq}`;
    ctx = { run: { runId, agentId: 'juror.helper.1', state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes }, spend: { run: 0, day: 0, month: 0 }, budgetOf: 'parent', helperOf: parent };
    token = await tokens.mint({ runId, agentId: 'juror.helper.1' });
  };
  beforeEach(() => helper('reviewer'));

  it('a read goes out with the parent key, never a key of the helper', async () => {
    const r = await send(port, 'GET', '/github/repos/o/r/pulls/1', token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seen, [{ method: 'GET', auth: 'Bearer reviewer-key' }]);
  });

  for (const [method, path] of [['POST', '/github/repos/o/r/issues'], ['PUT', '/github/repos/o/r/pulls/1/merge'], ['DELETE', '/github/repos/o/r']]) {
    it(`a write (${method}) is 403 read_only_route, even though the route itself allows writes`, async () => {
      const r = await send(port, method, path, token, method === 'DELETE' ? undefined : '{}');
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'read_only_route');
      assert.equal(seen.length, 0);
    });
  }

  it('a parent with no GitHub key: the read is refused, nothing goes out', async () => {
    await helper('nobody');
    const r = await send(port, 'GET', '/github/repos/o/r', token);
    assert.ok(r.status >= 400, JSON.stringify(r.body));
    assert.equal(seen.length, 0);
  });

  it('a helper without the github route (its parent has none) is 403', async () => {
    await helper('reviewer', []);
    const r = await send(port, 'GET', '/github/repos/o/r', token);
    assert.equal(r.status, 403);
    assert.equal(seen.length, 0);
  });

  it('a helper reaches no connection route', async () => {
    const r = await send(port, 'GET', '/conn/x', token);
    assert.equal(r.status, 403);
    assert.equal(seen.length, 0);
  });
});
