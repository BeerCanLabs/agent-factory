import { SUBSCRIPTION_TEMPLATES, type SubscriptionErrorRecogniser, type SubscriptionTemplate } from '@beercanlabs/factory-contract';
import { ModelUpstreamError, type CatalogEntry, type ChatRequest, type ChatResult, type ModelAdapter, type ToolCall } from './models.js';

/**
 * The Responses API adapter for subscription models (DESIGN_AUTHORITY §6.9 M5(3), (6), (7)).
 *
 * The factory model API speaks OpenAI Chat Completions (M1). Both permitted vendors serve their subscription plans on the
 * Responses API (xAI `https://api.x.ai/v1/responses`; OpenAI `https://chatgpt.com/backend-api/codex/responses`, which needs
 * `store: false`, a streamed reply and the signed-in account's id in `ChatGPT-Account-ID`). This adapter translates a chat
 * request into one, and the reply (streamed or not) back into a chat result with its tool calls.
 *
 * Everything vendor-specific comes from the reviewed subscription template named by the Keymaster's own record for the
 * connection, never from the catalog entry: the host the token goes to, and exactly the headers the template lists (the
 * factory's User-Agent, OpenAI's `originator`, the vendor-required ones), plus the HTTP framing `Content-Type`. No vendor
 * application's identity is borrowed. The adapter is registered for the factory model API only; a provider-native route (M4)
 * never reaches it.
 */

export type SubscriptionTokenResult =
  | { ok: true; accessToken: string; templateId: string; accountId?: string }
  | { ok: false; kind: 'needs_reconsent'; reason?: string }
  | { ok: false; kind: 'unavailable'; message?: string };

/** The connection's grant needs re-consent (K4): skipped for every agent until an admin reconnects it. Never retried. */
export class SubscriptionNeedsReconsentError extends ModelUpstreamError {
  constructor(readonly connection: string) {
    super(503, 'subscription_needs_reconsent', 'the subscription connection needs re-consent');
  }
}

/** The vendor reported that the plan's usage limit is spent, or that the plan's tier is refused (M5(7)). */
export class SubscriptionLimitError extends ModelUpstreamError {
  constructor(
    readonly connection: string,
    readonly kind: 'plan-limit' | 'tier-refused',
    readonly vendorCode: string,
    /** ISO time the vendor says the limit resets; absent when it gave none. */
    readonly resetAt: string | undefined,
    upstreamStatus: number,
  ) {
    super(kind === 'plan-limit' ? 429 : 403, kind === 'plan-limit' ? 'subscription_limit_reached' : 'subscription_tier_refused', `the subscription's ${kind === 'plan-limit' ? 'usage limit is reached' : 'tier is refused'} (${vendorCode})`, upstreamStatus);
  }
}

export type ResponsesAdapterOptions = {
  /** The connection's current access token from the Keymaster (through the control plane), per call. */
  token(connection: string, opts?: { invalidate?: boolean }): Promise<SubscriptionTokenResult>;
  /** The factory version, for the template's `User-Agent`. */
  version: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Tests only: other templates. Production uses the contract's reviewed ones. */
  templates?: Record<string, SubscriptionTemplate>;
  /** Called with each access token, so the egress adds it to its redaction set (S1). */
  onToken?(secret: string): void;
  now?: () => number;
};

const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

