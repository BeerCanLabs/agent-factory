import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { benchSchema } from '@beercanlabs/factory-contract';
import { createGateway, type ControlClient } from '@beercanlabs/factory-gateway';
import { httpClient, matrix, recommend, runBench, summarize } from '@beercanlabs/factory-bench';
import { loadCatalog } from './catalog.js';
import { createFactoryServer, finishRun, SYSTEM, type FactoryState } from './app.js';
import { memoryRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const KEY = 'bench-run-token-key-0123456789abcdefghij';
const ADMIN = 'bench-admin';
const GATEWAY = 'bench-gateway';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('benchmark harness against a live factory', { concurrency: false }, () => {
  const servers: http.Server[] = [];
  let cpPort = 0;
  const providerSaw: string[] = [];

  before(async () => {
    // Fake provider: the "big" model always names the subject; the "small" one does not.
    const provider = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        providerSaw.push(String(req.headers['x-api-key']));
        const { model } = JSON.parse(b) as { model: string };
        const text = model === 'test-big' ? 'The gateway meters every token.' : 'Tokens are counted.';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model, content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } }));
      });
    });
    const providerPort = await listen(provider);
    servers.push(provider);

    const root = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
    const state = {
      agents: new Map(loadCatalog(agentsRoot).map((a) => [a.id, a])),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gateway', token: GATEWAY, roles: ['gateway'] },
      ]),
      version: 'bench',
      providers: [envProvider({})],
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(KEY),
      callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 30_000,
      idleTimers: new Map(),
      secretValues: new Set(),
    } as unknown as FactoryState;
    state.runtime = memoryRuntime({
      store: { root: join(root, 'store') },
      ephemeralRoot: join(root, 'eph'),
      workerCommand: (agent) => (agent.localCommand ? { cmd: process.execPath, args: agent.localCommand.slice(1) } : undefined),
      onExit: (_agent, code, ctx) =>
        void finishRun(state, ctx.runId, code === 0 ? 'DONE' : 'FAILED', { actor: SYSTEM.runtime, exitCode: code }),
    });
    const cp = createFactoryServer(state);
    cpPort = await listen(cp);
    servers.push(cp);
    state.publicUrl = `http://127.0.0.1:${cpPort}`;

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${cpPort}${path}`, {
        method,
        headers: { Authorization: `Bearer ${GATEWAY}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as never };
    };
    const control: ControlClient = {
      runContext: async (id) => ((await call('GET', `/api/v1/gateway/runs/${id}`)).status === 200 ? (await call('GET', `/api/v1/gateway/runs/${id}`)).body : null),
      requestApproval: async (r) => (await call('POST', '/api/v1/gateway/approvals', r)).body,
      consumeApproval: async (id) => (await call('POST', `/api/v1/gateway/approvals/${id}/consume`)).status === 200,
      ledger: async (e) => {
        const r = await call('POST', '/api/v1/ledger', e);
        if (r.status !== 201) throw new Error(`ledger ${r.status}`);
      },
    };
    const gw = createGateway({
      routes: [{ id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${providerPort}`, credential: { secret: 'ANTHROPIC_API_KEY', header: 'x-api-key' } }],
      prices: { 'test-big': { inputPerMTok: 15, outputPerMTok: 75 }, 'test-small': { inputPerMTok: 1, outputPerMTok: 5 } },
      runTokens: new RunTokens(KEY),
      control,
      providers: [envProvider({ ANTHROPIC_API_KEY: 'sk-real-bench-key' })],
      contextTtlMs: 0,
    });
    const gwPort = await listen(gw);
    servers.push(gw);
    state.gatewayUrl = `http://127.0.0.1:${gwPort}`;

    const put = await fetch(`http://127.0.0.1:${cpPort}/api/v1/agents/llm-summarizer/policy`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ routes: ['anthropic'] }),
    });
    assert.equal(put.status, 200);
  });

  after(async () => {
    for (const s of servers.reverse()) await new Promise<void>((r) => s.close(() => r()));
  });

  it('produces a cost vs quality matrix and picks the cheapest model that clears the bar', async () => {
    const suite = benchSchema.parse(parseYaml(readFileSync(join(agentsRoot, 'examples/llm-summarizer/bench.yaml'), 'utf8')));
    const client = httpClient(`http://127.0.0.1:${cpPort}`, ADMIN);
    const results = await runBench(client, 'llm-summarizer', suite, ['test-big', 'test-small'], { pollMs: 50 });
    const failures = results.filter((r) => !r.pass && r.model === 'test-big');
    assert.equal(failures.length, 0, JSON.stringify(failures));

    const s = summarize(results);
    const big = s.find((x) => x.model === 'test-big')!;
    const small = s.find((x) => x.model === 'test-small')!;
    assert.equal(big.passRate, 1);
    assert.equal(small.passRate, 0.5);
    // 1000 in + 100 out per call, one call per case, priced by the gateway from the ledger.
    assert.equal(big.avgCostUsd, (1000 * 15 + 100 * 75) / 1e6);
    assert.equal(small.avgCostUsd, (1000 * 1 + 100 * 5) / 1e6);
    assert.ok(providerSaw.every((k) => k === 'sk-real-bench-key'), 'the worker never held the provider key');

    const table = matrix(s, 10_000);
    assert.match(table, /\| test-big \| 100% \(2\/2\) \|/);
    assert.match(table, /\| test-small \| 50% \(1\/2\) \|/);
    assert.equal(recommend(s, { minPassRate: 0.9 })?.model, 'test-big');
    assert.equal(recommend(s, { minPassRate: 0.5 })?.model, 'test-small');
  });
});
