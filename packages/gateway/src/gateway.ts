import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import stream from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { RunTokens } from '@beercanlabs/factory-auth';
import { payloadHash, redactSecrets } from '@beercanlabs/factory-ledger';
import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { SseMeter, costUsd, priceFor, usageFromJson, type Price, type Provider, type Usage } from './meter.js';
import { writeTrace, type TraceConfig } from './traces.js';
import { ModelUpstreamError, defaultModelAdapters, parseChatRequest, type ChatResult, type ModelAdapter, type ModelCatalog } from './models.js';
import type { Meter } from '@opentelemetry/api';

export type Route = {
  id: string;
  /** `models` is the factory model API (§6.9): no fixed upstream; the model catalog routes each call. */
  kind: 'llm' | 'mcp' | 'http' | 'models';
  provider?: Provider;
  upstream?: string;
  credential?: { secret: string; header: string; format?: string };
  /**
   * Keymaster connection (§6.11 K3): the gateway asks the control plane for a current access token for
   * (agent, connection) and injects it as `Authorization: Bearer`. Never combined with `credential`.
   */
  connection?: string;
  /** Scopes to request for this route's connection (service-account connections; user grants use what was granted). */
  scopes?: string[];
};

export type ConnectionTokenResult =
  | { ok: true; accessToken: string; expiresAt: string }
  | { ok: false; status: number; error: string; provider?: string; connectUrl?: string };

export type ToolRule = { allow: string[] | '*'; requireApproval?: string[] };
export type Policy = {
  routes: string[];
  models?: string[];
  hosts?: string[];
  tools?: Record<string, ToolRule>;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  tokensPerMinute?: number;
};

export type RunContext = {
  run: { runId: string; agentId: string; state: string; live: boolean; model?: string };
  agentState: string;
  isBuiltin?: boolean;
  policy: Policy;
  spend: { run: number; day: number; month: number };
};

export type Approval = { approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'consumed' };

/** How the gateway talks to the control plane. HTTP in production, in-memory in tests. */
export type ControlClient = {
  runContext(runId: string): Promise<RunContext | null>;
  requestApproval(req: { runId: string; route: string; tool: string; argsSha256: string }): Promise<Approval>;
  consumeApproval(approvalId: string): Promise<boolean>;
  /** Keymaster access token for a live run's agent connection (§6.11). */
  connectionToken?(req: { runId: string; agentId: string; connection: string; scopes?: string[] }): Promise<ConnectionTokenResult>;
  ledger(event: Record<string, unknown>): Promise<void>;
  /** Circuit breaker: returns false when the ledger endpoint is known-unreachable. */
  ledgerAvailable?(): boolean;
};

export type GatewayOptions = {
  routes: Route[];
  prices: Record<string, Price>;
  runTokens: RunTokens;
  control: ControlClient;
  providers: SecretProvider[];
  traces?: TraceConfig;
  contextTtlMs?: number;
  maxBodyBytes?: number;
  meter?: Meter;
  /** Offered models for the `models` route (operations config, M3). */
  modelCatalog?: ModelCatalog;
  /** Adapters by catalog `provider`; defaults to the built-in ones. */
  modelAdapters?: Record<string, ModelAdapter>;
};

const BUILTIN_AGENT_IDS = new Set(['doorman', 'keymaster', 'doctor', 'coach']);

const STRIP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'x-api-key',
  'x-factory-run-token',
  'x-upstream-authorization',
  'accept-encoding',
  'cookie',
]);

