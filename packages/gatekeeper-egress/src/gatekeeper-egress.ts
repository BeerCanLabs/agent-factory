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
import { ModelUpstreamError, defaultModelAdapters, parseChatRequest, type CatalogEntry, type ChatResult, type ModelAdapter, type ModelCatalog } from './models.js';
import type { Meter } from '@opentelemetry/api';

/** The factory's default model when a policy names none (M2): Claude Haiku 4.5, unless operations configure another. */
export const DEFAULT_MODEL = 'claude-haiku-4-5';
import { stripSignInLinksFromJson } from './signin-links.js';
import { ProgressCall, ProgressEmitter, type ProgressEvent, type ProgressOptions } from './progress.js';

export type Route = {
  id: string;
  system?: string;
  /** `models` is the factory model API (§6.9): no fixed upstream; the model catalog routes each call. */
  kind: 'llm' | 'mcp' | 'http' | 'models';
  provider?: Provider;
  upstream?: string;
  /**
   * `{agent}` in `secret` expands to the calling agent (`CASTLE_GITHUB_TOKEN` for castle). `fallback: false` means
   * the per-agent secret is the only candidate: an agent without its own gets `credential_unbound`, never the
   * shared unprefixed secret. Omitted (the default) keeps the shared fallback (discord).
   */
  credential?: { secret: string; header: string; format?: string; fallback?: boolean };
  /**
   * Keymaster connection (§6.11 K3): the gatekeeper-egress asks the control plane for a current access token for
   * (agent, connection) and injects it as `Authorization: Bearer`. Never combined with `credential`.
   */
  connection?: string;
  /** Scopes to request for this route's connection (service-account connections; user grants use what was granted). */
  scopes?: string[];
  /**
   * E9: requests that act in a person's name. A request with one of these methods is held for an approver, never
   * forwarded on first sight; the identical request is released once after approval. Operations config, not policy.
   * `preview` tells the console how to render the held copy (e.g. `linkedin-post`).
   */
  hold?: { methods: string[]; preview?: string };
  /**
   * K4 (GAP-067): a message route (e.g. `discord`). Sign-in or authorization URLs in a JSON body that do not point at
   * the factory's public host are replaced before forwarding, so no agent can send a person to sign in elsewhere.
   */
  stripSignInLinks?: boolean;
};

/** E9: what the gatekeeper-egress sends the control plane about a held request (the credential is never part of it). */
export type HoldRequest = {
  runId: string;
  route: string;
  argsSha256: string;
  request: { method: string; path: string; headers: Record<string, string>; body: string; bodyEncoding: 'utf8' | 'base64'; preview?: string };
};
export type HoldOutcome = { approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'consumed'; notes?: string };

/**
 * E9: the request headers that change what a held request does, so they are part of the reviewed copy and its hash
 * (an approved body cannot be re-sent as another operation). Everything else is transport.
 */
export const HELD_HEADERS = ['content-type', 'x-restli-method', 'x-http-method-override', 'x-http-method', 'x-method-override', 'linkedin-version'];
/** E9: the largest request the gatekeeper-egress will hold for review. */
export const HELD_BODY_LIMIT = 192 * 1024;

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

/** How the gatekeeper-egress talks to the control plane. HTTP in production, in-memory in tests. */
export type ControlClient = {
  runContext(runId: string): Promise<RunContext | null>;
  requestApproval(req: { runId: string; route: string; tool: string; argsSha256: string }): Promise<Approval>;
  consumeApproval(approvalId: string): Promise<boolean>;
  /** E9: hold a request for review, or find the hold for the identical request. Absent: held routes refuse every hold. */
  holdRequest?(req: HoldRequest): Promise<HoldOutcome>;
  /** Keymaster access token for a live run's agent connection (§6.11). */
  connectionToken?(req: { runId: string; agentId: string; connection: string; scopes?: string[] }): Promise<ConnectionTokenResult>;
  ledger(event: Record<string, unknown>): Promise<void>;
  /** Circuit breaker: returns false when the ledger endpoint is known-unreachable. */
  ledgerAvailable?(): boolean;
  /**
   * Run progress (§6.5): a batch of call start/end events. Best effort: called off the request path, failures are
   * logged and the batch dropped. Absent: no progress is reported.
   */
  progress?(events: ProgressEvent[]): Promise<void>;
  /** E10: resolve non-model routes from the factory. Cached, refreshed on change, no redeploy. */
  systemRoutes?(): Promise<Route[]>;
  /** M3: resolve model offering from the factory. Cached, refreshed on change, no redeploy. */
  models?(): Promise<{ catalog?: ModelCatalog; default?: string } | ModelCatalog>;
};


