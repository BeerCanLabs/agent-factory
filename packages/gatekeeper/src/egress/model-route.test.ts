import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type Policy, type RunContext } from './gatekeeper-egress.js';
import { bedrockConverse, parseModelCatalog, signV4, ModelUpstreamError, type ModelCatalog, type ModelAdapter } from '@beercanlabs/factory-executive';

const tokens = new RunTokens('models-test-run-token-key-0123456789');
const AWS = { accessKeyId: 'AKIDGATEKEEPER', secretAccessKey: 'gatekeeper-egress-secret-key', sessionToken: 'gatekeeper-egress-session' };
const SONNET_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<{ status: number; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

describe('factory model API (/models/v1/chat/completions)', { concurrency: false }, () => {
  const seen: Seen[] = [];
  let upstreamStatus = 200;
  let upstreamUsage = true;
  let upstream: http.Server;
  let upPort = 0;
  let gatekeeperEgress: http.Server;
  let port = 0;
  const ledger: Array<Record<string, any>> = [];
  let ctx: RunContext;
  let token = '';
  let runSeq = 0;

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
      if (event.type === 'llm' && typeof event.costUsd === 'number' && event.runId === ctx.run.runId) {
        ctx.spend.run += event.costUsd;
        ctx.spend.day += event.costUsd;
        ctx.spend.month += event.costUsd;
      }
    },
  };

  const catalog: ModelCatalog = parseModelCatalog(
    JSON.stringify({
      'claude-sonnet-4-5': { provider: 'bedrock-converse', id: SONNET_ID, region: 'us-east-1', price: { inputPerMTok: 3, outputPerMTok: 15 } },
      'claude-haiku-4-5': { provider: 'bedrock-converse', id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', region: 'us-east-1', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      'future-model': { provider: 'vertex', id: 'x', price: { inputPerMTok: 1, outputPerMTok: 1 } },
    }),
  );
  // Fixtures name the models they use: a policy without `models` grants only the factory default (M2).
  const TEST_MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-9', 'future-model'];
  const policy = (p: Partial<Policy> = {}): Policy => ({ routes: ['models'], models: TEST_MODELS, ...p });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const lastLlm = () => ledger.filter((e) => e.type === 'llm').at(-1);
  const chat = (model = 'claude-sonnet-4-5', extra: Record<string, unknown> = {}) => ({
    model,
    max_tokens: 256,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You are Donna.' },
      { role: 'user', content: 'secret prompt text' },
    ],
    ...extra,
  });

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
        if (upstreamStatus !== 200) {
          res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Too many requests, please wait.' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            output: { message: { role: 'assistant', content: [{ text: 'Hello, ' }, { text: 'Dale.' }] } },
            stopReason: 'end_turn',
            ...(upstreamUsage ? { usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } } : {}),
          }),
        );
      });
    });
    upPort = await listen(upstream);
    gatekeeperEgress = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }, { id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}/anthropic` }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      contextTtlMs: 0,
      modelCatalog: catalog,
      // The factory default is configuration (M2, GAP-181): this factory has one.
      defaultModel: 'claude-haiku-4-5',
      modelAdapters: {
        'bedrock-converse': bedrockConverse({ credentials: async () => AWS, endpoint: (region) => `http://127.0.0.1:${upPort}/${region}` }),
      },
    });
    port = await listen(gatekeeperEgress);
  });

  after(async () => {
    await new Promise<void>((r) => gatekeeperEgress.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(async () => {
    ledger.length = 0;
    seen.length = 0;
    upstreamStatus = 200;
    upstreamUsage = true;
    const runId = `run-${++runSeq}`;
    ctx = { run: { runId, agentId: 'donna', state: 'WORKING', live: true }, agentState: 'WORKING', policy: policy(), spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId: 'donna' });
  });

  it('translates to Bedrock Converse, signs with the gatekeeper-egress credentials, and answers in OpenAI shape', async () => {
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat() });
    assert.equal(res.status, 200, res.text);
    const out = res.json();
    assert.equal(out.object, 'chat.completion');
    assert.equal(out.model, 'claude-sonnet-4-5');
    assert.match(out.id, /^chatcmpl-/);
    assert.deepEqual(out.choices, [{ index: 0, message: { role: 'assistant', content: 'Hello, Dale.' }, finish_reason: 'stop' }]);
    assert.deepEqual(out.usage, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });

    assert.equal(seen.length, 1);
    const up = seen[0];
    assert.equal(up.method, 'POST');
    assert.equal(up.path, `/us-east-1/model/${encodeURIComponent(SONNET_ID)}/converse`);
    assert.deepEqual(JSON.parse(up.body), {
      system: [{ text: 'You are Donna.' }],
      messages: [{ role: 'user', content: [{ text: 'secret prompt text' }] }],
      inferenceConfig: { maxTokens: 256, temperature: 0.2 },
    });
    // The signature covers exactly what arrived upstream.
    const date = String(up.headers['x-amz-date']);
    const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expected = signV4(
      { method: 'POST', url: new URL(`http://127.0.0.1:${upPort}${up.path}`), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: up.body },
      AWS,
      { region: 'us-east-1', service: 'bedrock' },
      d,
      { contentSha256Header: true },
    );
    assert.equal(up.headers.authorization, expected.authorization);
    assert.match(String(up.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDGATEKEEPER\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
    assert.equal(up.headers['x-amz-security-token'], 'gatekeeper-egress-session');
  });

  it('never forwards the run token upstream', async () => {
    await call(port, '/models/v1/chat/completions', { token, body: chat() });
    assert.equal(seen.length, 1);
    assert.equal(JSON.stringify(seen[0].headers).includes(token), false);
    assert.equal(seen[0].body.includes(token), false);
  });

  it('meters from Converse usage at the catalog price and ledgers an llm event without prompt bodies', async () => {
    await call(port, '/models/v1/chat/completions', { token, body: chat() });
    await settle();
    const e = lastLlm()!;
    assert.equal(e.route, 'models');
    assert.equal(e.model, 'claude-sonnet-4-5');
    assert.equal(e.upstreamModel, SONNET_ID);
    assert.equal(e.provider, 'bedrock-converse');
    assert.equal(e.inputTokens, 1200);
    assert.equal(e.outputTokens, 300);
    assert.equal(e.costUsd, (1200 * 3 + 300 * 15) / 1e6);
    assert.equal(e.runId, ctx.run.runId);
    assert.equal(e.actor, 'run:donna');
    assert.ok(e.payloadSha256);
    assert.equal(JSON.stringify(ledger).includes('secret prompt text'), false);
  });

  it('charges the worst case when the provider reports no usage', async () => {
    upstreamUsage = false;
    ctx.policy = policy({ models: ['claude-haiku-4-5'] });
    await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') });
    await settle();
    const e = lastLlm()!;
    assert.equal(e.action, 'METERING_GAP');
    assert.equal(e.outputTokens, 256);
    assert.equal(e.costUsd, (256 * 5) / 1e6);
  });

  it('denies when the policy does not grant the models route (E7)', async () => {
    ctx.policy = { routes: ['anthropic'] };
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat() });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'route_not_allowed');
    assert.equal(seen.length, 0);
    await settle();
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROUTE_NOT_ALLOWED' && e.route === 'models'));
  });

  it('E7 an admin-set policy that grants a model needs no separate models route', async () => {
    ctx.policySet = true;
    ctx.policy = { routes: [], models: ['claude-haiku-4-5'] };
    const ok = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') });
    assert.equal(ok.status, 200);
    // The route is implied; which model is still the policy's (M2): asking for another serves the policy's.
    const other = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(other.status, 200);
    assert.equal(other.json().model, 'claude-haiku-4-5');
  });

  it('E7 the global fallback policy implies no model access', async () => {
    ctx.policySet = false;
    ctx.policy = { routes: [], models: ['claude-haiku-4-5'] };
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'route_not_allowed');
  });

  it('E7 M4 an admin-set policy does not imply provider-native routes', async () => {
    ctx.policySet = true;
    ctx.policy = { routes: [], models: ['claude-haiku-4-5'] };
    const res = await call(port, '/anthropic/v1/messages', { token, body: { model: 'x', messages: [] } });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'route_not_allowed');
  });

  it('M2 E7 a policy that names no models gets the configured factory default, whatever the agent asks for', async () => {
    ctx.policy = { routes: ['models'] };
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(res.status, 200);
    assert.equal(res.json().model, 'claude-haiku-4-5');
    assert.ok(seen.at(-1)?.path.includes(encodeURIComponent('us.anthropic.claude-haiku-4-5-20251001-v1:0')), 'the provider was asked for the default');
  });

  it('M2 GAP-181 agents never choose: the policy model is served and a differing request is recorded', async () => {
    ctx.policy = policy({ models: ['claude-haiku-4-5'] });
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(res.status, 200);
    assert.equal(res.json().model, 'claude-haiku-4-5');
    await settle();
    const llm = lastLlm()!;
    assert.equal(llm.model, 'claude-haiku-4-5');
    assert.equal(llm.requestedModel, 'claude-sonnet-4-5');
    // A call that names no model, or the served one, records no request.
    await call(port, '/models/v1/chat/completions', { token, body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 256 } });
    await settle();
    assert.equal(lastLlm()!.requestedModel, undefined);
    assert.ok(!ledger.some((e) => e.action === 'EGRESS_DENIED_MODEL_NOT_ALLOWED'));
  });

  it('refuses a policy model the catalog does not offer', async () => {
    ctx.policy = policy({ models: ['gpt-9'] });
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'model_not_offered');
    assert.equal(seen.length, 0);
  });

  it('refuses a catalog model whose provider has no adapter', async () => {
    ctx.policy = policy({ models: ['future-model'] });
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('future-model') });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'provider_unavailable');
  });

  it('rejects streaming for now', async () => {
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5', { stream: true }) });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'streaming_not_supported');
    assert.equal(seen.length, 0);
  });

  it('rejects missing tokens and unsupported message shapes', async () => {
    assert.equal((await call(port, '/models/v1/chat/completions', { body: chat() })).status, 401);
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5', { messages: [{ role: 'function', content: 'x' }] }) });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'unsupported_role');
    // A tool result must name the call it answers (GAP-173).
    const orphan = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5', { messages: [{ role: 'tool', content: 'x' }] }) });
    assert.equal(orphan.status, 400);
    assert.equal(orphan.json().error, 'invalid_tool_message');
    assert.equal(seen.length, 0);
  });

  it('enforces the budget before calling the provider', async () => {
    ctx.policy = policy({ budgetUsd: { perRun: 0.01 } });
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat() })).status, 200);
    await settle();
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat() })).status, 200);
    await settle();
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat() });
    assert.equal(res.status, 402);
    assert.equal(res.json().error, 'budget_exceeded');
    assert.equal(seen.length, 2);
  });

  it('a helper run out of its parent budget is refused as supervising_agent_out_of_budget (E2.1)', async () => {
    ctx.policy = policy({ budgetUsd: { perRun: 0.01 } });
    const saved = ctx.spend;
    (ctx as any).budgetOf = 'parent';
    (ctx as any).spend = { run: 1, day: 1, month: 1 };
    const before = seen.length;
    try {
      const res = await call(port, '/models/v1/chat/completions', { token, body: chat() });
      assert.equal(res.status, 402);
      assert.equal(res.json().error, 'supervising_agent_out_of_budget');
      assert.equal(seen.length, before);
    } finally {
      delete (ctx as any).budgetOf;
      ctx.spend = saved;
    }
  });

  it('honours isolate and pause', async () => {
    ctx.agentState = 'ISOLATED';
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat() })).status, 403);
    ctx.agentState = 'PAUSED';
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat() })).status, 503);
    assert.equal(seen.length, 0);
  });

  it('maps provider throttling to 429 and ledgers the failure without charging', async () => {
    upstreamStatus = 429;
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat() });
    assert.equal(res.status, 429);
    assert.equal(res.json().error, 'upstream_throttled');
    await settle();
    assert.equal(lastLlm(), undefined);
    assert.ok(ledger.some((e) => e.action === 'MODEL_UPSTREAM_ERROR' && e.upstreamStatus === 429));
  });

  it('lists the offered models the policy allows', async () => {
    ctx.policy = policy({ models: ['claude-haiku-4-5'] });
    const res = await call(port, '/models/v1/models', { token, method: 'GET' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json().data.map((m: { id: string }) => m.id), ['claude-haiku-4-5']);
  });

  it('resolves provider credentials from SecretProvider with precedence over ambient env (GAP-162, K5, M3)', async () => {
    let capturedKey = '';
    const origEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'stale-ambient-env-key';
    const memProviders = [{
      name: 'mem',
      async get(name: string) { return name === 'ANTHROPIC_API_KEY' ? 'sk-ant-from-provider-123' : undefined; },
      async put() {},
      async has() { return false; },
      async present() { return new Set<string>(); },
    }];

    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: memProviders,
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'claude-haiku-5-5': { provider: 'anthropic', id: 'claude-haiku-5-5', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async (url, init) => {
        capturedKey = new Headers(init?.headers).get('x-api-key') ?? '';
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Hello from Anthropic via provider key!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        }), { status: 200 });
      },
    });

    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['claude-haiku-5-5'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('claude-haiku-5-5') });
      assert.equal(res.status, 200);
      assert.equal(capturedKey, 'sk-ant-from-provider-123');
      const body = res.json();
      assert.equal(body.choices[0].message.content, 'Hello from Anthropic via provider key!');
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_API_KEY = origEnv;
      else delete process.env.ANTHROPIC_API_KEY;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('redacts bound SecretProvider credentials from upstream error responses (S1)', async () => {
    const memProviders = [{
      name: 'mem',
      async get(name: string) { return name === 'ANTHROPIC_API_KEY' ? 'placeholder-secret-to-redact-987' : undefined; },
      async put() {},
      async has() { return false; },
      async present() { return new Set<string>(); },
    }];

    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: memProviders,
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'claude-haiku-5-5': { provider: 'anthropic', id: 'claude-haiku-5-5', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async () => {
        return new Response(JSON.stringify({
          error: { message: 'Invalid API key: placeholder-secret-to-redact-987 is expired or revoked' },
        }), { status: 401 });
      },
    });

    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['claude-haiku-5-5'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('claude-haiku-5-5') });
      assert.equal(res.status, 502);
      const body = res.json();
      assert.equal(body.error, 'upstream_error');
      assert.ok(body.message.includes('***'), 'bound secret is replaced with ***');
      assert.ok(!res.text.includes('placeholder-secret-to-redact-987'), 'raw response does not leak secret');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses a catalog secret that is not a platform credential, reading nothing (GAP-169, S1, K5)', async () => {
    const read: string[] = [];
    let called = false;
    const memProviders = [{
      name: 'mem',
      async get(name: string) { read.push(name); return 'held-value-1234'; },
    }];

    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control: { ...control, systemRoutes: async () => ({ routes: [], platformCredentials: ['DEEPSEEK_API_KEY'], platformCredentialHosts: { DEEPSEEK_API_KEY: ['api.deepseek.example'] } }) },
      providers: memProviders,
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        exfil: { provider: 'openai', id: 'gpt-x', endpoint: 'https://collector.example', secret: 'DISCORD_BOT_TOKEN', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });

    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['exfil'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('exfil') });
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'provider_credentials_unavailable');
      assert.deepEqual(read, [], 'no secret is read');
      assert.equal(called, false, 'the vendor is never called');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('resolves a catalog secret that is a platform credential on an approved system (GAP-169, GAP-167)', async () => {
    let capturedAuth = '';
    const memProviders = [{
      name: 'mem',
      async get(name: string) { return name === 'DEEPSEEK_API_KEY' ? 'sk-deepseek-5678' : undefined; },
    }];

    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control: { ...control, systemRoutes: async () => ({ routes: [], platformCredentials: ['DEEPSEEK_API_KEY'], platformCredentialHosts: { DEEPSEEK_API_KEY: ['api.deepseek.example'] } }) },
      providers: memProviders,
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'deepseek-chat': { provider: 'openai', id: 'deepseek-chat', endpoint: 'https://api.deepseek.example', secret: 'DEEPSEEK_API_KEY', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async (_url, init) => {
        capturedAuth = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }), { status: 200 });
      },
    });

    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['deepseek-chat'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('deepseek-chat') });
      assert.equal(res.status, 200);
      assert.equal(capturedAuth, 'Bearer sk-deepseek-5678');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('serves a tool-result turn end to end: the second call of Rosie reaches Anthropic as tool_use/tool_result (GAP-173, M1)', async () => {
    let sent: { messages?: unknown; temperature?: unknown } = {};
    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 'mem', async get(name: string) { return name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-1234' : undefined; } }],
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'claude-haiku-5-5': { provider: 'anthropic', id: 'claude-haiku-5-5', price: { inputPerMTok: 0.1, outputPerMTok: 0.5 } },
      })),
      modelFetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'The litter box is clean!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 40, output_tokens: 8 },
        }), { status: 200 });
      },
    });
    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['claude-haiku-5-5'] });
      const res = await call(sPort, '/models/v1/chat/completions', {
        token,
        body: {
          model: 'claude-haiku-5-5',
          temperature: 0.2,
          messages: [
            { role: 'user', content: 'hey Rosie' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'toolu_01', content: '{"level":"clean"}' },
          ],
          tools: [{ type: 'function', function: { name: 'get_kitty_litter_status', parameters: { type: 'object', properties: {} } } }],
        },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'The litter box is clean!');
      assert.deepEqual((sent.messages as unknown[]).slice(1), [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_kitty_litter_status', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"level":"clean"}' }] },
      ]);
      assert.equal('temperature' in sent, false, 'no sampling params for a Claude 5.5 model (GAP-171)');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sends tool_choice required to Claude Sonnet 5.5 as auto, which it accepts (GAP-175, M3)', async () => {
    let sent: { tool_choice?: unknown } = {};
    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 'mem', async get(name: string) { return name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-5678' : undefined; } }],
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'claude-sonnet-5-5': { provider: 'anthropic', id: 'claude-sonnet-5-5', price: { inputPerMTok: 2, outputPerMTok: 10 } },
      })),
      modelFetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          content: [{ type: 'tool_use', id: 'toolu_02', name: 'get_kitty_litter_status', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 5 },
        }), { status: 200 });
      },
    });
    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['claude-sonnet-5-5'] });
      const res = await call(sPort, '/models/v1/chat/completions', {
        token,
        body: {
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'check the litter box' }],
          tools: [{ type: 'function', function: { name: 'get_kitty_litter_status', parameters: { type: 'object', properties: {} } } }],
          tool_choice: 'required',
        },
      });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(sent.tool_choice, { type: 'auto' });
      assert.equal(res.json().choices[0].message.tool_calls[0].function.name, 'get_kitty_litter_status');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('M2 GAP-181 with no factory default configured, a policy naming no models is refused (no_default_model)', async () => {
    const bare = createGatekeeperEgress({ routes: [{ id: 'models', kind: 'models' }], prices: {}, runTokens: tokens, control, contextTtlMs: 0, modelCatalog: catalog });
    const bPort = await listen(bare);
    try {
      ctx.policy = { routes: ['models'] };
      const res = await call(bPort, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'no_default_model');
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it('E7 GAP-181 a run pin the policy does not grant is refused on the factory model API', async () => {
    ctx.policy = policy({ models: ['claude-haiku-4-5'] });
    ctx.run.model = 'claude-sonnet-4-5';
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'model_not_allowed');
    assert.equal(seen.length, 0, 'nothing reached a provider');
  });

  it('M2 an explicit empty model list grants none, even with a factory default configured', async () => {
    ctx.policy = policy({ models: [] });
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'model_not_allowed');
    assert.equal(seen.length, 0);
  });

  it('GAP-182 a key goes only to its own hosts: a built-in key on a foreign endpoint is refused before anything is read', async () => {
    const read: string[] = [];
    let called = false;
    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control: { ...control, systemRoutes: async () => ({ routes: [], platformCredentials: [], platformCredentialHosts: {} }) },
      providers: [{ name: 'mem', async get(name: string) { read.push(name); return 'sk-real-openai-key'; } }],
      contextTtlMs: 0,
      modelCatalog: parseModelCatalog(JSON.stringify({
        'gpt-x': { provider: 'openai', id: 'gpt-x', endpoint: 'https://collector.example', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });
    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['gpt-x'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('gpt-x') });
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'provider_credentials_unavailable');
      assert.deepEqual(read, [], 'no key is read for an unbound host');
      assert.equal(called, false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('GAP-182 a host the operator trusts may receive a model key', async () => {
    let auth = '';
    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 'mem', async get(name: string) { return name === 'OPENAI_API_KEY' ? 'sk-proxy-key' : undefined; } }],
      contextTtlMs: 0,
      trustedModelHosts: ['proxy.internal.example'],
      modelCatalog: parseModelCatalog(JSON.stringify({
        'gpt-x': { provider: 'openai', id: 'gpt-x', endpoint: 'https://proxy.internal.example', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      })),
      modelFetch: async (_url, init) => {
        auth = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      },
    });
    const sPort = await listen(server);
    try {
      ctx.policy = policy({ models: ['gpt-x'] });
      const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('gpt-x') });
      assert.equal(res.status, 200, res.text);
      assert.equal(auth, 'Bearer sk-proxy-key');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  describe('persistent failback and model failover (TSK-168)', () => {
    let discordServer: http.Server;
    let dPort = 0;
    const discordPosted: Array<{ content: string }> = [];

    before(async () => {
      discordServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const p = JSON.parse(body);
            if (typeof p.content === 'string') discordPosted.push({ content: p.content });
          } catch {}
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg-1' }));
        });
      });
      dPort = await listen(discordServer);
    });

    after(async () => {
      await new Promise<void>((r) => discordServer.close(() => r()));
    });

    beforeEach(() => {
      discordPosted.length = 0;
    });

    const createTestRig = (opts: {
      adapter?: ModelAdapter;
      customCatalog?: ModelCatalog;
      failoverHandler?: (req: { runId: string; toModel: string; fromModel?: string; reason?: string }) => Promise<{ ok: boolean; currentModel?: string }>;
      enableRunModels?: boolean;
      getRunModelsHandler?: (req: { runId: string; runToken: string }) => Promise<any>;
      setRunModelsHandler?: (req: { runId: string; runToken: string; currentModel?: string; primaryModel?: string; secondaryModel?: string }) => Promise<any>;
    } = {}) => {
      const rigLedger: Array<Record<string, any>> = [];
      const failoverCalls: Array<{ runId: string; toModel: string; fromModel?: string; reason?: string }> = [];
      const getRunModelsCalls: Array<{ runId: string; runToken: string }> = [];
      const setRunModelsCalls: Array<{ runId: string; runToken: string; currentModel?: string; primaryModel?: string; secondaryModel?: string }> = [];

      const testControl: ControlClient = {
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
          rigLedger.push(event);
          if (event.type === 'llm' && typeof event.costUsd === 'number' && event.runId === ctx.run.runId) {
            ctx.spend.run += event.costUsd;
            ctx.spend.day += event.costUsd;
            ctx.spend.month += event.costUsd;
          }
        },
        async modelFailover(req) {
          failoverCalls.push(req);
          if (opts.failoverHandler) return opts.failoverHandler(req);
          if (ctx.run.runId === req.runId) {
            ctx.policy.currentModel = req.toModel;
          }
          return { ok: true, currentModel: req.toModel };
        },
        ...(opts.enableRunModels
          ? {
              async getRunModels(req) {
                getRunModelsCalls.push(req);
                if (opts.getRunModelsHandler) return opts.getRunModelsHandler(req);
                return {
                  agentId: ctx.run.agentId,
                  approvedModels: ctx.policy.models ?? [],
                  currentModel: ctx.policy.currentModel ?? ctx.policy.models?.[0],
                  primaryModel: ctx.policy.primaryModel ?? ctx.policy.models?.[0],
                  secondaryModel: ctx.policy.secondaryModel,
                  canManageModels: ctx.canManageModels,
                };
              },
              async setRunModels(req) {
                setRunModelsCalls.push(req);
                if (opts.setRunModelsHandler) return opts.setRunModelsHandler(req);
                if (req.currentModel) ctx.policy.currentModel = req.currentModel;
                if (req.primaryModel) ctx.policy.primaryModel = req.primaryModel;
                if (req.secondaryModel !== undefined) ctx.policy.secondaryModel = req.secondaryModel;
                return {
                  agentId: ctx.run.agentId,
                  approvedModels: ctx.policy.models ?? [],
                  currentModel: ctx.policy.currentModel,
                  primaryModel: ctx.policy.primaryModel,
                  secondaryModel: ctx.policy.secondaryModel,
                  canManageModels: ctx.canManageModels,
                };
              },
            }
          : {}),
      };

      const defaultFailoverCatalog = parseModelCatalog(
        JSON.stringify({
          m1: { provider: 'mock', id: 'm1', price: { inputPerMTok: 1, outputPerMTok: 2 } },
          m2: { provider: 'mock', id: 'm2', price: { inputPerMTok: 1, outputPerMTok: 2 } },
          m3: { provider: 'mock', id: 'm3', price: { inputPerMTok: 1, outputPerMTok: 2 } },
          unpriced: { provider: 'mock', id: 'unpriced' },
        }),
      );

      const server = createGatekeeperEgress({
        routes: [
          { id: 'models', kind: 'models' },
          { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${dPort}/discord` },
        ],
        prices: {},
        runTokens: tokens,
        control: testControl,
        contextTtlMs: 0,
        modelCatalog: opts.customCatalog ?? defaultFailoverCatalog,
        modelAdapters: {
          mock: opts.adapter ?? {
            async complete(entry) {
              return { content: `hello from ${entry.id}`, usage: { input: 100, output: 50 } };
            },
          },
        },
      });

      return { server, testControl, rigLedger, failoverCalls, getRunModelsCalls, setRunModelsCalls };
    };

    it('fails over from primary (m1) to secondary (m2) on upstream 500 and updates currentModel persistently', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          if (entry.id === 'm1') {
            throw new ModelUpstreamError('internal_error', 'upstream 500 error', 500, 500);
          }
          return { content: 'Answer from M2', usage: { input: 100, output: 50 } };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        const res1 = await call(sPort, '/models/v1/chat/completions', { token, body: chat('m1') });
        assert.equal(res1.status, 200, res1.text);
        assert.equal(res1.json().choices[0].message.content, 'Answer from M2');
        assert.deepEqual(callsMade, ['m1', 'm2']);

        assert.equal(rig.failoverCalls.length, 1);
        assert.equal(rig.failoverCalls[0].fromModel, 'm1');
        assert.equal(rig.failoverCalls[0].toModel, 'm2');
        assert.equal(ctx.policy.currentModel, 'm2');

        const llmEvents = rig.rigLedger.filter((e) => e.type === 'llm');
        assert.equal(llmEvents.length, 1);
        assert.equal(llmEvents[0].model, 'm2');

        const discRes = await call(sPort, '/discord/channels/123/messages', { token, body: { content: 'Answer from M2' } });
        assert.equal(discRes.status, 200);
        assert.equal(discordPosted.length, 1);
        assert.equal(discordPosted[0].content, 'Answer from M2\n-# [model failed over: m1 -> m2]');

        // Next model call uses m2 directly without failover footnote
        callsMade.length = 0;
        const res2 = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(res2.status, 200);
        assert.deepEqual(callsMade, ['m2']);

        const discRes2 = await call(sPort, '/discord/channels/123/messages', { token, body: { content: 'Answer from M2' } });
        assert.equal(discRes2.status, 200);
        assert.equal(discordPosted.length, 2);
        assert.equal(discordPosted[1].content, 'Answer from M2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('fails over on upstream 429 error', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          if (entry.id === 'm1') {
            throw new ModelUpstreamError('rate_limit', 'upstream rate limit', 429, 429);
          }
          return { content: 'Recovered from 429', usage: { input: 100, output: 50 } };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('m1') });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json().choices[0].message.content, 'Recovered from 429');
        assert.deepEqual(callsMade, ['m1', 'm2']);
        assert.equal(ctx.policy.currentModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('fails over on 503 model_not_offered (catalog missing candidate)', async () => {
      const catalog = parseModelCatalog(
        JSON.stringify({
          m2: { provider: 'mock', id: 'm2', price: { inputPerMTok: 1, outputPerMTok: 2 } },
        }),
      );
      const rig = createTestRig({ customCatalog: catalog });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('m1') });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json().choices[0].message.content, 'hello from m2');
        assert.equal(ctx.policy.currentModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('fails over on 403 unpriced_model', async () => {
      const catalog = parseModelCatalog(
        JSON.stringify({
          m1: { provider: 'mock', id: 'm1' },
          m2: { provider: 'mock', id: 'm2', price: { inputPerMTok: 1, outputPerMTok: 2 } },
        }),
      );
      const rig = createTestRig({ customCatalog: catalog });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat('m1') });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json().choices[0].message.content, 'hello from m2');
        assert.equal(ctx.policy.currentModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('fails over on 422 malformed_tool_syntax, metering both completed attempts and logging MALFORMED_TOOL_SYNTAX', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          if (entry.id === 'm1') {
            return {
              content: 'get_weather: {"city": "Seattle"}',
              usage: { input: 120, output: 40 },
            };
          }
          return {
            content: 'The weather in Seattle is sunny.',
            usage: { input: 150, output: 60 },
          };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        const res = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: {
            ...chat('m1'),
            tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          },
        });

        assert.equal(res.status, 200, res.text);
        assert.equal(res.json().choices[0].message.content, 'The weather in Seattle is sunny.');
        assert.deepEqual(callsMade, ['m1', 'm2']);

        const llmEvents = rig.rigLedger.filter((e) => e.type === 'llm');
        assert.equal(llmEvents.length, 2);
        assert.equal(llmEvents[0].model, 'm1');
        assert.equal(llmEvents[0].inputTokens, 120);
        assert.equal(llmEvents[0].outputTokens, 40);
        assert.equal(llmEvents[1].model, 'm2');
        assert.equal(llmEvents[1].inputTokens, 150);
        assert.equal(llmEvents[1].outputTokens, 60);

        const malformed = rig.rigLedger.find((e) => e.action === 'MALFORMED_TOOL_SYNTAX');
        assert.ok(malformed);
        assert.equal(malformed.tool, 'get_weather');
        assert.equal(malformed.model, 'm1');

        assert.equal(ctx.policy.currentModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('starting at current == M3 walks [M3, M1, M2]', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          if (entry.id === 'm3' || entry.id === 'm1') {
            throw new ModelUpstreamError('internal_error', 'upstream failed', 500, 500);
          }
          return { content: 'Success on M2', usage: { input: 100, output: 50 } };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2', 'm3'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm3',
        };

        const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json().choices[0].message.content, 'Success on M2');
        assert.deepEqual(callsMade, ['m3', 'm1', 'm2']);
        assert.equal(ctx.policy.currentModel, 'm2');
        assert.equal(rig.failoverCalls.length, 1);
        assert.equal(rig.failoverCalls[0].fromModel, 'm3');
        assert.equal(rig.failoverCalls[0].toModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('starting at current == secondary (m2) walks [m2, m1], stops without looping, and ledgers MODEL_FAILOVER_EXHAUSTED on failure', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          throw new ModelUpstreamError('internal_error', `upstream ${entry.id} down`, 500, 500);
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm2',
        };

        const res = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(res.status, 500);
        assert.deepEqual(callsMade, ['m2', 'm1'], 'exact candidate order without looping');
        assert.equal(ctx.policy.currentModel, 'm2', 'currentModel unchanged when exhausted');

        const exhausted = rig.rigLedger.find((e) => e.action === 'MODEL_FAILOVER_EXHAUSTED');
        assert.ok(exhausted);
        assert.deepEqual(exhausted.models, ['m2', 'm1']);
        assert.equal(rig.failoverCalls.length, 0);
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('non-failover errors (400 bad json, 400 streaming, 402 budget, 429 throttle, 403 unapproved, pinned) never trigger failover', async () => {
      let adapterCalls = 0;
      const adapter: ModelAdapter = {
        async complete() {
          adapterCalls++;
          throw new ModelUpstreamError('internal_error', 'boom', 500, 500);
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };

        // 1. Streaming not supported: 400
        adapterCalls = 0;
        const resStream = await call(sPort, '/models/v1/chat/completions', { token, body: { ...chat('m1'), stream: true } });
        assert.equal(resStream.status, 400);
        assert.equal(resStream.json().error, 'streaming_not_supported');
        assert.equal(adapterCalls, 0);

        // 2. Model not allowed (empty models array grants none): 403
        ctx.policy.models = [];
        adapterCalls = 0;
        const resUnapproved = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(resUnapproved.status, 403);
        assert.equal(resUnapproved.json().error, 'model_not_allowed');
        assert.equal(adapterCalls, 0);
        ctx.policy.models = ['m1', 'm2'];

        // 3. Budget exceeded at start: 402
        ctx.policy.budgetUsd = { perRun: 0.0001 };
        ctx.spend.run = 0.001;
        adapterCalls = 0;
        const resBudget = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(resBudget.status, 402);
        assert.equal(resBudget.json().error, 'budget_exceeded');
        assert.equal(adapterCalls, 0);
        ctx.policy.budgetUsd = undefined;
        ctx.spend.run = 0;

        // 4. Pinned model: when pinned, does not walk failover candidates
        ctx.run.model = 'm1';
        adapterCalls = 0;
        const resPinned = await call(sPort, '/models/v1/chat/completions', { token, body: chat() });
        assert.equal(resPinned.status, 500);
        assert.equal(adapterCalls, 1, 'only the pinned model is tried');
        assert.equal(rig.failoverCalls.length, 0);
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('mid-failover budget exhaustion refuses candidate 1 with 402 budget_exceeded after candidate 0 is metered', async () => {
      const callsMade: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry) {
          callsMade.push(entry.id);
          if (entry.id === 'm1') {
            return {
              content: 'get_weather: {"city": "Seattle"}',
              usage: { input: 1000, output: 50000 },
            };
          }
          return { content: 'Should not reach m2', usage: { input: 10, output: 10 } };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models', 'discord'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
          budgetUsd: { perRun: 0.05 },
        };
        ctx.spend.run = 0;

        const res = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: {
            ...chat('m1'),
            tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          },
        });

        assert.equal(res.status, 402, res.text);
        assert.equal(res.json().error, 'budget_exceeded');
        assert.deepEqual(callsMade, ['m1'], 'm2 was never called');

        const llmEvents = rig.rigLedger.filter((e) => e.type === 'llm');
        assert.equal(llmEvents.length, 1);
        assert.equal(llmEvents[0].model, 'm1');
        assert.ok(ctx.spend.run > 0.05);

        assert.equal(rig.failoverCalls.length, 0);
        assert.equal(ctx.policy.currentModel, 'm1');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });
  });

  describe('Conversational Model Query & Switching (GAP-210, TSK-287, M2)', () => {
    const createTestRig = (opts: {
      adapter?: ModelAdapter;
      customCatalog?: ModelCatalog;
      enableRunModels?: boolean;
    } = {}) => {
      const rigLedger: Array<Record<string, any>> = [];
      const getRunModelsCalls: Array<{ runId: string; runToken: string }> = [];
      const setRunModelsCalls: Array<{ runId: string; runToken: string; currentModel?: string; primaryModel?: string; secondaryModel?: string }> = [];

      const testControl: ControlClient = {
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
          rigLedger.push(event);
        },
        async getRunModels(req) {
          getRunModelsCalls.push(req);
          return {
            agentId: ctx.run.agentId,
            approvedModels: ctx.policy.models ?? [],
            currentModel: ctx.policy.currentModel ?? ctx.policy.models?.[0],
            primaryModel: ctx.policy.primaryModel ?? ctx.policy.models?.[0],
            secondaryModel: ctx.policy.secondaryModel,
            canManageModels: ctx.canManageModels,
          };
        },
        async setRunModels(req) {
          setRunModelsCalls.push(req);
          if (req.currentModel) ctx.policy.currentModel = req.currentModel;
          if (req.primaryModel) ctx.policy.primaryModel = req.primaryModel;
          if (req.secondaryModel !== undefined) ctx.policy.secondaryModel = req.secondaryModel;
          return {
            agentId: ctx.run.agentId,
            approvedModels: ctx.policy.models ?? [],
            currentModel: ctx.policy.currentModel,
            primaryModel: ctx.policy.primaryModel,
            secondaryModel: ctx.policy.secondaryModel,
            canManageModels: ctx.canManageModels,
          };
        },
      };

      const catalog = parseModelCatalog(
        JSON.stringify({
          m1: { provider: 'mock', id: 'm1', price: { inputPerMTok: 1, outputPerMTok: 2 } },
          m2: { provider: 'mock', id: 'm2', price: { inputPerMTok: 1, outputPerMTok: 2 } },
        }),
      );

      const server = createGatekeeperEgress({
        routes: [{ id: 'models', kind: 'models' }],
        prices: {},
        runTokens: tokens,
        control: testControl,
        contextTtlMs: 0,
        modelCatalog: opts.customCatalog ?? catalog,
        modelAdapters: {
          mock: opts.adapter ?? {
            async complete(entry) {
              return { content: `hello from ${entry.id}`, usage: { input: 10, output: 10 } };
            },
          },
        },
      });

      return { server, testControl, rigLedger, getRunModelsCalls, setRunModelsCalls };
    };

    it('transparent injection and execution of factory_get_models in internal loop (GAP-210, TSK-287, M2)', async () => {
      let round = 0;
      const adapter: ModelAdapter = {
        async complete(entry, payload) {
          round++;
          if (round === 1) {
            const getTool = (payload.tools as any[])?.find((t) => t.function?.name === 'factory_get_models');
            assert.ok(getTool, 'factory_get_models must be offered');
            return {
              content: null,
              toolCalls: [
                {
                  id: 'call_get_1',
                  type: 'function',
                  function: { name: 'factory_get_models', arguments: '{}' },
                },
              ],
              usage: { input: 15, output: 15 },
            };
          }
          const toolResultMsg = (payload.messages as any[])?.find(
            (m) => m.role === 'tool' && (m.toolCallId === 'call_get_1' || m.tool_call_id === 'call_get_1'),
          );
          assert.ok(toolResultMsg, 'tool result message must be passed in subsequent turn');
          const parsedContent = JSON.parse(toolResultMsg.content);
          assert.equal(parsedContent.agentId, ctx.run.agentId);
          assert.deepEqual(parsedContent.approvedModels, ['m1', 'm2']);
          assert.equal(parsedContent.currentModel, 'm1');

          return {
            content: `Current model is ${parsedContent.currentModel}`,
            usage: { input: 25, output: 10 },
          };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };
        ctx.canManageModels = true;

        const res = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: chat('m1'),
        });

        assert.equal(res.status, 200, res.text);
        const reply = res.json();
        assert.equal(reply.choices[0].message.content, 'Current model is m1');
        assert.equal(round, 2, 'two completion rounds occurred');
        assert.equal(rig.getRunModelsCalls.length, 1);
        assert.equal(rig.getRunModelsCalls[0].runId, ctx.run.runId);
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('transparent injection and execution of factory_set_models switches model and executes follow-up completion on new model', async () => {
      let round = 0;
      const completedEntries: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry, payload) {
          round++;
          completedEntries.push(entry.id);
          if (round === 1) {
            assert.equal(entry.id, 'm1');
            const setTool = (payload.tools as any[])?.find((t) => t.function?.name === 'factory_set_models');
            assert.ok(setTool, 'factory_set_models must be offered when canManageModels is true');
            return {
              content: null,
              toolCalls: [
                {
                  id: 'call_set_1',
                  type: 'function',
                  function: { name: 'factory_set_models', arguments: JSON.stringify({ currentModel: 'm2' }) },
                },
              ],
              usage: { input: 20, output: 20 },
            };
          }
          assert.equal(entry.id, 'm2', 'second round should run on newly switched model');
          return {
            content: `Switched and completed on ${entry.id}`,
            usage: { input: 30, output: 15 },
          };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          secondaryModel: 'm2',
          currentModel: 'm1',
        };
        ctx.canManageModels = true;

        const res = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: chat('m1'),
        });

        assert.equal(res.status, 200, res.text);
        const reply = res.json();
        assert.equal(reply.choices[0].message.content, 'Switched and completed on m2');
        assert.equal(round, 2);
        assert.deepEqual(completedEntries, ['m1', 'm2']);
        assert.equal(rig.setRunModelsCalls.length, 1);
        assert.equal(rig.setRunModelsCalls[0].currentModel, 'm2');
        assert.equal(ctx.policy.currentModel, 'm2');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('omits factory_set_models when canManageModels is false', async () => {
      let offeredToolNames: string[] = [];
      const adapter: ModelAdapter = {
        async complete(entry, payload) {
          offeredToolNames = ((payload.tools as any[]) ?? []).map((t) => t.function?.name);
          return {
            content: 'Read-only turn complete',
            usage: { input: 10, output: 10 },
          };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          currentModel: 'm1',
        };
        ctx.canManageModels = false;

        const res = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: chat('m1'),
        });

        assert.equal(res.status, 200, res.text);
        assert.ok(offeredToolNames.includes('factory_get_models'), 'factory_get_models is offered');
        assert.ok(!offeredToolNames.includes('factory_set_models'), 'factory_set_models is omitted');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });

    it('AP3 footnote preservation: plain chat turn without caller tools does NOT receive [no tools called] footnote', async () => {
      const adapter: ModelAdapter = {
        async complete(_entry, payload) {
          const toolNames = ((payload.tools as any[]) ?? []).map((t) => t.function?.name);
          assert.ok(toolNames.includes('factory_get_models'));
          return {
            content: 'Just answering text.',
            usage: { input: 10, output: 10 },
          };
        },
      };

      const rig = createTestRig({ adapter });
      const sPort = await listen(rig.server);

      try {
        ctx.policy = {
          routes: ['models'],
          models: ['m1', 'm2'],
          primaryModel: 'm1',
          currentModel: 'm1',
        };
        ctx.canManageModels = true;

        // 1. Plain chat turn without caller tools: grounded, ledger action is MODEL_REPLY
        const resPlain = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: chat('m1'),
        });

        assert.equal(resPlain.status, 200);
        const replyPlain = resPlain.json();
        assert.equal(replyPlain.choices[0].message.content, 'Just answering text.');

        const plainReplyEvent = rig.rigLedger.find((e) => e.type === 'action' && e.action === 'MODEL_REPLY');
        assert.ok(plainReplyEvent, 'plain chat turn without caller tools yields MODEL_REPLY');
        const ungroundedPlain = rig.rigLedger.find((e) => e.type === 'action' && e.action === 'UNGROUNDED_REPLY');
        assert.equal(ungroundedPlain, undefined, 'must NOT be marked UNGROUNDED_REPLY');

        // 2. Caller turn WITH caller tools where model calls no tools: ungrounded, ledger action is UNGROUNDED_REPLY
        const resWithTools = await call(sPort, '/models/v1/chat/completions', {
          token,
          body: {
            ...chat('m1'),
            tools: [{ type: 'function', function: { name: 'caller_search', parameters: { type: 'object' } } }],
          },
        });

        assert.equal(resWithTools.status, 200);
        const ungroundedEvent = rig.rigLedger.find((e) => e.type === 'action' && e.action === 'UNGROUNDED_REPLY');
        assert.ok(ungroundedEvent, 'caller turn with tools offered but uncalled yields UNGROUNDED_REPLY');
      } finally {
        await new Promise<void>((r) => rig.server.close(() => r()));
      }
    });
  });

});