function send(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Run token from `Authorization: Bearer`, `x-api-key` (Anthropic SDKs), `Proxy-Authorization: Bearer`,
 * `Proxy-Authorization: Basic` (password = token; what boto3/urllib send for `http://run:<token>@gw`), or `x-factory-run-token`.
 */
function presentedToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers;
  if (typeof h['x-factory-run-token'] === 'string') return h['x-factory-run-token'];
  if (typeof h['x-api-key'] === 'string') return h['x-api-key'];
  const proxyAuth = h['proxy-authorization'];
  if (typeof proxyAuth === 'string' && proxyAuth.startsWith('Bearer ')) return proxyAuth.slice(7).trim();
  if (typeof proxyAuth === 'string' && proxyAuth.startsWith('Basic ')) {
    const decoded = Buffer.from(proxyAuth.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    return sep >= 0 ? decoded.slice(sep + 1) : undefined;
  }
  const a = h.authorization;
  return a?.startsWith('Bearer ') ? a.slice(7).trim() : undefined;
}

function isHostAllowed(policy: Policy, routes: Map<string, Route>, destHost: string): boolean {
  const allowed = new Set(policy.hosts ?? []);
  for (const rId of policy.routes) {
    const r = routes.get(rId);
    // Connection routes are reachable only through the gateway's token injection, never as a raw tunnel host.
    if (r?.upstream && !r.connection) {
      try {
        allowed.add(new URL(r.upstream).hostname);
      } catch {}
    }
  }
  if (allowed.has('*') || allowed.has(destHost)) return true;
  for (const h of allowed) {
    if (h.startsWith('*.') && (destHost === h.slice(2) || destHost.endsWith('.' + h.slice(2)))) {
      return true;
    }
  }
  return false;
}

function tryJson(buf: Buffer): unknown {
  if (!buf.length) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

function overBudget(policy: Policy, spend: RunContext['spend']): string | undefined {
  const b = policy.budgetUsd;
  if (!b) return undefined;
  if (b.perRun !== undefined && spend.run >= b.perRun) return 'perRun';
  if (b.perDay !== undefined && spend.day >= b.perDay) return 'perDay';
  if (b.perMonth !== undefined && spend.month >= b.perMonth) return 'perMonth';
  return undefined;
}

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: unknown; arguments?: unknown } };

