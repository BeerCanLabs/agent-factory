import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

// TSK-174 (E12 item 4): the gatekeeper-egress refuses, before the credential is injected, a call through a skill's route
// that the run's requesting person's roles do not allow. The factory decides (`access` on the run); the agent cannot.
const tokens = new RunTokens('access-roles-run-token-key-0123456789');
const GMAIL_KEY = 'fake-gmail-key-0000';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function get(port: number, path: string, token: string) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('E12 item 4: the gatekeeper-egress enforces the requesting person’s roles (TSK-174)', { concurrency: false }, () => {
  const upstreamSaw: Array<{ path: string; auth?: string }> = [];
  const ledger: Array<Record<string, any>> = [];
  let upstream: http.Server;
  let egress: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;

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
  };
  const providers: SecretProvider[] = [{ name: 'test', async get(name) { return name === 'GMAIL_KEY' ? GMAIL_KEY : undefined; } }];

  async function run(access: unknown) {
    const runId = `run-${++seq}`;
    ctx = {
      run: { runId, agentId: 'donna', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['google-gmail', 'google-calendar', 'discord', 'toString', 'tools-mcp', 'conn-gmail', 'local-svc'] },
      spend: { run: 0, day: 0, month: 0 },
      ...(access !== undefined ? { access: access as RunContext['access'] } : {}),
    };
    token = await tokens.mint({ runId, agentId: 'donna' });
    upstreamSaw.length = 0;
    ledger.length = 0;
  }

  before(async () => {
    upstream = http.createServer((req, res) => {
      upstreamSaw.push({ path: req.url ?? '', auth: req.headers['x-key'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const up = await listen(upstream);
    egress = createGatekeeperEgress({
      routes: [
        { id: 'google-gmail', kind: 'http', upstream: `http://127.0.0.1:${up}/gmail`, credential: { secret: 'GMAIL_KEY', header: 'x-key' } },
        { id: 'google-calendar', kind: 'http', upstream: `http://127.0.0.1:${up}/cal` },
        { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${up}/discord` },
        { id: 'toString', kind: 'http', upstream: `http://127.0.0.1:${up}/ts` },
        { id: 'local-svc', kind: 'http', upstream: `http://localhost:${up}/l` },
        { id: 'tools-mcp', kind: 'mcp', upstream: `http://127.0.0.1:${up}/mcp` },
        { id: 'conn-gmail', kind: 'http', upstream: `http://127.0.0.1:${up}/conn`, connection: 'google' },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers,
      contextTtlMs: 0,
    });
    port = await listen(egress);
  });

  after(async () => {
    await new Promise<void>((r) => egress.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('refuses a route the person’s roles deny: 403, ledgered, and nothing reaches the system or its credential', async () => {
    await run({ restricted: true, routes: { 'google-calendar': 'allowed', 'google-gmail': 'denied' } });
    const r = await get(port, '/google-gmail/messages', token);
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'role_not_allowed', route: 'google-gmail' });
    assert.equal(upstreamSaw.length, 0, 'nothing was forwarded, so no credential was injected');
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED' && e.route === 'google-gmail' && e.runId === ctx.run.runId), 'the refusal is ledgered');
  });

  it('forwards a route the person’s roles allow, and a route no skill declares', async () => {
    await run({ restricted: true, routes: { 'google-calendar': 'allowed', 'google-gmail': 'denied' } });
    assert.equal((await get(port, '/google-calendar/events', token)).status, 200);
    assert.equal((await get(port, '/discord/channels/1/messages', token)).status, 200, 'a route in no skill is not narrowed by roles: the agent can still answer');
    assert.deepEqual(upstreamSaw.map((s) => s.path), ['/cal/events', '/discord/channels/1/messages']);
  });

  it('a person whose roles allow nothing gets nothing from the skills’ routes', async () => {
    await run({ restricted: true, routes: { 'google-calendar': 'denied', 'google-gmail': 'denied' } });
    assert.equal((await get(port, '/google-calendar/events', token)).status, 403);
    assert.equal((await get(port, '/google-gmail/x', token)).status, 403);
    assert.equal(upstreamSaw.length, 0);
  });

  it('a run that is not restricted (no requesting person, owner, admin) forwards the same call with its credential', async () => {
    await run({ restricted: false });
    const r = await get(port, '/google-gmail/messages', token);
    assert.equal(r.status, 200);
    assert.deepEqual(upstreamSaw, [{ path: '/gmail/messages', auth: GMAIL_KEY }]);
  });

  it('an older control plane that sends no answer restricts nothing', async () => {
    await run(undefined);
    assert.equal((await get(port, '/google-gmail/messages', token)).status, 200);
  });

  it('a route named like an object property is judged by its own entry, never by the prototype', async () => {
    await run({ restricted: true, routes: { 'google-gmail': 'denied' } });
    // `toString` is a route the factory defines; the answer lists no such route, so roles do not narrow it.
    const r = await get(port, '/toString/x', token);
    assert.equal(r.status, 200);
  });

  it('an answer the egress cannot read fails closed, never open', async () => {
    for (const bad of [null, 'restricted', 7, [], { restricted: 'yes' }, {}, { restricted: true }, { restricted: true, routes: null }, { restricted: true, routes: [] }, { restricted: true, routes: { 'google-gmail': 'maybe' } }]) {
      await run(bad);
      const r = await get(port, '/google-calendar/events', token);
      assert.equal(r.status, 503, JSON.stringify(bad));
      assert.equal(r.json.error, 'access_unreadable');
      assert.equal(upstreamSaw.length, 0, JSON.stringify(bad));
    }
  });

  it('a denied route’s own host is not a way around it: the forward proxy and CONNECT refuse that host', async () => {
    await run({ restricted: true, routes: { 'google-gmail': 'denied', 'google-calendar': 'allowed' } });
    const up = (upstream.address() as { port: number }).port;
    const viaProxy = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${up}/gmail/x`, method: 'GET', headers: { host: `127.0.0.1:${up}`, 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(viaProxy.status, 403, viaProxy.text);
    assert.equal(JSON.parse(viaProxy.text).error, 'role_not_allowed');
    const tunnel = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${up}`, headers: { 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(tunnel, 403);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED' && e.host === '127.0.0.1'));
    // And an answer that cannot be read closes the host paths too.
    await run({ restricted: 'yes' });
    const unreadable = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${up}/gmail/x`, method: 'GET', headers: { host: `127.0.0.1:${up}`, 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(unreadable, 403);
    await run({ restricted: true, routes: { 'google-gmail': 'denied', 'google-calendar': 'allowed' } });
    assert.equal(upstreamSaw.length, 0);
    // The same host is reachable for a run that is not restricted.
    await run({ restricted: false });
    const ok = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${up}/gmail/x`, method: 'GET', headers: { host: `127.0.0.1:${up}`, 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(ok, 200);
  });

  it('an MCP route and a connection route are refused the same way, before anything is forwarded or minted', async () => {
    await run({ restricted: true, routes: { 'tools-mcp': 'denied', 'conn-gmail': 'denied', 'google-calendar': 'allowed' } });
    for (const route of ['tools-mcp', 'conn-gmail']) {
      const r = await get(port, `/${route}/x`, token);
      assert.equal(r.status, 403, route);
      assert.deepEqual(r.json, { error: 'role_not_allowed', route });
    }
    assert.equal(upstreamSaw.length, 0);
    assert.equal(ledger.filter((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED').length, 2);
  });

  it('a CONNECT refusal of a denied route’s host is ledgered', async () => {
    await run({ restricted: true, routes: { 'google-gmail': 'denied' } });
    const up = (upstream.address() as { port: number }).port;
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:${up}`, headers: { 'proxy-authorization': `Bearer ${token}` } });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await status('127.0.0.1'), 403);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED' && e.host === '127.0.0.1'), 'the CONNECT refusal is ledgered');
  });

  it('a denied route’s host is matched without regard to case or a trailing dot, on CONNECT and on the forward proxy', async () => {
    await run({ restricted: true, routes: { 'local-svc': 'denied' } });
    const up = (upstream.address() as { port: number }).port;
    const connect = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:${up}`, headers: { 'proxy-authorization': `Bearer ${token}` } });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
    const proxy = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: `http://${host}:${up}/x`, method: 'GET', headers: { host: `${host}:${up}`, 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end();
      });
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'LocalHost.']) {
      ledger.length = 0;
      assert.equal(await connect(host), 403, `CONNECT ${host}`);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED'), `CONNECT ${host} ledgered`);
    }
    for (const host of ['localhost', 'LOCALHOST', 'localhost.']) {
      ledger.length = 0;
      assert.equal(await proxy(host), 403, `proxy ${host}`);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED'), `proxy ${host} ledgered`);
    }
    assert.equal(upstreamSaw.length, 0);
  });

  it('an allowed route cannot be used to reach another route’s path on the same origin (dot segments, also percent-encoded)', async () => {
    await run({ restricted: true, routes: { 'google-calendar': 'allowed', 'google-gmail': 'denied' } });
    for (const path of ['/google-calendar/../gmail/messages', '/google-calendar/%2e%2e/gmail/messages', '/google-calendar/%2E%2E/gmail/messages', '/google-calendar/a/../../gmail/messages']) {
      const r = await get(port, path, token);
      assert.equal(r.status, 400, path);
      assert.equal(r.json.error, 'bad_path');
    }
    assert.equal(upstreamSaw.length, 0, 'the credential-bearing upstream was never reached');
    assert.equal((await get(port, '/google-calendar/a/b/../c', token)).status, 200, 'a dot segment that stays inside the route still works');
  });

  it('a denied route’s host does not close a different allowed host', async () => {
    await run({ restricted: true, routes: { 'local-svc': 'denied', 'google-calendar': 'allowed' } });
    const up = (upstream.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${up}/x`, method: 'GET', headers: { host: `127.0.0.1:${up}`, 'proxy-authorization': `Bearer ${token}`, authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end();
    });
    assert.notEqual(status, 403, 'only the denied route’s own host is refused');
  });
});
