import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTION_TEMPLATES } from '@beercanlabs/factory-contract';
import {
  ModelUpstreamError,
  SubscriptionLimitError,
  SubscriptionNeedsReconsentError,
  chatgptAccountIdFromJwt,
  discoverSubscriptionModels,
  fromResponses,
  parseChatRequest,
  parseModelCatalog,
  subscriptionResponses,
  toResponsesRequest,
  type CatalogEntry,
  type ChatRequest,
  type SubscriptionTokenResult,
} from './index.js';

// Recorded-shape fixtures: the Responses API's documented wire format (output items, SSE events) and OpenAI's confirmed
// `usage_limit_reached` error. The vendors' live behaviour is confirmed only by a real signed-in grant (TSK-327 open item).

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const OPENAI_TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } });
const XAI_TOKEN = 'xai-access-token-aaaaaaaa'; // secret-scan:allow (fake fixture)

const openaiEntry: CatalogEntry = { provider: 'openai-subscription', id: 'gpt-5-codex', credentialMode: 'subscription', connection: 'c-openai', templateId: 'openai-subscription' };
const xaiEntry: CatalogEntry = { provider: 'xai-subscription', id: 'grok-4', credentialMode: 'subscription', connection: 'c-xai', templateId: 'xai-subscription' };

const tokens: Record<string, SubscriptionTokenResult> = {
  'c-openai': { ok: true, accessToken: OPENAI_TOKEN, templateId: 'openai-subscription' },
  'c-xai': { ok: true, accessToken: XAI_TOKEN, templateId: 'xai-subscription' },
};

type Seen = { url: string; headers: Record<string, string>; body: any; redirect?: string };
function fake(reply: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const s: Seen = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined, redirect: init?.redirect };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { fetch: f, seen };
}

const sse = (events: unknown[]) => new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const chat = (extra: Record<string, unknown> = {}): ChatRequest => {
  const p = parseChatRequest({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'weather in Paris?' }], ...extra });
  if (!p.ok) throw new Error(p.error);
  return p.req;
};
const adapter = (f: typeof fetch, token = (c: string) => Promise.resolve(tokens[c] ?? { ok: false as const, kind: 'unavailable' as const })) => subscriptionResponses({ token, version: '9.9.9', fetch: f });

const weatherTool = { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

describe('request translation (Chat Completions to Responses)', () => {
  it('maps system to instructions, messages to typed input, tools to flat function tools, and sets store:false', () => {
    const req = chat({ tools: [weatherTool], tool_choice: 'auto', max_tokens: 50, temperature: 0.2 });
    const body = toResponsesRequest('gpt-5-codex', req, 'openai');
    assert.equal(body.instructions, 'be brief');
    assert.equal(body.store, false);
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'weather in Paris?' }] }]);
    assert.deepEqual(body.tools, [{ type: 'function', name: 'get_weather', description: 'Get weather', parameters: weatherTool.function.parameters, strict: false }]);
    assert.equal(body.tool_choice, 'auto');
    // The ChatGPT Codex backend rejects the length and sampling knobs; xAI accepts them.
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.temperature, undefined);
    const x = toResponsesRequest('grok-4', req, 'xai');
    assert.equal(x.max_output_tokens, 50);
    assert.equal(x.temperature, 0.2);
  });

  it('carries a tool round trip: assistant tool_calls become function_call items and tool results function_call_output', () => {
    const req = chat();
    req.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
    req.messages.push({ role: 'tool', content: '{"temp":"18C"}', toolCallId: 'call_1' });
    const input = toResponsesRequest('m', req, 'xai').input as any[];
    assert.deepEqual(input.slice(1), [
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":"18C"}' },
    ]);
  });

  it('maps a named tool_choice', () => {
    const body = toResponsesRequest('m', chat({ tools: [weatherTool], tool_choice: { type: 'function', function: { name: 'get_weather' } } }), 'xai');
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'get_weather' });
  });
});

