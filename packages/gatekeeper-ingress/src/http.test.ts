import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperIngress, fakeDiscordClient } from './index.js';
import { createGatekeeperIngressHttp } from './http.js';

function call(port: number, path: string, method = 'GET', token?: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function serve(auth: ReturnType<typeof bearerAuth>, discord = fakeDiscordClient(), providers = [envProvider({})]) {
  const door = createGatekeeperIngress({ discord, providers, wake: async () => {}, handoff: async () => {} });
  return { server: createGatekeeperIngressHttp(door, auth), door };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

describe('gatekeeper-ingress http', () => {
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = serve(bearerAuth([{ name: 'control-plane', token: 'presence-token', roles: ['operator'] }])).server;
    port = await listen(server);
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('serves health without auth', async () => {
    assert.equal(await call(port, '/healthz'), 200);
  });

  it('requires GATEKEEPER_INGRESS_TOKEN for presence changes', async () => {
    const body = { agentId: 'echo-agent', presence: 'available' };
    assert.equal(await call(port, '/api/v1/presence', 'POST', undefined, body), 401);
    assert.equal(await call(port, '/api/v1/presence', 'POST', 'wrong', body), 401);
    assert.equal(await call(port, '/api/v1/presence', 'POST', 'presence-token', body), 200);
  });

  it('fails closed when no token is configured', async () => {
    const open = serve(bearerAuth([])).server;
    const p = await listen(open);
    try {
      assert.equal(await call(p, '/api/v1/presence', 'POST', 'anything', { agentId: 'x', presence: 'offline' }), 401);
    } finally {
      await new Promise<void>((r) => open.close(() => r()));
    }
  });
  it('P1: the control plane drives presence offline, starting and available', async () => {
    const discord = fakeDiscordClient();
    const { server: s, door } = serve(
      bearerAuth([{ name: 'control-plane', token: 'presence-token', roles: ['operator'] }]),
      discord,
      [envProvider({ DISCORD_BOT_TOKEN: 'bot-token' })],
    );
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    const p = await listen(s);
    try {
      const set = (presence: string) => call(p, '/api/v1/presence', 'POST', 'presence-token', { agentId: 'echo-agent', presence });
      assert.equal(await set('starting'), 200);
      assert.equal(discord.presence, 'starting');
      assert.equal(await set('available'), 200);
      assert.equal(discord.presence, 'available');
      assert.equal(await set('offline'), 200);
      assert.equal(discord.presence, 'offline');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
