// #334: the github route sends the agent's own GitHub App key when it has one for the org; else its usual credential.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('github-app-test-run-token-key-0123456789ab');

function send(port: number, method: string, path: string, token: string, body?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra } }, (res) => {
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

describe('github route uses the agent GitHub App key (#334)', { concurrency: false }, () => {
  const seen: Array<{ method: string; url: string; auth?: string; org?: string }> = [];
  const asked: Array<{ runId: string; agentId: string; org?: string }> = [];
  const ledgered: string[] = [];
  let upstream: http.Server;
  let gk: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;
  let upStatus = 200;
  const control: ControlClient = {
    async runContext(runId) { return runId === ctx.run.runId ? structuredClone(ctx) : null; },
    async requestApproval() { return { approvalId: 'unused', state: 'pending' }; },
    async consumeApproval() { return false; },
    async ledger(e) { ledgered.push(String(e.action)); },
    async githubAppToken(req) {
      asked.push(req);
      // #501: a slow control plane (cold mint), and one that times out.
      if (req.agentId === 'slowpoke') { await new Promise((r) => setTimeout(r, 150)); return { ok: true, accessToken: `ghs_slow_${asked.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; }
      if (req.agentId === 'stalled') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (req.agentId === 'refused') return { ok: false, status: 504, error: 'github_app_token_slow' };
      if (req.agentId === 'archie' && req.org?.toLowerCase() === 'beercanlabs') return { ok: true, accessToken: `ghs_app_${asked.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      // GAP-256: no org (a GraphQL call with no hint): the control plane answers with the app's only chosen org.
      if (req.agentId === 'archie' && req.org === undefined) return { ok: true, accessToken: `ghs_sole_${asked.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString(), org: 'BeerCanLabs' };
      return { ok: false, status: 428, error: 'not_installed' };
    },
  };

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, org: req.headers['x-github-org'] as string | undefined });
        res.writeHead(upStatus, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = (upstream.address() as { port: number }).port;
    gk = createGatekeeperEgress({
      routes: [
        { id: 'github', kind: 'http', upstream: `http://127.0.0.1:${up}`, credential: { secret: 'GH', header: 'authorization', format: 'token {}' } },
        { id: 'github-git', kind: 'http', upstream: `http://localhost:${up}`, credential: { secret: 'GH', header: 'authorization', format: 'x-access-token:{}', encoding: 'basic' } },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 't', async get(n) { return n === 'GH' ? 'gh-pat' : undefined; } }],
      contextTtlMs: 0,
      githubAppHosts: { '127.0.0.1': 'api', localhost: 'git' },
    });
    await new Promise<void>((r) => gk.listen(0, '127.0.0.1', r));
    port = (gk.address() as { port: number }).port;
  });
  after(async () => { for (const s of [gk, upstream]) await new Promise<void>((r) => s.close(() => r())); });

  const as = async (agentId: string, helperOf?: string) => {
    const runId = `app-run-${++seq}`;
    ctx = { run: { runId, agentId, state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes: ['github', 'github-git'] }, spend: { run: 0, day: 0, month: 0 }, ...(helperOf ? { helperOf } : {}) };
    token = await tokens.mint({ runId, agentId });
  };
  beforeEach(() => { seen.length = 0; asked.length = 0; ledgered.length = 0; upStatus = 200; });

  it('an agent with an app on the org reads with its app key, not the shared credential', async () => {
    await as('archie');
    const r = await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    assert.equal(r.status, 200);
    assert.match(seen[0].auth ?? '', /^token ghs_app_/);
    assert.deepEqual(asked[0], { runId: ctx.run.runId, agentId: 'archie', org: 'BeerCanLabs' });
    assert.ok(ledgered.includes('GITHUB_APP_KEY_USED'));
  });

  it('the key is cached: a second call does not ask again', async () => {
    await as('archie');
    await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc/pulls', token);
    await send(port, 'GET', '/github/orgs/BeerCanLabs/repos', token);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((x) => /^token ghs_app_/.test(x.auth ?? '')));
    assert.ok(asked.length <= 1);
  });

  it('falls back to the route credential when there is no app, it is not installed, or no org is in the path', async () => {
    await as('archie');
    await send(port, 'GET', '/github/repos/other-org/x', token);
    await send(port, 'GET', '/github/user', token);
    await as('donna');
    await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    assert.deepEqual(seen.map((x) => x.auth), ['token gh-pat', 'token gh-pat', 'token gh-pat']);
  });

  it('a /users/:login call is for that personal account (multi-owner apps): its owner is asked for', async () => {
    await as('archie');
    await send(port, 'GET', '/github/users/dsackr/repos', token);
    assert.deepEqual(asked[0], { runId: ctx.run.runId, agentId: 'archie', org: 'dsackr' });
    assert.equal(seen[0].auth, 'token gh-pat', 'no app key for dsackr here, so the route credential is kept');
  });

  it('git over HTTPS gets Basic x-access-token with the app key', async () => {
    await as('archie');
    await send(port, 'GET', '/github-git/BeerCanLabs/agentic-sdlc.git/info/refs?service=git-upload-pack', token);
    const decoded = Buffer.from((seen[0].auth ?? '').replace(/^Basic /, ''), 'base64').toString();
    assert.match(decoded, /^x-access-token:ghs_app_/);
  });

  it("a helper borrows its parent's app key but stays read-only", async () => {
    await as('beercanlabs-juror.helper.abc', 'archie');
    const read = await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    assert.equal(read.status, 200);
    assert.match(seen[0].auth ?? '', /^token ghs_app_/);
    assert.ok(asked.every((a) => a.agentId === 'archie'), 'only the parent key is ever asked for');
    const write = await send(port, 'POST', '/github/repos/BeerCanLabs/agentic-sdlc/issues', token, '{}');
    assert.equal(write.status, 403);
    assert.equal(write.body.error, 'read_only_route');
    assert.equal(seen.length, 1, 'the write never reached GitHub');
  });

  it('a 401 drops the cached app key so the next call asks again', async () => {
    await as('archie');
    upStatus = 401;
    await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    upStatus = 200;
    const before = asked.length;
    await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    assert.equal(asked.length, before + 1);
  });
  it('#501: concurrent calls of a run share one token request while the control plane mints', async () => {
    await as('slowpoke');
    const rs = await Promise.all([1, 2, 3].map(() => send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token)));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(asked.filter((a) => a.agentId === 'slowpoke').length, 1);
    assert.ok(seen.every((s) => s.auth === 'token ghs_slow_1'), 'every call used the one minted key');
  });

  it('#501: a timed-out or failed token request is logged with the agent, org and elapsed time', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      await as('stalled');
      assert.equal((await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token)).status, 200);
      await as('refused');
      await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
      await as('nobody');
      await send(port, 'GET', '/github/repos/BeerCanLabs/agentic-sdlc', token);
    } finally {
      console.error = orig;
    }
    assert.equal(seen[0].auth, 'token gh-pat', 'falls back to the route credential');
    assert.ok(lines.some((l) => /github app token github for stalled\/BeerCanLabs: The operation was aborted due to timeout after \d+ ms/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /github app token github for refused\/BeerCanLabs: 504 github_app_token_slow after \d+ ms/.test(l)));
    assert.ok(!lines.some((l) => l.includes('nobody/')), 'a routine 4xx refusal (no app) is not logged');
  });

  describe('GAP-256: GraphQL (Projects v2) picks the app key for an org', () => {
    const q = (variables: Record<string, unknown>) => JSON.stringify({ query: 'query{viewer{login}}', variables });

    it('an X-GitHub-Org header names the org; the header never reaches GitHub', async () => {
      await as('archie');
      const r = await send(port, 'POST', '/github/graphql', token, q({}), { 'x-github-org': 'BeerCanLabs' });
      assert.equal(r.status, 200);
      assert.match(seen[0].auth ?? '', /^token ghs_app_/);
      assert.equal(seen[0].org, undefined);
      assert.ok(asked.every((a) => a.org === 'BeerCanLabs'), 'only the named org is asked for (the key may be cached)');
    });

    it("the query's own org or owner variable names it when there is no header", async () => {
      await as('archie');
      await send(port, 'POST', '/github/graphql', token, q({ org: 'BeerCanLabs', n: 1 }));
      await send(port, 'POST', '/github/graphql', token, q({ owner: 'other-org', name: 'x' }));
      assert.match(seen[0].auth ?? '', /^token ghs_app_/);
      assert.equal(seen[1].auth, 'token gh-pat', 'an org the app is not for keeps the route credential');
    });

    it("no hint at all (a mutation by node id): the control plane may use the app's only chosen org", async () => {
      await as('archie');
      const r = await send(port, 'POST', '/github/graphql', token, q({ p: 'PVT_1', i: 'PVTI_1' }));
      assert.equal(r.status, 200);
      assert.match(seen[0].auth ?? '', /^token ghs_sole_/);
      assert.deepEqual(asked[0], { runId: ctx.run.runId, agentId: 'archie' });
      assert.ok(ledgered.includes('GITHUB_APP_KEY_USED'));
    });

    it('a header that is not an org name is refused before anything is sent', async () => {
      await as('archie');
      const r = await send(port, 'POST', '/github/graphql', token, q({}), { 'x-github-org': '../evil' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'bad_github_org');
      assert.equal(seen.length, 0);
    });

    it('a REST call is unchanged by the header (the org comes from its path)', async () => {
      await as('archie');
      await send(port, 'GET', '/github/repos/other-org/x', token, undefined, { 'x-github-org': 'BeerCanLabs' });
      assert.equal(seen[0].auth, 'token gh-pat');
      assert.equal(seen[0].org, undefined);
    });

    it('a read-only helper may query with its parent key but never mutate', async () => {
      await as('beercanlabs-juror.helper.gql', 'archie');
      const read = await send(port, 'POST', '/github/graphql', token, q({ org: 'BeerCanLabs' }));
      assert.equal(read.status, 200);
      assert.match(seen[0].auth ?? '', /^token ghs_app_/);
      const write = await send(port, 'POST', '/github/graphql', token, JSON.stringify({ query: 'mutation($p:ID!){x(p:$p){id}}', variables: { org: 'BeerCanLabs', p: '1' } }));
      assert.equal(write.status, 403);
      assert.equal(seen.length, 1, 'the mutation never reached GitHub');
    });
  });
});