export function createGateway(opts: GatewayOptions): http.Server {
  for (const r of opts.routes) {
    if (r.connection && r.credential) throw new Error(`route ${r.id}: a connection route must not also carry a static credential`);
    if (r.connection && r.kind !== 'http') throw new Error(`route ${r.id}: connections are supported on http routes only`);
  }
  const routes = new Map(opts.routes.map((r) => [r.id, r]));
  const ttl = opts.contextTtlMs ?? 1000;
  const limit = opts.maxBodyBytes ?? 10 * 1024 * 1024;
  const ctxCache = new Map<string, { at: number; ctx: RunContext }>();
  /** Spend settled here whose ledger write the control plane has not yet acknowledged. */
  const unacked = new Map<string, number>();
  const tpm = new Map<string, { windowStart: number; tokens: number }>();
  const credCache = new Map<string, string>();
  /** Keymaster access tokens by agent × connection, until 60s before expiry. */
  const connCache = new Map<string, { token: string; expiresAtMs: number }>();
  const secretValues = new Set<string>();
  const modelAdapters = opts.modelAdapters ?? defaultModelAdapters();
  const m = opts.meter
    ? {
        requests: opts.meter.createCounter('factory.gateway.requests', { description: 'Egress requests by route and outcome' }),
        latency: opts.meter.createHistogram('factory.gateway.upstream.duration', { unit: 's' }),
        tokens: opts.meter.createCounter('factory.gateway.tokens', { description: 'Metered LLM tokens' }),
        cost: opts.meter.createCounter('factory.gateway.cost', { unit: 'USD' }),
      }
    : undefined;

  async function context(runId: string): Promise<RunContext | null> {
    const hit = ctxCache.get(runId);
    if (hit && Date.now() - hit.at < ttl) return hit.ctx;
    const ctx = await opts.control.runContext(runId);
    if (ctx) ctxCache.set(runId, { at: Date.now(), ctx });
    return ctx;
  }

  async function credential(route: Route, ctx?: RunContext): Promise<string | undefined> {
    if (!route.credential) return undefined;
    let name = route.credential.secret;
    if (ctx && (name.includes('{agent}') || name.includes('${agent}'))) {
      const agentVar = ctx.run.agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      name = name.replace(/\$\{agent\}|\{agent\}/gi, agentVar);
    }
    let value = credCache.get(name);
    if (!value) {
      const candidates = [
        name,
        name.toLowerCase(),
        name.toLowerCase().replace(/_/g, '-'),
        // A per-agent secret ({agent}_X) falls back to the shared X. Never to another route's secret: that would
        // send one service's credential to a different upstream.
        route.credential.secret.replace(/\$\{agent\}|\{agent\}[_-]?/gi, ''),
      ];
      for (const cand of candidates) {
        if (!cand) continue;
        const bound = await bindSecrets([cand], opts.providers);
        if (bound.ok && bound.env[cand]) {
          value = bound.env[cand];
          credCache.set(name, value);
          if (value.length >= 4) secretValues.add(value);
          break;
        }
      }
    }
    if (!value) return undefined;
    return (route.credential.format ?? '{}').replace('{}', value);
  }

  async function connectionToken(route: Route, ctx: RunContext): Promise<ConnectionTokenResult> {
    if (!opts.control.connectionToken) return { ok: false, status: 503, error: 'connections_unavailable' };
    const key = `${ctx.run.agentId}\u0000${route.connection}\u0000${(route.scopes ?? []).join(' ')}`;
    const hit = connCache.get(key);
    if (hit && hit.expiresAtMs - 60_000 > Date.now()) return { ok: true, accessToken: hit.token, expiresAt: new Date(hit.expiresAtMs).toISOString() };
    const r = await opts.control.connectionToken({
      runId: ctx.run.runId,
      agentId: ctx.run.agentId,
      connection: route.connection!,
      ...(route.scopes?.length ? { scopes: route.scopes } : {}),
    });
    if (r.ok) {
      if (r.accessToken.length >= 4) secretValues.add(r.accessToken);
      connCache.set(key, { token: r.accessToken, expiresAtMs: Date.parse(r.expiresAt) || Date.now() + 5 * 60_000 });
    }
    return r;
  }

  /** Forward an HTTP route call with the agent's Keymaster connection token injected (§6.11 K3/K4). */
  async function handleConnection(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    const host = route.upstream ? new URL(route.upstream).hostname : undefined;
    let tok: ConnectionTokenResult;
    try {
      tok = await connectionToken(route, ctx);
    } catch (err) {
      console.error(`[gateway] connection token ${route.id}: ${err instanceof Error ? err.message : String(err)}`);
      tok = { ok: false, status: 503, error: 'connection_unavailable' };
    }
    if (!tok.ok) {
      if (tok.error === 'needs_reconsent') {
        m?.requests.add(1, { route: route.id, outcome: 'needs_reconsent', agent: ctx.run.agentId });
        ledger(ctx, route, { type: 'action', action: 'CONNECTION_NEEDS_RECONSENT', connection: route.connection, provider: tok.provider, host });
        return send(res, 428, { error: 'needs_reconsent', provider: tok.provider, connectUrl: tok.connectUrl });
      }
      return deny(res, ctx, route, tok.status >= 400 && tok.status < 600 ? tok.status : 503, 'connection_unavailable', { connection: route.connection });
    }
    const status = await forward(req, res, route, rest, raw, `Bearer ${tok.accessToken}`);
    if (status === 401) {
      // The upstream rejected the token: drop it so the next call asks the Keymaster again.
      for (const k of connCache.keys()) if (k.startsWith(`${ctx.run.agentId}\u0000${route.connection}\u0000`)) connCache.delete(k);
    }
    ledger(ctx, route, { type: 'action', action: status === 401 ? 'RUNTIME_AUTH_FAILURE' : 'EGRESS', connection: route.connection, host, status });
  }

  /** Resolves true once the control plane has accepted the event. */
  function ledger(ctx: RunContext, route: Route, event: Record<string, unknown>): Promise<boolean> {
    return opts.control
      .ledger({
        agentId: ctx.run.agentId,
        runId: ctx.run.runId,
        actor: `run:${ctx.run.agentId}`,
        route: route.id,
        ...event,
      })
      .then(
        () => true,
        (err) => {
          console.error(`[gateway] ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        },
      );
  }

  function deny(res: http.ServerResponse, ctx: RunContext, route: Route, status: number, reason: string, extra: Record<string, unknown> = {}) {
    m?.requests.add(1, { route: route.id, outcome: reason, agent: ctx.run.agentId });
    ledger(ctx, route, { type: 'action', action: `EGRESS_DENIED_${reason.toUpperCase()}` });
    send(res, status, { error: reason, ...extra });
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route,
    rest: string,
    body: Buffer,
    authHeader: string | undefined,
    onResponse?: (status: number, isSse: boolean) => { chunk: (b: Buffer) => void },
  ): Promise<number> {
    const t0 = performance.now();
    const done = (status: number) => {
      m?.requests.add(1, { route: route.id, outcome: String(status) });
      m?.latency.record((performance.now() - t0) / 1000, { route: route.id });
    };
    return new Promise<number>((resolve) => {
      if (!route.upstream) {
        send(res, 500, { error: 'route_has_no_upstream' });
        resolve(500);
        return;
      }
      const base = new URL(route.upstream);
      // Build by string so `//host` in the path can never switch origin (and carry the credential elsewhere).
      const dest = new URL(base.origin + base.pathname.replace(/\/$/, '') + rest);
      if (dest.origin !== base.origin) {
        send(res, 400, { error: 'bad_path' });
        resolve(400);
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !STRIP.has(k.toLowerCase())) headers[k] = v;
      headers['accept-encoding'] = 'identity';
      if (body.length) headers['content-length'] = String(body.length);
      if (route.connection) {
        // §6.11: only the Keymaster's token goes upstream; the caller's credentials never do.
        if (authHeader) headers['authorization'] = authHeader;
      } else if (route.credential && authHeader) {
        headers[route.credential.header.toLowerCase()] = authHeader;
      } else if (req.headers['x-upstream-authorization']) {
        headers['authorization'] = req.headers['x-upstream-authorization'];
      } else if (req.headers['authorization'] && req.headers['x-factory-run-token']) {
        headers['authorization'] = req.headers['authorization'];
      }
      const transport = dest.protocol === 'https:' ? https : http;
      const up = transport.request(dest, { method: req.method, headers }, (upRes) => {
        const status = upRes.statusCode ?? 502;
        const outHeaders = { ...upRes.headers };
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        res.writeHead(status, outHeaders);
        const isSse = String(upRes.headers['content-type'] ?? '').includes('text/event-stream');
        const tap = onResponse?.(status, isSse);
        upRes.on('data', (c: Buffer) => {
          tap?.chunk(c);
          res.write(c);
        });
        upRes.on('end', () => {
          res.end();
          done(status);
          resolve(status);
        });
        upRes.on('error', () => {
          res.end();
          resolve(502);
        });
      });
      up.on('error', (err) => {
        console.error(`[gateway] upstream ${route.id}: ${err.message}`);
        send(res, 502, { error: 'upstream_unreachable' });
        resolve(502);
      });
      if (body.length) up.write(body);
      up.end();
    });
  }

  /** Policy gate on a model name (E4, E7): shared by provider routes and the factory model API. */
  function modelDenial(ctx: RunContext, model: string): [number, string, Record<string, unknown>] | undefined {
    const isTraining = ctx.agentState === 'TRAINING';
    if (!isTraining && ctx.policy.models && !ctx.policy.models.includes(model)) return [403, 'model_not_allowed', { model }];
    if (ctx.run.model && ctx.run.model !== model) return [403, 'model_pinned', { model, pinned: ctx.run.model }];
    return undefined;
  }

  function throttled(ctx: RunContext): boolean {
    const w = tpm.get(ctx.run.runId);
    return ctx.policy.tokensPerMinute !== undefined && !!w && Date.now() - w.windowStart < 60_000 && w.tokens >= ctx.policy.tokensPerMinute;
  }

  /** Meter, count against the budget, and ledger one model call (E5). Never records prompt bodies. */
  function recordUsage(
    ctx: RunContext,
    route: Route,
    call: { usage: Usage; model: string | undefined; price: Price | undefined; request: unknown; requestId: string; action?: string; extra?: Record<string, unknown> },
  ) {
    const { usage, model, price } = call;
    const cost = price ? costUsd(usage, price) : 0;
    const attrs = { route: route.id, model: usage.model ?? model ?? 'unknown', agent: ctx.run.agentId };
    m?.tokens.add(usage.input + usage.cacheRead + usage.cacheWrite, { ...attrs, direction: 'input' });
    m?.tokens.add(usage.output, { ...attrs, direction: 'output' });
    m?.cost.add(cost, attrs);
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const cur = tpm.get(ctx.run.runId);
    if (!cur || Date.now() - cur.windowStart >= 60_000) tpm.set(ctx.run.runId, { windowStart: Date.now(), tokens });
    else cur.tokens += tokens;
    const runId = ctx.run.runId;
    unacked.set(runId, (unacked.get(runId) ?? 0) + cost);
    void ledger(ctx, route, {
      type: 'llm',
      model: usage.model ?? model,
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      costUsd: cost,
      requestId: call.requestId,
      payloadSha256: payloadHash(call.request),
      ...(call.extra ?? {}),
      ...(call.action ? { action: call.action } : {}),
    }).then((accepted) => {
      // Until the control plane has counted it, this spend keeps counting against the budget here.
      if (!accepted) return;
      unacked.set(runId, (unacked.get(runId) ?? 0) - cost);
      ctxCache.delete(runId);
    });
  }

  async function handleLlm(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    const provider = route.provider ?? 'openai';
    const parsed = tryJson(raw) as Record<string, unknown> | undefined;
    const model = typeof parsed?.model === 'string' ? parsed.model : undefined;
    if (req.method === 'POST' && parsed) {
      if (!model) return deny(res, ctx, route, 400, 'model_required');
      const denial = modelDenial(ctx, model);
      if (denial) return deny(res, ctx, route, ...denial);
      if (!priceFor(opts.prices, model)) return deny(res, ctx, route, 403, 'unpriced_model', { model });
    }
    if (throttled(ctx)) return deny(res, ctx, route, 429, 'throttled');

    let body = raw;
    const streaming = parsed?.stream === true;
    if (streaming && provider === 'openai' && parsed && typeof parsed.input === 'undefined') {
      body = Buffer.from(JSON.stringify({ ...parsed, stream_options: { ...(parsed.stream_options as object), include_usage: true } }));
    }

    const cred = await credential(route, ctx);
    if (route.credential && !cred) return deny(res, ctx, route, 503, 'credential_unbound');
    const requestId = randomUUID();
    const price = priceFor(opts.prices, model);
    let jsonChunks: Buffer[] = [];
    let meter: SseMeter | undefined;

    const status = await forward(req, res, route, rest, body, cred, (_s, isSse) => {
      if (isSse) meter = new SseMeter(provider, opts.traces?.enabled ? 1_000_000 : 0);
      return { chunk: (c) => (meter ? meter.feed(c) : jsonChunks.push(c)) };
    });

    if (status === 401) {
      credCache.delete(route.credential?.secret ?? '');
      ledger(ctx, route, { type: 'action', action: 'RUNTIME_AUTH_FAILURE' });
      return;
    }
    if (req.method !== 'POST' || !parsed) return;

    const respBody = meter ? undefined : Buffer.concat(jsonChunks);
    jsonChunks = [];
    let usage: Usage | null = meter ? meter.result() : usageFromJson(provider, tryJson(respBody!));
    let action: string | undefined;
    if (!usage && status < 400) {
      // No usage reported: charge the worst case the request allowed rather than nothing.
      const maxOut = typeof parsed.max_tokens === 'number' ? parsed.max_tokens : typeof parsed.max_output_tokens === 'number' ? parsed.max_output_tokens : 4096;
      usage = { model, input: 0, output: maxOut, cacheRead: 0, cacheWrite: 0 };
      action = 'METERING_GAP';
    }
    if (!usage) return;
    recordUsage(ctx, route, { usage, model, price, request: parsed, requestId, action });
    if (opts.traces?.enabled) {
      writeTrace(
        { ...opts.traces, dir: `${opts.traces.dir}/${ctx.run.agentId}` },
        {
          timestamp: new Date().toISOString(),
          requestId,
          kind: 'llm',
          model,
          request: parsed,
          response: meter ? meter.raw : tryJson(respBody!),
        },
        secretValues,
      );
    }
  }

  /**
   * Factory model API (§6.9 M1): `POST /models/v1/chat/completions` in OpenAI Chat Completions format.
   * The catalog maps the neutral model name to a provider adapter; the gateway signs the upstream call
   * with its own credentials and never forwards the run token.
   */
  async function handleModels(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    const catalog = opts.modelCatalog ?? {};
    const path = rest.split('?')[0].replace(/\/$/, '');
    if (req.method === 'GET' && path === '/v1/models') {
      const offered = Object.keys(catalog).filter((name) => !modelDenial(ctx, name));
      return send(res, 200, { object: 'list', data: offered.map((id) => ({ id, object: 'model', owned_by: 'factory' })) });
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return send(res, 404, { error: 'unknown_endpoint' });

    const parsed = tryJson(raw) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return deny(res, ctx, route, 400, 'invalid_json');
    if (parsed.stream === true) return deny(res, ctx, route, 400, 'streaming_not_supported');
    const model = typeof parsed.model === 'string' ? parsed.model : undefined;
    if (!model) return deny(res, ctx, route, 400, 'model_required');
    const entry = Object.hasOwn(catalog, model) ? catalog[model] : undefined;
    if (!entry) return deny(res, ctx, route, 400, 'model_not_offered', { model });
    const denial = modelDenial(ctx, model);
    if (denial) return deny(res, ctx, route, ...denial);
    const price = entry.price ?? priceFor(opts.prices, model);
    if (!price) return deny(res, ctx, route, 403, 'unpriced_model', { model });
    if (throttled(ctx)) return deny(res, ctx, route, 429, 'throttled');
    const chat = parseChatRequest(parsed);
    if (!chat.ok) return deny(res, ctx, route, 400, chat.error);
    const adapter = Object.hasOwn(modelAdapters, entry.provider) ? modelAdapters[entry.provider] : undefined;
    if (!adapter) return deny(res, ctx, route, 503, 'provider_unavailable', { provider: entry.provider });

    const requestId = randomUUID();
    const t0 = performance.now();
    let result: ChatResult;
    try {
      result = await adapter.complete(entry, chat.req);
    } catch (err) {
      const e = err instanceof ModelUpstreamError ? err : new ModelUpstreamError(502, 'upstream_error', err instanceof Error ? err.message : String(err));
      m?.requests.add(1, { route: route.id, outcome: e.code, agent: ctx.run.agentId });
      console.error(`[gateway] models ${model} via ${entry.provider}: ${e.code} ${e.upstreamStatus ?? ''} ${e.message}`);
      ledger(ctx, route, { type: 'action', action: 'MODEL_UPSTREAM_ERROR', model, provider: entry.provider, upstreamStatus: e.upstreamStatus, requestId });
      return send(res, e.status, { error: e.code, message: redactSecrets(e.message, secretValues), ...(e.upstreamStatus ? { upstreamStatus: e.upstreamStatus } : {}) });
    }
    m?.requests.add(1, { route: route.id, outcome: '200' });
    m?.latency.record((performance.now() - t0) / 1000, { route: route.id });

    let usage: Usage;
    let action: string | undefined;
    if (result.usage) usage = { model, input: result.usage.input, output: result.usage.output, cacheRead: 0, cacheWrite: 0 };
    else {
      // No usage reported: charge the worst case the request allowed rather than nothing.
      usage = { model, input: 0, output: chat.req.maxTokens ?? 4096, cacheRead: 0, cacheWrite: 0 };
      action = 'METERING_GAP';
    }
    recordUsage(ctx, route, { usage, model, price, request: parsed, requestId, action, extra: { provider: entry.provider, upstreamModel: entry.id } });

    const body = {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: result.finishReason }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    };
    send(res, 200, body);
    if (opts.traces?.enabled) {
      writeTrace(
        { ...opts.traces, dir: `${opts.traces.dir}/${ctx.run.agentId}` },
        { timestamp: new Date().toISOString(), requestId, kind: 'llm', model, request: parsed, response: body },
        secretValues,
      );
    }
  }

  async function checkTool(ctx: RunContext, route: Route, call: JsonRpc): Promise<{ ok: true; consume?: string } | { ok: false; code: number; message: string; data?: unknown }> {
    const tool = typeof call.params?.name === 'string' ? call.params.name : '';
    const rule = ctx.policy.tools?.[route.id];
    if (!rule || (rule.allow !== '*' && !rule.allow.includes(tool))) {
      ledger(ctx, route, { type: 'mcp', mcpMethod: 'tools/call', mcpName: tool, action: 'TOOL_DENIED' });
      return { ok: false, code: -32001, message: `tool not allowed: ${tool}` };
    }
    if (!rule.requireApproval?.includes(tool)) return { ok: true };
    const argsSha256 = payloadHash(call.params?.arguments ?? {});
    const approval = await opts.control.requestApproval({ runId: ctx.run.runId, route: route.id, tool, argsSha256 });
    if (approval.state === 'approved') return { ok: true, consume: approval.approvalId };
    if (approval.state === 'rejected') return { ok: false, code: -32002, message: `tool call rejected by approver: ${tool}`, data: { approvalId: approval.approvalId } };
    ledger(ctx, route, { type: 'mcp', mcpMethod: 'tools/call', mcpName: tool, action: 'TOOL_APPROVAL_REQUIRED', approvalId: approval.approvalId });
    ctxCache.delete(ctx.run.runId);
    return {
      ok: false,
      code: -32003,
      message: `approval required for ${tool}; retry the same call after approval`,
      data: { approvalId: approval.approvalId },
    };
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    const parsed = tryJson(raw) as JsonRpc | JsonRpc[] | undefined;
    const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const toolCalls = calls.filter((c) => c && c.method === 'tools/call');
    const decisions = await Promise.all(toolCalls.map((c) => checkTool(ctx, route, c)));
    const blocked = decisions.some((d) => !d.ok);
    if (blocked) {
      const errors = calls.map((c) => {
        const i = toolCalls.indexOf(c);
        const d = i >= 0 ? decisions[i] : undefined;
        const err = d && !d.ok ? { code: d.code, message: d.message, data: d.data } : { code: -32004, message: 'batch rejected: another call in this batch was not allowed' };
        return { jsonrpc: '2.0', id: c?.id ?? null, error: err };
      });
      return send(res, 200, Array.isArray(parsed) ? errors : errors[0]);
    }
    for (const d of decisions) {
      if (d.ok && d.consume && !(await opts.control.consumeApproval(d.consume))) {
        return send(res, 200, { jsonrpc: '2.0', id: (parsed as JsonRpc)?.id ?? null, error: { code: -32003, message: 'approval already used' } });
      }
    }
    const cred = await credential(route, ctx);
    if (route.credential && !cred) return deny(res, ctx, route, 503, 'credential_unbound');
    const status = await forward(req, res, route, rest, raw, cred);
    if (status === 401) {
      credCache.delete(route.credential?.secret ?? '');
      ledger(ctx, route, { type: 'action', action: 'RUNTIME_AUTH_FAILURE' });
    }
    for (const c of calls) {
      if (!c?.method) continue;
      ledger(ctx, route, {
        type: 'mcp',
        mcpMethod: c.method,
        mcpName: typeof c.params?.name === 'string' ? c.params.name : undefined,
        action: c.method === 'tools/call' ? 'TOOL_CALL' : undefined,
        payloadSha256: payloadHash(c.params ?? {}),
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (url === '/healthz') return send(res, 200, { status: 'ok', routes: [...routes.keys()] });

      // Circuit breaker: refuse to proxy if the ledger is unreachable.
      // Agents must not egress without an audit trail.
      if (opts.control.ledgerAvailable?.() === false) {
        return send(res, 503, { error: 'ledger_unavailable' });
      }

      // Forward HTTP proxy support (e.g. GET http://api.notion.com/v1/users)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const parsed = new URL(url);
        const claims = await opts.runTokens.verify(presentedToken(req));
        if (!claims) return send(res, 401, { error: 'invalid_run_token' });
        const ctx = await context(claims.runId);
        if (!ctx || ctx.run.agentId !== claims.agentId || !ctx.run.live) return send(res, 401, { error: 'run_not_live' });
        if (ctx.agentState === 'ISOLATED') return send(res, 403, { error: 'isolated' });
        if (ctx.agentState === 'PAUSED') return send(res, 503, { error: 'paused' });
        if (ctx.run.state === 'BLOCKED_UNHEALTHY') return send(res, 503, { error: 'unhealthy' });

        if (!isHostAllowed(ctx.policy, routes, parsed.hostname)) {
          void opts.control.ledger({
            agentId: ctx.run.agentId,
            runId: ctx.run.runId,
            actor: `run:${ctx.run.agentId}`,
            type: 'action',
            action: `EGRESS_DENIED_HOST_${parsed.hostname}`,
          }).catch(() => {});
          return send(res, 403, { error: 'host_not_allowed', host: parsed.hostname });
        }

        const raw = await readBody(req, limit);
        const routeStub: Route = { id: `proxy-${parsed.hostname}`, kind: 'http', upstream: `${parsed.protocol}//${parsed.host}` };
        const status = await forward(req, res, routeStub, parsed.pathname + parsed.search, raw, undefined);
        void opts.control.ledger({
          agentId: ctx.run.agentId,
          runId: ctx.run.runId,
          actor: `run:${ctx.run.agentId}`,
          type: 'action',
          action: status === 401 ? 'RUNTIME_AUTH_FAILURE' : 'EGRESS_PROXY',
          host: parsed.hostname,
        }).catch(() => {});
        return;
      }

      const m = url.match(/^\/([A-Za-z0-9_.-]+)(\/.*)?$/);
      const route = m ? routes.get(m[1]) : undefined;
      if (!route) return send(res, 404, { error: 'unknown_route' });
      const rest = m![2] ?? '/';

      const claims = await opts.runTokens.verify(presentedToken(req));
      if (!claims) return send(res, 401, { error: 'invalid_run_token' });
      const ctx = await context(claims.runId);
      if (!ctx || ctx.run.agentId !== claims.agentId || !ctx.run.live) return send(res, 401, { error: 'run_not_live' });

      if (ctx.agentState === 'ISOLATED') return deny(res, ctx, route, 403, 'isolated');
      if (ctx.agentState === 'PAUSED') return deny(res, ctx, route, 503, 'paused');
      if (ctx.run.state === 'BLOCKED_UNHEALTHY') return deny(res, ctx, route, 503, 'unhealthy');
      if (!ctx.policy.routes.includes(route.id)) return deny(res, ctx, route, 403, 'route_not_allowed', { route: route.id });
      const isBuiltin = Boolean(ctx.isBuiltin || BUILTIN_AGENT_IDS.has(ctx.run.agentId));
      if ((route.kind === 'llm' || route.kind === 'models') && !isBuiltin) {
        const pending = unacked.get(ctx.run.runId) ?? 0;
        const spend = { run: ctx.spend.run + pending, day: ctx.spend.day + pending, month: ctx.spend.month + pending };
        const window = ctx.run.state === 'BLOCKED_BUDGET_EXCEEDED' ? 'blocked' : overBudget(ctx.policy, spend);
        if (window) return deny(res, ctx, route, 402, 'budget_exceeded', { window });
      }

      const raw = await readBody(req, limit);
      if (route.kind === 'llm') return await handleLlm(req, res, ctx, route, rest, raw);
      if (route.kind === 'models') return await handleModels(req, res, ctx, route, rest, raw);
      if (route.kind === 'mcp') return await handleMcp(req, res, ctx, route, rest, raw);
      if (route.connection) return await handleConnection(req, res, ctx, route, rest, raw);
      const cred = await credential(route, ctx);
      if (route.credential && !cred) return deny(res, ctx, route, 503, 'credential_unbound');
      const status = await forward(req, res, route, rest, raw, cred);
      ledger(ctx, route, { type: 'action', action: status === 401 ? 'RUNTIME_AUTH_FAILURE' : 'EGRESS' });
      if (status === 401) credCache.delete(route.credential?.secret ?? '');
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      send(res, status, { error: redactSecrets(err instanceof Error ? err.message : String(err), secretValues) });
    }
  });

  server.on('connect', async (req: http.IncomingMessage, clientSocket: stream.Duplex, head: Buffer) => {
    try {
      // Circuit breaker: refuse tunnels if the ledger is unreachable.
      if (opts.control.ledgerAvailable?.() === false) {
        clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const token = presentedToken(req);
      const claims = await opts.runTokens.verify(token);
      if (!claims) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      const ctx = await context(claims.runId);
      if (!ctx || ctx.run.agentId !== claims.agentId || !ctx.run.live) {
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      if (ctx.agentState === 'ISOLATED' || ctx.agentState === 'PAUSED' || ctx.run.state === 'BLOCKED_UNHEALTHY') {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const [destHost, portStr] = (req.url ?? '').split(':');
      const destPort = parseInt(portStr || '443', 10);
      if (!destHost || isNaN(destPort)) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      if (!isHostAllowed(ctx.policy, routes, destHost)) {
        void opts.control.ledger({
          agentId: ctx.run.agentId,
          runId: ctx.run.runId,
          actor: `run:${ctx.run.agentId}`,
          type: 'action',
          action: `EGRESS_DENIED_HOST_${destHost}`,
        }).catch(() => {});
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const upstreamSocket = net.connect(destPort, destHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        void opts.control.ledger({
          agentId: ctx.run.agentId,
          runId: ctx.run.runId,
          actor: `run:${ctx.run.agentId}`,
          type: 'action',
          action: 'EGRESS_TUNNEL',
          host: destHost,
          port: destPort,
        }).catch(() => {});
      });

      upstreamSocket.on('error', (err) => {
        console.warn(`[gateway] connect error to ${destHost}:${destPort}: ${err.message}`);
        clientSocket.destroy();
      });
      clientSocket.on('error', () => {
        upstreamSocket.destroy();
      });
    } catch {
      clientSocket.destroy();
    }
  });

  return server;
}
