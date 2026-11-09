import { createHash } from 'node:crypto';

export const LEDGER_TYPES = ['llm', 'mcp', 'action', 'crash', 'budget.alert'] as const;

export type LedgerEvent = {
  timestamp: string;
  agentId: string;
  type: string;
  actor?: string;
  requestId?: string;
  runId?: string;
  /** Authoritative trigger of the run (`schedule`, `cron`, `conversation`, `discord`, `api`, `smoke`, etc., #345). */
  trigger?: string;
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
  /** E1.5 (#296): a helper run's parent run and agent, stamped by the control plane from the run record. */
  parentRunId?: string;
  parentAgentId?: string;
  /** Egress destination of a tunnelled or proxied connection (hostname only) — E3. */
  host?: string;
  port?: number;
  /** Full git commit SHA (admission and deploys, §6.8). */
  commit?: string;
  /** Upstream HTTP status of a gatekeeper-egress route call (E3). */
  status?: number;
  /** Keymaster connection (§6.11): provider or connection name, and the scopes granted. Never tokens. */
  provider?: string;
  connection?: string;
  scopes?: string[];
  /** Keymaster static credential (§6.11 K5.3): the secret's declared name only. Never its value. */
  credential?: string;
  /** M2 (GAP-181): the model name an agent's call carried when the factory served another. */
  requestedModel?: string;
  /** The provider's own model id the factory model API called. */
  upstreamModel?: string;
  /** Model names a model-catalog change touched (e.g. MODEL_RELINKED, GAP-182). */
  models?: string[];
  /** AP3 (GAP-178): a hash of a final model answer, never its text. */
  replySha256?: string;
  /** AP3: the footnote a reply received. */
  footnote?: '[no tools called]' | '[no model or tools used]';
  /** AP3.3: the request id of the warn-once retry, and whether it called a tool. */
  retryRequestId?: string;
  toolCalled?: boolean;
  /** AM5: whose conversation an admin read (an actor, never content). */
  subject?: string;
  /** S3 / D10: canonical human principal (`user:<id>`) on whose behalf an admin executed the action. */
  onBehalfOf?: string;
  /** S3 / S7 / M5(4): structured grant scope (`fleet` or `agent`/`skill` with id) for grant/authz rows, or subscription scope (`'factory' | 'personal'`). */
  scope?: { kind: 'fleet' } | { kind: 'agent' | 'skill'; id: string } | 'factory' | 'personal';
  /** M5(4): canonical owner principal (`user:<id>`) of a `personal` subscription connection. */
  ownerPrincipalId?: string;
  /** S3 / S7: structured pre-mutation principal/grant snapshot (`null` when newly created). */
  before?: Record<string, unknown> | null;
  /** S3 / S7: structured post-mutation principal/grant snapshot (`null` when deleted/revoked). */
  after?: Record<string, unknown> | null;
  /** S18: legacy owner string converted to canonical principal and grant. */
  legacyOwner?: string;
  /** S7: the privilege a denied (`AUTHZ_DENIED`) call asked for; its resource is `scope`. */
  privilege?: string;
  principalId?: string;
  role?: string;
  /** M5(4): a model subscription connection's row. The subscriber's account email and plan tier, the connection's display name, whether the admin attested the subscriber agreed, and whether this connect replaced an existing grant. Never a token. */
  subscriber?: string;
  tier?: string;
  connectionName?: string;
  previousName?: string;
  attested?: boolean;
  reconnect?: boolean;
  entriesRetired?: number;
  /** M5(6) to (8): a plan-limit window row (`SUBSCRIPTION_LIMIT_*`): what opened it, the vendor's error code, its reset time, what closed it. Never vendor text. */
  limitKind?: 'plan-limit' | 'tier-refused';
  limitCode?: string;
  resetAt?: string;
  closedBy?: 'reset' | 'probe' | 'disconnect';
  /** M5: the credential mode a call was served on (`subscription`), and why a failover skipped the selected entry. */
  credentialMode?: 'api-key' | 'subscription';
  failoverReason?: string;
  /** M5(2), (8): per-agent daily token cap updates, cap reach/reset rows, priced-fallback notices, and vendor-withdrawal metadata. */
  dailyTokenCap?: number | null;
  tokensUsed?: number;
  utcDay?: string;
  templateId?: string;
};

