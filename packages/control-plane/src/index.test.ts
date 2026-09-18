import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { pullMind, pushMind } from '@beercanlabs/factory-hydrate';
import { loadCatalog } from './catalog.js';
import { checkHealth, createFactoryServer, FactoryState, factoryMetrics, handleMcp, reconcileRuns } from './app.js';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { noopRuntime, type Runtime } from './runtime.js';
import { cronMatches } from './scheduler.js';
import { FileRunStore, MemoryRunStore, RunTokens, type Run } from './runs.js';
import { checkCallbackUrl, deliverCallback } from './callbacks.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';

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

const TOKENS = {
  admin: 'dev-token',
  viewer: 'viewer-token',
  operator: 'operator-token',
  ingest: 'ingest-token',
  gateway: 'gateway-token',
  approver: 'approver-token',
};
const SIGNING_KEY = 'callback-signing-key-for-tests';

function makeState(overrides: Partial<FactoryState> = {}): FactoryState & { runtime: ReturnType<typeof noopRuntime> } {
  const catalog = loadCatalog(agentsRoot);
  return {
    agents: new Map(catalog.map((a) => [a.id, a])),
    ledger: new MemoryLedger(),
    auth: bearerAuth([
      { name: 'admin', token: TOKENS.admin, roles: ['admin'] },
      { name: 'viewer', token: TOKENS.viewer, roles: ['viewer'] },
      { name: 'operator', token: TOKENS.operator, roles: ['operator'] },
      { name: 'sidecar', token: TOKENS.ingest, roles: ['ingest'] },
      { name: 'gateway', token: TOKENS.gateway, roles: ['gateway'] },
      { name: 'dale', token: TOKENS.approver, roles: ['approver'] },
    ]),
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    approvals: new ApprovalStore(),
    version: 'test',
    providers: [envProvider({ ECHO_WEBHOOK_SECRET: 'whsec', FACTORY_LEDGER_TOKEN: 'ledger' })],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    runTokens: new RunTokens(undefined),
    callbacks: { signingKey: SIGNING_KEY, allowInsecure: true, attempts: 2, backoffMs: 5 },
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
    ...overrides,
  } as FactoryState & { runtime: ReturnType<typeof noopRuntime> };
}

