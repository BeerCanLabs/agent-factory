import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type Route, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('systems-egress-test-run-token-key-1234567890');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, token: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('gatekeeper-egress dynamic system route resolution (E10)', () => {
  let upstream: http.Server;
  let upPort = 0;
  let egressServer: http.Server;
  let egressPort = 0;
  let token = '';

  const dynamicRoutes: Route[] = [];

  const control: ControlClient = {
    async runContext() {
      return {
        run: { runId: 'run-1', agentId: 'test-agent', state: 'WORKING', live: true },
        agentState: 'WORKING',
        policy: { routes: ['dyn-service', 'new-service'], hosts: [] },
        spend: { run: 0, day: 0, month: 0 },
      };
    },
    async requestApproval() { throw new Error('unused'); },
    async consumeApproval() { return false; },
    async ledger() {},
    async systemRoutes() {
      return [...dynamicRoutes];
    },
  };

  before(async () => {
    token = await tokens.mint({ runId: 'run-1', agentId: 'test-agent' });
    upstream = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
    upPort = await listen(upstream);

    // Initial route
    dynamicRoutes.push({
      id: 'dyn-service',
      kind: 'http',
      upstream: `http://127.0.0.1:${upPort}`,
    });

    // Start egress with 0 static routes
    egressServer = createGatekeeperEgress({
      routes: [],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      allowHttpSystems: true,
      routeRefreshIntervalMs: 0,
    });
    egressPort = await listen(egressServer);
  });

  after(async () => {
    await new Promise<void>((r) => egressServer.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('resolves a route dynamically from control.systemRoutes on first request', async () => {
    const res = await call(egressPort, '/dyn-service/test', token);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true });
  });

  it('picks up newly approved systems without redeploy or restart', async () => {
    // Before adding to dynamicRoutes, an unknown route returns 404
    const r1 = await call(egressPort, '/new-service/ping', token);
    assert.equal(r1.status, 404);

    // Now factory approves new-service
    dynamicRoutes.push({
      id: 'new-service',
      kind: 'http',
      upstream: `http://127.0.0.1:${upPort}`,
    });

    // Next request to /new-service/ping resolves and forwards with 200!
    const r2 = await call(egressPort, '/new-service/ping', token);
    assert.equal(r2.status, 200);
    assert.deepEqual(JSON.parse(r2.text), { ok: true });
  });

  it('a system the factory no longer serves stops at once (E10)', async () => {
    const at = dynamicRoutes.findIndex((r) => r.id === 'new-service');
    const [removed] = dynamicRoutes.splice(at, 1);
    try {
      const res = await call(egressPort, '/new-service/ping', token);
      assert.equal(res.status, 404);
    } finally {
      dynamicRoutes.push(removed);
    }
  });
});

describe('gatekeeper-egress refuses unsafe factory systems (E10, E5)', () => {
  let upstream: http.Server;
  let upPort = 0;
  let egressServer: http.Server;
  let egressPort = 0;
  let token = '';
  let modelHits = 0;
  const offered: Route[] = [];

  before(async () => {
    token = await tokens.mint({ runId: 'run-2', agentId: 'test-agent' });
    upstream = http.createServer((req, res) => {
      if (req.url?.startsWith('/static')) modelHits++;
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    upPort = await listen(upstream);
    offered.push(
      // Tries to replace the landing zone's model route.
      { id: 'anthropic', kind: 'http', upstream: `http://127.0.0.1:${upPort}/hijack` },
      // A model provider as a system: model calls must use provider routes.
      { id: 'sneaky-model', kind: 'http', upstream: 'https://api.openai.com' },
      // Not a system kind.
      { id: 'llm-system', kind: 'llm', upstream: 'https://example.com' } as Route,
      // Mixed credential and connection.
      { id: 'mixed', kind: 'http', upstream: 'https://example.com', connection: 'google', credential: { secret: 'X', header: 'x' } },
    );
    egressServer = createGatekeeperEgress({
      routes: [{ id: 'anthropic', kind: 'http', upstream: `http://127.0.0.1:${upPort}/static` }],
      prices: {},
      runTokens: tokens,
      providers: [],
      routeRefreshIntervalMs: 0,
      control: {
        async runContext() {
          return {
            run: { runId: 'run-2', agentId: 'test-agent', state: 'WORKING', live: true },
            agentState: 'WORKING',
            policy: { routes: ['anthropic', 'sneaky-model', 'llm-system', 'mixed'], hosts: [] },
            spend: { run: 0, day: 0, month: 0 },
          };
        },
        async requestApproval() { throw new Error('unused'); },
        async consumeApproval() { return false; },
        async ledger() {},
        async systemRoutes() { return [...offered]; },
      },
    });
    egressPort = await listen(egressServer);
  });

  after(async () => {
    await new Promise<void>((r) => egressServer.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('a factory system never replaces a landing-zone route (E10)', async () => {
    const res = await call(egressPort, '/anthropic/v1/x', token);
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.text).path, /^\/static/);
    assert.equal(modelHits, 1);
  });

  it('model providers, non-system kinds and mixed credentials are not served as systems (E5, E10)', async () => {
    for (const id of ['sneaky-model', 'llm-system', 'mixed']) {
      const res = await call(egressPort, `/${id}/x`, token);
      assert.equal(res.status, 404, id);
    }
  });
});
