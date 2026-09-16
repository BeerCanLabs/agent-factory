import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { pullMind, pushMind } from '@beercanlabs/factory-hydrate';
import { loadCatalog } from './catalog.js';
import { createFactoryServer, FactoryState, handleMcp } from './app.js';
import { noopRuntime } from './runtime.js';
import { cronMatches } from './scheduler.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      resolve(addr.port);
    });
  });
}

function request(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeState(overrides: Partial<FactoryState> = {}): FactoryState {
  const catalog = loadCatalog(agentsRoot);
  return {
    agents: new Map(catalog.map((a) => [a.id, a])),
    ledger: new MemoryLedger(),
    token: 'dev-token',
    auth: bearerAuth('dev-token'),
    version: 'test',
    providers: [envProvider({ ECHO_WEBHOOK_SECRET: 'whsec', FACTORY_LEDGER_TOKEN: 'ledger' })],
    runtime: noopRuntime(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
    ...overrides,
  };
}

describe('catalog', () => {
  it('loads example cartridges from agents/', () => {
    const catalog = loadCatalog(agentsRoot);
    const ids = catalog.map((a) => a.id).sort();
    assert.ok(ids.includes('echo-agent'));
    assert.ok(ids.includes('finops-officer'));
    assert.ok(ids.includes('med-doc'));
  });
});

describe('scheduler', () => {
  it('matches */1 cron on the current minute', () => {
    assert.equal(cronMatches('* * * * *'), true);
    assert.equal(cronMatches('60 * * * *'), false);
  });
});

describe('control plane HTTP + MCP', { concurrency: false }, () => {
  let server: http.Server;
  let port = 0;
  const token = 'dev-token';
  let state: FactoryState;

  before(async () => {
    state = makeState();
    server = createFactoryServer(state);
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('serves health without auth', async () => {
    const res = await request(port, '/healthz');
    assert.equal(res.status, 200);
    assert.equal((res.json as { status: string }).status, 'ok');
  });

  it('rejects catalog without bearer', async () => {
    const res = await request(port, '/api/v1/agents');
    assert.equal(res.status, 401);
  });

  it('lists cartridges from the registry', async () => {
    const res = await request(port, '/api/v1/agents', { token });
    assert.equal(res.status, 200);
    const rows = res.json as { id: string }[];
    assert.ok(rows.some((a) => a.id === 'echo-agent'));
  });

  it('wakes an agent after binding secrets', async () => {
    const wake = await request(port, '/api/v1/agents/echo-agent/wake', { method: 'POST', token });
    assert.equal(wake.status, 200, JSON.stringify(wake.json));
    assert.equal((wake.json as { state: string }).state, 'WORKING');
    const ledger = await request(port, '/api/v1/ledger?agent=echo-agent', { token });
    const rows = ledger.json as { type: string; action?: string }[];
    assert.ok(rows.some((e) => e.action === 'RESUME'));
  });

  it('rejects wake when secrets are unbound', async () => {
    const res = await request(port, '/api/v1/agents/finops-officer/wake', { method: 'POST', token });
    assert.equal(res.status, 412);
    assert.ok(((res.json as { missing: string[] }).missing ?? []).includes('CLOUD_BILLING_READER'));
  });

  it('wakes via authenticated webhook from surface.yaml', async () => {
    const res = await request(port, '/api/v1/hooks/echo-agent', {
      method: 'POST',
      token,
      headers: { 'x-factory-secret': 'whsec' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  });

  it('routes crash ledger events to med-doc', async () => {
    const crash = await request(port, '/api/v1/ledger', {
      method: 'POST',
      token,
      body: { agentId: 'echo-agent', type: 'crash' },
    });
    assert.equal(crash.status, 201);
    assert.equal(state.agents.get('med-doc')?.state, 'WORKING');
  });

  it('strips payload text from POST /ledger', async () => {
    const res = await request(port, '/api/v1/ledger', {
      method: 'POST',
      token,
      body: {
        agentId: 'echo-agent',
        type: 'llm',
        prompt: 'never store this prompt',
        inputTokens: 2,
      },
    });
    assert.equal(res.status, 201);
    const ledger = await request(port, '/api/v1/ledger?agent=echo-agent', { token });
    const rows = ledger.json as Array<Record<string, unknown>>;
    const llm = rows.filter((e) => e.type === 'llm');
    assert.ok(llm.length >= 1);
    assert.equal(llm.some((e) => JSON.stringify(e).includes('never store this prompt')), false);
    assert.ok(llm.some((e) => typeof e.payloadSha256 === 'string'));
  });

  it('accepts a doorman conversation handoff', async () => {
    const res = await request(port, '/api/v1/agents/echo-agent/conversation', {
      method: 'POST',
      token,
      body: { content: 'hello', channelId: 'c1' },
    });
    assert.equal(res.status, 202, JSON.stringify(res.json));
  });

  it('exposes the same surface over MCP', async () => {
    const listed = (await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((t) => t.name);
    assert.ok(names.includes('list_agents'));
    assert.ok(names.includes('wake_agent'));
    assert.ok(names.includes('query_ledger'));
  });
});

describe('hydrate through runtime store', () => {
  it('survives a kill of ephemeral disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-'));
    const store = { root: join(root, 'obj') };
    const dest = join(root, 'ephem');
    writeFileSync(join(root, 'note.md'), 'x');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'note.md'), 'x');
    pushMind(store, 'echo-agent', dest);
    rmSync(dest, { recursive: true, force: true });
    pullMind(store, 'echo-agent', dest);
    assert.equal(readFileSync(join(dest, 'note.md'), 'utf8'), 'x');
    rmSync(root, { recursive: true });
  });
});
