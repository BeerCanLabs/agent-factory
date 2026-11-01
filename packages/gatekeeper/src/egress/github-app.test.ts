// #334: the github route sends the agent's own GitHub App key when it has one for the org; else its usual credential.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('github-app-test-run-token-key-0123456789ab');

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

describe('github route uses the agent GitHub App key (#334)', { concurrency: false }, () => {
  const seen: Array<{ method: string; url: string; auth?: string }> = [];
  const asked: Array<{ runId: string; agentId: string; org: string }> = [];
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
      if (req.agentId === 'archie' && req.org.toLowerCase() === 'beercanlabs') return { ok: true, accessToken: `ghs_app_${asked.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      return { ok: false, status: 428, error: 'not_installed' };
    },
  };

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
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
});
