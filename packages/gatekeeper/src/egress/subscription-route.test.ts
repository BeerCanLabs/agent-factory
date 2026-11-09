import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, SKILL_CONTEXT_HEADER, type ControlClient, type LimitWindowView, type Policy, type RunContext } from './gatekeeper-egress.js';
import { ModelUpstreamError, parseModelCatalog, type ModelAdapter, type SubscriptionTokenResult } from '@beercanlabs/factory-executive';

// DESIGN_AUTHORITY.md TSK-327 (§6.9 M5(3), (6), (7)): subscription models on the factory model API, against a fake vendor and a
// fake control plane whose window store is shared by every egress instance (as the real one is).

const tokens = new RunTokens('subscription-route-test-run-token-key-0123456789');
const SERVICE = 'egress-service-token';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const OPENAI_TOKEN = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })}.sig`;
const XAI_TOKEN = 'xai-access-token-bbbbbbbb'; // secret-scan:allow (fake fixture)

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(
  port: number,
  path: string,
  opts: { token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** The control plane's window store, as the real one behaves (idempotent open, one probe slot per hour). */
class FakeWindows {
  windows = new Map<string, LimitWindowView>();
  lastProbe = new Map<string, number>();
  rows: string[] = [];
  async list() {
    for (const w of [...this.windows.values()]) if (w.resetAt && Date.parse(w.resetAt) <= Date.now()) { this.windows.delete(w.connection); this.rows.push(`RESET ${w.connection} reset`); }
    return [...this.windows.values()];
  }
  async apply(req: any) {
    if (req.action === 'open') {
      const ex = (await this.list()).find((w) => w.connection === req.connection);
      if (ex) return { opened: false, window: ex };
      const w: LimitWindowView = { connection: req.connection, kind: req.kind, code: req.code, openedAt: new Date().toISOString(), ...(req.resetAt && Date.parse(req.resetAt) > Date.now() ? { resetAt: req.resetAt } : {}) };
      this.windows.set(req.connection, w);
      this.rows.push(`REACHED ${req.connection}`);
      return { opened: true, window: w };
    }
    if (req.action === 'close') {
      const had = this.windows.delete(req.connection);
      if (had) this.rows.push(`RESET ${req.connection} ${req.by}`);
      return { closed: had };
    }
    const open = this.windows.has(req.connection);
    const last = this.lastProbe.get(req.connection);
    if (!open || (last && Date.now() - last < 3_600_000)) return { granted: false };
    this.lastProbe.set(req.connection, Date.now());
    this.rows.push(`PROBE ${req.connection}`);
    return { granted: true };
  }
}

const catalog = parseModelCatalog(
  JSON.stringify({
    'grok-sub': { provider: 'xai-subscription', id: 'grok-4', credentialMode: 'subscription', scope: 'factory', connection: 'c-xai', connectionName: 'Team Grok', templateId: 'xai-subscription', price: { inputPerMTok: 0, outputPerMTok: 0 } },
    'gpt-sub': { provider: 'openai-subscription', id: 'gpt-5-codex', credentialMode: 'subscription', scope: 'factory', connection: 'c-openai', connectionName: 'Team ChatGPT', templateId: 'openai-subscription', price: { inputPerMTok: 0, outputPerMTok: 0 } },
    'grok-sub-2': { provider: 'xai-subscription', id: 'grok-3', credentialMode: 'subscription', scope: 'factory', connection: 'c-xai', connectionName: 'Team Grok', templateId: 'xai-subscription', price: { inputPerMTok: 0, outputPerMTok: 0 } },
    'dale-byom': { provider: 'xai-subscription', id: 'grok-4.6', credentialMode: 'subscription', scope: 'personal', ownerPrincipalId: 'user:dale', connection: 'c-dale', connectionName: "Dale's Grok", templateId: 'xai-subscription', dailyTokenCap: 100, price: { inputPerMTok: 0, outputPerMTok: 0 } },
    'unpriced-sub': { provider: 'xai-subscription', id: 'grok-unpriced', credentialMode: 'subscription', scope: 'factory', connection: 'c-xai', templateId: 'xai-subscription' },
    'api-model': { provider: 'mock', id: 'mock-1', price: { inputPerMTok: 1, outputPerMTok: 2 } },
    'api-bad': { provider: 'mock', id: 'mock-503', price: { inputPerMTok: 1, outputPerMTok: 2 } },
  }),
);

type VendorSeen = { url: string; headers: Record<string, string>; body: any };

describe('subscription models on the factory model API (TSK-327)', { concurrency: false }, () => {
  const windows = new FakeWindows();
  const ledger: Array<Record<string, any>> = [];
  const vendor: VendorSeen[] = [];
  const tokenCalls: string[] = [];
  const tokenReqs: Array<{ connection: string; invalidate?: boolean }> = [];
  const failoverCalls: any[] = [];
  const capUsage = new Map<string, { used: number; cap?: number; day: string }>();
  const capEvents: string[] = [];
  let tokenResult: Record<string, SubscriptionTokenResult> = {};
  let onTokenReq: ((req: { connection: string; invalidate?: boolean }) => SubscriptionTokenResult | undefined) | undefined;
  let vendorReply: (seen: VendorSeen) => Response = () => ok('from vendor');
  let ctx: RunContext;
  let runSeq = 0;
  let egress: http.Server;
  let egress2: http.Server;
  let port = 0;
  let port2 = 0;
  let runToken = '';
  let apiCalls = 0;

  const ok = (text: string, extra: unknown[] = []) =>
    new Response(
      [
        ...extra.map((item) => ({ type: 'response.output_item.done', item })),
        { type: 'response.completed', response: { output: extra.length ? extra : [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 4 } } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  /** The vendor's plan-limit answer, resetting in `sec` seconds (xAI's template reads `resets_at`, epoch seconds). */
  const limitIn = (sec: number) => limit({ resets_at: (Date.now() + sec * 1000) / 1000 });
  const limit = (error: Record<string, unknown> = {}) => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', ...error } }), { status: 429, headers: { 'content-type': 'application/json' } });

  const modelFetch = (async (url: string | URL, init?: RequestInit) => {
    const s: VendorSeen = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    vendor.push(s);
    return vendorReply(s);
  }) as typeof fetch;

  const mock: ModelAdapter = {
    async complete(entry) {
      if (entry.id === 'mock-503') throw new ModelUpstreamError(503, 'upstream_error', 'api-bad down', 503);
      apiCalls++;
      return { content: 'from api', finishReason: 'stop', usage: { input: 5, output: 2 } };
    },
  };

  const control = (shared: FakeWindows | undefined = windows): ControlClient => ({
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() { throw new Error('unused'); },
    async consumeApproval() { return false; },
    async ledger(event) { ledger.push(event); },
    async modelFailover(req) {
      failoverCalls.push(req);
      ctx.policy.currentModel = req.toModel;
      return { ok: true, currentModel: req.toModel };
    },
    async subscriptionToken(req) {
      tokenCalls.push(req.connection);
      tokenReqs.push(req);
      return onTokenReq?.(req) ?? tokenResult[req.connection] ?? { ok: false, kind: 'unavailable' };
    },
    ...(shared
      ? {
          async subscriptionWindows() {
            const winList = await shared.list();
            const caps = [...capUsage.entries()]
              .filter(([, v]) => v.cap !== undefined && v.used >= v.cap)
              .map(([k, v]) => {
                const [connection, agentId] = k.split('::');
                return {
                  connection,
                  agentId,
                  utcDay: v.day,
                  resetAt: `${v.day}T23:59:59.999Z`,
                  dailyTokenCap: v.cap,
                  tokensUsed: v.used,
                };
              });
            return caps.length > 0 ? { windows: winList, caps } : winList;
          },
          async subscriptionWindow(req: any) { return shared.apply(req); },
        }
      : {}),
  });

  const policy = (p: Partial<Policy> = {}): Policy => ({ routes: ['models'], models: ['grok-sub', 'gpt-sub', 'grok-sub-2', 'api-model', 'api-bad'], ...p });
  const chatBody = (extra: Record<string, unknown> = {}) => ({ model: 'whatever', messages: [{ role: 'user', content: 'hello' }], ...extra });
  const ask = (p = port, body: unknown = chatBody()) => call(p, '/models/v1/chat/completions', { token: runToken, body });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const actions = (a: string) => ledger.filter((e) => e.action === a);
  const setRun = async (agentId: string, pol: Policy, run: Partial<RunContext['run']> = {}) => {
    const runId = `run-${++runSeq}`;
    ctx = { run: { runId, agentId, state: 'WORKING', live: true, ...run }, agentState: 'WORKING', policy: pol, spend: { run: 0, day: 0, month: 0 } };
    runToken = await tokens.mint({ runId, agentId });
  };

  const make = (c: ControlClient, extra: Record<string, unknown> = {}) =>
    createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control: c,
      providers: [],
      contextTtlMs: 0,
      modelCatalog: catalog,
      defaultModel: 'api-model',
      modelAdapters: { mock },
      modelFetch,
      version: '7.7.7',
      serviceToken: SERVICE,
      subscriptionProbeIntervalMs: 0,
      subscriptionWindowCacheMs: 0,
      ...extra,
    });

  // Fresh egress instances for every test: the caches (windows, re-consent) are per instance, as in production.
  beforeEach(async () => {
    egress = make(control());
    egress2 = make(control());
    port = await listen(egress);
    port2 = await listen(egress2);
  });
  afterEach(async () => {
    await new Promise<void>((r) => egress.close(() => r()));
    await new Promise<void>((r) => egress2.close(() => r()));
  });
  beforeEach(async () => {
    ledger.length = 0;
    vendor.length = 0;
    tokenCalls.length = 0;
    tokenReqs.length = 0;
    failoverCalls.length = 0;
    windows.windows.clear();
    windows.lastProbe.clear();
    windows.rows.length = 0;
    capUsage.clear();
    capEvents.length = 0;
    apiCalls = 0;
    onTokenReq = undefined;
    tokenResult = {
      'c-xai': { ok: true, accessToken: XAI_TOKEN, templateId: 'xai-subscription' },
      'c-openai': { ok: true, accessToken: OPENAI_TOKEN, templateId: 'openai-subscription' },
      'c-dale': { ok: true, accessToken: XAI_TOKEN, templateId: 'xai-subscription' },
    };
    vendorReply = () => ok('from vendor');
    await setRun('donna', policy({ currentModel: 'grok-sub', primaryModel: 'api-model' }));
  });

  describe('serving', () => {
    it('serves a subscription entry through the Responses adapter: token to the template host only, template headers only, tool calls round-trip', async () => {
      vendorReply = () => ok('', [{ type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '{"city":"Paris"}' }]);
      const tool = { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };
      const res = await ask(port, chatBody({ tools: [tool] }));
      assert.equal(res.status, 200, res.text);
      const msg = res.json().choices[0];
      assert.equal(msg.finish_reason, 'tool_calls');
      assert.deepEqual(msg.message.tool_calls, [{ id: 'call_7', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
      assert.equal(vendor.length, 1);
      assert.equal(vendor[0].url, 'https://api.x.ai/v1/responses');
      assert.deepEqual(vendor[0].headers, { 'user-agent': 'BeerCanLabs-AgentFactory/7.7.7', authorization: `Bearer ${XAI_TOKEN}`, 'content-type': 'application/json' });
      assert.equal(vendor[0].body.store, false);
      assert.deepEqual(vendor[0].body.tools.map((t: any) => t.name), ['get_weather']);
      assert.equal(JSON.stringify(vendor[0].headers).includes(runToken), false, 'the run token never goes upstream');
      assert.deepEqual(tokenCalls, ['c-xai'], 'the Keymaster is asked for a token per call');
      // The second turn, with the tool result, round-trips as function_call_output.
      vendorReply = () => ok('18C in Paris');
      const second = await ask(port, chatBody({ tools: [tool], messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: null, tool_calls: msg.message.tool_calls }, { role: 'tool', tool_call_id: 'call_7', content: '18C' }] }));
      assert.equal(second.json().choices[0].message.content, '18C in Paris');
      assert.deepEqual(vendor[1].body.input.slice(-2), [
        { type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_7', output: '18C' },
      ]);
      assert.equal(tokenCalls.length, 2);
    });

    it('OpenAI: ChatGPT-Account-ID and originator, and each call is ledgered with its catalog name, credential mode and connection', async () => {
      await setRun('donna', policy({ currentModel: 'gpt-sub' }));
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(vendor[0].url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(vendor[0].headers['chatgpt-account-id'], 'acct-9');
      assert.equal(vendor[0].headers.originator, 'beercanlabs-agent-factory');
      await settle();
      const row = ledger.find((e) => e.type === 'llm')!;
      assert.equal(row.model, 'gpt-sub');
      assert.equal(row.credentialMode, 'subscription');
      assert.equal(row.connection, 'c-openai');
      assert.equal(row.upstreamModel, 'gpt-5-codex');
    });

    it('the access token is never in a reply or a ledger row', async () => {
      vendorReply = () => new Response(`boom ${XAI_TOKEN}`, { status: 500 });
      await setRun('donna', policy({ currentModel: 'grok-sub' }));
      const res = await ask();
      await settle();
      assert.equal(res.text.includes(XAI_TOKEN), false);
      assert.equal(JSON.stringify(ledger).includes(XAI_TOKEN), false);
    });

    it('is never served on a provider-native route (M4): a subscription name there asks no Keymaster for a token', async () => {
      const up = http.createServer((_req, r) => r.end('{}'));
      const upPort = await listen(up);
      const native = make(control(), { routes: [{ id: 'xai', kind: 'llm', provider: 'xai', upstream: `http://127.0.0.1:${upPort}` }] });
      const nPort = await listen(native);
      await setRun('donna', policy({ routes: ['xai'], models: ['grok-sub'] }));
      const res = await call(nPort, '/xai/v1/chat/completions', { token: runToken, body: { model: 'grok-sub', messages: [{ role: 'user', content: 'x' }] } });
      assert.equal(res.status, 403, 'unpriced on the native route: no subscription entry resolves there');
      assert.deepEqual(tokenCalls, []);
      assert.deepEqual(vendor, []);
      await new Promise<void>((r) => native.close(() => r()));
      await new Promise<void>((r) => up.close(() => r()));
    });
  });

  describe('needs re-consent (M5(6))', () => {
    beforeEach(() => {
      tokenResult['c-xai'] = { ok: false, kind: 'needs_reconsent', reason: 'grant_marked' };
    });

    it('is skipped in failback: served by the next candidate, MODEL_FAILOVER with the footnote data, no refresh retry, no probe, no window, no POLICY_UPDATED', async () => {
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'from api');
      await settle();
      assert.equal(vendor.length, 0, 'no vendor call, so no probe either');
      assert.equal(windows.windows.size, 0);
      assert.deepEqual(windows.rows, []);
      assert.equal(failoverCalls.length, 0, 'the policy route (POLICY_UPDATED) is never called');
      assert.equal(ctx.policy.currentModel, 'grok-sub', 'the selection is unchanged');
      assert.equal(actions('POLICY_UPDATED').length, 0);
      const fo = actions('MODEL_FAILOVER');
      assert.equal(fo.length, 1);
      assert.deepEqual([fo[0].requestedModel, fo[0].model, fo[0].failoverReason], ['grok-sub', 'api-model', 'subscription_needs_reconsent']);
    });

    it('does not ask the Keymaster again for every call (no refresh retry storm)', async () => {
      await ask();
      await ask();
      await ask();
      assert.equal(tokenCalls.length, 1);
    });

    it('is skipped for every agent', async () => {
      await ask();
      await setRun('castle', policy({ currentModel: 'grok-sub', primaryModel: 'api-model' }));
      const res = await ask();
      assert.equal(res.json().choices[0].message.content, 'from api');
      assert.equal(vendor.length, 0);
    });

    it('MODEL_FAILOVER_EXHAUSTED when no candidate is left', async () => {
      await setRun('donna', policy({ models: ['grok-sub'], currentModel: 'grok-sub', primaryModel: 'grok-sub' }));
      const res = await ask();
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'subscription_needs_reconsent');
      await settle();
      assert.equal(actions('MODEL_FAILOVER_EXHAUSTED').length, 1);
      assert.equal(failoverCalls.length, 0);
    });

    it('refuses a pinned run with subscription_needs_reconsent and substitutes nothing', async () => {
      await setRun('donna', policy({ currentModel: 'api-model' }), { model: 'grok-sub' });
      const res = await ask();
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'subscription_needs_reconsent');
      assert.equal(apiCalls, 0);
      assert.equal(vendor.length, 0);
    });

    it('refuses a training run\'s requested entry too', async () => {
      await setRun('donna', policy(), {});
      ctx.agentState = 'TRAINING';
      const res = await ask(port, chatBody({ model: 'grok-sub' }));
      assert.equal(res.status, 503);
      assert.equal(res.json().error, 'subscription_needs_reconsent');
      assert.equal(apiCalls, 0);
    });
  });

  describe('plan-limit window (M5(7), (7a))', () => {
    it('a vendor usage_limit_reached opens the connection\'s window; the call is served by the next candidate; no selection changes', async () => {
      vendorReply = () => limitIn(3600);
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'from api');
      await settle();
      const w = [...windows.windows.values()];
      assert.equal(w.length, 1);
      assert.deepEqual([w[0].connection, w[0].kind, w[0].code], ['c-xai', 'plan-limit', 'usage_limit_reached']);
      assert.ok(w[0].resetAt && Date.parse(w[0].resetAt) > Date.now() + 3_000_000);
      assert.equal(failoverCalls.length, 0, 'no POLICY_UPDATED path');
      assert.equal(ctx.policy.currentModel, 'grok-sub');
      const fo = actions('MODEL_FAILOVER');
      assert.equal(fo.length, 1);
      assert.deepEqual([fo[0].requestedModel, fo[0].model, fo[0].failoverReason], ['grok-sub', 'api-model', 'subscription_limit_reached']);
    });

    it('skips the connection for every agent, every entry on it, wherever it sits in failback, across egress instances', async () => {
      vendorReply = () => limitIn(3600);
      await ask();
      assert.equal(vendor.length, 1);
      // Another agent with the connection as its secondary, on the other egress instance.
      await setRun('castle', policy({ currentModel: 'api-model', primaryModel: 'grok-sub-2', secondaryModel: 'grok-sub' }));
      let res = await ask(port2);
      assert.equal(res.json().choices[0].message.content, 'from api');
      // And an agent whose current model is a different entry on the same connection.
      await setRun('dave', policy({ currentModel: 'grok-sub-2', primaryModel: 'api-model' }));
      res = await ask(port2);
      assert.equal(res.json().choices[0].message.content, 'from api');
      assert.equal(vendor.length, 1, 'the vendor was not called again by anyone');
      await settle();
      assert.equal(failoverCalls.length, 0);
    });

    it('the window is per connection: another connection\'s entries are still served', async () => {
      vendorReply = (s) => (s.url.includes('api.x.ai') ? limitIn(3600) : ok('from openai'));
      await ask();
      await setRun('castle', policy({ currentModel: 'grok-sub', primaryModel: 'gpt-sub', secondaryModel: 'api-model' }));
      const res = await ask(port2);
      assert.equal(res.json().choices[0].message.content, 'from openai');
      assert.equal(vendor.filter((v) => v.url.includes('chatgpt.com')).length, 1);
    });

    it('with no candidate left off the connection, the call fails with MODEL_FAILOVER_EXHAUSTED', async () => {
      vendorReply = () => limitIn(3600);
      await setRun('donna', policy({ models: ['grok-sub', 'grok-sub-2'], currentModel: 'grok-sub', primaryModel: 'grok-sub-2' }));
      const res = await ask();
      assert.equal(res.status, 429);
      assert.equal(res.json().error, 'subscription_limit_reached');
      await settle();
      assert.equal(actions('MODEL_FAILOVER_EXHAUSTED').length, 1);
      assert.equal(vendor.length, 1, 'the second entry on the limited connection was skipped, not tried');
    });

    it('refuses a pinned run and a training run\'s requested entry with subscription_limit_reached and the reset time', async () => {
      vendorReply = () => limitIn(3600);
      await ask();
      await setRun('donna', policy({ currentModel: 'api-model' }), { model: 'grok-sub' });
      const pinned = await ask(port2);
      assert.equal(pinned.status, 429);
      assert.equal(pinned.json().error, 'subscription_limit_reached');
      assert.ok(pinned.json().resetAt);
      await setRun('donna', policy());
      ctx.agentState = 'TRAINING';
      const req = await ask(port2, chatBody({ model: 'grok-sub' }));
      assert.equal(req.status, 429);
      assert.equal(req.json().error, 'subscription_limit_reached');
      assert.equal(apiCalls, 1, 'only the first call was served elsewhere; nothing was substituted for the refused ones');
    });

    it('closes at the vendor\'s reset time: the connection\'s entries are served again', async () => {
      vendorReply = () => limitIn(1);
      await ask();
      assert.equal(windows.windows.size, 1);
      vendorReply = () => ok('back on the plan');
      assert.equal((await ask(port2)).json().choices[0].message.content, 'from api', 'still inside the window');
      await new Promise((r) => setTimeout(r, 1300));
      const res = await ask(port2);
      assert.equal(res.json().choices[0].message.content, 'back on the plan');
      await settle();
      assert.equal(windows.windows.size, 0);
      assert.ok(windows.rows.some((r) => r.startsWith('RESET c-xai')) || windows.windows.size === 0);
    });

    it('an instance that cached the window notices the reset time itself, serves the connection again and has the close ledgered', async () => {
      const cached = make(control(), { subscriptionWindowCacheMs: 60_000 });
      const p = await listen(cached);
      vendorReply = () => limitIn(1);
      await ask(p);
      assert.equal(windows.windows.size, 1);
      await new Promise((r) => setTimeout(r, 1300));
      vendorReply = () => ok('back');
      assert.equal((await ask(p)).json().choices[0].message.content, 'back');
      await settle();
      assert.equal(windows.windows.size, 0);
      assert.ok(windows.rows.includes('RESET c-xai reset'));
      await new Promise<void>((r) => cached.close(() => r()));
    });

    it('with no reset time, a probe closes it: one minimal factory-paid request, at most hourly, never an agent\'s call', async () => {
      vendorReply = () => limit(); // no reset time
      await ask();
      assert.equal(windows.windows.get('c-xai')?.resetAt, undefined);
      assert.equal(vendor.length, 1);
      // The next call meets the window: it is skipped, and a probe runs in the background; the vendor is still limited.
      await ask(port2);
      await settle();
      assert.equal(vendor.length, 2, 'one probe request');
      assert.deepEqual(vendor[1].body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }], 'a minimal request, not an agent\'s');
      assert.equal(vendor[1].body.max_output_tokens, 1);
      assert.equal(windows.windows.size, 1, 'a failed probe leaves the window open');
      // At most hourly: calls inside the hour do not probe again.
      await ask(port2);
      await ask(port);
      await settle();
      assert.equal(vendor.length, 2);
      // An hour later the vendor answers: the probe succeeds and closes the window.
      windows.lastProbe.set('c-xai', Date.now() - 3_700_000);
      vendorReply = () => ok('pong');
      await ask(port2);
      await settle();
      assert.equal(windows.windows.size, 0);
      assert.ok(windows.rows.includes('RESET c-xai probe'));
      assert.equal((await ask(port)).json().choices[0].message.content, 'pong');
    });

    it('a window with a vendor reset time is not probed', async () => {
      vendorReply = () => limitIn(3600);
      await ask();
      await ask(port2);
      await settle();
      assert.equal(vendor.length, 1);
      assert.ok(!windows.rows.some((r) => r.startsWith('PROBE')));
    });

    it('a tier refusal the template names opens a window too (unverified code, M5(7))', async () => {
      await setRun('donna', policy({ currentModel: 'gpt-sub', primaryModel: 'api-model' }));
      vendorReply = () => new Response(JSON.stringify({ error: { code: 'usage_not_included' } }), { status: 403 });
      const res = await ask();
      assert.equal(res.json().choices[0].message.content, 'from api');
      assert.equal(windows.windows.get('c-openai')?.kind, 'tier-refused');
    });

    it('an ordinary rate limit is unchanged: no window, and the persistent failback of M2 applies', async () => {
      vendorReply = () => new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }), { status: 429 });
      const res = await ask();
      assert.equal(res.json().choices[0].message.content, 'from api');
      await settle();
      assert.equal(windows.windows.size, 0);
      assert.equal(failoverCalls.length, 1, 'ordinary failure: the M2 policy failover');
      assert.equal(failoverCalls[0].toModel, 'api-model');
    });

    it('mixed walk [503, skip, ok]: candidate 0 failed ordinarily, so currentModel is persisted via modelFailover with candidate 0\'s reason', async () => {
      // [api-bad (503), grok-sub (limit skip), api-model (ok)]
      vendorReply = () => limitIn(3600);
      await setRun('donna', policy({ currentModel: 'api-bad', primaryModel: 'grok-sub', secondaryModel: 'api-model' }));
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'from api');
      await settle();
      assert.equal(failoverCalls.length, 1, 'candidate 0 failed for a non-skip reason: M2 persistent failback runs');
      assert.deepEqual(
        [failoverCalls[0].fromModel, failoverCalls[0].toModel, failoverCalls[0].reason],
        ['api-bad', 'api-model', 'upstream_error'],
      );
      assert.equal(ctx.policy.currentModel, 'api-model');
    });

    it('mixed walk [skip, 503, ok]: candidate 0 was skipped, so currentModel stays unchanged and modelFailover is bypassed', async () => {
      // [grok-sub (limit skip), api-bad (503), api-model (ok)]
      vendorReply = () => limitIn(3600);
      await setRun('donna', policy({ currentModel: 'grok-sub', primaryModel: 'api-bad', secondaryModel: 'api-model' }));
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'from api');
      await settle();
      assert.equal(failoverCalls.length, 0, 'candidate 0 was skipped: temporary failover never calls modelFailover');
      assert.equal(ctx.policy.currentModel, 'grok-sub');
      const fo = actions('MODEL_FAILOVER');
      assert.equal(fo.length, 1);
      assert.deepEqual([fo[0].requestedModel, fo[0].model, fo[0].failoverReason], ['grok-sub', 'api-model', 'subscription_limit_reached']);
    });

    it('vendor 401 invalidates once: retries with fresh token (redacting it), or skips cleanly on needs_reconsent instead of 502', async () => {
      const freshToken = 'xai-access-fresh-eeeeeeee'; // secret-scan:allow (fake fixture)
      let calls = 0;
      vendorReply = () => (calls++ === 0 ? new Response('{"error":"unauthorized"}', { status: 401 }) : ok('after refresh'));
      onTokenReq = (req) => (req.invalidate ? { ok: true, accessToken: freshToken, templateId: 'xai-subscription' } : undefined);
      const res = await ask();
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json().choices[0].message.content, 'after refresh');
      assert.deepEqual(tokenReqs, [{ connection: 'c-xai' }, { connection: 'c-xai', invalidate: true }]);
      assert.equal(vendor[1].headers.authorization, `Bearer ${freshToken}`);

      // Fresh token is in the egress redaction set too: if a subsequent call fails with it in the upstream message, it is scrubbed.
      tokenResult['c-xai'] = { ok: true, accessToken: freshToken, templateId: 'xai-subscription' };
      onTokenReq = undefined;
      vendorReply = () => new Response(`leaked ${freshToken}`, { status: 500 });
      await setRun('donna', policy({ models: ['grok-sub'], currentModel: 'grok-sub', primaryModel: 'grok-sub' }));
      const failed = await ask();
      await settle();
      assert.equal(failed.text.includes(freshToken), false);
      assert.equal(JSON.stringify(ledger).includes(freshToken), false);

      // And when invalidated refresh hits invalid_grant (needs_reconsent), failback skips cleanly (and pinned returns 503 subscription_needs_reconsent) rather than 502.
      ledger.length = 0;
      tokenReqs.length = 0;
      tokenResult['c-xai'] = { ok: true, accessToken: XAI_TOKEN, templateId: 'xai-subscription' };
      onTokenReq = (req) => (req.invalidate ? { ok: false, kind: 'needs_reconsent', reason: 'invalid_grant' } : undefined);
      vendorReply = () => new Response('{"error":"unauthorized"}', { status: 401 });
      await setRun('donna', policy({ currentModel: 'grok-sub', primaryModel: 'api-model' }));
      const skippedRes = await ask();
      assert.equal(skippedRes.status, 200, skippedRes.text);
      assert.equal(skippedRes.json().choices[0].message.content, 'from api');
      await settle();
      assert.equal(failoverCalls.length, 0);
      assert.equal(actions('MODEL_FAILOVER')[0]?.failoverReason, 'subscription_needs_reconsent');

      // Pinned run surfaces 503 subscription_needs_reconsent (not 502) when 401 triggers invalid_grant on another egress instance.
      await setRun('donna', policy({ currentModel: 'api-model' }), { model: 'grok-sub' });
      const pinnedRes = await ask(port2);
      assert.equal(pinnedRes.status, 503, pinnedRes.text);
      assert.equal(pinnedRes.json().error, 'subscription_needs_reconsent');
    });

    it('a restart or another instance sees an open window: a fresh egress with the same store skips it', async () => {
      vendorReply = () => limitIn(3600);
      await ask();
      const fresh = make(control());
      const p = await listen(fresh);
      vendor.length = 0;
      await setRun('castle', policy({ currentModel: 'grok-sub', primaryModel: 'api-model' }));
      const res = await ask(p);
      assert.equal(res.json().choices[0].message.content, 'from api');
      assert.equal(vendor.length, 0);
      await new Promise<void>((r) => fresh.close(() => r()));
    });

    it('control plane unreachable for the list: serves as if no window were open and the vendor reports the limit again', async () => {
      const broken: ControlClient = { ...control(), async subscriptionWindows() { throw new Error('down'); } };
      const e = make(broken);
      const p = await listen(e);
      vendorReply = () => limitIn(3600);
      const res = await ask(p);
      assert.equal(res.status, 200);
      assert.equal(vendor.length, 1);
      await ask(p);
      assert.equal(vendor.length, 1, 'the window opened locally for this instance even though the list is unavailable');
      await new Promise<void>((r) => e.close(() => r()));
    });
  });

  describe('discovery (M5(4a))', () => {
    const disc = (connection: string, token: string | null = SERVICE) => call(port, '/internal/subscription-models', { token: token ?? undefined, body: { connection } });

    it('requires the service token', async () => {
      assert.equal((await disc('c-openai', null)).status, 401);
      assert.equal((await disc('c-openai', 'wrong')).status, 401);
    });

    it('OpenAI: lists the plan\'s models from /backend-api/codex/models with the account id; the token goes only to chatgpt.com', async () => {
      vendorReply = () => new Response(JSON.stringify({ models: [{ slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', priority: 1 }, { slug: 'gpt-5-mini', priority: 2 }] }), { status: 200 });
      const res = await disc('c-openai');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json(), { listAvailable: true, models: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }, { id: 'gpt-5-mini' }] });
      assert.match(vendor[0].url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);
      assert.equal(vendor[0].headers['chatgpt-account-id'], 'acct-9');
      assert.equal(res.text.includes(OPENAI_TOKEN), false);
    });

    it('xAI (unconfirmed): a vendor that refuses the OAuth token on its list is reported clearly, not guessed', async () => {
      vendorReply = () => new Response('{}', { status: 403 });
      const res = await disc('c-xai');
      assert.equal(res.status, 200);
      const b = res.json();
      assert.deepEqual([b.listAvailable, b.reason, b.status, b.models], [false, 'vendor_refused', 403, []]);
      assert.match(b.message, /add models by model id/);
      assert.equal(vendor[0].url, 'https://api.x.ai/v1/models');
    });

    it('a failed fetch is a 502 that tells the caller to retire nothing; a needs-re-consent connection is a 409 (including on vendor 401 -> invalid_grant)', async () => {
      vendorReply = () => new Response('x', { status: 503 });
      assert.equal((await disc('c-xai')).status, 502);
      // Vendor 401 during discovery invalidates once: if Keymaster hits invalid_grant, returns 409 subscription_needs_reconsent instead of 502.
      vendorReply = () => new Response('{}', { status: 401 });
      onTokenReq = (req) => (req.invalidate ? { ok: false, kind: 'needs_reconsent', reason: 'invalid_grant' } : undefined);
      const res401 = await disc('c-xai');
      assert.equal(res401.status, 409, res401.text);
      assert.equal(res401.json().error, 'subscription_needs_reconsent');
      onTokenReq = undefined;
      tokenResult['c-xai'] = { ok: false, kind: 'needs_reconsent' };
      const res = await disc('c-xai');
      assert.equal(res.status, 409);
      assert.equal(res.json().error, 'subscription_needs_reconsent');
    });
  });

  describe('BYOM D24/D15/S24, $0 standing, TPM throttle, daily caps & model listing markers (TSK-328)', () => {
    it('D24/D15/S24: allows personal BYOM on matching active personal owner, skips/refuses on team or owner mismatch or skill context', async () => {
      // 1. Personal agent actively owned by user:dale succeeds and ledgers scope + ownerPrincipalId + connectionName.
      await setRun('dale-assistant', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom', primaryModel: 'api-model', budgetUsd: { perDay: 0, perMonth: 0 } }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const okRes = await ask();
      assert.equal(okRes.status, 200, okRes.text);
      await settle();
      const llmRow = ledger.find((e) => e.type === 'llm');
      assert.ok(llmRow);
      assert.equal(llmRow.model, 'dale-byom');
      assert.equal(llmRow.credentialMode, 'subscription');
      assert.equal(llmRow.scope, 'personal');
      assert.equal(llmRow.ownerPrincipalId, 'user:dale');
      assert.equal(llmRow.connection, 'c-dale');
      assert.equal(llmRow.connectionName, "Dale's Grok");
      assert.equal(llmRow.costUsd, 0);

      // 2. D24: team agent pinned to dale-byom is refused 403 personal_model_team_forbidden.
      await setRun('team-bot', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom' }), { model: 'dale-byom' });
      ctx.agentKind = 'team';
      const d24 = await ask();
      assert.equal(d24.status, 403);
      assert.equal(d24.json().error, 'personal_model_team_forbidden');

      // 3. D15: personal agent whose activeOwnerPrincipalId is absent (pending-revoked) or user:bob is refused when pinned, or skips to api-model on walk.
      await setRun('dale-assistant', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom', primaryModel: 'api-model', budgetUsd: { perDay: 5, perMonth: 50 } }), { model: 'dale-byom' });
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = undefined;
      const d15Pin = await ask();
      assert.equal(d15Pin.status, 403);
      assert.equal(d15Pin.json().error, 'personal_model_owner_mismatch');

      await setRun('dale-assistant', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom', primaryModel: 'api-model', budgetUsd: { perDay: 5, perMonth: 50 } }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:bob';
      const d15Walk = await ask();
      assert.equal(d15Walk.status, 200);
      assert.equal(d15Walk.json().choices[0].message.content, 'from api');

      // 4. S24: skill context bound to personal BYOM is refused 403 personal_model_skill_forbidden.
      ctx.activeOwnerPrincipalId = 'user:dale';
      ctx.skillModels = { 'summarize-doc': 'dale-byom' };
      const s24 = await call(port, '/models/v1/chat/completions', {
        token: runToken,
        body: chatBody(),
        headers: { [SKILL_CONTEXT_HEADER]: 'summarize-doc' },
      });
      assert.equal(s24.status, 403);
      assert.equal(s24.json().error, 'personal_model_skill_forbidden');
    });

    it('M5(8), D25: $0 ceiling ({ perDay: 0, perMonth: 0 }) succeeds on $0 entry, fails closed 402 on >$0 fallback, and refuses unpriced_model', async () => {
      // Unallocated personal agent at { perDay: 0, perMonth: 0 }: $0 subscription entry succeeds.
      await setRun('dale-zero', policy({ models: ['grok-sub', 'api-model'], currentModel: 'grok-sub', primaryModel: 'api-model', budgetUsd: { perDay: 0, perMonth: 0 } }));
      const r1 = await ask();
      assert.equal(r1.status, 200, r1.text);

      // Open limit window on c-xai so grok-sub skips to >$0 api-model -> fails closed 402 budget_exceeded!
      await windows.apply({ action: 'open', connection: 'c-xai', kind: 'plan_limit', code: 'usage_limit_reached', resetAt: new Date(Date.now() + 3600_000).toISOString() });
      const r2 = await ask();
      assert.equal(r2.status, 402, r2.text);
      assert.equal(r2.json().error, 'budget_exceeded');
      assert.equal(apiCalls, 0, 'the >$0 upstream model was never called at $0 ceiling');

      // Unset price on a subscription entry is refused 403 unpriced_model.
      windows.windows.clear();
      await setRun('donna', policy({ models: ['unpriced-sub'], currentModel: 'unpriced-sub', budgetUsd: { perDay: 5, perMonth: 50 } }));
      const r3 = await ask();
      assert.equal(r3.status, 403);
      assert.equal(r3.json().error, 'unpriced_model');
    });

    it('M5(8): TPM throttle (tokensPerMinute) is enforced even on $0 subscription entries', async () => {
      await setRun('donna', policy({ models: ['grok-sub'], currentModel: 'grok-sub', tokensPerMinute: 10 }));
      // First call uses 10 + 4 = 14 tokens -> hits 10 TPM ceiling for next call within the minute.
      const first = await ask();
      assert.equal(first.status, 200);
      const second = await ask();
      assert.equal(second.status, 429);
      assert.equal(second.json().error, 'throttled');
    });

    it('M5(6), (7): per-agent daily token cap skips for that agent only, preserves mixed-walk currentModel vs modelFailover, and refuses pinned with 429 subscription_cap_reached', async () => {
      const today = new Date().toISOString().slice(0, 10);
      capUsage.set('c-dale::dale-1', { used: 100, cap: 100, day: today });
      capUsage.set('c-dale::dale-2', { used: 20, cap: 100, day: today });

      // Agent dale-1 at cap on candidate 0 ('dale-byom') -> skips to 'api-model', keeps currentModel ('dale-byom'), ledgers MODEL_FAILOVER, opens NO window!
      await setRun('dale-1', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom', primaryModel: 'api-model', budgetUsd: { perDay: 5, perMonth: 50 } }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const skipRes = await ask();
      assert.equal(skipRes.status, 200, skipRes.text);
      assert.equal(skipRes.json().choices[0].message.content, 'from api');
      assert.equal(failoverCalls.length, 0, 'candidate 0 skipped by cap keeps currentModel unchanged');
      assert.equal(windows.windows.size, 0, 'per-agent cap never opens a connection-wide limit window');
      await settle();
      assert.ok(actions('MODEL_FAILOVER').some((e) => e.failoverReason === 'subscription_cap_reached'));

      // Agent dale-2 on the SAME connection is under cap -> served by c-dale!
      await setRun('dale-2', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom', primaryModel: 'api-model', budgetUsd: { perDay: 0, perMonth: 0 } }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const otherAgent = await ask();
      assert.equal(otherAgent.status, 200);
      assert.equal(otherAgent.json().choices[0].message.content, 'from vendor');

      // Mixed walk: candidate 0 ('api-bad') fails with 503 (non-skip), candidate 1 ('dale-byom') skips due to cap, candidate 2 ('api-model') serves -> persists modelFailover!
      await setRun('dale-1', policy({ models: ['api-bad', 'dale-byom', 'api-model'], currentModel: 'api-bad', primaryModel: 'dale-byom', secondaryModel: 'api-model', budgetUsd: { perDay: 5, perMonth: 50 } }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const mixed = await ask();
      assert.equal(mixed.status, 200);
      assert.equal(failoverCalls.length, 1, 'candidate 0 non-skip failure persists currentModel via modelFailover even when candidate 1 skipped at cap');
      assert.equal(failoverCalls[0].toModel, 'api-model');

      // Pinned to capped entry -> 429 subscription_cap_reached!
      await setRun('dale-1', policy({ models: ['dale-byom', 'api-model'], currentModel: 'dale-byom' }), { model: 'dale-byom' });
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const pinnedCap = await ask();
      assert.equal(pinnedCap.status, 429);
      assert.equal(pinnedCap.json().error, 'subscription_cap_reached');
    });

    it('M5(1): GET /models/v1/models surfaces subscription markers + connection display names and hides disallowed personal BYOM entries', async () => {
      // Personal agent owned by user:dale sees dale-byom with connectionName & displayLabel.
      await setRun('dale-1', policy({ models: ['dale-byom', 'grok-sub', 'api-model'], currentModel: 'dale-byom' }));
      ctx.agentKind = 'personal';
      ctx.activeOwnerPrincipalId = 'user:dale';
      const m1 = await call(port, '/models/v1/models', { token: runToken, method: 'GET' });
      assert.equal(m1.status, 200);
      const data1 = m1.json().data as any[];
      const daleEntry = data1.find((d) => d.id === 'dale-byom');
      assert.ok(daleEntry);
      assert.equal(daleEntry.credentialMode, 'subscription');
      assert.equal(daleEntry.subscription, true);
      assert.equal(daleEntry.scope, 'personal');
      assert.equal(daleEntry.connection, 'c-dale');
      assert.equal(daleEntry.connectionName, "Dale's Grok");
      assert.equal(daleEntry.displayLabel, "grok-4.6 · Dale's Grok");
      assert.equal(daleEntry.dailyTokenCap, 100);

      // Team agent does NOT see dale-byom in GET /models/v1/models even if stale policy listed it.
      ctx.agentKind = 'team';
      ctx.activeOwnerPrincipalId = undefined;
      const m2 = await call(port, '/models/v1/models', { token: runToken, method: 'GET' });
      assert.equal(m2.status, 200);
      const ids2 = (m2.json().data as any[]).map((d) => d.id);
      assert.equal(ids2.includes('dale-byom'), false);
      assert.equal(ids2.includes('grok-sub'), true);
    });
  });
});
