import type { Price } from '@beercanlabs/factory-budget';
import { awsCredentialsFromEnv, signV4, type AwsCredentials } from './sigv4.js';

/**
 * Factory model API (DESIGN_AUTHORITY §6.9 M1–M3): agents send OpenAI Chat Completions requests
 * naming a neutral model; operations configure which neutral names are offered and which provider
 * serves each (`FACTORY_MODEL_CATALOG`); an adapter per provider translates to its native API.
 */

/** One offered model. `provider` selects the adapter; `id`/`region` are provider-specific; `endpoint` is optional custom base URL; `secret` is optional platform credential name. */
export type CatalogEntry = { provider: string; id: string; endpoint?: string; region?: string; secret?: string; price?: Price };
export type ModelCatalog = Record<string, CatalogEntry>;

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * One message of the factory model API (OpenAI Chat Completions, §6.9 M1). An assistant turn may carry the tool calls
 * the model made; a `tool` message returns one call's result (GAP-173).
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };
export type ChatRequest = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
};
export type ChatResult = {
  content: string;
  /** OpenAI finish_reason: stop | length | content_filter | tool_calls */
  finishReason: string;
  usage: { input: number; output: number } | null;
  toolCalls?: ToolCall[];
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
    out[name] = {
      provider: e.provider,
      id: e.id,
      ...(typeof (e as any).endpoint === 'string' ? { endpoint: (e as any).endpoint } : {}),
      ...(typeof (e as any).secret === 'string' ? { secret: (e as any).secret } : {}),
      ...(e.region ? { region: e.region } : {}),
      ...(p ? { price: p } : {}),
    };
  }
  return out;
}

/** Validates the OpenAI-format body; returns an error code for the agent, or the normalized request. */
export function parseChatRequest(body: Record<string, unknown>): { ok: true; req: ChatRequest } | { ok: false; error: string } {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return { ok: false, error: 'messages_required' };
  const messages: ChatMessage[] = [];
  for (const m of msgs as Array<Record<string, unknown>>) {
    const role = m?.role;
    if (role === 'tool') {
      const content = textContent(m.content);
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) return { ok: false, error: 'invalid_tool_message' };
      if (content === undefined) return { ok: false, error: 'unsupported_content' };
      messages.push({ role: 'tool', content, toolCallId: m.tool_call_id });
    } else if (role === 'assistant') {
      const toolCalls = parseToolCalls(m.tool_calls);
      if (toolCalls === null) return { ok: false, error: 'invalid_tool_calls' };
      // An assistant turn that only calls tools has null content in the OpenAI format.
      const content = m.content == null && toolCalls?.length ? '' : textContent(m.content);
      if (content === undefined) return { ok: false, error: 'unsupported_content' };
      messages.push({ role: 'assistant', content, ...(toolCalls?.length ? { toolCalls } : {}) });
    } else if (role === 'system' || role === 'user') {
      const content = textContent(m.content);
      if (content === undefined) return { ok: false, error: 'unsupported_content' };
      messages.push({ role, content });
    } else return { ok: false, error: 'unsupported_role' };
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens);
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === 'string') : undefined;
  let tools: unknown[] | undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, error: 'invalid_tools' };
    tools = body.tools;
  }
  const toolChoice = body.tool_choice;
  return {
    ok: true,
    req: {
      messages,
      ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
      ...(num(body.temperature) !== undefined ? { temperature: num(body.temperature) } : {}),
      ...(num(body.top_p) !== undefined ? { topP: num(body.top_p) } : {}),
      ...(stop?.length ? { stop } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    },
  };
}

/** A message's text: a string, or OpenAI text parts joined. Undefined when it holds anything else. */
function textContent(c: unknown): string | undefined {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((p) => p && p.type === 'text' && typeof p.text === 'string')) {
    return (c as Array<{ text: string }>).map((p) => p.text).join('');
  }
  return undefined;
}

/** OpenAI `tool_calls` on an assistant message. Undefined when absent, null when malformed. */
function parseToolCalls(v: unknown): ToolCall[] | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return null;
  const out: ToolCall[] = [];
  for (const tc of v as Array<Record<string, unknown> | null>) {
    const fn = tc?.function as { name?: unknown; arguments?: unknown } | undefined;
    if (typeof tc?.id !== 'string' || !tc.id || typeof fn?.name !== 'string') return null;
    out.push({
      id: tc.id,
      type: 'function',
      function: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) },
    });
  }
  return out;
}