export type GatekeeperEgressOptions = {
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
  /**
   * The model an agent gets when its policy names none (M2, E7): operations config, default `claude-haiku-4-5`. A policy
   * with no `models` grants exactly this model, never every model.
   */
  defaultModel?: string;
  /** Adapters by catalog `provider`; defaults to the built-in ones. */
  modelAdapters?: Record<string, ModelAdapter>;
  /** The factory's public URL (K4): the only host a sign-in link in a message may point at. */
  factoryPublicUrl?: string;
  /** Batching for run progress events (defaults: every 250 ms, 50 per batch, at most 1000 queued). */
  progress?: ProgressOptions;
  /** How often to refresh routes from control plane (ms); default 10_000. */
  routeRefreshIntervalMs?: number;
  /** How often to refresh models from control plane (ms); default 10_000. */
  modelRefreshIntervalMs?: number;
};


const BUILTIN_AGENT_IDS = new Set(['gatekeeper-ingress', 'keymaster', 'doctor', 'coach']);

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

const isText = (contentType: string | undefined) => !contentType || /^(text\/|application\/(json|x-www-form-urlencoded|[\w.+-]*\+json))/i.test(contentType);

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
    // Connection routes are reachable only through the gatekeeper-egress's token injection, never as a raw tunnel host.
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

