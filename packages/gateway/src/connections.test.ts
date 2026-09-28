// §6.11 K3/K4: the gateway injects Keymaster connection tokens; agents never hold them.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGateway, type ConnectionTokenResult, type ControlClient, type RunContext } from './gateway.js';

const tokens = new RunTokens('gateway-conn-test-run-token-key-0123456789');
const GOOGLE_TOKEN = 'fake-google-access-token-for-donna';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('gateway connection routes (§6.11)', { concurrency: false }, () => {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const ledger: Array<Record<string, any>> = [];
  const tokenRequests: Array<{ runId: string; agentId: string; connection: string; scopes?: string[] }> = [];
  let tokenResult: ConnectionTokenResult;
  let upstreamStatus = 200;
  let ctx: RunContext;
  let token = '';
  let runSeq = 0;
  let upstream: http.Server;
  let gateway: http.Server;
  let port = 0;
  let upPort = 0;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      throw new Error('unused');
    },
    async consumeApproval() {
      return false;
    },
    async ledger(event) {
      ledger.push(event);
    },
    async connectionToken(req) {
      tokenRequests.push(req);
      return tokenResult;
    },
  };

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: upstreamStatus === 200 }));
      });
    });
    upPort = await listen(upstream);
    gateway = createGateway({
      routes: [
        { id: 'google-calendar', kind: 'http', upstream: `http://127.0.0.1:${upPort}/calendar/v3`, connection: 'google' },
        { id: 'google-health', kind: 'http', upstream: `http://127.0.0.1:${upPort}`, connection: 'google' },
        { id: 'google-storage', kind: 'http', upstream: `http://127.0.0.1:${upPort}`, connection: 'google-service-account', scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      contextTtlMs: 0,
    });
    port = await listen(gateway);
  });

  after(async () => {
    await new Promise<void>((r) => gateway.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(async () => {
    seen.length = 0;
    ledger.length = 0;
    tokenRequests.length = 0;
    upstreamStatus = 200;
    tokenResult = { ok: true, accessToken: GOOGLE_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const runId = `run-${++runSeq}`;
    // A distinct agent per test keeps the gateway's token cache from leaking between cases.
    const agentId = `donna-${runSeq}`;
    ctx = {
      run: { runId, agentId, state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['google-calendar', 'google-health', 'google-storage'] },
      spend: { run: 0, day: 0, month: 0 },
    };
    token = await tokens.mint({ runId, agentId });
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('injects the Keymaster Google token, strips caller auth, and never forwards the run token', async () => {
    const res = await call(port, '/google-calendar/calendars/primary/events?maxResults=5', {
      authorization: `Bearer ${token}`,
      'x-upstream-authorization': 'Bearer agent-held-token',
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/calendar/v3/calendars/primary/events?maxResults=5');
    assert.equal(seen[0].headers.authorization, `Bearer ${GOOGLE_TOKEN}`);
    assert.equal(seen[0].headers['x-upstream-authorization'], undefined);
    assert.equal(JSON.stringify(seen[0].headers).includes(token), false, 'run token never upstream');
    assert.deepEqual(tokenRequests, [{ runId: ctx.run.runId, agentId: ctx.run.agentId, connection: 'google' }]);
  });

  it('ignores a caller Authorization even when the run token comes in x-factory-run-token', async () => {
    const res = await call(port, '/google-health/v4/users/me/identity', { 'x-factory-run-token': token, authorization: 'Bearer agent-held-google-token' });
    assert.equal(res.status, 200);
    assert.equal(seen[0].path, '/v4/users/me/identity');
    assert.equal(seen[0].headers.authorization, `Bearer ${GOOGLE_TOKEN}`);
  });

  it('caches the token per agent × connection until near expiry', async () => {
    await call(port, '/google-calendar/a', { authorization: `Bearer ${token}` });
    await call(port, '/google-calendar/b', { authorization: `Bearer ${token}` });
    assert.equal(tokenRequests.length, 1);
    upstreamStatus = 401;
    await call(port, '/google-calendar/c', { authorization: `Bearer ${token}` });
    upstreamStatus = 200;
    await call(port, '/google-calendar/d', { authorization: `Bearer ${token}` });
    assert.equal(tokenRequests.length, 2, 'an upstream 401 drops the cached token');
  });

  it('passes the route scopes for service-account connections', async () => {
    const res = await call(port, '/google-storage/upload/storage/v1/b/bucket/o?uploadType=media&name=x', { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, 'POST', 'hello');
    assert.equal(res.status, 200);
    assert.equal(seen[0].path, '/upload/storage/v1/b/bucket/o?uploadType=media&name=x');
    assert.equal(seen[0].body, 'hello');
    assert.deepEqual(tokenRequests[0].scopes, ['https://www.googleapis.com/auth/devstorage.read_write']);
    assert.equal(tokenRequests[0].connection, 'google-service-account');
  });

  it('returns 428 needs_reconsent with the connect link and ledgers it without secrets', async () => {
    tokenResult = { ok: false, status: 428, error: 'needs_reconsent', provider: 'google', connectUrl: 'https://factory.example/api/v1/connections/donna/google/start' };
    const res = await call(port, '/google-calendar/calendars/primary/events', { authorization: `Bearer ${token}` });
    assert.equal(res.status, 428);
    assert.deepEqual(res.json(), { error: 'needs_reconsent', provider: 'google', connectUrl: 'https://factory.example/api/v1/connections/donna/google/start' });
    assert.equal(seen.length, 0, 'nothing leaves without a token');
    await settle();
    const row = ledger.find((e) => e.action === 'CONNECTION_NEEDS_RECONSENT');
    assert.ok(row);
    assert.equal(row.route, 'google-calendar');
    assert.equal(row.host, '127.0.0.1');
    assert.equal(JSON.stringify(ledger).includes(token), false);
  });

  it('passes other upstream errors through and ledgers route, host, and status (no bodies)', async () => {
    upstreamStatus = 404;
    const res = await call(port, '/google-calendar/calendars/missing', { authorization: `Bearer ${token}` });
    assert.equal(res.status, 404);
    await settle();
    const row = ledger.find((e) => e.action === 'EGRESS');
    assert.deepEqual(
      { route: row?.route, host: row?.host, status: row?.status, connection: row?.connection, runId: row?.runId },
      { route: 'google-calendar', host: '127.0.0.1', status: 404, connection: 'google', runId: ctx.run.runId },
    );
    assert.equal(JSON.stringify(ledger).includes(GOOGLE_TOKEN), false);
  });

  it('enforces policy routes before asking the Keymaster', async () => {
    ctx.policy = { routes: ['google-health'] };
    const res = await call(port, '/google-calendar/calendars/primary/events', { authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(tokenRequests.length, 0);
    assert.equal(seen.length, 0);
    assert.equal((await call(port, '/google-calendar/x', {})).status, 401, 'no run token, no call');
  });

  it('does not open raw CONNECT tunnels to connection-route hosts', async () => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`);
    });
    const data = await new Promise<string>((resolve) => s.once('data', (b) => resolve(b.toString())));
    s.destroy();
    assert.match(data, /403/);
  });

  it('refuses a route that carries both a connection and a static credential', () => {
    assert.throws(() =>
      createGateway({
        routes: [{ id: 'bad', kind: 'http', upstream: 'https://example.com', connection: 'google', credential: { secret: 'X', header: 'authorization' } }],
        prices: {},
        runTokens: tokens,
        control,
        providers: [],
      }),
    );
  });
});