/** A tool call's arguments as the object providers with structured tool input expect. */
function toolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(tc.function.arguments || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

/** The factory's messages in the OpenAI wire format, for OpenAI-compatible providers. */
export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls };
    return { role: m.role, content: m.content };
  });
}

// ---------------------------------------------------------------------------------------------
// bedrock-converse

type ConverseBlock = {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
  toolResult?: { toolUseId: string; content: Array<{ text: string }> };
};
type ConverseBody = {
  messages: Array<{ role: 'user' | 'assistant'; content: ConverseBlock[] }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] };
  toolConfig?: {
    tools: Array<{
      toolSpec: {
        name: string;
        description?: string;
        inputSchema: {
          json: unknown;
        };
      };
    }>;
    toolChoice?: Record<string, unknown>;
  };
};

/**
 * Whether a Claude model accepts `temperature`/`top_p` (GAP-171). Claude 4.6 and earlier do; from Opus 4.7 on they are
 * rejected with a 400, so any later or unrecognised Claude id is treated as not accepting them. Works on direct
 * (`claude-haiku-5-5`), Vertex (`claude-opus-4-5@20251101`) and Bedrock (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) ids.
 */
export function claudeAcceptsSampling(modelId: string): boolean {
  const current = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);
  if (current) {
    const major = Number(current[1]);
    const minor = current[2] === undefined ? 0 : Number(current[2]);
    return major < 4 || (major === 4 && minor <= 6);
  }
  // Pre-4 naming: claude-3-5-sonnet, claude-2.1, claude-instant-1.2.
  return /claude-(?:instant|\d)/.test(modelId);
}