export function createGatekeeperEgress(opts: GatekeeperEgressOptions): http.Server {
  for (const r of opts.routes) {
    if (r.connection && r.credential) throw new Error(`route ${r.id}: a connection route must not also carry a static credential`);
    if (r.connection && r.kind !== 'http') throw new Error(`route ${r.id}: connections are supported on http routes only`);
  }
  const routes = new Map(opts.routes.map((r) => [r.id, r]));
  let lastRouteRefresh = 0;
  const ROUTE_REFRESH_INTERVAL_MS = opts.routeRefreshIntervalMs ?? 10_000;

  async function ensureRoutes(targetRouteId?: string): Promise<void> {
    if (!opts.control.systemRoutes) return;
    const now = Date.now();
    const needsRefresh = (targetRouteId && !routes.has(targetRouteId)) || now - lastRouteRefresh > ROUTE_REFRESH_INTERVAL_MS;
    if (!needsRefresh) return;
    try {
      const remote = await opts.control.systemRoutes();
      if (Array.isArray(remote)) {
        for (const r of remote) {
          routes.set(r.id, r);
        }
        lastRouteRefresh = Date.now();
      }
    } catch {}
  }

  const models = new Map<string, CatalogEntry>(Object.entries(opts.modelCatalog ?? {}));
  let lastModelRefresh = 0;
  const MODEL_REFRESH_INTERVAL_MS = opts.modelRefreshIntervalMs ?? 10_000;

  async function ensureModels(targetModelName?: string): Promise<void> {
    if (!opts.control.models) return;
    const now = Date.now();
    const needsRefresh = (targetModelName && !models.has(targetModelName)) || now - lastModelRefresh > MODEL_REFRESH_INTERVAL_MS;
    if (!needsRefresh) return;
    try {
      const remote = await opts.control.models();
      const catalog = remote && typeof remote === 'object' && 'catalog' in remote ? remote.catalog : remote;
      if (catalog && typeof catalog === 'object') {
        for (const [name, entry] of Object.entries(catalog)) {
          if (entry && typeof entry === 'object') {
            models.set(name, entry as CatalogEntry);
          }
        }
        lastModelRefresh = Date.now();
      }
    } catch {}
  }

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
  const progress = opts.control.progress ? new ProgressEmitter((events) => opts.control.progress!(events), opts.progress) : undefined;
  /** The progress record of the call each response answers (§6.5). */
  const calls = new WeakMap<http.ServerResponse, ProgressCall>();

  /** Report this call's start now (or when its model is known) and its end when the response finishes. */
  function track(res: http.ServerResponse, ctx: RunContext, routeId: string): ProgressCall | undefined {
    if (!progress) return undefined;
    const call = new ProgressCall(progress, ctx.run.runId, ctx.run.agentId, routeId);
    calls.set(res, call);
    res.once('finish', () => call.end(res.statusCode));
    res.once('close', () => {
      // Closed before the response finished: the caller went away or the upstream broke mid-stream.
      if (!res.writableFinished) call.outcome ??= 'error';
      call.end(res.statusCode);
    });
    return call;
  }

  function markOutcome(res: http.ServerResponse, outcome: 'denied' | 'timeout' | 'error') {
    const call = calls.get(res);
    if (call && !call.outcome) call.outcome = outcome;
  }
  const m = opts.meter
    ? {
        requests: opts.meter.createCounter('factory.gatekeeper-egress.requests', { description: 'Egress requests by route and outcome' }),
        latency: opts.meter.createHistogram('factory.gatekeeper-egress.upstream.duration', { unit: 's' }),
        tokens: opts.meter.createCounter('factory.gatekeeper-egress.tokens', { description: 'Metered LLM tokens' }),
        cost: opts.meter.createCounter('factory.gatekeeper-egress.cost', { unit: 'USD' }),
      }
    : undefined;

  async function context(runId: string): Promise<RunContext | null> {
    const hit = ctxCache.get(runId);
    if (hit && Date.now() - hit.at < ttl) return hit.ctx;
    const ctx = await opts.control.runContext(runId);
    if (ctx) ctxCache.set(runId, { at: Date.now(), ctx });
    return ctx;
  }

  function credentialSecretName(route: Route, ctx?: RunContext): string {
    if (!route.credential) return '';
    let name = route.credential.secret;
    if (ctx && (name.includes('{agent}') || name.includes('${agent}'))) {
      const agentVar = ctx.run.agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      name = name.replace(/\$\{agent\}|\{agent\}/gi, agentVar);
    }
    return name;
  }

  function evictCredential(route: Route, ctx?: RunContext) {
    if (!route.credential) return;
    const name = credentialSecretName(route, ctx);
    if (name) credCache.delete(name);
    credCache.delete(route.credential.secret);
    if (ctx) {
      const agentId = ctx.run.agentId.toLowerCase();
      const system = (route.system ?? route.id).toLowerCase();
      const stripped = route.credential.secret.replace(/\$\{agent\}|\{agent\}[_-]?/gi, '');
      for (const k of [
        `agents/${agentId}/${system}/${stripped.toLowerCase()}`,
        `agents/${agentId}/${system}/${stripped}`,
        `agents/${agentId}/${system}/token`,
        `agents/${agentId}/${system}/api_key`,
        `shared/${system}/${stripped.toLowerCase()}`,
        `shared/${system}/${stripped}`,
        `shared/${system}/token`,
        `shared/${system}/api_key`,
      ]) {
        credCache.delete(k);
      }
    }
  }

  async function credential(route: Route, ctx?: RunContext): Promise<string | undefined> {
    if (!route.credential) return undefined;
    const name = credentialSecretName(route, ctx);
    let value = credCache.get(name);
    if (!value) {
      const system = (route.system ?? route.id).toLowerCase();
      const keymasterCandidates: string[] = [];
      const stripped = route.credential.secret.replace(/\$\{agent\}|\{agent\}[_-]?/gi, '');
      const cleanName = stripped.toLowerCase();
      if (ctx) {
        const agentId = ctx.run.agentId.toLowerCase();
        keymasterCandidates.push(
          `agents/${agentId}/${system}/${cleanName}`,
          `agents/${agentId}/${system}/${stripped}`,
          `agents/${agentId}/${system}/token`,
          `agents/${agentId}/${system}/api_key`,
          `agents/${agentId}/${system}/api_token`,
          `agents/${agentId}/${system}/bot_token`,
        );
      }
      keymasterCandidates.push(
        `shared/${system}/${cleanName}`,
        `shared/${system}/${stripped}`,
        `shared/${system}/token`,
        `shared/${system}/api_key`,
        `shared/${system}/api_token`,
      );
      const candidates = [
        name,
        ...keymasterCandidates,
        name.toLowerCase(),
        name.toLowerCase().replace(/_/g, '-'),
        // A per-agent secret ({agent}_X) falls back to the shared X. Never to another route's secret: that would
        // send one service's credential to a different upstream.
        ...(route.credential.fallback === false ? [] : [stripped]),
      ];
      for (const cand of candidates) {
        if (!cand) continue;
        const bound = await bindSecrets([cand], opts.providers);
        if (bound.ok && bound.env[cand]) {
          value = bound.env[cand];
          credCache.set(name, value);
          credCache.set(cand, value);
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
      console.error(`[gatekeeper-egress] connection token ${route.id}: ${err instanceof Error ? err.message : String(err)}`);
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
          console.error(`[gatekeeper-egress] ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        },
      );
  }

  function deny(res: http.ServerResponse, ctx: RunContext, route: Route, status: number, reason: string, extra: Record<string, unknown> = {}) {
    markOutcome(res, 'denied');
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
        const code = (err as NodeJS.ErrnoException).code ?? '';
        markOutcome(res, code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed? ?out/i.test(err.message) ? 'timeout' : 'error');
        console.error(`[gatekeeper-egress] upstream ${route.id}: ${err.message}`);
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
    const allowed = ctx.policy.models ?? [opts.defaultModel ?? DEFAULT_MODEL];
    if (!isTraining && !allowed.includes(model)) return [403, 'model_not_allowed', { model }];
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
    calls.get(res)?.start(model);
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
      evictCredential(route, ctx);
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
   * The catalog maps the neutral model name to a provider adapter; the gatekeeper-egress signs the upstream call
   * with its own credentials and never forwards the run token.
   */
  async function handleModels(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    await ensureModels();
    const catalog: ModelCatalog = Object.fromEntries(models.entries());
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
    calls.get(res)?.start(model);
    if (!model) return deny(res, ctx, route, 400, 'model_required');
    if (!models.has(model)) {
      await ensureModels(model);
    }
    const entry = models.get(model);
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
      markOutcome(res, /timeout|timed out/i.test(`${e.code} ${e.message}`) ? 'timeout' : 'error');
      m?.requests.add(1, { route: route.id, outcome: e.code, agent: ctx.run.agentId });
      console.error(`[gatekeeper-egress] models ${model} via ${entry.provider}: ${e.code} ${e.upstreamStatus ?? ''} ${e.message}`);
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

  /**
   * E9: hold a request made in a person's name, or release the identical request once it is approved. Returns true when
   * it answered the request itself (held, refused); false means approved and consumed: forward it now.
   */
  async function holdOrRelease(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!opts.control.holdRequest) return deny(res, ctx, route, 503, 'hold_unavailable'), true;
    if (raw.length > HELD_BODY_LIMIT) return deny(res, ctx, route, 413, 'held_request_too_large', { limit: HELD_BODY_LIMIT }), true;
    const headers: Record<string, string> = {};
    for (const h of HELD_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const text = isText(headers['content-type']) && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw);
    const body = text ? raw.toString('utf8') : raw.toString('base64');
    const argsSha256 = payloadHash({ method, path: rest, headers, body: raw.toString('base64') });
    let held: HoldOutcome;
    try {
      held = await opts.control.holdRequest({
        runId: ctx.run.runId,
        route: route.id,
        argsSha256,
        request: { method, path: rest, headers, body, bodyEncoding: text ? 'utf8' : 'base64', ...(route.hold?.preview ? { preview: route.hold.preview } : {}) },
      });
    } catch (err) {
      console.error(`[gatekeeper-egress] hold ${route.id}: ${err instanceof Error ? err.message : String(err)}`);
      return deny(res, ctx, route, 503, 'hold_unavailable'), true;
    }
    if (held.state === 'approved') {
      if (!(await opts.control.consumeApproval(held.approvalId))) return deny(res, ctx, route, 409, 'approval_already_used', { approvalId: held.approvalId }), true;
      ledger(ctx, route, { type: 'action', action: 'HELD_REQUEST_RELEASED', approvalId: held.approvalId, payloadSha256: argsSha256 });
      return false;
    }
    if (held.state === 'rejected') {
      markOutcome(res, 'denied');
      ledger(ctx, route, { type: 'action', action: 'HELD_REQUEST_REJECTED', approvalId: held.approvalId, payloadSha256: argsSha256 });
      send(res, 403, { error: 'rejected_by_approver', approvalId: held.approvalId, ...(held.notes ? { notes: held.notes } : {}) });
      return true;
    }
    ledger(ctx, route, { type: 'action', action: 'HELD_FOR_APPROVAL', approvalId: held.approvalId, payloadSha256: argsSha256 });
    send(res, 202, {
      status: 'held',
      approvalId: held.approvalId,
      message: 'Held for approval (E9): nothing was sent. The decision arrives in your mailbox or as a new run; once approved, send the identical request again to release it.',
    });
    return true;
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
      evictCredential(route, ctx);
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
      if (url === '/healthz') {
        if (opts.control.systemRoutes && Date.now() - lastRouteRefresh > ROUTE_REFRESH_INTERVAL_MS) {
          await ensureRoutes();
        }
        return send(res, 200, { status: 'ok', routes: [...routes.keys()] });
      }

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
        const proxyCall = track(res, ctx, `proxy-${parsed.hostname}`);
        proxyCall?.start();
        if (ctx.agentState === 'ISOLATED' || ctx.agentState === 'PAUSED' || ctx.run.state === 'BLOCKED_UNHEALTHY') markOutcome(res, 'denied');
        if (ctx.agentState === 'ISOLATED') return send(res, 403, { error: 'isolated' });
        if (ctx.agentState === 'PAUSED') return send(res, 503, { error: 'paused' });
        if (ctx.run.state === 'BLOCKED_UNHEALTHY') return send(res, 503, { error: 'unhealthy' });

        if (opts.control.systemRoutes && Date.now() - lastRouteRefresh > ROUTE_REFRESH_INTERVAL_MS) {
          await ensureRoutes();
        }

        if (!isHostAllowed(ctx.policy, routes, parsed.hostname)) {
          markOutcome(res, 'denied');
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
      if (m && !routes.has(m[1]) && opts.control.systemRoutes) {
        await ensureRoutes(m[1]);
      } else if (opts.control.systemRoutes && Date.now() - lastRouteRefresh > ROUTE_REFRESH_INTERVAL_MS) {
        void ensureRoutes();
      }
      const route = m ? routes.get(m[1]) : undefined;
      if (!route) return send(res, 404, { error: 'unknown_route' });

      const rest = m![2] ?? '/';

      const claims = await opts.runTokens.verify(presentedToken(req));
      if (!claims) return send(res, 401, { error: 'invalid_run_token' });
      const ctx = await context(claims.runId);
      if (!ctx || ctx.run.agentId !== claims.agentId || !ctx.run.live) return send(res, 401, { error: 'run_not_live' });
      // Attributed to the run only once its token is verified and live (E2): nobody else can write into its progress.
      const call = track(res, ctx, route.id);

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

      let raw = await readBody(req, limit);
      if (route.stripSignInLinks && raw.length && /json/i.test(String(req.headers['content-type'] ?? ''))) {
        const parsed = tryJson(raw);
        if (parsed !== undefined) {
          const r = stripSignInLinksFromJson(parsed, opts.factoryPublicUrl);
          if (r.removed) {
            raw = Buffer.from(JSON.stringify(r.value));
            // Never the URLs themselves: only that links were removed, and how many.
            ledger(ctx, route, { type: 'action', action: 'SIGN_IN_LINK_REMOVED', count: r.removed });
          }
        }
      }
      // Model routes report their start once the model is known (handleLlm, handleModels).
      if (route.kind !== 'llm' && route.kind !== 'models') call?.start();
      if (route.kind === 'llm') return await handleLlm(req, res, ctx, route, rest, raw);
      if (route.kind === 'models') return await handleModels(req, res, ctx, route, rest, raw);
      if (route.kind === 'mcp') return await handleMcp(req, res, ctx, route, rest, raw);
      if (route.hold?.methods.some((h) => h.toUpperCase() === (req.method ?? 'GET').toUpperCase()) && (await holdOrRelease(req, res, ctx, route, rest, raw))) return;
      if (route.connection) return await handleConnection(req, res, ctx, route, rest, raw);
      const cred = await credential(route, ctx);
      if (route.credential && !cred) return deny(res, ctx, route, 503, 'credential_unbound');
      const status = await forward(req, res, route, rest, raw, cred);
      ledger(ctx, route, { type: 'action', action: status === 401 ? 'RUNTIME_AUTH_FAILURE' : 'EGRESS' });
      if (status === 401) evictCredential(route, ctx);
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
      const [destHost, portStr] = (req.url ?? '').split(':');
      const destPort = parseInt(portStr || '443', 10);
      const tunnel = progress && destHost ? new ProgressCall(progress, ctx.run.runId, ctx.run.agentId, `tunnel-${destHost}`) : undefined;
      tunnel?.start();
      const refuse = (line: string, status: number) => {
        if (tunnel) tunnel.outcome = 'denied';
        tunnel?.end(status);
        clientSocket.write(`HTTP/1.1 ${line}\r\n\r\n`);
        clientSocket.destroy();
      };
      if (ctx.agentState === 'ISOLATED' || ctx.agentState === 'PAUSED' || ctx.run.state === 'BLOCKED_UNHEALTHY') return refuse('403 Forbidden', 403);

      if (!destHost || isNaN(destPort)) return refuse('400 Bad Request', 400);

      if (opts.control.systemRoutes && Date.now() - lastRouteRefresh > ROUTE_REFRESH_INTERVAL_MS) {
        await ensureRoutes();
      }

      if (!isHostAllowed(ctx.policy, routes, destHost)) {

        void opts.control.ledger({
          agentId: ctx.run.agentId,
          runId: ctx.run.runId,
          actor: `run:${ctx.run.agentId}`,
          type: 'action',
          action: `EGRESS_DENIED_HOST_${destHost}`,
        }).catch(() => {});
        return refuse('403 Forbidden', 403);
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

      let tunnelStatus = 502;
      upstreamSocket.once('connect', () => (tunnelStatus = 200));
      clientSocket.once('close', () => tunnel?.end(tunnelStatus));
      upstreamSocket.on('error', (err) => {
        if (tunnel && !tunnel.outcome) tunnel.outcome = (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'error';
        console.warn(`[gatekeeper-egress] connect error to ${destHost}:${destPort}: ${err.message}`);
        clientSocket.destroy();
      });
      clientSocket.on('error', () => {
        upstreamSocket.destroy();
      });
    } catch {
      clientSocket.destroy();
    }
  });

  server.on('close', () => progress?.stop());
  return server;
}
