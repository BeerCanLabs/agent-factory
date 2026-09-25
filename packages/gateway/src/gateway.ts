import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { RunTokens } from '@beercanlabs/factory-auth';
import { payloadHash, redactSecrets } from '@beercanlabs/factory-ledger';
import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { SseMeter, costUsd, priceFor, usageFromJson, type Price, type Provider, type Usage } from './meter.js';
import { writeTrace, type TraceConfig } from './traces.js';
import type { Meter } from '@opentelemetry/api';

export type Route = {
  id: string;
  kind: 'llm' | 'mcp' | 'http';
  provider?: Provider;
  upstream: string;
  credential?: { secret: string; header: string; format?: string };
};

export type ToolRule = { allow: string[] | '*'; requireApproval?: string[] };
export type Policy = {
  routes: string[];
  models?: string[];
  tools?: Record<string, ToolRule>;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  tokensPerMinute?: number;
};

export type RunContext = {
  run: { runId: string; agentId: string; state: string; live: boolean; model?: string };
  agentState: string;
  policy: Policy;
  spend: { run: number; day: number; month: number };
};

export type Approval = { approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'consumed' };

/** How the gateway talks to the control plane. HTTP in production, in-memory in tests. */
export type ControlClient = {
  runContext(runId: string): Promise<RunContext | null>;
  requestApproval(req: { runId: string; route: string; tool: string; argsSha256: string }): Promise<Approval>;
  consumeApproval(approvalId: string): Promise<boolean>;
  ledger(event: Record<string, unknown>): Promise<void>;
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
};

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

/** Run token from `Authorization: Bearer`, `x-api-key` (Anthropic SDKs), or `x-factory-run-token`. */
function presentedToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers;
  if (typeof h['x-factory-run-token'] === 'string') return h['x-factory-run-token'];
  if (typeof h['x-api-key'] === 'string') return h['x-api-key'];
  const a = h.authorization;
  return a?.startsWith('Bearer ') ? a.slice(7).trim() : undefined;
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
  const routes = new Map(opts.routes.map((r) => [r.id, r]));
  const ttl = opts.contextTtlMs ?? 1000;
  const limit = opts.maxBodyBytes ?? 10 * 1024 * 1024;
  const ctxCache = new Map<string, { at: number; ctx: RunContext }>();
  /** Spend settled here whose ledger write the control plane has not yet acknowledged. */
  const unacked = new Map<string, number>();
  const tpm = new Map<string, { windowStart: number; tokens: number }>();
  const credCache = new Map<string, string>();
  const secretValues = new Set<string>();
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
      const bound = await bindSecrets([name], opts.providers);
      if (bound.ok && bound.env[name]) {
        value = bound.env[name];
        credCache.set(name, value);
        if (value.length >= 4) secretValues.add(value);
      } else if (route.credential.secret !== name) {
        // Fallback to the base secret name if the agent-specific secret is not found
        const fallbackName = route.credential.secret.replace(/\$\{agent\}|\{agent\}[_-]?/gi, '');
        const fallbackBound = await bindSecrets([fallbackName], opts.providers);
        if (fallbackBound.ok && fallbackBound.env[fallbackName]) {
          value = fallbackBound.env[fallbackName];
          credCache.set(name, value);
          if (value.length >= 4) secretValues.add(value);
        }
      }
    }
    if (!value) return undefined;
    return (route.credential.format ?? '{}').replace('{}', value);
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
      if (route.credential && authHeader) headers[route.credential.header.toLowerCase()] = authHeader;
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

  async function handleLlm(req: http.IncomingMessage, res: http.ServerResponse, ctx: RunContext, route: Route, rest: string, raw: Buffer) {
    const provider = route.provider ?? 'openai';
    const parsed = tryJson(raw) as Record<string, unknown> | undefined;
    const model = typeof parsed?.model === 'string' ? parsed.model : undefined;
    if (req.method === 'POST' && parsed) {
      if (!model) return deny(res, ctx, route, 400, 'model_required');
      const isTraining = ctx.agentState === 'TRAINING';
      if (!isTraining && ctx.policy.models && !ctx.policy.models.includes(model)) {
        return deny(res, ctx, route, 403, 'model_not_allowed', { model });
      }
      if (ctx.run.model && ctx.run.model !== model) return deny(res, ctx, route, 403, 'model_pinned', { model, pinned: ctx.run.model });
      if (!priceFor(opts.prices, model)) return deny(res, ctx, route, 403, 'unpriced_model', { model });
    }
    const w = tpm.get(ctx.run.runId);
    if (ctx.policy.tokensPerMinute !== undefined && w && Date.now() - w.windowStart < 60_000 && w.tokens >= ctx.policy.tokensPerMinute) {
      return deny(res, ctx, route, 429, 'throttled');
    }

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
      requestId,
      payloadSha256: payloadHash(parsed),
      ...(action ? { action } : {}),
    }).then((accepted) => {
      // Until the control plane has counted it, this spend keeps counting against the budget here.
      if (!accepted) return;
      unacked.set(runId, (unacked.get(runId) ?? 0) - cost);
      ctxCache.delete(runId);
    });
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

  return http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (url === '/healthz') return send(res, 200, { status: 'ok', routes: [...routes.keys()] });
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
      if (route.kind === 'llm') {
        const pending = unacked.get(ctx.run.runId) ?? 0;
        const spend = { run: ctx.spend.run + pending, day: ctx.spend.day + pending, month: ctx.spend.month + pending };
        const window = ctx.run.state === 'BLOCKED_BUDGET_EXCEEDED' ? 'blocked' : overBudget(ctx.policy, spend);
        if (window) return deny(res, ctx, route, 402, 'budget_exceeded', { window });
      }

      const raw = await readBody(req, limit);
      if (route.kind === 'llm') return await handleLlm(req, res, ctx, route, rest, raw);
      if (route.kind === 'mcp') return await handleMcp(req, res, ctx, route, rest, raw);
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
}