/** OpenAI messages → Bedrock Converse request. Consecutive same-role turns merge (Converse requires alternation). */
export function toConverse(req: ChatRequest, modelId?: string): ConverseBody {
  const sampling = !(modelId && /claude/.test(modelId)) || claudeAcceptsSampling(modelId);
  const system = req.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const messages: ConverseBody['messages'] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: ConverseBlock[] = [];
    if (m.role === 'tool') {
      blocks.push({ toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content) blocks.push({ text: m.content });
      for (const tc of m.toolCalls) blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input: toolArgs(tc) } });
    } else {
      blocks.push({ text: m.content });
    }
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  const inferenceConfig = {
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(sampling && req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(sampling && req.topP !== undefined ? { topP: req.topP } : {}),
    ...(req.stop ? { stopSequences: req.stop } : {}),
  };

  let toolConfig: ConverseBody['toolConfig'] | undefined;
  if (req.tool_choice !== 'none' && req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    const converseTools: NonNullable<ConverseBody['toolConfig']>['tools'] = [];
    for (const t of req.tools) {
      if (!t || typeof t !== 'object') continue;
      const toolObj = t as Record<string, unknown>;
      if (toolObj.type === 'function' && toolObj.function && typeof toolObj.function === 'object') {
        const fn = toolObj.function as { name?: unknown; description?: unknown; parameters?: unknown };
        if (typeof fn.name === 'string') {
          converseTools.push({
            toolSpec: {
              name: fn.name,
              ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
              inputSchema: {
                json: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
              },
            },
          });
        }
      } else if (typeof toolObj.name === 'string') {
        converseTools.push({
          toolSpec: {
            name: toolObj.name,
            ...(typeof toolObj.description === 'string' ? { description: toolObj.description } : {}),
            inputSchema: {
              json: toolObj.parameters && typeof toolObj.parameters === 'object' ? toolObj.parameters : { type: 'object', properties: {} },
            },
          },
        });
      }
    }

    if (converseTools.length > 0) {
      let toolChoice: Record<string, unknown> | undefined;
      if (req.tool_choice !== undefined) {
        if (req.tool_choice === 'auto') {
          toolChoice = { auto: {} };
        } else if (req.tool_choice === 'any' || req.tool_choice === 'required') {
          toolChoice = { any: {} };
        } else if (typeof req.tool_choice === 'object' && req.tool_choice !== null) {
          const tc = req.tool_choice as Record<string, unknown>;
          if (tc.type === 'function' && tc.function && typeof tc.function === 'object') {
            const fnName = (tc.function as { name?: unknown }).name;
            if (typeof fnName === 'string') {
              toolChoice = { tool: { name: fnName } };
            }
          }
        }
      }
      toolConfig = {
        tools: converseTools,
        ...(toolChoice ? { toolChoice } : {}),
      };
    }
  }

  return {
    messages,
    ...(system.length ? { system } : {}),
    ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  };
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
  const b = (body ?? {}) as {
    output?: {
      message?: {
        content?: Array<{
          text?: unknown;
          toolUse?: {
            toolUseId?: string;
            name?: string;
            input?: unknown;
          };
        }>;
      };
    };
    stopReason?: string;
    usage?: { inputTokens?: unknown; outputTokens?: unknown };
  };
  const content = (b.output?.message?.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
  const toolCalls: ToolCall[] = [];
  for (const c of b.output?.message?.content ?? []) {
    if (c.toolUse && typeof c.toolUse === 'object') {
      const tu = c.toolUse;
      toolCalls.push({
        id: tu.toolUseId ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: tu.name ?? '',
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
        },
      });
    }
  }
  const u = b.usage;
  const usage = u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number' ? { input: u.inputTokens, output: u.outputTokens } : null;
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : (FINISH[b.stopReason ?? ''] ?? 'stop');
  return {
    content,
    finishReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
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
        console.error(`[gatekeeper-egress] bedrock credentials: ${err instanceof Error ? err.message : String(err)}`);
        throw new ModelUpstreamError(503, 'provider_credentials_unavailable', 'gatekeeper-egress has no cloud credentials');
      }
      const url = new URL(`${endpoint(region).replace(/\/$/, '')}/model/${encodeURIComponent(entry.id)}/converse`);
      const body = JSON.stringify(toConverse(req, entry.id));
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

// ---------------------------------------------------------------------------------------------
// GCP Metadata / Access Token & Secret lookup helpers for Vertex AI and API-key adapters

let cachedGcpAccessToken: { token: string; expiresAt: number } | undefined;
const cachedProviderSecrets = new Map<string, { value: string; expiresAt: number }>();

export async function gcpAccessTokenFromEnv(doFetch: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  }
  if (cachedGcpAccessToken && Date.now() < cachedGcpAccessToken.expiresAt - 60_000) {
    return cachedGcpAccessToken.token;
  }
  const res = await doFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`GCP metadata token HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('GCP metadata response had no access_token');
  cachedGcpAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
  };
  return data.access_token;
}

export async function resolveProviderSecret(secretName: string, doFetch: typeof fetch = fetch): Promise<string> {
  const fromEnv = process.env[secretName] ?? (secretName === 'GEMINI_API_KEY' ? process.env.GOOGLE_API_KEY : undefined);
  if (fromEnv) return fromEnv.trim();

  const cached = cachedProviderSecrets.get(secretName);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const gcpProject = process.env.FACTORY_SECRETS_GCP_PROJECT ?? process.env.FACTORY_GCP_PROJECT;
  if (gcpProject) {
    const prefix = process.env.FACTORY_SECRETS_GCP_PREFIX ?? '';
    const secretId = `${prefix}${secretName.replace(/\//g, '---')}`;
    const token = await gcpAccessTokenFromEnv(doFetch);
    const res = await doFetch(
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(gcpProject)}/secrets/${encodeURIComponent(secretId)}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const json = (await res.json()) as { payload?: { data?: string } };
      if (json.payload?.data) {
        const value = Buffer.from(json.payload.data, 'base64').toString('utf8').replace(/\r?\n$/, '');
        if (value) {
          cachedProviderSecrets.set(secretName, { value, expiresAt: Date.now() + 60_000 });
          return value;
        }
      }
    }
  }
  throw new Error(`secret ${secretName} not available`);
}

// ---------------------------------------------------------------------------------------------
// vertex-gemini / vertex-ai (Google Gemini on Vertex AI via generateContent)

export type VertexOptions = {
  project?: string;
  region?: string;
  accessToken?: () => Promise<string>;
  endpoint?: (region: string) => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const VERTEX_GEMINI_FINISH: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
};

