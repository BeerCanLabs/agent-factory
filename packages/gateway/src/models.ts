import type { Price } from './meter.js';
import { awsCredentialsFromEnv, signV4, type AwsCredentials } from './sigv4.js';

/**
 * Factory model API (DESIGN_AUTHORITY §6.9 M1–M3): agents send OpenAI Chat Completions requests
 * naming a neutral model; operations configure which neutral names are offered and which provider
 * serves each (`FACTORY_MODEL_CATALOG`); an adapter per provider translates to its native API.
 */

/** One offered model. `provider` selects the adapter; `id`/`region` are provider-specific. */
export type CatalogEntry = { provider: string; id: string; region?: string; price?: Price };
export type ModelCatalog = Record<string, CatalogEntry>;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatRequest = { messages: ChatMessage[]; maxTokens?: number; temperature?: number; topP?: number; stop?: string[] };
export type ChatResult = {
  content: string;
  /** OpenAI finish_reason: stop | length | content_filter | tool_calls */
  finishReason: string;
  usage: { input: number; output: number } | null;
};

/** Upstream failure with the status the agent should see. `message` must not carry credentials. */
export class ModelUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export type ModelAdapter = { complete(entry: CatalogEntry, req: ChatRequest): Promise<ChatResult> };

export function parseModelCatalog(json: string | undefined): ModelCatalog {
  if (!json?.trim()) return {};
  const raw = JSON.parse(json) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FACTORY_MODEL_CATALOG must be a JSON object keyed by model name');
  const out: ModelCatalog = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<CatalogEntry> | null;
    if (!e || typeof e.provider !== 'string' || typeof e.id !== 'string') throw new Error(`FACTORY_MODEL_CATALOG.${name} needs provider and id`);
    const p = e.price;
    if (p !== undefined && (typeof p.inputPerMTok !== 'number' || typeof p.outputPerMTok !== 'number')) {
      throw new Error(`FACTORY_MODEL_CATALOG.${name}.price needs inputPerMTok and outputPerMTok`);
    }
    out[name] = { provider: e.provider, id: e.id, ...(e.region ? { region: e.region } : {}), ...(p ? { price: p } : {}) };
  }
  return out;
}

/** Validates the OpenAI-format body; returns an error code for the agent, or the normalized request. */
export function parseChatRequest(body: Record<string, unknown>): { ok: true; req: ChatRequest } | { ok: false; error: string } {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return { ok: false, error: 'messages_required' };
  const messages: ChatMessage[] = [];
  for (const m of msgs as Array<Record<string, unknown>>) {
    if (!m || (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant')) return { ok: false, error: 'unsupported_role' };
    let content: string;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content) && m.content.every((p) => p && p.type === 'text' && typeof p.text === 'string')) {
      content = (m.content as Array<{ text: string }>).map((p) => p.text).join('');
    } else return { ok: false, error: 'unsupported_content' };
    messages.push({ role: m.role, content });
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens);
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === 'string') : undefined;
  return {
    ok: true,
    req: {
      messages,
      ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
      ...(num(body.temperature) !== undefined ? { temperature: num(body.temperature) } : {}),
      ...(num(body.top_p) !== undefined ? { topP: num(body.top_p) } : {}),
      ...(stop?.length ? { stop } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// bedrock-converse

type ConverseBody = {
  messages: Array<{ role: 'user' | 'assistant'; content: Array<{ text: string }> }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] };
};

/** OpenAI messages → Bedrock Converse request. Consecutive same-role turns merge (Converse requires alternation). */
export function toConverse(req: ChatRequest): ConverseBody {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const messages: ConverseBody['messages'] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const last = messages.at(-1);
    if (last && last.role === m.role) last.content.push({ text: m.content });
    else messages.push({ role: m.role, content: [{ text: m.content }] });
  }
  const inferenceConfig = {
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { topP: req.topP } : {}),
    ...(req.stop ? { stopSequences: req.stop } : {}),
  };
  return { messages, ...(system.length ? { system } : {}), ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}) };
}

const FINISH: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  guardrail_intervened: 'content_filter',
  content_filtered: 'content_filter',
};

export function fromConverse(body: unknown): ChatResult {
  const b = (body ?? {}) as { output?: { message?: { content?: Array<{ text?: unknown }> } }; stopReason?: string; usage?: { inputTokens?: unknown; outputTokens?: unknown } };
  const content = (b.output?.message?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  const u = b.usage;
  const usage = u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number' ? { input: u.inputTokens, output: u.outputTokens } : null;
  return { content, finishReason: FINISH[b.stopReason ?? ''] ?? 'stop', usage };
}

export type BedrockConverseOptions = {
  credentials?: () => Promise<AwsCredentials>;
  /** Base URL for a region; tests point this at a fake upstream. */
  endpoint?: (region: string) => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function bedrockConverse(opts: BedrockConverseOptions = {}): ModelAdapter {
  const creds = opts.credentials ?? awsCredentialsFromEnv();
  const endpoint = opts.endpoint ?? ((region: string) => `https://bedrock-runtime.${region}.amazonaws.com`);
  const doFetch = opts.fetch ?? fetch;
  return {
    async complete(entry, req) {
      const region = entry.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) throw new ModelUpstreamError(503, 'provider_misconfigured', 'catalog entry has no region');
      let c: AwsCredentials;
      try {
        c = await creds();
      } catch (err) {
        console.error(`[gateway] bedrock credentials: ${err instanceof Error ? err.message : String(err)}`);
        throw new ModelUpstreamError(503, 'provider_credentials_unavailable', 'gateway has no cloud credentials');
      }
      const url = new URL(`${endpoint(region).replace(/\/$/, '')}/model/${encodeURIComponent(entry.id)}/converse`);
      const body = JSON.stringify(toConverse(req));
      const headers = signV4({ method: 'POST', url, headers: { 'content-type': 'application/json', accept: 'application/json' }, body }, c, { region, service: 'bedrock' }, new Date(), { contentSha256Header: true });
      delete headers['host'];
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000) });
      } catch (err) {
        throw new ModelUpstreamError(502, 'upstream_unreachable', err instanceof Error ? err.message : String(err));
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        const message = String((json as { message?: unknown } | undefined)?.message ?? text).slice(0, 500);
        if (res.status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, res.status);
        throw new ModelUpstreamError(502, 'upstream_error', message, res.status);
      }
      return fromConverse(json);
    },
  };
}

/** Adapters by catalog `provider`. Add anthropic-messages, vertex, openai-compatible here. */
export function defaultModelAdapters(): Record<string, ModelAdapter> {
  return { 'bedrock-converse': bedrockConverse() };
}
