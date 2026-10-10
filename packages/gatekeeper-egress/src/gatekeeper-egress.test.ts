import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import type { ApprovalOutcome } from '@beercanlabs/factory-bouncer';
import { createGatekeeperEgress, type ControlClient, type Policy, type RunContext } from './gatekeeper-egress.js';
import { ModelUpstreamError } from '@beercanlabs/factory-executive';
import type { ProgressEvent } from '@beercanlabs/factory-inspector';

const REAL_KEY = 'sk-real-provider-key-0000';
const NOTION_KEY = 'fake-notion-integration-key-0000';
const tokens = new RunTokens('gatekeeper-egress-test-run-token-key-0123456789');

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
  opts: { token?: string; header?: 'bearer' | 'x-api-key'; body?: unknown; method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
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

describe('gatekeeper-egress', { concurrency: false }, () => {
  const seen: Seen[] = [];
  let upstreamStatus = 200;
  let upstream: http.Server;
  let upPort = 0;
  let gatekeeperEgress: http.Server;
  let port = 0;

  // In-memory control plane
  const ledger: Array<Record<string, any>> = [];
  const approvals = new Map<string, ApprovalOutcome & { key: string }>();
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
        if (name === 'ECHO_AGENT_DISCORD_BOT_TOKEN') return 'bot-agent-secret';
        if (name === 'DISCORD_BOT_TOKEN') return 'bot-fallback-secret';
        if (name === 'NOTION_API_KEY') return NOTION_KEY;
        return name === 'PROVIDER_KEY' ? REAL_KEY : undefined;
      },
    },
  ];

  // Fixtures name the models they use: a policy without `models` grants only the factory default (M2).
  const TEST_MODELS = ['test-claude', 'test-gpt', 'test-other', 'test-nousage', 'unpriced-model', 'claude-sonnet', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
  const policy = (p: Partial<Policy> = {}): Policy => ({ routes: ['anthropic', 'openai', 'tools', 'discord', 'google-calendar', 'notion', 'notion-unbound'], models: TEST_MODELS, ...p });
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
        if (req.url?.startsWith('/discord') || req.url?.startsWith('/gcal') || req.url?.startsWith('/notion')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
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
    gatekeeperEgress = createGatekeeperEgress({
      routes: [
        { id: 'anthropic', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}`, credential: { secret: 'PROVIDER_KEY', header: 'x-api-key' } },
        { id: 'openai', kind: 'llm', provider: 'openai', upstream: `http://127.0.0.1:${upPort}`, credential: { secret: 'PROVIDER_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'tools', kind: 'mcp', upstream: `http://127.0.0.1:${upPort}/mcp`, credential: { secret: 'PROVIDER_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${upPort}/discord`, credential: { secret: '{agent}_DISCORD_BOT_TOKEN', header: 'authorization', format: 'Bot {}' } },
        { id: 'google-calendar', kind: 'http', upstream: `http://127.0.0.1:${upPort}/gcal` },
        { id: 'notion', kind: 'http', upstream: `http://127.0.0.1:${upPort}/notion`, credential: { secret: 'NOTION_API_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'notion-unbound', kind: 'http', upstream: `http://127.0.0.1:${upPort}/notion`, credential: { secret: 'NOTION_MISSING_KEY', header: 'authorization', format: 'Bearer {}' } },
        { id: 'forbidden', kind: 'llm', provider: 'anthropic', upstream: `http://127.0.0.1:${upPort}` },
      ],
      prices: { 'test-*': { inputPerMTok: 3, outputPerMTok: 15 } },
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

  it('resolves agent-specific credential for HTTP route and injects Bot header', async () => {
    const res = await call(port, '/discord/channels/123/messages', { token, body: { content: 'hello discord' } });
    assert.equal(res.status, 200);
    assert.equal(seen[0].headers.authorization, 'Bot bot-agent-secret');
    assert.equal(JSON.parse(seen[0].body).content, 'hello discord');
  });

  it('injects the shared Notion key in place of the run token, keeps Notion-Version, and ledgers the call (S1, K5.5)', async () => {
    const res = await call(port, '/notion/v1/pages', { token, headers: { 'notion-version': '2022-06-28' }, body: { parent: {} } });
    assert.equal(res.status, 200, res.text);
    assert.equal(seen[0].path, '/notion/v1/pages');
    assert.equal(seen[0].headers.authorization, `Bearer ${NOTION_KEY}`);
    assert.equal(seen[0].headers['notion-version'], '2022-06-28');
    assert.equal(JSON.stringify(seen[0].headers).includes(token), false, 'the run token never goes upstream');
    await settle();
    const row = ledger.find((e) => e.action === 'EGRESS' && e.route === 'notion');
    assert.ok(row, `no EGRESS ledger row for notion: ${JSON.stringify(ledger)}`);
    assert.equal(row.runId, ctx.run.runId);
    assert.equal(JSON.stringify(ledger).includes(NOTION_KEY), false, 'the key is never ledgered');
  });

  it('refuses the Notion route outside policy without contacting Notion', async () => {
    ctx.policy = policy({ routes: ['anthropic'] });
    assert.equal((await call(port, '/notion/v1/pages', { token, body: {} })).status, 403);
    assert.equal(seen.length, 0);
  });

  it('an unbound credential is refused, never replaced by another route\'s secret', async () => {
    const res = await call(port, '/notion-unbound/v1/pages', { token, body: {} });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'credential_unbound');
    assert.equal(seen.length, 0, 'nothing is sent upstream (in particular no Discord token)');
  });

  it('forwards caller authorization for uncredentialed HTTP route when x-factory-run-token is presented', async () => {
    const res = await call(port, '/google-calendar/calendars/primary/events', {
      headers: {
        'x-factory-run-token': token,
        authorization: 'Bearer user-oauth-token',
      },
      body: { summary: 'Team Meeting' },
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0].headers.authorization, 'Bearer user-oauth-token');
    assert.equal(JSON.parse(seen[0].body).summary, 'Team Meeting');
  });

  it('tunnels HTTPS CONNECT to allowed hosts with run token', async () => {
    ctx.policy = policy({ hosts: ['127.0.0.1'] });
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`);
    });
    const data = await new Promise<string>((resolve) => {
      s.once('data', (buf) => resolve(buf.toString()));
    });
    s.destroy();
    assert.ok(data.startsWith('HTTP/1.1 200 Connection Established'));
    await settle();
    assert.ok(ledger.some((e) => e.action === 'EGRESS_TUNNEL'));
  });

  it('accepts the run token as Basic proxy credentials (boto3, urllib)', async () => {
    ctx.policy = policy({ hosts: ['127.0.0.1'] });
    const basic = Buffer.from(`run:${token}`).toString('base64');
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`);
    });
    const data = await new Promise<string>((resolve) => {
      s.once('data', (buf) => resolve(buf.toString()));
    });
    s.destroy();
    assert.ok(data.startsWith('HTTP/1.1 200 Connection Established'));
  });

  it('denies HTTPS CONNECT to unallowed hosts', async () => {
    ctx.policy = policy({ hosts: ['api.notion.com'] });
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`CONNECT evil.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`);
    });
    const data = await new Promise<string>((resolve) => {
      s.once('data', (buf) => resolve(buf.toString()));
    });
    s.destroy();
    assert.ok(data.startsWith('HTTP/1.1 403 Forbidden'));
    await settle();
    assert.ok(ledger.some((e) => String(e.action).startsWith('EGRESS_DENIED_HOST')));
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

  it('allows candidate models outside policy when agentState is TRAINING', async () => {
    ctx.policy = policy({ models: ['test-other'] });
    ctx.agentState = 'TRAINING';
    // 'test-claude' is not in ctx.policy.models, but because agentState is TRAINING, it is permitted
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages('test-claude') })).status, 200);
    ctx.agentState = 'SLEEPING';
    // When back to production state, unapproved models are blocked
    assert.equal((await call(port, '/anthropic/v1/messages', { token, body: messages('test-claude') })).json().error, 'model_not_allowed');
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

  it('bypasses budget checks unconditionally for built-in system actors', async () => {
    ctx.isBuiltin = true;
    ctx.policy = policy({ budgetUsd: { perRun: 0.001 } });
    ctx.run.state = 'BLOCKED_BUDGET_EXCEEDED';
    // Even if state says BLOCKED_BUDGET_EXCEEDED or budget limit is tiny, built-ins are exempt!
    const res = await call(port, '/anthropic/v1/messages', { token, body: messages() });
    assert.equal(res.status, 200);
    ctx.isBuiltin = false;
    ctx.run.state = 'WORKING';
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

  it('on upstream 401 for per-agent secret, evicts the expanded credential name and re-fetches (GAP-072)', async () => {
    const res1 = await call(port, '/discord/channels/1/messages', { token, body: { content: 'hello' } });
    assert.equal(res1.status, 200);
    assert.equal(seen.at(-1)?.headers.authorization, 'Bot bot-agent-secret');
    const before = secretFetches;

    upstreamStatus = 401;
    const res401 = await call(port, '/discord/channels/1/messages', { token, body: { content: 'hello' } });
    assert.equal(res401.status, 401);
    await settle();
    assert.ok(ledger.some((e) => e.action === 'RUNTIME_AUTH_FAILURE'));

    upstreamStatus = 200;
    const res2 = await call(port, '/discord/channels/1/messages', { token, body: { content: 'hello' } });
    assert.equal(res2.status, 200);
    assert.equal(secretFetches, before + 1, 'per-agent credential cache was purged under expanded name');
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

describe('§6.5 run progress: gatekeeper-egress reports each call it handles for a run', { concurrency: false }, () => {
  const BOT_CREDENTIAL = 'progress-bot-credential-value';
  const CONN_TOKEN = 'progress-connection-access-value';
  let upstream: http.Server;
  let upPort = 0;
  let gk: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let runSeq = 0;
  let upstreamDelayMs = 0;
  let modelBehaviour: 'ok' | 'timeout' = 'ok';
  /** What the control plane receives; `sinkMode` makes it slow or failing. */
  const delivered: ProgressEvent[] = [];
  let sinkMode: 'ok' | 'fail' | 'hang' = 'ok';
  let sinkCalls = 0;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      return { approvalId: 'a', state: 'pending' };
    },
    async consumeApproval() {
      return false;
    },
    async ledger() {},
    async connectionToken() {
      return { ok: true, accessToken: CONN_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async progress(events) {
      sinkCalls++;
      if (sinkMode === 'fail') throw new Error('control plane 503');
      if (sinkMode === 'hang') return new Promise<void>(() => {});
      delivered.push(...events);
    },
  };

  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const eventsFor = (route: string) => delivered.filter((e) => e.runId === ctx.run.runId && e.route === route);

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        setTimeout(() => {
          res.writeHead(req.url?.startsWith('/gmail/missing') ? 404 : 200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }, upstreamDelayMs),
      );
    });
    upPort = await listen(upstream);
    gk = createGatekeeperEgress({
      routes: [
        { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${upPort}/discord`, credential: { secret: 'DISCORD_BOT_TOKEN', header: 'authorization', format: 'Bot {}' } },
        { id: 'google-gmail', kind: 'http', upstream: `http://127.0.0.1:${upPort}/gmail`, connection: 'google' },
        { id: 'models', kind: 'models' },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 'test', async get(name) { return name === 'DISCORD_BOT_TOKEN' ? BOT_CREDENTIAL : undefined; } }],
      contextTtlMs: 0,
      modelCatalog: { 'claude-sonnet': { provider: 'fake', id: 'fake-sonnet', price: { inputPerMTok: 3, outputPerMTok: 15 } } },
      modelAdapters: {
        fake: {
          async complete() {
            if (modelBehaviour === 'timeout') throw new ModelUpstreamError(502, 'upstream_unreachable', 'The operation was aborted due to timeout');
            return { content: 'hello', finishReason: 'stop', usage: { input: 10, output: 5 } };
          },
        },
      },
      progress: { flushMs: 20 },
    });
    port = await listen(gk);
  });

  after(async () => {
    await new Promise<void>((r) => gk.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(async () => {
    delivered.length = 0;
    sinkMode = 'ok';
    sinkCalls = 0;
    upstreamDelayMs = 0;
    modelBehaviour = 'ok';
    const runId = `progress-run-${++runSeq}`;
    ctx = {
      run: { runId, agentId: 'donna', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['discord', 'google-gmail', 'models'], models: ['claude-sonnet'] },
      spend: { run: 0, day: 0, month: 0 },
    };
    token = await tokens.mint({ runId, agentId: 'donna' });
  });

  it('§6.5 a proxied call emits call.start then call.end with route, status, duration and outcome', async () => {
    upstreamDelayMs = 30;
    const r = await call(port, '/google-gmail/gmail/v1/users/me/messages?q=from%3Astephanie', { token, method: 'GET' });
    assert.equal(r.status, 200);
    await settle();
    const evs = eventsFor('google-gmail');
    assert.deepEqual(evs.map((e) => e.kind), ['call.start', 'call.end']);
    const [start, end] = evs;
    assert.equal(start.callId, end.callId);
    assert.equal(start.agentId, 'donna');
    assert.ok(!Number.isNaN(Date.parse(start.at)));
    assert.equal(end.status, 200);
    assert.equal(end.outcome, 'ok');
    assert.ok(typeof end.durationMs === 'number' && end.durationMs >= 25, `durationMs ${end.durationMs}`);
  });

  it('§6.5 the models route reports the model on start and end', async () => {
    const r = await call(port, '/models/v1/chat/completions', { token, body: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'private prompt text' }] } });
    assert.equal(r.status, 200);
    await settle();
    const evs = eventsFor('models');
    assert.deepEqual(evs.map((e) => [e.kind, e.model]), [['call.start', 'claude-sonnet'], ['call.end', 'claude-sonnet']]);
    assert.equal(evs[1].outcome, 'ok');
  });

  it('E3 S1 progress events carry only metadata: no bodies, query strings, headers or secrets', async () => {
    await call(port, '/discord/channels/1/messages?token=abc', { token, body: { content: 'private message body' } });
    await call(port, '/google-gmail/gmail/v1/users/me/messages?q=secret-query', { token, method: 'GET' });
    await call(port, '/models/v1/chat/completions', { token, body: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'private prompt text' }] } });
    await settle();
    assert.ok(delivered.length >= 6);
    const allowed = new Set(['runId', 'agentId', 'at', 'kind', 'callId', 'route', 'model', 'status', 'durationMs', 'outcome']);
    for (const e of delivered) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    const wire = JSON.stringify(delivered);
    for (const leak of [BOT_CREDENTIAL, CONN_TOKEN, token, 'private message body', 'private prompt text', 'secret-query', '?', '/channels', 'authorization']) {
      assert.ok(!wire.includes(leak), `progress leaked ${leak}`);
    }
  });

  it('§6.5 a denied call reports outcome denied', async () => {
    ctx.policy = { routes: ['discord'], models: [] };
    assert.equal((await call(port, '/google-gmail/gmail/v1/users/me/messages', { token, method: 'GET' })).status, 403);
    assert.equal((await call(port, '/discord/x', { token, body: {} })).status, 200);
    ctx.policy = { routes: ['models'], models: ['other-model'] };
    assert.equal((await call(port, '/models/v1/chat/completions', { token, body: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'x' }] } })).status, 403);
    await settle();
    const gmail = eventsFor('google-gmail');
    assert.deepEqual(gmail.map((e) => e.kind), ['call.start', 'call.end']);
    assert.equal(gmail[1].outcome, 'denied');
    assert.equal(gmail[1].status, 403);
    assert.equal(eventsFor('models')[1].outcome, 'denied');
  });

  it('§6.5 an upstream timeout reports outcome timeout, and an upstream error reports error', async () => {
    modelBehaviour = 'timeout';
    await call(port, '/models/v1/chat/completions', { token, body: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal((await call(port, '/google-gmail/missing', { token, method: 'GET' })).status, 404);
    await settle();
    assert.equal(eventsFor('models')[1].outcome, 'timeout');
    const gmailEnd = eventsFor('google-gmail')[1];
    assert.equal(gmailEnd.outcome, 'error');
    assert.equal(gmailEnd.status, 404);
  });

  it('E2 a call without a valid live run token emits nothing', async () => {
    await call(port, '/discord/x', { body: {} });
    const forged = await new RunTokens('a-different-key-0123456789abcdefghij').mint({ runId: ctx.run.runId, agentId: 'donna' });
    await call(port, '/discord/x', { token: forged, body: {} });
    await settle();
    assert.equal(delivered.filter((e) => e.runId === ctx.run.runId).length, 0);
  });

  it('§6.5 a slow or failing control plane never delays a proxied call', async () => {
    const timed = async (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) assert.equal((await call(port, '/discord/x', { token, body: {} })).status, 200);
      return performance.now() - t0;
    };
    await settle(); // let earlier tests' batches drain first

    // Failing: every batch is refused; calls are unaffected and the batches are dropped.
    sinkMode = 'fail';
    sinkCalls = 0;
    const failing = await timed(5);
    await settle();
    assert.ok(sinkCalls >= 1, 'the failing control plane was tried');

    // Hung: the first batch never returns. Calls are unaffected, and no second request piles up behind it.
    sinkMode = 'hang';
    sinkCalls = 0;
    const hungFirst = await timed(5);
    await settle();
    assert.equal(sinkCalls, 1);
    const hungAfter = await timed(5);
    await settle();
    assert.equal(sinkCalls, 1, 'progress adds at most one request at a time to the control plane');
    for (const ms of [failing, hungFirst, hungAfter]) assert.ok(ms < 1000, `5 calls took ${ms.toFixed(0)} ms`);
  });
});