export function vertexGemini(opts: VertexOptions = {}): ModelAdapter {
  const doFetch = opts.fetch ?? fetch;
  const getToken = opts.accessToken ?? (() => gcpAccessTokenFromEnv(doFetch));
  const endpoint =
    opts.endpoint ??
    ((region: string) => (region === 'global' ? 'https://aiplatform.googleapis.com' : `https://${region}-aiplatform.googleapis.com`));

  return {
    async complete(entry, req) {
      const project = opts.project ?? process.env.FACTORY_GCP_PROJECT ?? process.env.FACTORY_SECRETS_GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
      const region = entry.region ?? opts.region ?? process.env.FACTORY_GCP_REGION ?? 'us-central1';
      if (!project) throw new ModelUpstreamError(503, 'provider_misconfigured', 'FACTORY_GCP_PROJECT is not configured for Vertex AI');

      let token: string;
      try {
        token = await getToken();
      } catch (err) {
        console.error(`[gatekeeper-egress] vertex credentials: ${err instanceof Error ? err.message : String(err)}`);
        throw new ModelUpstreamError(503, 'provider_credentials_unavailable', 'gatekeeper-egress has no cloud credentials');
      }

      const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
      type GeminiPart = { text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: { content: string } } };
      const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
      /** Gemini matches a function response to its call by name; OpenAI by id. */
      const callNames = new Map<string, string>();
      for (const m of req.messages) {
        if (m.role === 'system') continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts: GeminiPart[] = [];
        if (m.role === 'tool') {
          parts.push({ functionResponse: { name: callNames.get(m.toolCallId) ?? m.toolCallId, response: { content: m.content } } });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls) {
            callNames.set(tc.id, tc.function.name);
            parts.push({ functionCall: { name: tc.function.name, args: toolArgs(tc) } });
          }
        } else {
          parts.push({ text: m.content });
        }
        const last = contents.at(-1);
        if (last && last.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
      }

      const generationConfig = {
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { topP: req.topP } : {}),
        ...(req.stop ? { stopSequences: req.stop } : {}),
      };

      const functionDeclarations: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = [];
      if (req.tool_choice !== 'none' && Array.isArray(req.tools)) {
        for (const t of req.tools) {
          if (!t || typeof t !== 'object') continue;
          const toolObj = t as Record<string, unknown>;
          if (toolObj.type === 'function' && toolObj.function && typeof toolObj.function === 'object') {
            const fn = toolObj.function as { name?: unknown; description?: unknown; parameters?: unknown };
            if (typeof fn.name === 'string') {
              functionDeclarations.push({
                name: fn.name,
                ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
                parameters: (fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
              });
            }
          } else if (typeof toolObj.name === 'string') {
            functionDeclarations.push({
              name: toolObj.name,
              ...(typeof toolObj.description === 'string' ? { description: toolObj.description } : {}),
              parameters: (toolObj.parameters && typeof toolObj.parameters === 'object' ? toolObj.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
            });
          }
        }
      }

      let toolConfig: Record<string, unknown> | undefined;
      if (req.tool_choice === 'none') {
        toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (functionDeclarations.length > 0 && req.tool_choice !== undefined) {
        if (req.tool_choice === 'auto') {
          toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        } else if (req.tool_choice === 'any' || req.tool_choice === 'required') {
          toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (typeof req.tool_choice === 'object' && req.tool_choice !== null) {
          const tc = req.tool_choice as Record<string, unknown>;
          if (tc.type === 'function' && tc.function && typeof tc.function === 'object') {
            const fnName = (tc.function as { name?: unknown }).name;
            if (typeof fnName === 'string') {
              toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [fnName] } };
            }
          }
        }
      }

      const payload = {
        contents,
        ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      };

      const url = `${endpoint(region).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(entry.id)}:generateContent`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        });
      } catch (err) {
        throw new ModelUpstreamError(502, 'upstream_unreachable', err instanceof Error ? err.message : String(err));
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        const errObj = (json as { error?: { message?: unknown } } | undefined)?.error;
        const message = String(errObj?.message ?? text).slice(0, 500);
        if (res.status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, res.status);
        throw new ModelUpstreamError(502, 'upstream_error', message, res.status);
      }

      const b = (json ?? {}) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: unknown;
              functionCall?: { name?: string; args?: unknown };
            }>;
          };
          finishReason?: string;
        }>;
        usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
      };
      const first = b.candidates?.[0];
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const p of first?.content?.parts ?? []) {
        if (typeof p.text === 'string') textParts.push(p.text);
        if (p.functionCall && typeof p.functionCall === 'object' && typeof p.functionCall.name === 'string') {
          toolCalls.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: typeof p.functionCall.args === 'string' ? p.functionCall.args : JSON.stringify(p.functionCall.args ?? {}),
            },
          });
        }
      }
      const content = textParts.join('');
      const finishReason = toolCalls.length > 0 ? 'tool_calls' : (VERTEX_GEMINI_FINISH[first?.finishReason ?? ''] ?? 'stop');
      const u = b.usageMetadata;
      const usage =
        u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number'
          ? { input: u.promptTokenCount, output: u.candidatesTokenCount }
          : null;
      return {
        content,
        finishReason,
        usage,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// vertex-anthropic & anthropic (Claude Messages API on Vertex AI or direct api.anthropic.com)

/** `modelId` drops sampling parameters the model rejects (GAP-171); without it they pass through unchanged. */
export function toAnthropicMessages(req: ChatRequest, modelId?: string) {
  const sampling = modelId === undefined || claudeAcceptsSampling(modelId);
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  type Block =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };
  const turns: Array<{ role: 'user' | 'assistant'; blocks: Block[] }> = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: Block[] = [];
    if (m.role === 'tool') {
      blocks.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: toolArgs(tc) });
    } else {
      blocks.push({ type: 'text', text: m.content });
    }
    // Consecutive same-role turns merge (the Messages API requires alternation); a run of tool results becomes one user turn.
    const last = turns.at(-1);
    if (last && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks });
  }
  // Text-only turns stay plain strings; turns with tool blocks keep their blocks (empty text blocks are rejected).
  const messages = turns.map(({ role, blocks }) =>
    blocks.every((b) => b.type === 'text')
      ? { role, content: blocks.map((b) => (b as { text: string }).text).join('\n') }
      : { role, content: blocks.filter((b) => b.type !== 'text' || b.text) },
  );

  const tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }> = [];
  if (req.tool_choice !== 'none' && Array.isArray(req.tools)) {
    for (const t of req.tools) {
      if (!t || typeof t !== 'object') continue;
      const toolObj = t as Record<string, unknown>;
      if (toolObj.type === 'function' && toolObj.function && typeof toolObj.function === 'object') {
        const fn = toolObj.function as { name?: unknown; description?: unknown; parameters?: unknown };
        if (typeof fn.name === 'string') {
          tools.push({
            name: fn.name,
            ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
            input_schema: (fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
          });
        }
      } else if (typeof toolObj.name === 'string') {
        tools.push({
          name: toolObj.name,
          ...(typeof toolObj.description === 'string' ? { description: toolObj.description } : {}),
          input_schema: (toolObj.parameters && typeof toolObj.parameters === 'object' ? toolObj.parameters : { type: 'object', properties: {} }) as Record<string, unknown>,
        });
      }
    }
  }

  let tool_choice: Record<string, unknown> | undefined;
  if (req.tool_choice !== 'none' && tools.length > 0 && req.tool_choice !== undefined) {
    if (req.tool_choice === 'auto') {
      tool_choice = { type: 'auto' };
    } else if (req.tool_choice === 'any' || req.tool_choice === 'required') {
      tool_choice = { type: 'any' };
    } else if (typeof req.tool_choice === 'object' && req.tool_choice !== null) {
      const tc = req.tool_choice as Record<string, unknown>;
      if (tc.type === 'function' && tc.function && typeof tc.function === 'object') {
        const fnName = (tc.function as { name?: unknown }).name;
        if (typeof fnName === 'string') {
          tool_choice = { type: 'tool', name: fnName };
        }
      }
    }
  }

  return {
    max_tokens: req.maxTokens ?? 4096,
    messages,
    ...(system ? { system } : {}),
    ...(sampling && req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(sampling && req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop ? { stop_sequences: req.stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
  };
}

function fromAnthropicMessages(body: unknown): ChatResult {
  const b = (body ?? {}) as {
    content?: Array<{ type?: string; text?: unknown; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: Record<string, unknown>;
  };
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const c of b.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') {
      textParts.push(c.text);
    } else if (c.type === 'tool_use' && typeof c.name === 'string') {
      toolCalls.push({
        id: typeof c.id === 'string' ? c.id : `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}),
        },
      });
    }
  }
  const content = textParts.join('');
  const u = b.usage;
  const inTok = u && typeof u['input_tokens'] === 'number' ? (u['input_tokens'] as number) : undefined;
  const outTok = u && typeof u['output_tokens'] === 'number' ? (u['output_tokens'] as number) : undefined;
  const usage = inTok !== undefined && outTok !== undefined ? { input: inTok, output: outTok } : null;
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : (FINISH[b.stop_reason ?? ''] ?? 'stop');
  return {
    content,
    finishReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export function vertexAnthropic(opts: VertexOptions = {}): ModelAdapter {
  const doFetch = opts.fetch ?? fetch;
  const getToken = opts.accessToken ?? (() => gcpAccessTokenFromEnv(doFetch));
  const endpoint =
    opts.endpoint ??
    ((region: string) => (region === 'global' ? 'https://aiplatform.googleapis.com' : `https://${region}-aiplatform.googleapis.com`));

  return {
    async complete(entry, req) {
      const project = opts.project ?? process.env.FACTORY_GCP_PROJECT ?? process.env.FACTORY_SECRETS_GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
      const region = entry.region ?? opts.region ?? process.env.FACTORY_GCP_REGION ?? 'us-east5';
      if (!project) throw new ModelUpstreamError(503, 'provider_misconfigured', 'FACTORY_GCP_PROJECT is not configured for Vertex AI');

      let token: string;
      try {
        token = await getToken();
      } catch (err) {
        console.error(`[gatekeeper-egress] vertex-anthropic credentials: ${err instanceof Error ? err.message : String(err)}`);
        throw new ModelUpstreamError(503, 'provider_credentials_unavailable', 'gatekeeper-egress has no cloud credentials');
      }

      const payload = { anthropic_version: 'vertex-2023-10-16', ...toAnthropicMessages(req, entry.id) };
      const url = `${endpoint(region).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/anthropic/models/${encodeURIComponent(entry.id)}:rawPredict`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        });
      } catch (err) {
        throw new ModelUpstreamError(502, 'upstream_unreachable', err instanceof Error ? err.message : String(err));
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        const errObj = (json as { error?: { message?: unknown } } | undefined)?.error;
        const message = String(errObj?.message ?? text).slice(0, 500);
        if (res.status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, res.status);
        throw new ModelUpstreamError(502, 'upstream_error', message, res.status);
      }
      return fromAnthropicMessages(json);
    },
  };
}

export type ApiKeyAdapterOptions = {
  apiKey?: () => Promise<string>;
  secretName?: string;
  endpoint?: string;
  chatPath?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  resolveSecret?: (secretName: string) => Promise<string>;
};

async function resolveApiKey(
  opts: ApiKeyAdapterOptions,
  entry: CatalogEntry,
  defaultSecret: string,
  doFetch: typeof fetch,
): Promise<string> {
  const targetSecret = entry.secret ?? opts.secretName ?? defaultSecret;
  try {
    let key: string | undefined;
    if (opts.apiKey) {
      key = await opts.apiKey();
    } else if (opts.resolveSecret) {
      key = await opts.resolveSecret(targetSecret);
    } else {
      key = await resolveProviderSecret(targetSecret, doFetch);
    }
    if (!key) {
      throw new Error(`secret ${targetSecret} resolved to empty value`);
    }
    return key;
  } catch (err) {
    console.error(`[gatekeeper-egress] ${targetSecret} credentials: ${err instanceof Error ? err.message : String(err)}`);
    throw new ModelUpstreamError(503, 'provider_credentials_unavailable', 'gatekeeper-egress has no provider credentials');
  }
}

export function anthropicMessages(opts: ApiKeyAdapterOptions = {}): ModelAdapter {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.endpoint ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    async complete(entry, req) {
      const key = await resolveApiKey(opts, entry, 'ANTHROPIC_API_KEY', doFetch);
      const payload = { model: entry.id, ...toAnthropicMessages(req, entry.id) };
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        });
      } catch (err) {
        throw new ModelUpstreamError(502, 'upstream_unreachable', err instanceof Error ? err.message : String(err));
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        const errObj = (json as { error?: { message?: unknown } } | undefined)?.error;
        const message = String(errObj?.message ?? text).slice(0, 500);
        if (res.status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, res.status);
        throw new ModelUpstreamError(502, 'upstream_error', message, res.status);
      }
      return fromAnthropicMessages(json);
    },
  };
}

