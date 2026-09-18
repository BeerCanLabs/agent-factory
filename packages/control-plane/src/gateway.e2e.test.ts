import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createGateway, type ControlClient } from '@beercanlabs/factory-gateway';
import { loadCatalog } from './catalog.js';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore, type Run } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));
const KEY = 'e2e-run-token-key-0123456789abcdefghij';
const ADMIN = 'admin-e2e';
const GATEWAY = 'gateway-e2e';
const APPROVER = 'approver-e2e';
const PROVIDER_KEY = 'sk-provider-e2e-key';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function http_(port: number, path: string, method = 'GET', token?: string, body?: unknown, header = 'authorization') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { [header]: header === 'authorization' ? `Bearer ${token}` : token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('control plane + gateway, over HTTP', { concurrency: false }, () => {
  let upstream: http.Server;
  let cp: http.Server;
  let gw: http.Server;
  let cpPort = 0;
  let gwPort = 0;
  const upstreamSaw: Array<{ key?: string; body: string }> = [];
  let state: FactoryState & { runtime: ReturnType<typeof noopRuntime> };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        upstreamSaw.push({ key: req.headers['x-api-key'] as string | undefined, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url?.startsWith('/mcp')) {
          const p = JSON.parse(body);
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { content: [{ type: 'text', text: 'deployed' }] } }));
        }
        res.end(JSON.stringify({ model: 'test-model', usage: { input_tokens: 100_000, output_tokens: 20_000 } }));
      });
    });
    const upPort = await listen(upstream);

    state = {
      agents: new Map(loadCatalog(agentsRoot).map((a) => [a.id, a])),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gateway', token: GATEWAY, roles: ['gateway'] },
        { name: 'dale', token: APPROVER, roles: ['approver'] },
      ]),
      version: 'e2e',
      providers: [envProvider({ ECHO_WEBHOOK_SECRET: 'whsec' })],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(KEY),
      callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set(),
    } as FactoryState & { runtime: ReturnType<typeof noopRuntime> };
    cp = createFactoryServer(state);
    cpPort = await listen(cp);

    const call = async (method: string, path: string, body?: unknown) => {
      const r = await http_(cpPort, path, method, GATEWAY, body);
      if (r.status >= 500) throw new Error(`cp ${r.status}`);
      return r;
    };
    const control: ControlClient = {
      runContext: async (runId) => {
        const r = await call('GET', `/api/v1/gateway/runs/${runId}`);
        return r.status === 200 ? r.body : null;
      },
      requestApproval: async (req) => (await call('POST', '/api/v1/gateway/approvals', req)).body,
      consumeApproval: async (id) => (await call('POST', `/api/v1/gateway/approvals/${id}/consume`)).status === 200,
      ledger: async (event) => {
        const r = await call('POST', '/api/v1/ledger', event);
        if (r.status !== 201) throw new Error(`ledger ${r.status}`);
      },
    };
    gw = createGateway({
      routes: [
        { id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}`, credential: { secret: 'ANTHROPIC_API_KEY', header: 'x-api-key' } },
        { id: 'deployer', kind: 'mcp', upstream: `http://127.0.0.1:${upPort}/mcp` },
      ],
      prices: { 'test-model': { inputPerMTok: 3, outputPerMTok: 15 } },
      runTokens: new RunTokens(KEY),
      control,
      providers: [envProvider({ ANTHROPIC_API_KEY: PROVIDER_KEY })],
      contextTtlMs: 0,
    });
    gwPort = await listen(gw);
  });

  after(async () => {
    for (const s of [gw, cp, upstream]) await new Promise<void>((r) => s.close(() => r()));
  });

  async function startRun(): Promise<{ run: Run; token: string }> {
    for (const a of state.runs.list({ agentId: 'echo-agent', active: true })) await http_(cpPort, `/api/v1/runs/${a.runId}/cancel`, 'POST', ADMIN);
    const r = await http_(cpPort, '/api/v1/agents/echo-agent/runs', 'POST', ADMIN, {});
    const run = r.body as Run;
    const token = state.runtime.started.find((s) => s.runEnv.FACTORY_RUN_ID === run.runId)!.runEnv.FACTORY_RUN_TOKEN;
    return { run, token };
  }
  const llm = (token: string) =>
    http_(gwPort, '/anthropic/v1/messages', 'POST', token, { model: 'test-model', max_tokens: 10, messages: [] }, 'x-api-key');

  it('meters, attributes, and enforces a per-run budget end to end', async () => {
    // each call: 100k in * $3/M + 20k out * $15/M = $0.60
    await http_(cpPort, '/api/v1/agents/echo-agent/policy', 'PUT', ADMIN, { routes: ['anthropic'], budgetUsd: { perRun: 1 } });
    const { run, token } = await startRun();

    assert.equal((await llm(token)).status, 200);
    assert.equal(upstreamSaw.at(-1)?.key, PROVIDER_KEY, 'provider sees the real key');
    await settle();
    assert.equal((await llm(token)).status, 200);
    await settle();
    assert.equal(state.runs.get(run.runId)?.state, 'BLOCKED_BUDGET_EXCEEDED');
    const third = await llm(token);
    assert.equal(third.status, 402);

    const rows = state.ledger.query({ agent: 'echo-agent' }).filter((e) => e.type === 'llm');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((e) => e.actor === 'run:echo-agent' && e.runId === run.runId && e.costUsd === 0.6));

    await http_(cpPort, '/api/v1/agents/echo-agent/policy', 'PUT', ADMIN, { routes: ['anthropic'], budgetUsd: { perRun: 10 } });
    assert.equal((await llm(token)).status, 200, 'raising the budget unblocks');
  });

  it('isolating the agent cuts its egress within one context fetch', async () => {
    await http_(cpPort, '/api/v1/agents/echo-agent/policy', 'PUT', ADMIN, { routes: ['anthropic'] });
    const { token } = await startRun();
    assert.equal((await llm(token)).status, 200);
    await http_(cpPort, '/api/v1/agents/echo-agent/isolate', 'POST', ADMIN);
    assert.equal((await llm(token)).status, 403);
    await http_(cpPort, '/api/v1/agents/echo-agent/resume', 'POST', ADMIN);
  });

  it('a held tool call is released by a human approver through the control plane', async () => {
    await http_(cpPort, '/api/v1/agents/echo-agent/policy', 'PUT', ADMIN, {
      routes: ['deployer'],
      tools: { deployer: { allow: '*', requireApproval: ['deploy'] } },
    });
    const { run, token } = await startRun();
    const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'deploy', arguments: { env: 'prod' } } };

    const held = await http_(gwPort, '/deployer', 'POST', token, call);
    assert.equal(held.body.error.code, -32003);
    const approvalId = held.body.error.data.approvalId as string;
    assert.equal(state.runs.get(run.runId)?.state, 'BLOCKED_FOR_HUMAN');

    const pending = await http_(cpPort, '/api/v1/approvals?state=pending', 'GET', ADMIN);
    assert.ok((pending.body as Array<{ approvalId: string }>).some((a) => a.approvalId === approvalId));
    assert.equal((await http_(cpPort, `/api/v1/approvals/${approvalId}`, 'POST', APPROVER, { decision: 'approve' })).status, 200);

    const released = await http_(gwPort, '/deployer', 'POST', token, call);
    assert.equal(released.body.result.content[0].text, 'deployed');
    await settle();

    const trail = state.ledger
      .query({ agent: 'echo-agent' })
      .filter((e) => e.runId === run.runId && (e.action?.startsWith('APPROVAL_') || e.action?.startsWith('TOOL_')))
      .map((e) => `${e.action}@${e.actor}`);
    assert.deepEqual(trail, [
      'APPROVAL_REQUESTED@run:echo-agent',
      'TOOL_APPROVAL_REQUIRED@run:echo-agent',
      'APPROVAL_GRANTED@token:dale',
      'TOOL_CALL@run:echo-agent',
    ]);
  });
});
