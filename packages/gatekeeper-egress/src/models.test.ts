import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type Policy, type RunContext } from './gatekeeper-egress.js';
import { bedrockConverse, parseModelCatalog, toConverse, type ModelCatalog } from './models.js';
import { signV4 } from './sigv4.js';

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
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      contextTtlMs: 0,
      modelCatalog: catalog,
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

  it('M2 E7 a policy that names no models grants only the factory default, Claude Haiku 4.5', async () => {
    ctx.policy = { routes: ['models'] };
    const denied = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(denied.status, 403);
    assert.equal(denied.json().error, 'model_not_allowed');
    assert.equal(seen.length, 0, 'nothing reached a provider');
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') })).status, 200);
  });

  it('denies a model the policy does not list', async () => {
    ctx.policy = policy({ models: ['claude-haiku-4-5'] });
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5') });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'model_not_allowed');
    assert.equal(seen.length, 0);
    await settle();
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_MODEL_NOT_ALLOWED'));
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: chat('claude-haiku-4-5') })).status, 200);
  });

  it('rejects a model the catalog does not offer', async () => {
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('gpt-9') });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'model_not_offered');
    assert.equal(seen.length, 0);
  });

  it('refuses a catalog model whose provider has no adapter', async () => {
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
    const res = await call(port, '/models/v1/chat/completions', { token, body: chat('claude-sonnet-4-5', { messages: [{ role: 'tool', content: 'x' }] }) });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'unsupported_role');
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
});

describe('model catalog and translation', () => {
  it('rejects a malformed catalog', () => {
    assert.throws(() => parseModelCatalog('[]'));
    assert.throws(() => parseModelCatalog('{"x":{"provider":"bedrock-converse"}}'), /needs provider and id/);
    assert.deepEqual(parseModelCatalog(undefined), {});
  });

  it('merges consecutive same-role turns for Converse', () => {
    const body = toConverse({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    });
    assert.deepEqual(body, {
      messages: [
        { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
        { role: 'assistant', content: [{ text: 'c' }] },
      ],
    });
  });
});
