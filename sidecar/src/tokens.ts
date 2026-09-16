export type TokenUsage = {
  input: number;
  output: number;
  model?: string;
};

export function usageFromLlmJson(body: unknown): TokenUsage | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const usage = rec.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0;
  const output = num(u.completion_tokens) ?? num(u.output_tokens) ?? 0;
  if (input === 0 && output === 0) return null;
  const model = typeof rec.model === 'string' ? rec.model : undefined;
  return { input, output, model };
}

export function toolFromMcpJson(body: unknown): { method: string; name?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const method = typeof rec.method === 'string' ? rec.method : undefined;
  if (!method) return null;
  const params = rec.params && typeof rec.params === 'object' ? (rec.params as Record<string, unknown>) : {};
  const name = typeof params.name === 'string' ? params.name : undefined;
  return { method, name };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