const ALLOWED = new Set<keyof LedgerEvent>([
  'dailyTokenCap',
  'tokensUsed',
  'utcDay',
  'templateId',
  'limitKind',
  'limitCode',
  'resetAt',
  'closedBy',
  'credentialMode',
  'failoverReason',
  'subscriber',
  'tier',
  'connectionName',
  'previousName',
  'attested',
  'reconnect',
  'entriesRetired',
  'privilege',
  'legacyOwner',
  'principalId',
  'role',
  'requestedModel',
  'parentRunId',
  'parentAgentId',
  'upstreamModel',
  'models',
  'replySha256',
  'footnote',
  'retryRequestId',
  'toolCalled',
  'subject',
  'onBehalfOf',
  'scope',
  'ownerPrincipalId',
  'before',
  'after',
  'timestamp',
  'agentId',
  'type',
  'actor',
  'requestId',
  'runId',
  'trigger',
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
  'host',
  'port',
  'commit',
  'status',
  'provider',
  'connection',
  'scopes',
  'credential',
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

const AUDIT_ID_FIELD = /^[A-Za-z0-9:._@+-]{1,256}$/;
const AUDIT_SAFE_SCALAR_KEYS = new Set([
  'id',
  'kind',
  'subject',
  'subjectKind',
  'role',
  'state',
  'expiresAt',
  'grantedBy',
  'grantedAt',
  'onBehalfOf',
  'transferId',
  'transferExpiresAt',
  'pendingExpiresAt',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
]);

function sanitizeGrantScope(raw: unknown): { kind: 'fleet' } | { kind: 'agent' | 'skill'; id: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (s.kind === 'fleet') return { kind: 'fleet' };
  if ((s.kind === 'agent' || s.kind === 'skill') && typeof s.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s.id)) {
    return { kind: s.kind, id: s.id };
  }
  return undefined;
}

function sanitizeAuditSnapshot(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(src)) {
    if (val === undefined) continue;
    if (key === 'displayName') {
      if (typeof val === 'string') {
        const clean = val.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 256);
        if (clean) out.displayName = clean;
      }
      continue;
    }
    if (key === 'emails') {
      if (Array.isArray(val)) {
        const emails = val
          .filter((e): e is string => typeof e === 'string' && AUDIT_ID_FIELD.test(e) && e.includes('@'))
          .slice(0, 32);
        out.emails = emails;
      }
      continue;
    }
    if (key === 'scope') {
      const sc = sanitizeGrantScope(val);
      if (sc) out.scope = sc;
      continue;
    }
    if (key === 'version') {
      if (typeof val === 'number' && Number.isInteger(val) && val >= 0) {
        out.version = val;
      }
      continue;
    }
    if (AUDIT_SAFE_SCALAR_KEYS.has(key)) {
      if (val === null) {
        out[key] = null;
      } else if (typeof val === 'string' && AUDIT_ID_FIELD.test(val)) {
        out[key] = val;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const ident = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
  if (ident(raw.trigger)) event.trigger = raw.trigger;
  if (ident(raw.parentRunId)) event.parentRunId = raw.parentRunId;
  if (ident(raw.parentAgentId)) event.parentAgentId = raw.parentAgentId;
  // Only well-formed values: these fields must never become a channel for arbitrary text.
  if (typeof raw.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(raw.host)) event.host = raw.host.toLowerCase();
  if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) event.port = raw.port;
  if (typeof raw.commit === 'string' && /^[0-9a-f]{40}$/.test(raw.commit)) event.commit = raw.commit;
  if (typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 100 && raw.status < 600) event.status = raw.status;
  if (typeof raw.provider === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw.provider)) event.provider = raw.provider;
  if (typeof raw.connection === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw.connection)) event.connection = raw.connection;
  if (Array.isArray(raw.scopes)) {
    // Scope identifiers only (e.g. https://www.googleapis.com/auth/calendar.readonly), never free text.
    const scopes = raw.scopes.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9._:/#-]{1,200}$/.test(s)).slice(0, 64);
    if (scopes.length) event.scopes = scopes;
  }
  // An ENV-style secret name (as cartridges declare them), never free text: a value pasted here is dropped.
  if (typeof raw.credential === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(raw.credential)) event.credential = raw.credential;
  // Model names and ids: identifier characters only (e.g. claude-haiku-5-5, us.anthropic.x-v1:0, models/gemini-x).
  const modelName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:/@-]{1,128}$/.test(v);
  if (modelName(raw.requestedModel)) event.requestedModel = raw.requestedModel;
  if (modelName(raw.upstreamModel)) event.upstreamModel = raw.upstreamModel;
  if (Array.isArray(raw.models)) {
    const models = raw.models.filter(modelName).slice(0, 256);
    if (models.length) event.models = models;
  }
  if (typeof raw.replySha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.replySha256)) event.replySha256 = raw.replySha256;
  if (raw.footnote === '[no tools called]' || raw.footnote === '[no model or tools used]') event.footnote = raw.footnote;
  if (typeof raw.retryRequestId === 'string' && /^[0-9a-f-]{36}$/.test(raw.retryRequestId)) event.retryRequestId = raw.retryRequestId;
  if (typeof raw.toolCalled === 'boolean') event.toolCalled = raw.toolCalled;
  if (typeof raw.privilege === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){0,4}$/.test(raw.privilege) && raw.privilege.length <= 96) event.privilege = raw.privilege;
  if (typeof raw.onBehalfOf === 'string' && AUDIT_ID_FIELD.test(raw.onBehalfOf)) event.onBehalfOf = raw.onBehalfOf;
  if (raw.scope === 'factory' || raw.scope === 'personal') {
    event.scope = raw.scope;
  } else {
    const cleanScope = sanitizeGrantScope(raw.scope);
    if (cleanScope) event.scope = cleanScope;
  }
  if (
    typeof raw.ownerPrincipalId === 'string' &&
    raw.ownerPrincipalId.length <= 320 &&
    /^user:[A-Za-z0-9!#$%&'*+/=?^_`{|}~@.-]{1,315}$/.test(raw.ownerPrincipalId)
  ) {
    event.ownerPrincipalId = raw.ownerPrincipalId;
  }
  if (raw.before !== undefined) {
    const cleanBefore = sanitizeAuditSnapshot(raw.before);
    if (cleanBefore !== undefined) event.before = cleanBefore;
  }
  if (raw.after !== undefined) {
    const cleanAfter = sanitizeAuditSnapshot(raw.after);
    if (cleanAfter !== undefined) event.after = cleanAfter;
  }
  if (
    typeof raw.subject === 'string' &&
    raw.subject.length <= 320 &&
    !raw.subject.startsWith('fk_') &&
    /^(?:[a-z][a-z0-9-]{0,31}:[A-Za-z0-9!#$%&'*+/=?^_`{|}~@.:-]{1,287}|[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+)$/.test(raw.subject)
  ) {
    event.subject = raw.subject;
  }
  if (
    typeof raw.legacyOwner === 'string' &&
    raw.legacyOwner.length <= 320 &&
    !raw.legacyOwner.startsWith('fk_') &&
    /^(?:(?:user|cloudflare|oidc):[A-Za-z0-9!#$%&'*+/=?^_`{|}~@.-]{1,315}|[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+)$/.test(raw.legacyOwner)
  ) {
    event.legacyOwner = raw.legacyOwner;
  }
  if (
    typeof raw.principalId === 'string' &&
    raw.principalId.length <= 320 &&
    /^user:[A-Za-z0-9!#$%&'*+/=?^_`{|}~@.-]{1,315}$/.test(raw.principalId)
  ) {
    event.principalId = raw.principalId;
  }
  if (typeof raw.role === 'string' && /^[a-z0-9_-]{1,64}$/.test(raw.role)) event.role = raw.role;
  // M5(4): subscription connection rows. Email, tier and names are shape-checked; nothing here can carry a token.
  if (typeof raw.subscriber === 'string' && raw.subscriber.length <= 320 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+$/.test(raw.subscriber)) event.subscriber = raw.subscriber;
  if (typeof raw.tier === 'string' && /^[A-Za-z0-9 ._+:-]{1,64}$/.test(raw.tier)) event.tier = raw.tier;
  const displayName = (v: unknown): v is string => typeof v === 'string' && v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().length > 0;
  if (displayName(raw.connectionName)) event.connectionName = raw.connectionName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80);
  if (displayName(raw.previousName)) event.previousName = raw.previousName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80);
  if (typeof raw.attested === 'boolean') event.attested = raw.attested;
  if (typeof raw.reconnect === 'boolean') event.reconnect = raw.reconnect;
  if (typeof raw.entriesRetired === 'number' && Number.isInteger(raw.entriesRetired) && raw.entriesRetired >= 0) event.entriesRetired = raw.entriesRetired;
  // M5(6) to (8): plan-limit window rows and the credential mode of a call. Closed enums, a vendor error code's shape, an ISO time.
  if (raw.limitKind === 'plan-limit' || raw.limitKind === 'tier-refused') event.limitKind = raw.limitKind;
  if (typeof raw.limitCode === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(raw.limitCode)) event.limitCode = raw.limitCode;
  if (typeof raw.resetAt === 'string' && raw.resetAt.length <= 40 && Number.isFinite(Date.parse(raw.resetAt))) event.resetAt = raw.resetAt;
  if (raw.closedBy === 'reset' || raw.closedBy === 'probe' || raw.closedBy === 'disconnect') event.closedBy = raw.closedBy;
  if (raw.credentialMode === 'api-key' || raw.credentialMode === 'subscription') event.credentialMode = raw.credentialMode;
  if (typeof raw.failoverReason === 'string' && /^[a-z0-9_]{1,64}$/.test(raw.failoverReason)) event.failoverReason = raw.failoverReason;
  if (raw.dailyTokenCap === null || (typeof raw.dailyTokenCap === 'number' && Number.isInteger(raw.dailyTokenCap) && raw.dailyTokenCap > 0)) {
    event.dailyTokenCap = raw.dailyTokenCap;
  }
  if (typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) && raw.tokensUsed >= 0) {
    event.tokensUsed = raw.tokensUsed;
  }
  if (typeof raw.utcDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.utcDay)) {
    event.utcDay = raw.utcDay;
  }
  if (typeof raw.templateId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw.templateId)) {
    event.templateId = raw.templateId;
  }
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
