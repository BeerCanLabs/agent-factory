// E3.1 (#298): a read-only route forwards reads and refuses writes with 403 read_only_route; nothing refused reaches upstream.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, routeProblem, type ControlClient, type RunContext } from './gatekeeper-egress.js';
import { operationsAreQueries } from './read-only.js';

const tokens = new RunTokens('read-only-test-run-token-key-0123456789ab');

function send(port: number, method: string, path: string, token: string, body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, (res) => {
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

const gql = (query: unknown) => JSON.stringify({ query });

describe('a read-only github route (E3.1)', { concurrency: false }, () => {
  const seen: Array<{ method: string; url: string; auth?: string }> = [];
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

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = (upstream.address() as { port: number }).port;
    gk = createGatekeeperEgress({
      routes: [
        { id: 'github', kind: 'http', upstream: `http://127.0.0.1:${up}`, credential: { secret: 'GH', header: 'authorization', format: 'token {}' }, readOnly: true },
        { id: 'github-rw', kind: 'http', upstream: `http://127.0.0.1:${up}`, credential: { secret: 'GH', header: 'authorization', format: 'token {}' } },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 't', async get(n) { return n === 'GH' ? 'gh-secret' : undefined; } }],
      contextTtlMs: 0,
    });
    await new Promise<void>((r) => gk.listen(0, '127.0.0.1', r));
    port = (gk.address() as { port: number }).port;
  });
  after(async () => { for (const s of [gk, upstream]) await new Promise<void>((r) => s.close(() => r())); });
  beforeEach(async () => {
    seen.length = 0;
    const runId = `ro-run-${++seq}`;
    ctx = { run: { runId, agentId: 'juror', state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes: ['github', 'github-rw'] }, spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId: 'juror' });
  });

  const forwarded: Array<[string, string, string?]> = [
    ['GET', '/github/repos/o/r/pulls/1'],
    ['HEAD', '/github/repos/o/r'],
    ['GET', '/github/o/r.git/info/refs?service=git-upload-pack'],
    ['POST', '/github/o/r.git/git-upload-pack', '0000'],
    ['POST', '/github/graphql', gql('query { viewer { login } }')],
    ['POST', '/github/graphql', gql('{ repository(owner: "o", name: "r") { id } }')],
    ['POST', '/github/graphql', gql('query Q($n: String = "mutation") { repository(name: $n) { id } } fragment F on Repository { id }')],
    ['POST', '/github/graphql', gql('# mutation { x }\nquery { viewer { login } }')],
  ];
  for (const [method, path, body] of forwarded) {
    it(`forwards ${method} ${path} ${body ?? ''}`.trim(), async () => {
      const r = await send(port, method, path, token, body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].auth, 'token gh-secret');
    });
  }

  const refused: Array<[string, string, string | undefined, string, Record<string, string>?]> = [
    ['POST', '/github/repos/o/r/issues', '{}', 'write_method'],
    ['PUT', '/github/repos/o/r/pulls/1/merge', '{}', 'write_method'],
    ['PATCH', '/github/repos/o/r', '{}', 'write_method'],
    ['DELETE', '/github/repos/o/r', undefined, 'write_method'],
    ['OPTIONS', '/github/repos/o/r', undefined, 'write_method'],
    ['POST', '/github/graphql', gql('mutation { addComment(input: {}) { clientMutationId } }'), 'graphql_not_query'],
    ['POST', '/github/graphql', gql('subscription { x }'), 'graphql_not_query'],
    ['POST', '/github/graphql', gql('query { a } mutation M { b }'), 'graphql_not_query'],
    ['POST', '/github/graphql', 'not json', 'graphql_not_query'],
    ['POST', '/github/graphql', JSON.stringify([{ query: '{ a }' }]), 'graphql_not_query'],
    ['POST', '/github/graphql', JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'x' } } }), 'graphql_not_query'],
    ['POST', '/github/graphql', gql('query { a(s: "unterminated) }'), 'graphql_not_query'],
    ['POST', '/github/graphql', gql('query { a '), 'graphql_not_query'],
    ['POST', '/github/o/r.git/git-receive-pack', '0000', 'git_push'],
    ['GET', '/github/o/r.git/info/refs?service=git-receive-pack', undefined, 'git_push'],
    ['GET', '/github/o/r.git/info/refs?service=git%2Dreceive%2Dpack', undefined, 'git_push'],
    ['GET', '/github/repos/o/r', undefined, 'method_override', { 'x-http-method-override': 'DELETE' }],
  ];
  for (const [method, path, body, why, headers] of refused) {
    it(`refuses ${method} ${path} ${body ?? ''} (${why})`, async () => {
      const r = await send(port, method, path, token, body, headers);
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, { error: 'read_only_route', reason: why });
      assert.equal(seen.length, 0, 'nothing refused reaches upstream');
    });
  }

  it('a route without readOnly still forwards writes', async () => {
    assert.equal((await send(port, 'POST', '/github-rw/repos/o/r/issues', token, '{}')).status, 200);
    assert.equal(seen.length, 1);
  });
});

describe('read-only route validation and the GraphQL lexer', () => {
  it('readOnly must be a boolean', () => {
    const route = (readOnly: unknown) => ({ id: 'github', kind: 'http' as const, upstream: 'https://api.github.com', readOnly: readOnly as boolean });
    assert.equal(routeProblem(route(true)), undefined);
    assert.match(String(routeProblem(route('yes'))), /readOnly/);
  });
  it('classifies documents', () => {
    assert.equal(operationsAreQueries('query { a }'), true);
    assert.equal(operationsAreQueries('"""block mutation""" query { a }'), true);
    assert.equal(operationsAreQueries('mutation{a}'), false);
    assert.equal(operationsAreQueries(''), false);
    assert.equal(operationsAreQueries('query { a } }'), false);
    assert.equal(operationsAreQueries('query ( { a }'), false);
  });
});
