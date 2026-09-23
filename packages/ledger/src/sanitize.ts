import { createHash } from 'node:crypto';

export const LEDGER_TYPES = ['llm', 'mcp', 'action', 'crash', 'budget.alert'] as const;

export type LedgerEvent = {
  timestamp: string;
  agentId: string;
  type: string;
  actor?: string;
  requestId?: string;
  runId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  mcpMethod?: string;
  mcpName?: string;
  action?: string;
  payloadSha256?: string;
  costUsd?: number;
  route?: string;
  approvalId?: string;
  leaseId?: string;
  gatedSecret?: string;
  turnId?: string;
};

const ALLOWED = new Set<keyof LedgerEvent>([
  'timestamp',
  'agentId',
  'type',
  'actor',
  'requestId',
  'runId',
  'model',
  'inputTokens',
  'outputTokens',
  'mcpMethod',
  'mcpName',
  'action',
  'payloadSha256',
  'costUsd',
  'route',
  'approvalId',
  'leaseId',
  'gatedSecret',
  'turnId',
]);

const PAYLOAD_KEYS = ['payload', 'body', 'content', 'prompt', 'params', 'messages', 'text', 'input', 'output'];

export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortValue(rec[k]);
    return out;
  }
  return value;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** Exact-string mask. Longest secrets first. Ignore tiny values so we do not eat "ok". */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const list = [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of list) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env.FACTORY_REDACT_NAMES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const auto = Object.keys(env).filter((k) => /(_TOKEN|_SECRET|_KEY|_PASSWORD)$/i.test(k));
  const values: string[] = [];
  for (const name of [...named, ...auto]) {
    const v = env[name];
    if (v && v.length >= 4) values.push(v);
  }
  return values;
}

function toxicPayload(raw: Record<string, unknown>): unknown {
  const bag: Record<string, unknown> = {};
  let found = false;
  for (const key of PAYLOAD_KEYS) {
    if (raw[key] !== undefined) {
      bag[key] = raw[key];
      found = true;
    }
  }
  if (!found) return undefined;
  const keys = Object.keys(bag);
  if (keys.length === 1) return bag[keys[0]];
  return bag;
}

function asType(raw: unknown): string {
  const t = String(raw ?? 'action');
  if ((LEDGER_TYPES as readonly string[]).includes(t)) return t;
  if (/^[a-z0-9._-]{1,64}$/i.test(t)) return t;
  return 'action';
}

export function toLedgerEvent(raw: Record<string, unknown>, secrets: Iterable<string> = []): LedgerEvent {
  const event: LedgerEvent = {
    timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString(),
    agentId: String(raw.agentId ?? ''),
    type: asType(raw.type),
  };
  if (raw.actor !== undefined) event.actor = String(raw.actor);
  if (raw.requestId !== undefined) event.requestId = String(raw.requestId);
  if (raw.runId !== undefined) event.runId = String(raw.runId);
  if (raw.model !== undefined) event.model = String(raw.model);
  if (typeof raw.inputTokens === 'number') event.inputTokens = raw.inputTokens;
  if (typeof raw.outputTokens === 'number') event.outputTokens = raw.outputTokens;
  if (raw.mcpMethod !== undefined) event.mcpMethod = String(raw.mcpMethod);
  if (raw.mcpName !== undefined) event.mcpName = String(raw.mcpName);
  if (raw.action !== undefined) event.action = String(raw.action);
  if (typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd)) event.costUsd = raw.costUsd;
  if (raw.route !== undefined) event.route = String(raw.route);
  if (raw.approvalId !== undefined) event.approvalId = String(raw.approvalId);
  if (raw.leaseId !== undefined) event.leaseId = String(raw.leaseId);
  if (raw.gatedSecret !== undefined) event.gatedSecret = String(raw.gatedSecret);
  if (raw.turnId !== undefined) event.turnId = String(raw.turnId);
  if (raw.payloadSha256 !== undefined) event.payloadSha256 = String(raw.payloadSha256);
  else {
    const toxic = toxicPayload(raw);
    if (toxic !== undefined) event.payloadSha256 = payloadHash(toxic);
  }

  const line = JSON.stringify(event);
  const masked = redactSecrets(line, secrets);
  const parsed = JSON.parse(masked) as LedgerEvent;
  for (const key of Object.keys(parsed) as (keyof LedgerEvent)[]) {
    if (!ALLOWED.has(key)) delete parsed[key];
  }
  return parsed;
}