export function openAiCompatible(opts: ApiKeyAdapterOptions = {}): ModelAdapter {
  const doFetch = opts.fetch ?? fetch;
  const defaultBase = (opts.endpoint ?? 'https://api.openai.com').replace(/\/$/, '');
  const chatPath = opts.chatPath ?? '/v1/chat/completions';

  return {
    async complete(entry, req) {
      const key = await resolveApiKey(opts, entry, 'OPENAI_API_KEY', doFetch);
      const base = (entry.endpoint ?? defaultBase).replace(/\/$/, '');
      const chatUrl = `${base}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`;
      const payload: Record<string, unknown> = {
        model: entry.id,
        messages: toOpenAiMessages(req.messages),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(req.stop ? { stop: req.stop } : {}),
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
      };
      let res: Response;
      try {
        res = await doFetch(chatUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        });
      } catch (err) {
        throw new ModelUpstreamError(502, 'upstream_unreachable', err instanceof Error ? err.message : String(err));
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) {
        const errObj = (json as { error?: { message?: unknown } } | undefined)?.error;
        const message = String(errObj?.message ?? text).slice(0, 500);
        if (res.status === 429) throw new ModelUpstreamError(429, 'upstream_throttled', message, res.status);
        throw new ModelUpstreamError(502, 'upstream_error', message, res.status);
      }
      const b = (json ?? {}) as {
        choices?: Array<{
          message?: {
            content?: unknown;
            tool_calls?: Array<{
              id?: unknown;
              type?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: Record<string, unknown>;
      };
      const first = b.choices?.[0];
      const content = typeof first?.message?.content === 'string' ? first.message.content : '';
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(first?.message?.tool_calls)) {
        for (const tc of first.message.tool_calls) {
          const fn = tc?.function;
          if (typeof fn?.name === 'string') {
            toolCalls.push({
              id: typeof tc.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2, 10)}`,
              type: 'function',
              function: {
                name: fn.name,
                arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
              },
            });
          }
        }
      }
      const finishReason = toolCalls.length > 0 ? 'tool_calls' : (typeof first?.finish_reason === 'string' ? first.finish_reason : 'stop');
      const u = b.usage;
      const inTok = u && typeof u['prompt_tokens'] === 'number' ? (u['prompt_tokens'] as number) : undefined;
      const outTok = u && typeof u['completion_tokens'] === 'number' ? (u['completion_tokens'] as number) : undefined;
      const usage = inTok !== undefined && outTok !== undefined ? { input: inTok, output: outTok } : null;
      return {
        content,
        finishReason,
        usage,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}

/** The secret names the built-in API-key vendors use: the built-in platform credentials (GAP-167). */
export const BUILTIN_PROVIDER_SECRETS: readonly string[] = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY'];

export type DefaultModelAdaptersOptions = {
  resolveSecret?: (secretName: string) => Promise<string>;
  fetch?: typeof fetch;
};

/** Adapters by catalog `provider`. Supports AWS Bedrock, GCP Vertex AI (Gemini & Claude), and API-key providers (Anthropic, OpenAI, xAI, Google/Gemini). */
export function defaultModelAdapters(opts: DefaultModelAdaptersOptions = {}): Record<string, ModelAdapter> {
  const doFetch = opts.fetch ?? fetch;
  const gemini = vertexGemini({ fetch: doFetch });
  const vClaude = vertexAnthropic({ fetch: doFetch });
  const anthropic = anthropicMessages({
    fetch: doFetch,
    resolveSecret: opts.resolveSecret,
  });
  const openai = openAiCompatible({
    secretName: 'OPENAI_API_KEY',
    endpoint: 'https://api.openai.com',
    fetch: doFetch,
    resolveSecret: opts.resolveSecret,
  });
  const xai = openAiCompatible({
    secretName: 'XAI_API_KEY',
    endpoint: 'https://api.x.ai',
    fetch: doFetch,
    resolveSecret: opts.resolveSecret,
  });
  const directGemini = openAiCompatible({
    secretName: 'GEMINI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatPath: '/chat/completions',
    fetch: doFetch,
    resolveSecret: opts.resolveSecret,
  });
  return {
    'bedrock-converse': bedrockConverse(),
    'vertex-ai': gemini,
    'vertex-gemini': gemini,
    'vertex-anthropic': vClaude,
    anthropic,
    'anthropic-messages': anthropic,
    openai,
    xai,
    gemini: directGemini,
    google: directGemini,
  };
}