describe('subscription adapter', () => {
  it('OpenAI: posts to the template host with exactly the template headers, the account id from the JWT claim and store:false', async () => {
    const { fetch: f, seen } = fake(() =>
      sse([
        { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] } },
        { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }], usage: { input_tokens: 11, output_tokens: 3 } } },
      ]),
    );
    const out = await adapter(f).complete(openaiEntry, chat());
    assert.deepEqual(out, { content: 'Hi', finishReason: 'stop', usage: { input: 11, output: 3 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(seen[0].redirect, 'error');
    // Exactly the template's headers, plus the HTTP framing Content-Type; nothing else.
    assert.deepEqual(seen[0].headers, {
      'user-agent': 'BeerCanLabs-AgentFactory/9.9.9',
      originator: 'beercanlabs-agent-factory',
      authorization: `Bearer ${OPENAI_TOKEN}`,
      'chatgpt-account-id': 'acct-123',
      'content-type': 'application/json',
    });
    const names = SUBSCRIPTION_TEMPLATES['openai-subscription'].headers.map((h) => h.name.toLowerCase()).sort();
    assert.deepEqual(Object.keys(seen[0].headers).filter((h) => h !== 'content-type').sort(), names);
    assert.equal(seen[0].body.store, false);
    assert.equal(seen[0].body.model, 'gpt-5-codex');
  });

  it('xAI: posts to api.x.ai/v1/responses with the factory User-Agent and the bearer token only', async () => {
    const { fetch: f, seen } = fake(() => sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }]));
    await adapter(f).complete(xaiEntry, chat());
    assert.equal(seen[0].url, 'https://api.x.ai/v1/responses');
    assert.deepEqual(seen[0].headers, { 'user-agent': 'BeerCanLabs-AgentFactory/9.9.9', authorization: `Bearer ${XAI_TOKEN}`, 'content-type': 'application/json' });
  });

  it('uses the Keymaster-reported account id over the JWT claim', async () => {
    const { fetch: f, seen } = fake(() => sse([{ type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 0 } } }]));
    const a = adapter(f, async () => ({ ok: true, accessToken: OPENAI_TOKEN, templateId: 'openai-subscription', accountId: 'acct-keymaster' }));
    await a.complete(openaiEntry, chat());
    assert.equal(seen[0].headers['chatgpt-account-id'], 'acct-keymaster');
  });

  it('refuses OpenAI without an account id rather than sending the call without it', async () => {
    const { fetch: f, seen } = fake(() => sse([]));
    const a = adapter(f, async () => ({ ok: true, accessToken: 'opaque-token-no-claim', templateId: 'openai-subscription' }));
    await assert.rejects(a.complete(openaiEntry, chat()), (e: ModelUpstreamError) => e.code === 'subscription_account_unavailable');
    assert.equal(seen.length, 0);
  });

  it('the host and headers come from the Keymaster record\'s template, never from the catalog entry', async () => {
    const { fetch: f, seen } = fake(() => sse([{ type: 'response.completed', response: { output: [] } }]));
    // A catalog entry that names another endpoint and template: ignored.
    const sneaky: CatalogEntry = { ...xaiEntry, endpoint: 'https://evil.example', templateId: 'openai-subscription' };
    await adapter(f).complete(sneaky, chat());
    assert.equal(new URL(seen[0].url).host, 'api.x.ai');
  });

  it('refuses an entry that is not a subscription entry, and a token naming an unknown template', async () => {
    const { fetch: f, seen } = fake(() => sse([]));
    await assert.rejects(adapter(f).complete({ provider: 'xai-subscription', id: 'x' }, chat()), (e: ModelUpstreamError) => e.code === 'subscription_unconfigured');
    const a = adapter(f, async () => ({ ok: true, accessToken: 'tok-aaaaaaaa', templateId: 'anthropic-subscription' }));
    await assert.rejects(a.complete(xaiEntry, chat()), (e: ModelUpstreamError) => e.code === 'subscription_template_unknown');
    assert.equal(seen.length, 0, 'no token went anywhere');
  });

  it('round-trips tool calls from a streamed reply, with usage and finish_reason', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' };
    const { fetch: f } = fake(() => sse([{ type: 'response.output_item.done', item: call }, { type: 'response.completed', response: { output: [call], usage: { input_tokens: 20, output_tokens: 8 } } }]));
    const out = await adapter(f).complete(xaiEntry, chat({ tools: [weatherTool] }));
    assert.equal(out.finishReason, 'tool_calls');
    assert.deepEqual(out.toolCalls, [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
    assert.deepEqual(out.usage, { input: 20, output: 8 });
  });

  it('falls back to the output item events when the completed event has no output, and to text deltas', async () => {
    const msg = { type: 'message', content: [{ type: 'output_text', text: 'from item' }] };
    const a = fake(() => sse([{ type: 'response.output_item.done', item: msg }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }]));
    assert.equal((await adapter(a.fetch).complete(xaiEntry, chat())).content, 'from item');
    const b = fake(() => sse([{ type: 'response.output_text.delta', delta: 'he' }, { type: 'response.output_text.delta', delta: 'llo' }, { type: 'response.completed', response: {} }]));
    assert.equal((await adapter(b.fetch).complete(xaiEntry, chat())).content, 'hello');
  });

  it('reads a plain JSON Responses reply too', async () => {
    const { fetch: f } = fake(() => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'json' }] }], usage: { input_tokens: 2, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    assert.equal((await adapter(f).complete(xaiEntry, chat())).content, 'json');
  });

  it('reports no usage as null so the egress meters the worst case', () => {
    assert.equal(fromResponses({ output: [] }).usage, null);
  });

  it('a needs-re-consent connection throws SubscriptionNeedsReconsentError and calls no vendor', async () => {
    const { fetch: f, seen } = fake(() => sse([]));
    const a = adapter(f, async () => ({ ok: false, kind: 'needs_reconsent', reason: 'grant_marked' }));
    await assert.rejects(a.complete(xaiEntry, chat()), (e: unknown) => e instanceof SubscriptionNeedsReconsentError && e.connection === 'c-xai' && e.code === 'subscription_needs_reconsent');
    assert.equal(seen.length, 0);
  });

  it('an unavailable token is an ordinary upstream failure, not a limit or re-consent', async () => {
    const { fetch: f } = fake(() => sse([]));
    const a = adapter(f, async () => ({ ok: false, kind: 'unavailable' }));
    await assert.rejects(a.complete(xaiEntry, chat()), (e: unknown) => e instanceof ModelUpstreamError && !(e instanceof SubscriptionLimitError) && e.code === 'subscription_token_unavailable');
  });

  it('recognises OpenAI usage_limit_reached (429) as a plan limit and reads the reset time (resets_in_seconds and resets_at)', async () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const mk = (error: Record<string, unknown>) => fake(() => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', ...error } }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const a1 = subscriptionResponses({ token: async () => tokens['c-openai'], version: '1', fetch: mk({ resets_in_seconds: 3600 }).fetch, now: () => now });
    await assert.rejects(a1.complete(openaiEntry, chat()), (e: unknown) => e instanceof SubscriptionLimitError && e.kind === 'plan-limit' && e.resetAt === '2026-11-08T13:00:00.000Z' && e.connection === 'c-openai' && e.code === 'subscription_limit_reached');
    const a2 = subscriptionResponses({ token: async () => tokens['c-openai'], version: '1', fetch: mk({ resets_at: Date.parse('2026-11-09T00:00:00Z') / 1000 }).fetch, now: () => now });
    await assert.rejects(a2.complete(openaiEntry, chat()), (e: unknown) => e instanceof SubscriptionLimitError && e.resetAt === '2026-11-09T00:00:00.000Z');
    const a3 = subscriptionResponses({ token: async () => tokens['c-openai'], version: '1', fetch: mk({}).fetch, now: () => now });
    await assert.rejects(a3.complete(openaiEntry, chat()), (e: unknown) => e instanceof SubscriptionLimitError && e.resetAt === undefined);
  });

  it('recognises the limit when it arrives as a failed stream event', async () => {
    const { fetch: f } = fake(() => sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'limit' } } }]));
    // The stream's failure has no HTTP status of its own: it is matched on the vendor's code.
    await assert.rejects(adapter(f).complete(openaiEntry, chat()), (e: unknown) => e instanceof SubscriptionLimitError);
  });

  it('an unrecognised failure inside a stream is an upstream error, not a throttle', async () => {
    const { fetch: f } = fake(() => sse([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'oops' } } }]));
    await assert.rejects(adapter(f).complete(openaiEntry, chat()), (e: unknown) => e instanceof ModelUpstreamError && !(e instanceof SubscriptionLimitError) && e.code === 'upstream_error');
  });

  it('an ordinary 429 (rate limit) is not a plan limit', async () => {
    const { fetch: f } = fake(() => new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }), { status: 429 }));
    await assert.rejects(adapter(f).complete(openaiEntry, chat()), (e: unknown) => e instanceof ModelUpstreamError && !(e instanceof SubscriptionLimitError) && e.code === 'upstream_throttled');
  });

  it('recognises the (unverified) tier refusals the template names, and nothing the template does not', async () => {
    const { fetch: f } = fake(() => new Response(JSON.stringify({ error: { code: 'usage_not_included', message: 'no' } }), { status: 403 }));
    await assert.rejects(adapter(f).complete(openaiEntry, chat()), (e: unknown) => e instanceof SubscriptionLimitError && e.kind === 'tier-refused' && e.code === 'subscription_tier_refused');
    const g = fake(() => new Response(JSON.stringify({ error: { code: 'something_else' } }), { status: 403 }));
    await assert.rejects(adapter(g.fetch).complete(openaiEntry, chat()), (e: unknown) => e instanceof ModelUpstreamError && !(e instanceof SubscriptionLimitError) && e.code === 'upstream_error');
  });

  it('never carries the access token in an error message', async () => {
    const { fetch: f } = fake(() => new Response(`boom ${OPENAI_TOKEN} boom`, { status: 500 }));
    await assert.rejects(adapter(f).complete(openaiEntry, chat()), (e: Error) => !e.message.includes(OPENAI_TOKEN) && e.message.includes('***'));
  });

  it('reports each token it fetched, for the redaction set', async () => {
    const got: string[] = [];
    const { fetch: f } = fake(() => sse([{ type: 'response.completed', response: { output: [] } }]));
    await subscriptionResponses({ token: async () => tokens['c-xai'], version: '1', fetch: f, onToken: (t) => got.push(t) }).complete(xaiEntry, chat());
    assert.deepEqual(got, [XAI_TOKEN]);
  });

  it('on vendor 401, invalidates the token once, remembers the fresh token for redaction, and retries once', async () => {
    const freshToken = 'xai-access-fresh-cccccccc'; // secret-scan:allow (fake fixture)
    const tokenCalls: Array<{ c: string; invalidate?: boolean }> = [];
    const redacted: string[] = [];
    let attempt = 0;
    const { fetch: f, seen } = fake(() => {
      if (attempt++ === 0) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
      return sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'retried ok' }] }], usage: { input_tokens: 3, output_tokens: 2 } } }]);
    });
    const a = subscriptionResponses({
      token: async (c, opts) => {
        tokenCalls.push({ c, invalidate: opts?.invalidate });
        return opts?.invalidate ? { ok: true, accessToken: freshToken, templateId: 'xai-subscription' } : tokens['c-xai'];
      },
      version: '1.0.0',
      fetch: f,
      onToken: (t) => redacted.push(t),
    });
    const out = await a.complete(xaiEntry, chat());
    assert.equal(out.content, 'retried ok');
    assert.deepEqual(tokenCalls, [{ c: 'c-xai', invalidate: undefined }, { c: 'c-xai', invalidate: true }]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].headers.authorization, `Bearer ${XAI_TOKEN}`);
    assert.equal(seen[1].headers.authorization, `Bearer ${freshToken}`);
    assert.deepEqual(redacted, [XAI_TOKEN, freshToken]);
  });

  it('on vendor 401, surfaces SubscriptionNeedsReconsentError when invalidated refresh hits invalid_grant, and never refreshes twice on repeated 401', async () => {
    const { fetch: f, seen } = fake(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    const reconsent = subscriptionResponses({
      token: async (_c, opts) => (opts?.invalidate ? { ok: false, kind: 'needs_reconsent', reason: 'invalid_grant' } : tokens['c-xai']),
      version: '1.0.0',
      fetch: f,
    });
    await assert.rejects(reconsent.complete(xaiEntry, chat()), (e: unknown) => e instanceof SubscriptionNeedsReconsentError && e.connection === 'c-xai');
    assert.equal(seen.length, 1, 'no retry when refresh reports needs_reconsent');

    // Repeated 401 even with a fresh token: refreshes only once and redacts both tokens.
    const freshToken = 'xai-access-fresh-dddddddd'; // secret-scan:allow (fake fixture)
    let tokCount = 0;
    const g = fake(() => new Response(`denied ${XAI_TOKEN} and ${freshToken}`, { status: 401 }));
    const still401 = subscriptionResponses({
      token: async (_c, opts) => {
        tokCount++;
        return { ok: true, accessToken: opts?.invalidate ? freshToken : XAI_TOKEN, templateId: 'xai-subscription' };
      },
      version: '1.0.0',
      fetch: g.fetch,
    });
    await assert.rejects(
      still401.complete(xaiEntry, chat()),
      (e: unknown) => e instanceof ModelUpstreamError && e.upstreamStatus === 401 && !e.message.includes(XAI_TOKEN) && !e.message.includes(freshToken),
    );
    assert.equal(tokCount, 2, 'at most one invalidated refresh');
    assert.equal(g.seen.length, 2);
  });
});

