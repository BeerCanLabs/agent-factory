import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createGateway, type Approval, type ControlClient, type Policy, type RunContext } from './gateway.js';

const REAL_KEY = 'sk-real-provider-key-0000';
const tokens = new RunTokens('gateway-test-run-token-key-0123456789');

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: string };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(
  port: number,
  path: string,
  opts: { token?: string; header?: 'bearer' | 'x-api-key'; body?: unknown; method?: string } = {},
): Promise<{ status: number; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) {
      if (opts.header === 'x-api-key') headers['x-api-key'] = opts.token;
      else headers.authorization = `Bearer ${opts.token}`;
    }
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

describe('egress gateway', { concurrency: false }, () => {
  const seen: Seen[] = [];
  let upstreamStatus = 200;
  let upstream: http.Server;
  let upPort = 0;
  let gateway: http.Server;
  let port = 0;

  // In-memory control plane
  const ledger: Array<Record<string, any>> = [];
  const approvals = new Map<string, Approval & { key: string }>();
  let ctx: RunContext;
  let token = '';
  let runSeq = 0;
  let secretFetches = 0;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval(req) {
      const key = `${req.runId}|${req.route}|${req.tool}|${req.argsSha256}`;
      for (const a of approvals.values()) if (a.key === key && (a.state === 'pending' || a.state === 'approved')) return { ...a };
      const a = { approvalId: `appr-${approvals.size + 1}`, state: 'pending' as const, key };
      approvals.set(a.approvalId, a);
      return { ...a };
    },
    async consumeApproval(id) {
      const a = approvals.get(id);
      if (a?.state !== 'approved') return false;
      a.state = 'consumed';
      return true;
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
  const providers: SecretProvider[] = [
    {
      name: 'test',
      async get(name) {
        secretFetches++;
        return name === 'PROVIDER_KEY' ? REAL_KEY : undefined;
      },
    },
  ];

  const policy = (p: Partial<Policy> = {}): Policy => ({ routes: ['anthropic', 'openai', 'tools'], ...p });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const lastLlm = () => ledger.filter((e) => e.type === 'llm').at(-1);

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers, body });
        const parsed = body ? JSON.parse(body) : {};
        if (upstreamStatus !== 200) {
          res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
          return res.end('{"error":"nope"}');
        }
        if (req.url?.startsWith('/v1/messages') && parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"test-claude","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"streamed"}}\n\n');
          return res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n');
        }
        if (req.url?.startsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ model: parsed.model, usage: parsed.model === 'test-nousage' ? undefined : { input_tokens: 2000, output_tokens: 1000 } }));
        }
        if (req.url?.startsWith('/v1/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"model":"test-gpt","choices":[{"delta":{"content":"x"}}]}\n\n');
          if (parsed.stream_options?.include_usage) res.write('data: {"model":"test-gpt","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n');
          return res.end('data: [DONE]\n\n');
        }
        if (req.url?.startsWith('/mcp')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'tool ran' }] } }));
        }
        res.writeHead(404);
        res.end();
      });
    });
    upPort = await listen(upstream);
    gateway = createGateway({
      routes: [
        { id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}`, credential: { secret: 'PROVIDER_KEY', header: 'x-api-key' } },
        { id: 'openai', kind: 'llm', provider: 'openai', upstream: `http://127.0.0.1:${upPort}`, credential: { secret: 'PROVIDER_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'tools', kind: 'mcp', upstream: `http://127.0.0.1:${upPort}/mcp`, credential: { secret: 'PROVIDER_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'forbidden', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}` },
      ],
      prices: { 'test-*': { inputPerMTok: 3, outputPerMTok: 15 } },
      runTokens: tokens,
      control,
      providers,
      contextTtlMs: 0,
    });
    port = await listen(gateway);
  });

  after(async () => {
    await new Promise<void>((r) => gateway.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(async () => {
    ledger.length = 0;
    seen.length = 0;
    approvals.clear();
    upstreamStatus = 200;
    const runId = `run-${++runSeq}`;
    ctx = {
      run: { runId, agentId: 'echo-agent', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: policy(),
      spend: { run: 0, day: 0, month: 0 },
    };
    token = await tokens.mint({ runId, agentId: 'echo-agent' });
  });

  const messages = (model = 'test-claude', extra: Record<string, unknown> = {}) => ({
    model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  });

  it('rejects missing, forged, and dead-run tokens', async () => {
    assert.equal((await call(port, '/anthropic/v1/messages', { body: messages() })).status, 401);
    const other = await new RunTokens('a-different-key-0123456789abcdefghij').mint({ runId: ctx.run.runId, agentId: 'echo-agent' });
    assert.equal((await call(port, '/anthropic/v1/messages', { token: other, body: messages() })).status, 401);
    ctx.run.live = false;
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 401);
    assert.equal(seen.length, 0);
  });

  it('injects the provider credential and never forwards the run token', async () => {
    const res = await call(port, '/anthropic/v1/messages', { token, header: 'x-api-key', body: messages() });
    assert.equal(res.status, 200, res.text);
    const up = seen[0];
    assert.equal(up.headers['x-api-key'], REAL_KEY);
    assert.equal(JSON.stringify(up.headers).includes(token), false);
    assert.equal(up.headers.authorization, undefined);
  });

  it('meters a JSON response and prices it', async () => {
    await call(port, '/anthropic/v1/messages', { token, body: messages() });
    await settle();
    const e = lastLlm()!;
    assert.equal(e.inputTokens, 2000);
    assert.equal(e.outputTokens, 1000);
    assert.equal(e.costUsd, (2000 * 3 + 1000 * 15) / 1e6);
    assert.equal(e.actor, 'run:echo-agent');
    assert.equal(e.runId, ctx.run.runId);
    assert.ok(e.payloadSha256);
    assert.equal(JSON.stringify(e).includes('"hi"'), false, 'no prompt text in the ledger event');
  });

  it('meters Anthropic SSE while streaming it through unchanged', async () => {
    const res = await call(port, '/anthropic/v1/messages', { token, body: messages('test-claude', { stream: true }) });
    assert.ok(res.text.includes('streamed'));
    await settle();
    assert.equal(lastLlm()!.inputTokens, 1000);
    assert.equal(lastLlm()!.outputTokens, 500);
  });

  it('forces include_usage on OpenAI streams so they can be metered', async () => {
    await call(port, '/openai/v1/chat/completions', { token, body: { model: 'test-gpt', stream: true, messages: [] } });
    await settle();
    assert.equal(JSON.parse(seen[0].body).stream_options.include_usage, true);
    assert.equal(seen[0].headers.authorization, `Bearer ${REAL_KEY}`);
    assert.equal(lastLlm()!.outputTokens, 50);
  });

  it('charges the worst case when a response reports no usage', async () => {
    await call(port, '/anthropic/v1/messages', { token, body: messages('test-nousage') });
    await settle();
    const e = lastLlm()!;
    assert.equal(e.action, 'METERING_GAP');
    assert.equal(e.outputTokens, 100);
  });

  it('denies routes, models, and unpriced models outside policy', async () => {
    assert.equal((await call(port, '/forbidden/v1/messages', { token, body: messages() })).status, 403);
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages('unpriced-model') })).json().error, 'unpriced_model');
    ctx.policy = policy({ models: ['test-other'] });
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).json().error, 'model_not_allowed');
    assert.equal(seen.length, 0);
    await settle();
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_ROUTE_NOT_ALLOWED'));
  });

  it('enforces the budget before the call, counting spend not yet seen by the control plane', async () => {
    ctx.policy = policy({ budgetUsd: { perRun: 0.02 } });
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 200); // costs 0.021
    const second = await call(port, '/anthropic/v1/messages', { token, body: messages() });
    assert.equal(second.status, 402);
    assert.equal(second.json().error, 'budget_exceeded');
    ctx.run.state = 'BLOCKED_BUDGET_EXCEEDED';
    ctx.policy = policy();
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 402);
  });

  it('enforces a run-level model pin', async () => {
    ctx.run.model = 'test-claude';
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages('test-claude') })).status, 200);
    const other = await call(port, '/anthropic/v1/messages', { token, body: messages('test-other') });
    assert.equal(other.status, 403);
    assert.equal(other.json().error, 'model_pinned');
  });

  it('applies the kill switch from agent state', async () => {
    ctx.agentState = 'ISOLATED';
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 403);
    ctx.agentState = 'PAUSED';
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 503);
    assert.equal(seen.length, 0);
  });

  it('throttles by tokens per minute', async () => {
    ctx.policy = policy({ tokensPerMinute: 2500 });
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 200);
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 429);
  });

  it('on upstream 401, records RUNTIME_AUTH_FAILURE and re-fetches the credential', async () => {
    await call(port, '/anthropic/v1/messages', { token, body: messages() });
    const before = secretFetches;
    upstreamStatus = 401;
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages() })).status, 401);
    await settle();
    assert.ok(ledger.some((e) => e.action === 'RUNTIME_AUTH_FAILURE'));
    upstreamStatus = 200;
    await call(port, '/anthropic/v1/messages', { token, body: messages() });
    assert.equal(secretFetches, before + 1, 'credential cache was purged');
  });

  it('cannot be steered to another origin through the path', async () => {
    const res = await call(port, '/anthropic//evil.example/v1/messages', { token, body: messages() });
    assert.ok(seen.every((s) => !s.headers.host?.includes('evil')));
    assert.notEqual(res.status, 0);
  });

  describe('MCP tool governance', () => {
    const toolCall = (name: string, args: unknown = { q: 1 }, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

    it('denies tools not on the allowlist without contacting the server', async () => {
      ctx.policy = policy({ tools: { tools: { allow: ['search'] } } });
      const res = (await call(port, '/tools', { token, body: toolCall('delete_repo') })).json();
      assert.equal(res.error.code, -32001);
      assert.equal(seen.length, 0);
      const ok = (await call(port, '/tools', { token, body: toolCall('search') })).json();
      assert.equal(ok.result.content[0].text, 'tool ran');
      await settle();
      assert.ok(ledger.some((e) => e.action === 'TOOL_DENIED' && e.mcpName === 'delete_repo'));
      assert.ok(ledger.some((e) => e.action === 'TOOL_CALL' && e.mcpName === 'search'));
    });

    it('holds approval-required tools, releases exactly one call after approval', async () => {
      ctx.policy = policy({ tools: { tools: { allow: '*', requireApproval: ['deploy'] } } });
      const held = (await call(port, '/tools', { token, body: toolCall('deploy', { env: 'prod' }) })).json();
      assert.equal(held.error.code, -32003);
      const id = held.error.data.approvalId as string;
      assert.equal(seen.length, 0);

      approvals.get(id)!.state = 'approved';
      const released = (await call(port, '/tools', { token, body: toolCall('deploy', { env: 'prod' }) })).json();
      assert.equal(released.result.content[0].text, 'tool ran');
      assert.equal(approvals.get(id)!.state, 'consumed');

      const again = (await call(port, '/tools', { token, body: toolCall('deploy', { env: 'prod' }) })).json();
      assert.equal(again.error.code, -32003, 'a consumed approval does not release a second call');
      assert.notEqual(again.error.data.approvalId, id);
    });

    it('an approval for one set of arguments does not release different arguments', async () => {
      ctx.policy = policy({ tools: { tools: { allow: '*', requireApproval: ['deploy'] } } });
      const held = (await call(port, '/tools', { token, body: toolCall('deploy', { env: 'staging' }) })).json();
      approvals.get(held.error.data.approvalId)!.state = 'approved';
      const swapped = (await call(port, '/tools', { token, body: toolCall('deploy', { env: 'prod' }) })).json();
      assert.equal(swapped.error.code, -32003);
      assert.equal(seen.length, 0);
    });

    it('rejects a whole batch if any call in it is not allowed', async () => {
      ctx.policy = policy({ tools: { tools: { allow: ['search'] } } });
      const res = (await call(port, '/tools', { token, body: [toolCall('search', {}, 1), toolCall('drop_db', {}, 2)] })).json();
      assert.equal(res[0].error.code, -32004);
      assert.equal(res[1].error.code, -32001);
      assert.equal(seen.length, 0);
    });
  });
});