/** The signed-in account id OpenAI carries in the access token's `https://api.openai.com/auth` claim. */
export function chatgptAccountIdFromJwt(accessToken: string): string | undefined {
  const part = accessToken.split('.')[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The template's headers with their placeholders filled: exactly those, nothing else. A header whose value needs the
 * account id is a vendor-required one, so with no account id the call is refused rather than sent without it.
 */
export function subscriptionHeaders(template: SubscriptionTemplate, tok: { accessToken: string; accountId?: string }, version: string): Record<string, string> {
  const accountId = tok.accountId ?? (template.vendor === 'openai' ? chatgptAccountIdFromJwt(tok.accessToken) : undefined);
  const out: Record<string, string> = {};
  for (const h of template.headers) {
    if (h.value.includes('{account_id}') && !accountId) {
      throw new ModelUpstreamError(503, 'subscription_account_unavailable', 'the subscription connection has no account id for the vendor');
    }
    out[h.name] = h.value.replace('{version}', version).replace('{access_token}', tok.accessToken).replace('{account_id}', accountId ?? '');
  }
  return out;
}

// ---- request translation -------------------------------------------------------------------------

type ResponsesInput = Record<string, unknown>;

export function toResponsesRequest(modelId: string, req: ChatRequest, vendor: SubscriptionTemplate['vendor']): Record<string, unknown> {
  const instructions: string[] = [];
  const input: ResponsesInput[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      if (m.content) instructions.push(m.content);
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model: modelId,
    instructions: instructions.join('\n\n') || DEFAULT_INSTRUCTIONS,
    input,
    store: false,
    stream: true,
  };
  const tools = (req.tools ?? [])
    .map((t) => {
      const fn = (t as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function;
      if (typeof fn?.name !== 'string') return undefined;
      return {
        type: 'function',
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters: fn.parameters ?? { type: 'object', properties: {} },
        // The Responses API defaults to strict schemas, which the factory's tool schemas are not written for.
        strict: false,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== undefined);
  if (tools.length > 0) {
    body.tools = tools;
    const tc = req.tool_choice;
    if (tc === 'auto' || tc === 'none' || tc === 'required') body.tool_choice = tc;
    else if (tc && typeof tc === 'object' && typeof (tc as { function?: { name?: unknown } }).function?.name === 'string') {
      body.tool_choice = { type: 'function', name: (tc as { function: { name: string } }).function.name };
    }
  }
  // The ChatGPT Codex backend rejects the sampling and length knobs; xAI accepts them.
  if (vendor === 'xai') {
    if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
  }
  return body;
}

// ---- response translation ------------------------------------------------------------------------

type ResponsesObject = {
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  incomplete_details?: { reason?: unknown } | null;
  status?: unknown;
};

export function fromResponses(r: ResponsesObject, fallbackText = ''): ChatResult {
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const item of r.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') content += part.text;
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({
        id: typeof item.call_id === 'string' && item.call_id ? item.call_id : typeof item.id === 'string' ? item.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
    }
  }
  if (!content && toolCalls.length === 0) content = fallbackText;
  const reason = r.incomplete_details?.reason;
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : 'stop';
  const inTok = r.usage?.input_tokens;
  const outTok = r.usage?.output_tokens;
  return {
    content,
    finishReason,
    usage: typeof inTok === 'number' && typeof outTok === 'number' ? { input: inTok, output: outTok } : null,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

type SseFailure = { code?: string; message?: string; status?: number; body: unknown };

/** The final response of a Responses stream, or what failed in it. */
export function readResponsesStream(text: string): { response: ResponsesObject; text: string } | { failure: SseFailure } {
  const items: Array<Record<string, unknown>> = [];
  let deltas = '';
  let completed: ResponsesObject | undefined;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev.type;
    if (type === 'response.output_item.done' && ev.item && typeof ev.item === 'object') items.push(ev.item as Record<string, unknown>);
    else if (type === 'response.output_text.delta' && typeof ev.delta === 'string') deltas += ev.delta;
    else if (type === 'response.completed' || type === 'response.incomplete') completed = ev.response as ResponsesObject;
    else if (type === 'response.failed') {
      const err = ((ev.response as { error?: unknown } | undefined)?.error ?? {}) as { code?: unknown; type?: unknown; message?: unknown };
      return { failure: { code: String(err.code ?? err.type ?? ''), message: typeof err.message === 'string' ? err.message : undefined, body: { error: err } } };
    } else if (type === 'error') {
      const err = (ev.error ?? ev) as { code?: unknown; type?: unknown; message?: unknown; status?: unknown };
      return { failure: { code: String(err.code ?? err.type ?? ''), message: typeof err.message === 'string' ? err.message : undefined, ...(typeof err.status === 'number' ? { status: err.status } : {}), body: { error: err } } };
    }
  }
  const response: ResponsesObject = completed ?? {};
  // The completed event carries the whole output on the vendors seen so far; the item events are the fallback.
  if (!response.output?.length && items.length) response.output = items;
  return { response, text: deltas };
}

// ---- vendor limit recognition --------------------------------------------------------------------

function resetTime(body: unknown, rec: SubscriptionErrorRecogniser, nowMs: number): string | undefined {
  const err = (body as { error?: unknown } | undefined)?.error;
  for (const holder of [err, body]) {
    if (!holder || typeof holder !== 'object') continue;
    const h = holder as Record<string, unknown>;
    for (const f of rec.resetFields ?? []) {
      const v = h[f];
      if (f === 'resets_in_seconds' && typeof v === 'number' && v > 0) return new Date(nowMs + v * 1000).toISOString();
      if ((f === 'resets_at' || f === 'reset_at') && typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
      if ((f === 'resets_at' || f === 'reset_at') && typeof v === 'string' && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
    }
  }
  return undefined;
}

/** The template's plan-limit or tier recogniser a vendor failure matches, if any (never an ordinary rate limit). A failure inside a stream or a 200 body has no status of its own: it matches on the vendor's code alone. */
export function recogniseSubscriptionError(template: SubscriptionTemplate, status: number | undefined, body: unknown, nowMs: number): { rec: SubscriptionErrorRecogniser; resetAt?: string } | undefined {
  const err = (body as { error?: { code?: unknown; type?: unknown } } | undefined)?.error;
  const codes = [err?.code, err?.type].filter((c): c is string => typeof c === 'string');
  for (const rec of template.errors) {
    if ((status === undefined || rec.status === status) && codes.includes(rec.code)) return { rec, resetAt: resetTime(body, rec, nowMs) };
  }
  return undefined;
}

// ---- the adapter ---------------------------------------------------------------------------------

export function subscriptionInferenceUrl(template: SubscriptionTemplate): string {
  return new URL(template.inference.path, template.inference.upstream).toString();
}

async function resolveToken(
  opts: ResponsesAdapterOptions,
  connection: string,
  tokenOpts?: { invalidate?: boolean },
): Promise<{ tok: Extract<SubscriptionTokenResult, { ok: true }>; template: SubscriptionTemplate }> {
  let tok: SubscriptionTokenResult;
  try {
    tok = await (tokenOpts ? opts.token(connection, tokenOpts) : opts.token(connection));
  } catch {
    throw new ModelUpstreamError(502, 'subscription_token_unavailable', 'the subscription token could not be fetched');
  }
  if (!tok.ok) {
    if (tok.kind === 'needs_reconsent') throw new SubscriptionNeedsReconsentError(connection);
    throw new ModelUpstreamError(502, 'subscription_token_unavailable', 'the subscription token could not be fetched');
  }
  opts.onToken?.(tok.accessToken);
  const templates = opts.templates ?? SUBSCRIPTION_TEMPLATES;
  const template = Object.hasOwn(templates, tok.templateId) ? templates[tok.templateId] : undefined;
  if (!template) throw new ModelUpstreamError(503, 'subscription_template_unknown', 'the subscription connection names no shipped template');
  return { tok, template };
}

export function subscriptionResponses(opts: ResponsesAdapterOptions): ModelAdapter {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  return {
    async complete(entry: CatalogEntry, req: ChatRequest): Promise<ChatResult> {
      if (entry.credentialMode !== 'subscription' || !entry.connection) {
        throw new ModelUpstreamError(503, 'subscription_unconfigured', 'the catalog entry names no subscription connection');
      }
      const connection = entry.connection;
      const seenTokens: string[] = [];
      const redact = (s: string): string => {
        let out = s;
        for (const t of seenTokens) if (t) out = out.split(t).join('***');
        return out;
      };
      let { tok, template } = await resolveToken(opts, connection);
      seenTokens.push(tok.accessToken);
      const sendOnce = async () => {
        const headers = { ...subscriptionHeaders(template, tok, opts.version), 'Content-Type': 'application/json' };
        try {
          return await doFetch(subscriptionInferenceUrl(template), {
            method: 'POST',
            // GAP-182: the token is bound to the template's inference host; never follow a redirect elsewhere with it.
            redirect: 'error',
            headers,
            body: JSON.stringify(toResponsesRequest(entry.id, req, template.vendor)),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
          });
        } catch (err) {
          throw new ModelUpstreamError(502, 'upstream_unreachable', redact(err instanceof Error ? err.message : String(err)));
        }
      };
      let res = await sendOnce();
      let text = await res.text();
      // A vendor 401 may mean an access token revoked server-side before its local expiry: invalidate once so Keymaster
      // runs a single refresh (surfacing `SubscriptionNeedsReconsentError` on `invalid_grant`, or retrying once with the fresh token).
      if (res.status === 401 && !recogniseSubscriptionError(template, 401, (() => { try { return JSON.parse(text); } catch { return undefined; } })(), now())) {
        ({ tok, template } = await resolveToken(opts, connection, { invalidate: true }));
        seenTokens.push(tok.accessToken);
        res = await sendOnce();
        text = await res.text();
      }
      const contentType = res.headers.get('content-type') ?? '';
      const asStream = contentType.includes('text/event-stream');
      let json: unknown;
      if (!asStream) {
        try {
          json = JSON.parse(text);
        } catch {}
      }
      const fail = (status: number | undefined, body: unknown, message: string, upstreamStatus: number): never => {
        const hit = recogniseSubscriptionError(template, status, body, now());
        if (hit) throw new SubscriptionLimitError(connection, hit.rec.kind, hit.rec.code, hit.resetAt, upstreamStatus);
        if (status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, upstreamStatus);
        throw new ModelUpstreamError(502, 'upstream_error', message, upstreamStatus);
      };
      if (!res.ok) {
        const parsed = json ?? (() => { try { return JSON.parse(text); } catch { return undefined; } })();
        const errObj = (parsed as { error?: { message?: unknown } | string; detail?: unknown } | undefined);
        const msg = typeof errObj?.error === 'object' ? errObj.error?.message : typeof errObj?.error === 'string' ? errObj.error : errObj?.detail;
        return fail(res.status, parsed, redact(String(msg ?? text).slice(0, 500)), res.status);
      }
      if (asStream) {
        const read = readResponsesStream(text);
        if ('failure' in read) {
          const f = read.failure;
          return fail(f.status, f.body, redact(String(f.message ?? f.code ?? 'stream failed').slice(0, 500)), f.status ?? 200);
        }
        return fromResponses(read.response, read.text);
      }
      const body = (json ?? {}) as ResponsesObject & { error?: unknown };
      if (body.error && typeof body.error === 'object') return fail(undefined, body, redact(String((body.error as { message?: unknown }).message ?? 'upstream error').slice(0, 500)), 200);
      return fromResponses(body);
    },
  };
}

// ---- discovery (M5(4a)) --------------------------------------------------------------------------

export type SubscriptionModel = { id: string; name?: string; description?: string };

export type SubscriptionDiscovery =
  /** The vendor's model list for this plan. */
  | { ok: true; models: SubscriptionModel[] }
  /** The vendor refused the token on its model list, or has none for subscription tokens: the admin adds by model id. */
  | { ok: false; listAvailable: false; reason: 'vendor_refused' | 'no_model_list'; status?: number; message: string }
  /** The fetch itself failed (network, 5xx, unreadable answer): nothing is retired, try again later. */
  | { ok: false; listAvailable: true; reason: 'fetch_failed'; message: string };

const CODEX_CLIENT_VERSIONS = ['99.0.0', '0.0.0'];

/**
 * Fetch a connection's model list from the vendor with its OAuth token (the control plane never sees the token).
 * OpenAI: `GET /backend-api/codex/models` (needs `ChatGPT-Account-ID`). xAI: UNCONFIRMED: this tries `GET /v1/models` with the
 * OAuth token and, if the vendor refuses or has no list, says so; it never guesses a list.
 */
export async function discoverSubscriptionModels(opts: ResponsesAdapterOptions, connection: string): Promise<SubscriptionDiscovery> {
  const doFetch = opts.fetch ?? fetch;
  let { tok, template } = await resolveToken(opts, connection);
  let headers = subscriptionHeaders(template, tok, opts.version);
  const base = new URL(template.aiProvider.discoveryPath, template.inference.upstream);
  const urls = template.vendor === 'openai' ? CODEX_CLIENT_VERSIONS.map((v) => `${base.toString()}?client_version=${v}`) : [base.toString()];
  let last: { status: number } | undefined;
  let retried401 = false;
  for (const url of urls) {
    let res: Response;
    try {
      res = await doFetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch {
      return { ok: false, listAvailable: true, reason: 'fetch_failed', message: 'the vendor could not be reached' };
    }
    if (res.status === 401 && !retried401) {
      retried401 = true;
      await res.text().catch(() => '');
      try {
        ({ tok, template } = await resolveToken(opts, connection, { invalidate: true }));
      } catch (err) {
        if (err instanceof SubscriptionNeedsReconsentError) throw err;
        return { ok: false, listAvailable: true, reason: 'fetch_failed', message: err instanceof Error ? err.message : 'the subscription token could not be fetched' };
      }
      headers = subscriptionHeaders(template, tok, opts.version);
      try {
        res = await doFetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      } catch {
        return { ok: false, listAvailable: true, reason: 'fetch_failed', message: 'the vendor could not be reached' };
      }
    }
    last = { status: res.status };
    if (res.status >= 500 || res.status === 429) return { ok: false, listAvailable: true, reason: 'fetch_failed', message: `the vendor answered ${res.status}` };
    if (res.status !== 200) continue;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, listAvailable: true, reason: 'fetch_failed', message: 'the vendor answered with an unreadable model list' };
    }
    const models = parseModelList(body);
    if (models.length > 0) return { ok: true, models };
  }
  if (last && last.status === 200) {
    return { ok: false, listAvailable: false, reason: 'no_model_list', status: 200, message: `${template.vendor} returned no model list for this subscription; add models by model id` };
  }
  return {
    ok: false,
    listAvailable: false,
    reason: 'vendor_refused',
    ...(last ? { status: last.status } : {}),
    message: `${template.vendor} refused the model list for this subscription token${last ? ` (${last.status})` : ''}; add models by model id`,
  };
}

function parseModelList(body: unknown): SubscriptionModel[] {
  const b = (body ?? {}) as { models?: unknown; data?: unknown };
  const out = new Map<string, { rank: number; m: SubscriptionModel }>();
  // OpenAI Codex: `models: [{slug, display_name, description, visibility, priority}]`. xAI (if it answers): `data: [{id}]`.
  for (const item of Array.isArray(b.models) ? b.models : []) {
    const m = item as { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; priority?: unknown };
    if (typeof m.slug !== 'string' || !m.slug.trim()) continue;
    if (typeof m.visibility === 'string' && ['hide', 'hidden'].includes(m.visibility.trim().toLowerCase())) continue;
    const id = m.slug.trim();
    if (!out.has(id)) out.set(id, { rank: typeof m.priority === 'number' ? m.priority : 10_000, m: { id, ...(typeof m.display_name === 'string' ? { name: m.display_name } : {}), ...(typeof m.description === 'string' ? { description: m.description } : {}) } });
  }
  for (const item of Array.isArray(b.data) ? b.data : []) {
    const m = item as { id?: unknown };
    if (typeof m.id === 'string' && m.id && !out.has(m.id)) out.set(m.id, { rank: 10_000, m: { id: m.id } });
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank || a.m.id.localeCompare(b.m.id)).map((v) => v.m);
}