type RunBody = Run & { error?: string; missing?: string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('catalog', () => {
  it('loads example cartridges from agents/', () => {
    const ids = loadCatalog(agentsRoot).map((a) => a.id);
    for (const id of ['echo-agent', 'finops-officer', 'med-doc']) assert.ok(ids.includes(id));
  });
});

describe('scheduler', () => {
  it('matches */1 cron on the current minute', () => {
    assert.equal(cronMatches('* * * * *'), true);
    assert.equal(cronMatches('60 * * * *'), false);
  });
});

describe('control plane', { concurrency: false }, () => {
  let server: http.Server;
  let port = 0;
  let state: ReturnType<typeof makeState>;

  beforeEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    state = makeState();
    server = createFactoryServer(state);
    port = await listen(server);
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const actions = (agent: string) =>
    (state.ledger.query({ agent }) as Array<{ action?: string; actor?: string; runId?: string }>).filter((e) => e.action);
  const wake = (agent = 'echo-agent', body: unknown = {}, token = TOKENS.operator) =>
    request(port, `/api/v1/agents/${agent}/runs`, { method: 'POST', token, body });
  const tokenFor = (runId: string) => state.runtime.started.find((s) => s.runEnv.FACTORY_RUN_ID === runId)!.runEnv.FACTORY_RUN_TOKEN;

  describe('auth and roles', () => {
    it('serves health without auth and rejects the catalog without a bearer', async () => {
      assert.equal((await request(port, '/healthz')).status, 200);
      assert.equal((await request(port, '/api/v1/agents')).status, 401);
      assert.equal((await request(port, '/api/v1/agents', { token: TOKENS.viewer })).status, 200);
    });

    it('forbids a viewer from starting a run', async () => {
      assert.equal((await wake('echo-agent', {}, TOKENS.viewer)).status, 403);
    });

    it('only the ingest role may write the ledger; actor and type are enforced', async () => {
      const body = { agentId: 'echo-agent', type: 'llm', inputTokens: 1 };
      assert.equal((await request(port, '/api/v1/ledger', { method: 'POST', token: TOKENS.operator, body })).status, 403);
      assert.equal((await request(port, '/api/v1/ledger', { method: 'POST', body })).status, 401);
      assert.equal((await request(port, '/api/v1/ledger', { method: 'POST', token: TOKENS.ingest, body })).status, 201);
      await request(port, '/api/v1/ledger', {
        method: 'POST',
        token: TOKENS.ingest,
        body: { agentId: 'echo-agent', type: 'action', action: 'SPOOF', actor: 'oidc:ceo@example.com' },
      });
      assert.deepEqual(actions('echo-agent').filter((e) => e.action === 'SPOOF').map((e) => e.actor), ['token:sidecar']);
      assert.equal((await request(port, '/api/v1/agents', { token: TOKENS.ingest })).status, 403);
      assert.equal(
        (await request(port, '/api/v1/ledger', { method: 'POST', token: TOKENS.ingest, body: { agentId: 'echo-agent', type: 'approval' } })).status,
        400,
      );
    });

    it('verifies the ledger chain for viewers and reports tampering with 409', async () => {
      await wake();
      const ok = await request(port, '/api/v1/ledger/verify', { token: TOKENS.viewer });
      assert.equal(ok.status, 200);
      assert.equal((ok.json as { ok: boolean }).ok, true);
      const rows = (state.ledger as MemoryLedger).events;
      (rows[0] as { actor?: string }).actor = 'someone-else';
      const bad = await request(port, '/api/v1/ledger/verify', { token: TOKENS.viewer });
      assert.equal(bad.status, 409);
      assert.equal((bad.json as { firstBadSeq: number }).firstBadSeq, 1);
    });

    it('strips payload text from POST /ledger', async () => {
      await request(port, '/api/v1/ledger', {
        method: 'POST',
        token: TOKENS.ingest,
        body: { agentId: 'echo-agent', type: 'llm', prompt: 'never store this prompt', inputTokens: 2 },
      });
      const rows = (await request(port, '/api/v1/ledger?agent=echo-agent', { token: TOKENS.admin })).json as Array<Record<string, unknown>>;
      assert.equal(JSON.stringify(rows).includes('never store this prompt'), false);
      assert.ok(rows.some((e) => typeof e.payloadSha256 === 'string'));
    });
  });

  describe('runs', () => {
    it('returns 202 with a run and starts compute with secrets and run env kept separate', async () => {
      const res = await wake('echo-agent', { input: { q: 1 } });
      assert.equal(res.status, 202, JSON.stringify(res.json));
      const run = res.json as RunBody;
      assert.equal(run.state, 'WORKING');
      assert.equal(run.actor, 'token:operator');
      const start = state.runtime.started[0];
      assert.deepEqual(start.secrets, { ECHO_WEBHOOK_SECRET: 'whsec' });
      assert.equal(start.runEnv.FACTORY_RUN_ID, run.runId);
      assert.ok(start.runEnv.FACTORY_RUN_TOKEN);
      assert.equal('ECHO_WEBHOOK_SECRET' in start.runEnv, false);
      const started = actions('echo-agent').find((e) => e.action === 'RUN_STARTED');
      assert.equal(started?.actor, 'token:operator');
      assert.equal(started?.runId, run.runId);
    });

    it('wake is an alias that also returns 202', async () => {
      const res = await request(port, '/api/v1/agents/echo-agent/wake', { method: 'POST', token: TOKENS.operator });
      assert.equal(res.status, 202);
    });

    it('queues a second run while one is active, then starts it when the first reports', async () => {
      const first = (await wake()).json as RunBody;
      const second = (await wake()).json as RunBody;
      assert.equal(second.state, 'QUEUED');
      assert.equal(state.runtime.started.length, 1);

      const input = await request(port, `/api/v1/runs/${first.runId}/input`, { token: tokenFor(first.runId) });
      assert.equal(input.status, 200);

      const report = await request(port, `/api/v1/runs/${first.runId}/result`, {
        method: 'POST',
        token: tokenFor(first.runId),
        body: { status: 'succeeded', output: { answer: 'ok whsec' } },
      });
      assert.equal(report.status, 200, JSON.stringify(report.json));
      const done = report.json as RunBody;
      assert.equal(done.state, 'DONE');
      assert.deepEqual(done.result, { answer: 'ok ***' }, 'bound secret values are redacted from results');
      assert.equal(state.runs.get(second.runId)?.state, 'WORKING');
      assert.equal(state.runtime.started.length, 2);
    });

    it('run tokens are bound to one live run', async () => {
      const a = (await wake()).json as RunBody;
      const b = (await wake('med-doc')).json as RunBody;
      const path = `/api/v1/runs/${a.runId}/result`;
      assert.equal((await request(port, path, { method: 'POST', body: { status: 'succeeded' } })).status, 401);
      assert.equal((await request(port, path, { method: 'POST', token: TOKENS.admin, body: { status: 'succeeded' } })).status, 401);
      assert.equal((await request(port, path, { method: 'POST', token: tokenFor(b.runId), body: { status: 'succeeded' } })).status, 401);
      assert.equal((await request(port, path, { method: 'POST', token: tokenFor(a.runId), body: { status: 'succeeded' } })).status, 200);
      assert.equal(
        (await request(port, path, { method: 'POST', token: tokenFor(a.runId), body: { status: 'failed' } })).status,
        401,
        'token dies with its run',
      );
    });

    it('pre-flight: unbound secrets give 412 with a recorded run and ledger event', async () => {
      const res = await wake('finops-officer');
      assert.equal(res.status, 412);
      const body = res.json as { missing: string[]; runId: string };
      assert.ok(body.missing.includes('CLOUD_BILLING_READER'));
      assert.equal(state.runs.get(body.runId)?.state, 'PRE_FLIGHT_MISSING_SECRET');
      assert.ok(actions('finops-officer').some((e) => e.action === 'PRE_FLIGHT_MISSING_SECRET'));
      assert.equal(state.runtime.started.length, 0);
    });

    it('a failed run raises a crash event and wakes med-doc', async () => {
      const run = (await wake()).json as RunBody;
      await request(port, `/api/v1/runs/${run.runId}/result`, {
        method: 'POST',
        token: tokenFor(run.runId),
        body: { status: 'failed', error: 'boom' },
      });
      await sleep(10);
      assert.ok((state.ledger.query({ agent: 'echo-agent' }) as Array<{ type: string }>).some((e) => e.type === 'crash'));
      const medDoc = state.runs.list({ agentId: 'med-doc' })[0];
      assert.equal(medDoc?.trigger, 'event:crash');
      assert.equal(medDoc?.actor, 'factory:event-router');
    });

    it('crash events from ingest also route to med-doc', async () => {
      assert.equal((await request(port, '/api/v1/ledger', { method: 'POST', token: TOKENS.ingest, body: { agentId: 'echo-agent', type: 'crash' } })).status, 201);
      assert.equal(state.agents.get('med-doc')?.state, 'WORKING');
    });

    it('paused and isolated agents refuse new runs; resume starts queued work', async () => {
      assert.equal((await request(port, '/api/v1/agents/echo-agent/isolate', { method: 'POST', token: TOKENS.operator })).status, 200);
      assert.equal((await wake()).status, 409);
      assert.equal((await request(port, '/api/v1/agents/echo-agent/resume', { method: 'POST', token: TOKENS.operator })).status, 200);
      assert.equal((await wake()).status, 202);
      assert.ok(actions('echo-agent').some((e) => e.action === 'ISOLATE' && e.actor === 'token:operator'));
    });

    it('cancel stops a run; timeout ends a run that never reports', async () => {
      const run = (await wake()).json as RunBody;
      const cancelled = await request(port, `/api/v1/runs/${run.runId}/cancel`, { method: 'POST', token: TOKENS.operator });
      assert.equal((cancelled.json as RunBody).state, 'CANCELLED');

      state.idleMs = 20;
      const slow = (await wake()).json as RunBody;
      await sleep(60);
      assert.equal(state.runs.get(slow.runId)?.state, 'TIMED_OUT');
    });

    it('webhooks authenticate by cartridge secret and pass the body as input', async () => {
      const res = await request(port, '/api/v1/hooks/echo-agent', {
        method: 'POST',
        headers: { 'x-factory-secret': 'whsec' },
        body: { event: 'push' },
      });
      assert.equal(res.status, 202, JSON.stringify(res.json));
      const run = res.json as RunBody;
      assert.equal(run.actor, 'webhook:echo-agent');
      assert.deepEqual(state.runs.get(run.runId)?.input, { event: 'push' });
      assert.equal((await request(port, '/api/v1/hooks/echo-agent', { method: 'POST', headers: { 'x-factory-secret': 'nope' } })).status, 401);
      assert.equal((await request(port, '/api/v1/hooks/echo-agent', { method: 'POST', token: TOKENS.admin })).status, 401);
    });

    it('lists and fetches runs for viewers', async () => {
      const run = (await wake()).json as RunBody;
      assert.equal((await request(port, `/api/v1/runs/${run.runId}`, { token: TOKENS.viewer })).status, 200);
      const list = (await request(port, '/api/v1/runs?agent=echo-agent', { token: TOKENS.viewer })).json as RunBody[];
      assert.equal(list.length, 1);
    });
  });

  describe('callbacks', () => {
    let hook: http.Server;
    let hookPort = 0;
    const received: Array<{ sig: string; body: string }> = [];
    before(async () => {
      hook = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ sig: String(req.headers['x-factory-signature']), body });
          res.writeHead(200);
          res.end();
        });
      });
      hookPort = await listen(hook);
    });
    after(() => new Promise<void>((r) => hook.close(() => r())));

    it('delivers a signed terminal-state callback', async () => {
      const run = (await wake('echo-agent', { callbackUrl: `http://127.0.0.1:${hookPort}/done` })).json as RunBody;
      await request(port, `/api/v1/runs/${run.runId}/result`, {
        method: 'POST',
        token: tokenFor(run.runId),
        body: { status: 'succeeded', output: 42 },
      });
      await sleep(30);
      const got = received.at(-1)!;
      const payload = JSON.parse(got.body) as { runId: string; state: string; result: number };
      assert.equal(payload.runId, run.runId);
      assert.equal(payload.state, 'DONE');
      assert.equal(payload.result, 42);
      const [, t, v1] = got.sig.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
      assert.equal(v1, createHmac('sha256', SIGNING_KEY).update(`${t}.${got.body}`).digest('hex'));
      assert.ok(actions('echo-agent').some((e) => e.action === 'RUN_CALLBACK_DELIVERED'));
    });

    it('rejects unsafe callback targets', async () => {
      const strict = { signingKey: SIGNING_KEY, allowInsecure: false, attempts: 1, backoffMs: 1 };
      assert.match(checkCallbackUrl('http://example.com/x', strict) ?? '', /https/);
      assert.match(checkCallbackUrl('https://u:p@example.com/x', strict) ?? '', /credentials/);
      assert.match(checkCallbackUrl('https://example.com/x', { ...strict, signingKey: undefined }) ?? '', /SIGNING_KEY/);
      for (const target of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://localhost/x']) {
        const out = await deliverCallback(target, {}, strict);
        assert.equal(out.ok, false, target);
        assert.match(out.error ?? '', /private/, target);
      }
      assert.equal((await wake('echo-agent', { callbackUrl: 'ftp://example.com' })).status, 400);
    });
  });

  describe('policy, budget, approvals', () => {
    const put = (agent: string, body: unknown, token = TOKENS.admin) =>
      request(port, `/api/v1/agents/${agent}/policy`, { method: 'PUT', token, body });
    const llm = (run: RunBody, costUsd: number, token = TOKENS.gateway) =>
      request(port, '/api/v1/ledger', {
        method: 'POST',
        token,
        body: { agentId: run.agentId, runId: run.runId, type: 'llm', model: 'test-model', inputTokens: 1, costUsd, actor: `run:${run.agentId}` },
      });

    it('policy is deny-by-default, admin-only to change, and validated', async () => {
      assert.deepEqual((await request(port, '/api/v1/agents/echo-agent/policy', { token: TOKENS.viewer })).json, { routes: [] });
      assert.equal((await put('echo-agent', { routes: ['anthropic'] }, TOKENS.operator)).status, 403);
      assert.equal((await put('echo-agent', { routes: 'anthropic' })).status, 400);
      assert.equal((await put('echo-agent', { routes: [], budgetUsd: { perWeek: 1 } })).status, 400);
      assert.equal((await put('echo-agent', { routes: ['anthropic'], budgetUsd: { perRun: 1 } })).status, 200);
      assert.ok(actions('echo-agent').some((e) => e.action === 'POLICY_UPDATED' && e.actor === 'token:admin'));
    });

    it('the gateway gets run context, including spend', async () => {
      const run = (await wake()).json as RunBody;
      assert.equal((await request(port, `/api/v1/gateway/runs/${run.runId}`, { token: TOKENS.operator })).status, 403);
      await llm(run, 0.25);
      const ctx = (await request(port, `/api/v1/gateway/runs/${run.runId}`, { token: TOKENS.gateway })).json as {
        run: { live: boolean };
        spend: { run: number };
      };
      assert.equal(ctx.run.live, true);
      assert.equal(ctx.spend.run, 0.25);
    });

    it('only the gateway may attest a run actor or report cost', async () => {
      const run = (await wake()).json as RunBody;
      await llm(run, 5, TOKENS.ingest);
      const rows = state.ledger.query({ agent: 'echo-agent' }).filter((e) => e.type === 'llm');
      assert.equal(rows.at(-1)?.actor, 'token:sidecar');
      assert.equal(rows.at(-1)?.costUsd, undefined);
      assert.equal(state.spend.get('echo-agent', run.runId).run, 0);
      await llm(run, 0.1);
      assert.equal(state.ledger.query({ agent: 'echo-agent' }).filter((e) => e.type === 'llm').at(-1)?.actor, 'run:echo-agent');
      const wrongAgent = await request(port, '/api/v1/ledger', {
        method: 'POST',
        token: TOKENS.gateway,
        body: { agentId: 'med-doc', runId: run.runId, type: 'llm', costUsd: 1 },
      });
      assert.equal(wrongAgent.status, 400);
    });

    it('crossing the budget blocks the run, alerts, and raising the budget unblocks it', async () => {
      await put('echo-agent', { routes: ['anthropic'], budgetUsd: { perRun: 1 } });
      const run = (await wake()).json as RunBody;
      await llm(run, 0.6);
      assert.equal(state.runs.get(run.runId)?.state, 'WORKING');
      await llm(run, 0.6);
      assert.equal(state.runs.get(run.runId)?.state, 'BLOCKED_BUDGET_EXCEEDED');
      const alert = state.ledger.query({ agent: 'echo-agent' }).find((e) => e.type === 'budget.alert');
      assert.equal(alert?.action, 'BUDGET_PERRUN_EXCEEDED');
      assert.equal(state.runs.list({ agentId: 'finops-officer' }).length, 1, 'budget alert routed to finops-officer');
      await put('echo-agent', { routes: ['anthropic'], budgetUsd: { perRun: 5 } });
      assert.equal(state.runs.get(run.runId)?.state, 'WORKING');
      assert.ok(actions('echo-agent').some((e) => e.action === 'RUN_UNBLOCKED'));
    });

    it('approvals: request blocks the run, approver decides, one consume per approval', async () => {
      const run = (await wake()).json as RunBody;
      const req = { runId: run.runId, route: 'tools', tool: 'deploy', argsSha256: 'abc' };
      const first = await request(port, '/api/v1/gateway/approvals', { method: 'POST', token: TOKENS.gateway, body: req });
      assert.equal(first.status, 201);
      const approval = first.json as { approvalId: string; state: string };
      assert.equal(state.runs.get(run.runId)?.state, 'BLOCKED_FOR_HUMAN');
      const again = await request(port, '/api/v1/gateway/approvals', { method: 'POST', token: TOKENS.gateway, body: req });
      assert.equal((again.json as { approvalId: string }).approvalId, approval.approvalId, 'idempotent');

      assert.equal((await request(port, `/api/v1/approvals/${approval.approvalId}`, { method: 'POST', token: TOKENS.operator, body: { decision: 'approve' } })).status, 403);
      assert.equal((await request(port, `/api/v1/gateway/approvals/${approval.approvalId}/consume`, { method: 'POST', token: TOKENS.gateway })).status, 409);
      const decided = await request(port, `/api/v1/approvals/${approval.approvalId}`, { method: 'POST', token: TOKENS.approver, body: { decision: 'approve' } });
      assert.equal(decided.status, 200);
      assert.equal(state.runs.get(run.runId)?.state, 'WORKING');
      assert.equal((await request(port, `/api/v1/gateway/approvals/${approval.approvalId}/consume`, { method: 'POST', token: TOKENS.gateway })).status, 200);
      assert.equal((await request(port, `/api/v1/gateway/approvals/${approval.approvalId}/consume`, { method: 'POST', token: TOKENS.gateway })).status, 409);

      const trail = actions('echo-agent').filter((e) => e.action?.startsWith('APPROVAL_'));
      assert.deepEqual(trail.map((e) => [e.action, e.actor]), [
        ['APPROVAL_REQUESTED', 'run:echo-agent'],
        ['APPROVAL_GRANTED', 'token:dale'],
      ]);
    });
  });

  describe('health', () => {
    const beat = (run: RunBody, body: unknown = {}) =>
      request(port, `/api/v1/runs/${run.runId}/heartbeat`, { method: 'POST', token: tokenFor(run.runId), body });

    it('heartbeats need the run token; silence after the first beat halts the run as BLOCKED_UNHEALTHY', async () => {
      state.heartbeatTimeoutMs = 1000;
      const run = (await wake()).json as RunBody;
      assert.equal((await request(port, `/api/v1/runs/${run.runId}/heartbeat`, { method: 'POST', token: TOKENS.admin })).status, 401);
      await checkHealth(state);
      assert.equal(state.runs.get(run.runId)?.state, 'WORKING', 'no heartbeat yet: not monitored');
      assert.equal((await beat(run, { rssMb: 50 })).status, 200);
      await checkHealth(state, Date.now() + 500);
      assert.equal(state.runs.get(run.runId)?.state, 'WORKING');
      await checkHealth(state, Date.now() + 5000);
      const halted = state.runs.get(run.runId)!;
      assert.equal(halted.state, 'BLOCKED_UNHEALTHY');
      assert.equal(halted.error, 'HEARTBEAT_LOST');
      assert.equal(state.runtime.running('echo-agent'), false, 'compute halted');
      assert.ok(state.ledger.query({ agent: 'echo-agent' }).some((e) => e.type === 'crash' && e.action === 'HEARTBEAT_LOST'));
      assert.equal(state.runs.list({ agentId: 'med-doc' }).length, 1, 'crash routed to med-doc');
    });

    it('a heartbeat over the memory ceiling halts immediately', async () => {
      state.maxRssMb = 100;
      const run = (await wake()).json as RunBody;
      await beat(run, { rssMb: 512 });
      assert.equal(state.runs.get(run.runId)?.state, 'BLOCKED_UNHEALTHY');
      assert.equal(state.runs.get(run.runId)?.error, 'MEMORY_CEILING');
    });

    it('three consecutive failures pause the agent until an operator resumes it', async () => {
      state.crashLoopThreshold = 3;
      for (let i = 0; i < 3; i++) {
        const run = (await wake()).json as RunBody;
        await request(port, `/api/v1/runs/${run.runId}/result`, { method: 'POST', token: tokenFor(run.runId), body: { status: 'failed' } });
      }
      assert.equal(state.agents.get('echo-agent')?.state, 'PAUSED');
      assert.ok(actions('echo-agent').some((e) => e.action === 'CRASH_LOOP_PAUSED' && e.actor === 'factory:health'));
      assert.equal((await wake()).status, 409);
      await request(port, '/api/v1/agents/echo-agent/resume', { method: 'POST', token: TOKENS.operator });
      assert.equal((await wake()).status, 202);
    });

    it('emits run metrics through OpenTelemetry', async () => {
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
      const provider = new MeterProvider({ readers: [reader] });
      state.metrics = factoryMetrics(provider.getMeter('test'), () => state);
      const run = (await wake()).json as RunBody;
      await reader.forceFlush();
      await request(port, `/api/v1/runs/${run.runId}/result`, { method: 'POST', token: tokenFor(run.runId), body: { status: 'succeeded' } });
      await reader.forceFlush();
      const names = exporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)));
      for (const n of ['factory.runs.finished', 'factory.run.duration', 'factory.runs.active']) assert.ok(names.includes(n), n);
      await provider.shutdown();
    });
  });

  describe('MCP', () => {
    it('filters and enforces tools by role', async () => {
      const admin = { actor: 'token:admin', roles: ['admin' as const] };
      const viewer = { actor: 'token:viewer', roles: ['viewer' as const] };
      const names = (p: typeof admin | typeof viewer) =>
        handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, p).then((r) =>
          (r as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name),
        );
      assert.ok((await names(admin)).includes('wake_agent'));
      assert.ok((await names(viewer)).includes('get_run'));
      assert.equal((await names(viewer)).includes('wake_agent'), false);
      const denied = (await handleMcp(
        state,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wake_agent', arguments: { id: 'echo-agent' } } },
        viewer,
      )) as { error?: { message: string } };
      assert.match(denied.error?.message ?? '', /forbidden/);
      assert.equal((await request(port, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
    });
  });
});

