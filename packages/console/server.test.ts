// DESIGN_AUTHORITY.md §6.12 A2: no proxy, the console included, adds a privileged credential on a caller's behalf.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.FACTORY_TOKEN = 'console-must-never-send-this'; // secret-scan:allow (test fixture)
const { createConsoleServer } = await import('./server.js');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('A2 console forwards the caller, adds no credential', () => {
  const seen: http.IncomingHttpHeaders[] = [];
  let cp: http.Server;
  let consoleServer: http.Server;
  let port = 0;

  before(async () => {
    cp = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/api/v1/whoami') {
        const who = req.headers['cf-access-jwt-assertion'] ? { actor: 'cloudflare:owner@example.com', roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'] } : null;
        res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(who ?? { error: 'unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    const cpPort = await listen(cp);
    consoleServer = createConsoleServer({ controlPlaneUrl: `http://127.0.0.1:${cpPort}` });
    port = await listen(consoleServer);
  });
  after(() => {
    cp.close();
    consoleServer.close();
  });

  it('proxies API calls without adding FACTORY_TOKEN, forwarding the Access assertion and cookie', async () => {
    seen.length = 0;
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/agents?x=1`, {
      headers: { 'cf-access-jwt-assertion': 'h.p.s', cookie: 'CF_Authorization=h.p.s' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { path: '/api/v1/agents?x=1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, undefined);
    assert.equal(seen[0]['cf-access-jwt-assertion'], 'h.p.s');
    assert.equal(seen[0].cookie, 'CF_Authorization=h.p.s');
    assert.ok(!JSON.stringify(seen).includes(process.env.FACTORY_TOKEN!));
  });

  it("passes the caller's own bearer token through unchanged", async () => {
    seen.length = 0;
    await fetch(`http://127.0.0.1:${port}/api/v1/agents`, { method: 'POST', headers: { authorization: 'Bearer callers-own' }, body: '{}' });
    assert.equal(seen[0].authorization, 'Bearer callers-own');
  });

  it('/api/auth/me reports what the control plane verified, never a default admin', async () => {
    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { 'cf-access-jwt-assertion': 'h.p.s' } });
    assert.deepEqual(await me.json(), {
      user: { email: 'owner@example.com', name: 'owner@example.com', roles: ['admin', 'operator', 'approver', 'viewer'], provider: 'Cloudflare Access' },
    });
    const anon = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { 'cf-access-authenticated-user-email': 'owner@example.com' } });
    assert.equal(anon.status, 401);
  });

  it('proxies identity-links endpoints forwarding credentials and payload', async () => {
    seen.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/identity-links/discord/123456789`, {
      method: 'PUT',
      headers: {
        'cf-access-jwt-assertion': 'jwt-for-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ actor: 'cloudflare:owner@example.com', name: 'Owner', roles: ['admin'] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: '/api/v1/identity-links/discord/123456789' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['cf-access-jwt-assertion'], 'jwt-for-admin');
  });
});