describe('account id claim', () => {
  it('reads chatgpt_account_id from the https://api.openai.com/auth claim, and nothing from a malformed token', () => {
    assert.equal(chatgptAccountIdFromJwt(OPENAI_TOKEN), 'acct-123');
    assert.equal(chatgptAccountIdFromJwt('nope'), undefined);
    assert.equal(chatgptAccountIdFromJwt(jwt({ sub: 'x' })), undefined);
  });
});

describe('catalog entry fields', () => {
  it('keeps credentialMode, connection and templateId on a subscription entry and drops a half-specified one', () => {
    const c = parseModelCatalog(JSON.stringify({
      a: { provider: 'xai-subscription', id: 'grok', credentialMode: 'subscription', connection: 'c-1', templateId: 'xai-subscription' },
      b: { provider: 'xai-subscription', id: 'grok', credentialMode: 'subscription' },
      c: { provider: 'xai', id: 'grok' },
    }));
    assert.deepEqual(c.a, { provider: 'xai-subscription', id: 'grok', credentialMode: 'subscription', connection: 'c-1', templateId: 'xai-subscription' });
    assert.equal(c.b.credentialMode, undefined);
    assert.equal(c.c.credentialMode, undefined);
  });
});

describe('discovery (M5(4a))', () => {
  const opts = (f: typeof fetch, c = 'c-openai') => ({ token: async (x: string) => tokens[x] ?? tokens[c], version: '9.9.9', fetch: f });

  it('OpenAI: GET /backend-api/codex/models with the account id, ranked by priority, hidden models dropped', async () => {
    const { fetch: f, seen } = fake(() => new Response(JSON.stringify({ models: [{ slug: 'gpt-5-mini', display_name: 'GPT-5 mini', priority: 5 }, { slug: 'gpt-5-codex', priority: 1 }, { slug: 'secret', visibility: 'hide' }, { slug: 'gpt-5-codex' }] }), { status: 200 }));
    const out = await discoverSubscriptionModels(opts(f), 'c-openai');
    assert.deepEqual(out, { ok: true, models: [{ id: 'gpt-5-codex' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] });
    assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=99.0.0');
    assert.equal(seen[0].headers['chatgpt-account-id'], 'acct-123');
    assert.equal(seen[0].headers.authorization, `Bearer ${OPENAI_TOKEN}`);
    assert.equal(seen[0].headers.originator, 'beercanlabs-agent-factory');
  });

  it('OpenAI: an empty list on the newest client version falls through to the 0.0.0 sentinel', async () => {
    let n = 0;
    const { fetch: f, seen } = fake(() => new Response(JSON.stringify({ models: n++ === 0 ? [] : [{ slug: 'gpt-5' }] }), { status: 200 }));
    const out = await discoverSubscriptionModels(opts(f), 'c-openai');
    assert.deepEqual(out, { ok: true, models: [{ id: 'gpt-5' }] });
    assert.equal(seen.length, 2);
    assert.match(seen[1].url, /client_version=0\.0\.0$/);
  });

  it('xAI (unconfirmed): tries api.x.ai/v1/models with the OAuth token and returns the list if the vendor gives one', async () => {
    const { fetch: f, seen } = fake(() => new Response(JSON.stringify({ data: [{ id: 'grok-4' }, { id: 'grok-3' }] }), { status: 200 }));
    const out = await discoverSubscriptionModels(opts(f), 'c-xai');
    assert.deepEqual(out, { ok: true, models: [{ id: 'grok-3' }, { id: 'grok-4' }] });
    assert.equal(seen[0].url, 'https://api.x.ai/v1/models');
    assert.equal(seen[0].headers.authorization, `Bearer ${XAI_TOKEN}`);
    assert.equal(seen[0].headers['chatgpt-account-id'], undefined);
  });

  it('xAI (unconfirmed): a vendor that refuses the token on its model list is reported clearly, never guessed', async () => {
    for (const status of [401, 403, 404]) {
      const { fetch: f } = fake(() => new Response('{}', { status }));
      const out = await discoverSubscriptionModels(opts(f), 'c-xai');
      assert.equal(out.ok, false);
      assert.ok(!out.ok && out.listAvailable === false && out.reason === 'vendor_refused' && out.status === status);
      assert.match((out as { message: string }).message, /add models by model id/);
    }
  });

  it('a 200 with no models is "no model list"; a 5xx, 429 or network failure is a failed fetch that retires nothing', async () => {
    const empty = fake(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const e = await discoverSubscriptionModels(opts(empty.fetch), 'c-xai');
    assert.ok(!e.ok && e.listAvailable === false && e.reason === 'no_model_list');
    for (const f of [fake(() => new Response('x', { status: 503 })).fetch, fake(() => new Response('x', { status: 429 })).fetch, (async () => { throw new Error('down'); }) as typeof fetch]) {
      const out = await discoverSubscriptionModels(opts(f), 'c-xai');
      assert.ok(!out.ok && out.listAvailable === true && out.reason === 'fetch_failed');
    }
  });

  it('a needs-re-consent connection is not asked, and a 401 on discovery invalidates once (retrying with fresh token or surfacing needs_reconsent)', async () => {
    const { fetch: f, seen } = fake(() => new Response('{}'));
    await assert.rejects(discoverSubscriptionModels({ token: async () => ({ ok: false, kind: 'needs_reconsent' }), version: '1', fetch: f }, 'c-xai'), SubscriptionNeedsReconsentError);
    assert.equal(seen.length, 0);

    // 401 -> invalidate -> fresh token succeeds
    const freshToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' }, jti: 'fresh' });
    let n = 0;
    const d1 = fake(() => (n++ === 0 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ models: [{ slug: 'gpt-5-codex' }] }), { status: 200 })));
    const out = await discoverSubscriptionModels({
      token: async (_c, opts) => ({ ok: true, accessToken: opts?.invalidate ? freshToken : OPENAI_TOKEN, templateId: 'openai-subscription' }),
      version: '1',
      fetch: d1.fetch,
    }, 'c-openai');
    assert.deepEqual(out, { ok: true, models: [{ id: 'gpt-5-codex' }] });
    assert.equal(d1.seen[1].headers.authorization, `Bearer ${freshToken}`);

    // 401 -> invalidate -> needs_reconsent throws SubscriptionNeedsReconsentError
    const d2 = fake(() => new Response('{}', { status: 401 }));
    await assert.rejects(
      discoverSubscriptionModels({
        token: async (_c, opts) => (opts?.invalidate ? { ok: false, kind: 'needs_reconsent' } : tokens['c-xai']),
        version: '1',
        fetch: d2.fetch,
      }, 'c-xai'),
      SubscriptionNeedsReconsentError,
    );
  });
});