describe('restart reconciliation', () => {
  it('fails runs whose in-process task died with the control plane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const before = makeState({ runs: new FileRunStore(dir) });
    const run = before.runs.create({ agentId: 'echo-agent', state: 'WORKING', actor: 'token:operator', trigger: 'api', taskHandle: 'pid:1' });

    const after = makeState({ runs: new FileRunStore(dir) });
    assert.equal(after.runs.get(run.runId)?.state, 'WORKING', 'run survived the restart on disk');
    await reconcileRuns(after);
    const lost = after.runs.get(run.runId)!;
    assert.equal(lost.state, 'FAILED');
    assert.match(lost.error ?? '', /control plane restarted/);
    rmSync(dir, { recursive: true });
  });

  it('adopts or finishes runs whose remote tasks outlived the control plane', async () => {
    const statuses: Record<string, 'running' | 'stopped'> = { 'arn:a': 'running', 'arn:b': 'stopped' };
    const remote: Runtime = {
      ...noopRuntime(),
      running: () => false,
      status: async (h) => (statuses[h] === 'running' ? { state: 'running' } : { state: 'stopped', exitCode: 0 }),
    };
    const state = makeState({ runtime: remote as ReturnType<typeof noopRuntime> });
    const a = state.runs.create({ agentId: 'echo-agent', state: 'WORKING', actor: 'x', trigger: 'api', taskHandle: 'arn:a' });
    const b = state.runs.create({ agentId: 'med-doc', state: 'WORKING', actor: 'x', trigger: 'api', taskHandle: 'arn:b' });
    await reconcileRuns(state);
    assert.equal(state.runs.get(a.runId)?.state, 'WORKING');
    assert.equal(state.agents.get('echo-agent')?.state, 'WORKING');
    assert.equal(state.runs.get(b.runId)?.state, 'DONE');
  });
});

describe('hydrate through runtime store', () => {
  it('survives a kill of ephemeral disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-'));
    const store = { root: join(root, 'obj') };
    const dest = join(root, 'ephem');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'note.md'), 'x');
    pushMind(store, 'echo-agent', dest);
    rmSync(dest, { recursive: true, force: true });
    pullMind(store, 'echo-agent', dest);
    assert.equal(readFileSync(join(dest, 'note.md'), 'utf8'), 'x');
    rmSync(root, { recursive: true });
  });
});
