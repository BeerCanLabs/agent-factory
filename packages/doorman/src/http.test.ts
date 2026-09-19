import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { createDoorman, fakeGateway } from './index.js';
import { createDoormanHttp } from './http.js';

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

function serve(auth: ReturnType<typeof bearerAuth>) {
  const door = createDoorman({ gateway: fakeGateway(), providers: [envProvider({})], wake: async () => {}, handoff: async () => {} });
  return createDoormanHttp(door, auth);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

describe('doorman http', () => {
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = serve(bearerAuth([{ name: 'control-plane', token: 'presence-token', roles: ['operator'] }]));
    port = await listen(server);
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('serves health without auth', async () => {
    assert.equal(await call(port, '/healthz'), 200);
  });

  it('requires DOORMAN_TOKEN for presence changes', async () => {
    const body = { agentId: 'echo-agent', presence: 'available' };
    assert.equal(await call(port, '/api/v1/presence', 'POST', undefined, body), 401);
    assert.equal(await call(port, '/api/v1/presence', 'POST', 'wrong', body), 401);
    assert.equal(await call(port, '/api/v1/presence', 'POST', 'presence-token', body), 200);
  });

  it('fails closed when no token is configured', async () => {
    const open = serve(bearerAuth([]));
    const p = await listen(open);
    try {
      assert.equal(await call(p, '/api/v1/presence', 'POST', 'anything', { agentId: 'x', presence: 'offline' }), 401);
    } finally {
      await new Promise<void>((r) => open.close(() => r()));
    }
  });
});
