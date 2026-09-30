import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

// TSK-045: per-agent GitHub tokens with no shared fallback, a header-only key (motion), and multipart bodies.
const CASTLE_GH = 'fake-castle-github-token-0000';
const SHARED_GH = 'fake-shared-github-token-0000';
const MOTION_KEY = 'motion-key-0000';
const tokens = new RunTokens('routes-test-run-token-key-0123456789ab');

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, token: string, opts: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('TSK-045 gatekeeper-egress routes (S1)', { concurrency: false }, () => {
  const seen: Seen[] = [];
  const ledger: Array<Record<string, any>> = [];
  let upstream: http.Server;
  let gatekeeperEgress: http.Server;
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
  const providers: SecretProvider[] = [
    {
      name: 'test',
      async get(name) {
        if (name === 'CASTLE_GITHUB_TOKEN') return CASTLE_GH;
        if (name === 'GITHUB_TOKEN') return SHARED_GH;
        if (name === 'MOTION_API_KEY') return MOTION_KEY;
        return undefined;
      },
    },
  ];

  async function as(agentId: string, routes: string[]) {
    const runId = `run-${++seq}`;
    ctx = { run: { runId, agentId, state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes }, spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId });
  }

  before(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const upPort = await listen(upstream);
    gatekeeperEgress = createGatekeeperEgress({
      routes: [
        { id: 'github', kind: 'http', upstream: `http://127.0.0.1:${upPort}/gh`, credential: { secret: '{agent}_GITHUB_TOKEN', header: 'authorization', format: 'Bearer {}', fallback: false } },
        { id: 'motion', kind: 'http', upstream: `http://127.0.0.1:${upPort}/motion/v1`, credential: { secret: 'MOTION_API_KEY', header: 'x-api-key' } },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers,
      contextTtlMs: 0,
    });
    port = await listen(gatekeeperEgress);
  });

  after(async () => {
    await new Promise<void>((r) => gatekeeperEgress.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(() => {
    seen.length = 0;
    ledger.length = 0;
  });

  it("github injects the calling agent's own token and never forwards the run token", async () => {
    await as('castle', ['github']);
    const r = await call(port, '/github/repos/BeerCanLabs/x/pulls', token, { headers: { 'x-factory-run-token': token } });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/gh/repos/BeerCanLabs/x/pulls');
    assert.equal(seen[0].headers.authorization, `Bearer ${CASTLE_GH}`);
    assert.ok(!JSON.stringify(seen[0].headers).includes(token), 'run token reached the upstream');
    assert.equal(ledger.at(-1)?.action, 'EGRESS');
  });

  it('github with fallback:false: an agent without its own token gets credential_unbound, not the shared token', async () => {
    await as('higgins', ['github']);
    const r = await call(port, '/github/user', token);
    assert.equal(r.status, 503);
    assert.match(r.text, /credential_unbound/);
    assert.equal(seen.length, 0);
  });

  it('github is denied to an agent whose policy lacks the route (E7)', async () => {
    await as('castle', ['motion']);
    assert.equal((await call(port, '/github/user', token)).status, 403);
    assert.equal(seen.length, 0);
  });

  it('motion injects MOTION_API_KEY as x-api-key with no prefix', async () => {
    await as('finley', ['motion']);
    const r = await call(port, '/motion/tasks', token, { headers: { 'x-api-key': token } });
    assert.equal(r.status, 200);
    assert.equal(seen[0].path, '/motion/v1/tasks');
    assert.equal(seen[0].headers['x-api-key'], MOTION_KEY);
    assert.equal(seen[0].headers.authorization, undefined);
  });

  it('passes a ~2 MB multipart POST body through unchanged', async () => {
    await as('finley', ['motion']);
    const boundary = 'tsk045boundary';
    const file = Buffer.alloc(2 * 1024 * 1024, 7);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await call(port, '/motion/upload', token, { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.equal(r.status, 200);
    assert.equal(seen[0].headers['content-type'], `multipart/form-data; boundary=${boundary}`);
    assert.equal(seen[0].body.length, body.length);
    assert.ok(seen[0].body.equals(body));
  });
});
