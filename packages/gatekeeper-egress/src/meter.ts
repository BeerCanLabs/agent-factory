import type { TokenUsage } from '@beercanlabs/factory-budget';

export type Provider = 'anthropic' | 'openai';

/** Normalized usage: `input` excludes cached tokens; cache reads/writes are counted separately. */
export type Usage = TokenUsage & { model?: string };

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function fromAnthropic(u: Record<string, unknown>): Omit<Usage, 'model'> {
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  };
}

/** OpenAI Chat (prompt/completion) and Responses (input/output) shapes; cached tokens are a subset of input. */
function fromOpenAi(u: Record<string, unknown>): Omit<Usage, 'model'> {
  const total = n(u.prompt_tokens ?? u.input_tokens);
  const cached = n(obj(u.prompt_tokens_details ?? u.input_tokens_details).cached_tokens);
  return { input: Math.max(0, total - cached), output: n(u.completion_tokens ?? u.output_tokens), cacheRead: cached, cacheWrite: 0 };
}

/** Usage from a complete (non-streaming) JSON response body. */
export function usageFromJson(provider: Provider, body: unknown): Usage | null {
  const b = obj(body);
  const usage = obj(b.usage ?? obj(b.response).usage);
  if (!Object.keys(usage).length) return null;
  const model = typeof b.model === 'string' ? b.model : typeof obj(b.response).model === 'string' ? (obj(b.response).model as string) : undefined;
  return { model, ...(provider === 'anthropic' ? fromAnthropic(usage) : fromOpenAi(usage)) };
}

/**
 * Incremental SSE parser that extracts usage while bytes stream through to the client.
 * Anthropic: message_start carries input/cache usage, message_delta carries cumulative output.
 * OpenAI Chat: final chunk carries `usage` (the gatekeeper-egress forces stream_options.include_usage).
 * OpenAI Responses: `response.completed` carries response.usage.
 */
export class SseMeter {
  private buf = '';
  private usage: Usage | null = null;
  raw = '';

  constructor(private readonly provider: Provider, private readonly keepRaw = 0) {}

  feed(chunk: Buffer | string) {
    const text = chunk.toString();
    if (this.keepRaw && this.raw.length < this.keepRaw) this.raw += text.slice(0, this.keepRaw - this.raw.length);
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.startsWith('data:')) this.onData(line.slice(5).trim());
    }
  }

  private onData(data: string) {
    if (!data || data === '[DONE]') return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.provider === 'anthropic') {
      if (ev.type === 'message_start') {
        const m = obj(ev.message);
        this.usage = { model: typeof m.model === 'string' ? m.model : undefined, ...fromAnthropic(obj(m.usage)) };
      } else if (ev.type === 'message_delta' && this.usage) {
        const u = obj(ev.usage);
        if (typeof u.output_tokens === 'number') this.usage.output = u.output_tokens;
        if (typeof u.input_tokens === 'number') this.usage.input = u.input_tokens;
      }
      return;
    }
    const direct = obj(ev.usage);
    if (Object.keys(direct).length) {
      this.usage = { model: typeof ev.model === 'string' ? ev.model : this.usage?.model, ...fromOpenAi(direct) };
      return;
    }
    if (ev.type === 'response.completed') {
      const r = obj(ev.response);
      this.usage = { model: typeof r.model === 'string' ? r.model : undefined, ...fromOpenAi(obj(r.usage)) };
      return;
    }
    if (typeof ev.model === 'string' && !this.usage) this.usage = { model: ev.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  result(): Usage | null {
    if (this.buf.trim()) this.feed('\n');
    if (!this.usage || this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite === 0) return null;
    return this.usage;
  }
}

