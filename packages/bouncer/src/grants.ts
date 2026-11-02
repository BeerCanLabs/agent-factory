import { randomUUID } from 'node:crypto';
import { ROLES, type Principal, type Role } from '@beercanlabs/factory-auth';
import {
  DuplicatePrincipalEmailError,
  EMAIL_DOMAIN_BODY,
  MemoryDocBackend,
  PRINCIPAL_ID,
  PrincipalStore,
  PrincipalStoreUnavailableError,
  SERVICE_PRINCIPAL_ID,
  SLUG_BODY,
  isValidUserPrincipalId,
  normalizeDomain,
  normalizeEmail,
  snapshotSha256,
  type PrincipalRecord,
  type VersionedDocBackend,
} from './principals.js';

const GROUP_ID_BODY = '(?:[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]|[a-z0-9])';
const SCOPE_ID_REGEX = new RegExp(`^${SLUG_BODY}$`);
const GRANT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const AGENT_SUBROLE_REGEX = /^(?:subrole:)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_8601_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const DOMAIN_SUBJECT = new RegExp(`^domain:${EMAIL_DOMAIN_BODY}$`);
export const GROUP_SUBJECT = new RegExp(`^group:${GROUP_ID_BODY}$`);
export const GRANT_SUBJECT = new RegExp(
  `^(?:${PRINCIPAL_ID.source.slice(1, -1)}|domain:${EMAIL_DOMAIN_BODY}|group:${GROUP_ID_BODY}|${SERVICE_PRINCIPAL_ID.source.slice(1, -1)})$`,
);

export const FLEET_HUMAN_ROLES = ['viewer', 'operator', 'approver', 'admin', 'budget-owner'] as const;
export type FleetHumanRole = (typeof FLEET_HUMAN_ROLES)[number];

export const FLEET_SERVICE_ROLES = ['ingest', 'gatekeeper-egress', 'gatekeeper-ingress'] as const;
export type FleetServiceRole = (typeof FLEET_SERVICE_ROLES)[number];

export type FleetGrantRole = FleetHumanRole | FleetServiceRole;

export const AGENT_BUILTIN_ROLES = ['content-owner', 'accountable-lead', 'member', 'agent-member'] as const;
export type AgentBuiltInRole = (typeof AGENT_BUILTIN_ROLES)[number];

export const SKILL_GRANT_ROLES = ['content-owner', 'member'] as const;
export type SkillGrantRole = (typeof SKILL_GRANT_ROLES)[number];

export const GRANT_STATES = ['active', 'pending-revoked', 'pending-accepted'] as const;
export type GrantState = (typeof GRANT_STATES)[number];

export type GrantSubjectKind = 'user' | 'domain' | 'group' | 'service';

export type GrantScope =
  | { kind: 'fleet' }
  | { kind: 'agent'; id: string }
  | { kind: 'skill'; id: string };

export type GrantRecord = {
  id: string;
  subject: string;
  scope: GrantScope;
  role: string;
  state: GrantState;
  expiresAt: string | null;
  transferId?: string;
  pendingExpiresAt?: string | null;
  onBehalfOf?: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type GrantsDoc = {
  grants: GrantRecord[];
};

export type GrantErrorCode =
  | 'invalid_grant'
  | 'invalid_subject'
  | 'invalid_scope'
  | 'invalid_role'
  | 'invalid_expiry'
  | 'expired_timestamp'
  | 'unknown_subject'
  | 'forbidden'
  | 'grant_not_found'
  | 'transfer_not_found'
  | 'owner_exists'
  | 'lead_exists'
  | 'budget_owner_exists'
  | 'agent_kind_conflict'
  | 'last_admin'
  | 'transfer_conflict'
  | 'transfer_expired';

export class GrantStoreError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: GrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GrantStoreError';
  }
}

export class GrantStoreUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'grant_store_unavailable';
  constructor(cause?: unknown) {
    super(`grant store unavailable: ${cause instanceof Error ? cause.message : String(cause ?? 'unhealthy')}`);
    this.name = 'GrantStoreUnavailableError';
  }
}

export type KnownGroupsCheck = ReadonlySet<string> | ((groupId: string) => boolean);

export type GrantStoreOptions = {
  now?: () => Date;
  principals?: PrincipalStore;
  knownGroups?: KnownGroupsCheck;
};

export type CreateGrantInput = {
  id?: string;
  subject: string;
  subjectDisplayName?: string;
  scope: GrantScope;
  role: string;
  expiresAt?: string | null;
  state?: GrantState;
  transferId?: string;
  pendingExpiresAt?: string | null;
  by: string;
  onBehalfOf?: string;
  granterIsAdmin?: boolean;
  granterRole?: 'admin' | 'content-owner' | 'accountable-lead';
  agentKind?: 'personal' | 'team';
  replaceExisting?: boolean;
  principals?: PrincipalStore;
  knownGroups?: KnownGroupsCheck;
};

export type UpdateGrantInput = {
  role?: string;
  expiresAt?: string | null;
  state?: GrantState;
  by: string;
  onBehalfOf?: string;
};

export type RevokeGrantOptions = {
  by: string;
  onBehalfOf?: string;
};

export type EffectiveGrantQuery = {
  subject?: string;
  emails?: readonly string[];
  groupIds?: readonly string[];
  at?: Date;
};

export type EffectiveGrant = {
  grant: GrantRecord;
  source: 'direct' | 'group' | 'domain';
  /** True while an outgoing `content-owner` grant is in `pending-revoked` before transfer expiry (D15). */
  readOnly: boolean;
};

export type EvaluateEffectiveGrantsResult =
  | {
      ok: true;
      allowed: boolean;
      grants: EffectiveGrant[];
      roles: Role[];
      fleetRoles: FleetGrantRole[];
    }
  | {
      ok: false;
      allowed: false;
      status: 503;
      code: 'grant_store_unavailable' | 'principal_store_unavailable';
      message: string;
    };

export type MaterializeSignInInput = {
  idp: string;
  sub?: string;
  email: string;
  emailVerified?: boolean;
  displayName?: string;
  groupIds?: readonly string[];
  principals?: PrincipalStore;
};

export type MaterializeSignInResult =
  | {
      ok: true;
      admitted: boolean;
      materialized: boolean;
      principal: Principal | null;
      record: PrincipalRecord | null;
      normalizedEmail: string;
      grants: EffectiveGrant[];
      fleetRoles: FleetGrantRole[];
    }
  | {
      ok: false;
      reason: 'email_not_verified' | 'invalid_email' | 'invalid_idp';
    };

export type StartOwnershipTransferInput = {
  scope: { kind: 'agent' | 'skill'; id: string };
  fromSubject: string;
  toSubject: string;
  by: string;
  onBehalfOf?: string;
  ttlMs?: number;
  transferId?: string;
  granterIsAdmin?: boolean;
  principals?: PrincipalStore;
};

export type ResolveOwnershipTransferInput = {
  transferId: string;
  action: 'accept' | 'decline' | 'cancel';
  by: string;
  onBehalfOf?: string;
};

export const DEFAULT_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RESERVED_AGENT_SUBROLES = new Set([
  'owner',
  'admin',
  'operator',
  'approver',
  'viewer',
  'budget-owner',
  'ingest',
  'gatekeeper-egress',
  'gatekeeper-ingress',
  'skill-owner',
]);

const AUTH_ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const FLEET_HUMAN_ROLE_SET: ReadonlySet<string> = new Set(FLEET_HUMAN_ROLES);
const FLEET_SERVICE_ROLE_SET: ReadonlySet<string> = new Set(FLEET_SERVICE_ROLES);

export function normalizeGroupSubjectId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new GrantStoreError(400, 'invalid_subject', `invalid group id: ${JSON.stringify(raw)}`);
  }
  const trimmed = raw.trim().toLowerCase();
  const body = trimmed.startsWith('group:') ? trimmed.slice('group:'.length) : trimmed;
  if (!GROUP_SUBJECT.test(`group:${body}`) || FORBIDDEN_OBJECT_KEYS.has(body)) {
    throw new GrantStoreError(400, 'invalid_subject', `invalid group id: ${JSON.stringify(raw)}`);
  }
  return body;
}

export function parseGrantSubject(raw: unknown): { subject: string; kind: GrantSubjectKind } {
  if (typeof raw !== 'string') {
    throw new GrantStoreError(400, 'invalid_subject', `subject must be a string: ${JSON.stringify(raw)}`);
  }
  const clean = raw.trim().toLowerCase();
  if (!clean || clean.length > 320 || /\s/.test(clean)) {
    throw new GrantStoreError(400, 'invalid_subject', `invalid grant subject: ${JSON.stringify(raw)}`);
  }
  if (isValidUserPrincipalId(clean)) {
    return { subject: clean, kind: 'user' };
  }
  if (DOMAIN_SUBJECT.test(clean)) {
    return { subject: clean, kind: 'domain' };
  }
  if (GROUP_SUBJECT.test(clean)) {
    const gid = clean.slice('group:'.length);
    if (FORBIDDEN_OBJECT_KEYS.has(gid)) {
      throw new GrantStoreError(400, 'invalid_subject', `invalid group subject: ${JSON.stringify(raw)}`);
    }
    return { subject: clean, kind: 'group' };
  }
  if (SERVICE_PRINCIPAL_ID.test(clean)) {
    return { subject: clean, kind: 'service' };
  }
  throw new GrantStoreError(400, 'invalid_subject', `invalid grant subject: ${JSON.stringify(raw)}`);
}

export function normalizeGrantScope(raw: unknown): GrantScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GrantStoreError(400, 'invalid_scope', 'grant scope must be an object');
  }
  const obj = raw as { kind?: unknown; id?: unknown };
  if (obj.kind === 'fleet') {
    if (obj.id !== undefined) {
      throw new GrantStoreError(400, 'invalid_scope', 'fleet scope must not specify an id');
    }
    return { kind: 'fleet' };
  }
  if (obj.kind === 'agent' || obj.kind === 'skill') {
    if (typeof obj.id !== 'string') {
      throw new GrantStoreError(400, 'invalid_scope', `${obj.kind} scope requires a string id`);
    }
    const id = obj.id.trim().toLowerCase();
    if (!SCOPE_ID_REGEX.test(id) || FORBIDDEN_OBJECT_KEYS.has(id)) {
      throw new GrantStoreError(400, 'invalid_scope', `invalid ${obj.kind} scope id: ${JSON.stringify(obj.id)}`);
    }
    return { kind: obj.kind, id };
  }
  throw new GrantStoreError(400, 'invalid_scope', `invalid grant scope kind: ${JSON.stringify(obj.kind)}`);
}

export function parseIsoTimestamp(raw: unknown, field = 'expiresAt'): { iso: string; ms: number } {
  if (typeof raw !== 'string') {
    throw new GrantStoreError(400, 'invalid_expiry', `${field} must be an ISO-8601 timestamp string or null`);
  }
  const trimmed = raw.trim();
  const m = trimmed.match(ISO_8601_REGEX);
  if (!m) {
    throw new GrantStoreError(400, 'invalid_expiry', `invalid ${field} ISO-8601 timestamp: ${JSON.stringify(raw)}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const tz = m[8];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new GrantStoreError(400, 'invalid_expiry', `invalid ${field} calendar component: ${JSON.stringify(raw)}`);
  }
  const checkUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    checkUtc.getUTCFullYear() !== year ||
    checkUtc.getUTCMonth() !== month - 1 ||
    checkUtc.getUTCDate() !== day
  ) {
    throw new GrantStoreError(400, 'invalid_expiry', `invalid ${field} calendar date: ${JSON.stringify(raw)}`);
  }
  if (tz !== 'Z') {
    const [tzH, tzM] = tz.slice(1).split(':').map(Number);
    if (tzH > 23 || tzM > 59) {
      throw new GrantStoreError(400, 'invalid_expiry', `invalid ${field} timezone offset: ${JSON.stringify(raw)}`);
    }
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new GrantStoreError(400, 'invalid_expiry', `unparseable ${field} timestamp: ${JSON.stringify(raw)}`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function validateAndNormalizeRole(scope: GrantScope, rawRole: unknown, subjectKind: GrantSubjectKind): string {
  if (typeof rawRole !== 'string' || !rawRole.trim()) {
    throw new GrantStoreError(400, 'invalid_role', 'grant role must be a non-empty string');
  }
  const trimmed = rawRole.trim();
  const lower = trimmed.toLowerCase();

  if (scope.kind === 'fleet') {
    if (FLEET_SERVICE_ROLE_SET.has(lower)) {
      if (subjectKind !== 'service') {
        throw new GrantStoreError(
          400,
          'invalid_role',
          `machine-only fleet role '${lower}' requires a service:<name> subject`,
        );
      }
      return lower;
    }
    if (lower === 'budget-owner') {
      if (subjectKind !== 'user') {
        throw new GrantStoreError(400, 'invalid_role', `role 'budget-owner' requires a human user:<id> subject`);
      }
      return lower;
    }
    if (FLEET_HUMAN_ROLE_SET.has(lower)) {
      return lower;
    }
    throw new GrantStoreError(400, 'invalid_role', `invalid fleet role: ${JSON.stringify(rawRole)}`);
  }

  if (subjectKind === 'service') {
    throw new GrantStoreError(400, 'invalid_role', `service:<name> subjects may only hold fleet roles`);
  }

  if (scope.kind === 'agent') {
    if (lower === 'content-owner' || lower === 'accountable-lead') {
      if (subjectKind !== 'user') {
        throw new GrantStoreError(400, 'invalid_role', `agent role '${lower}' requires a human user:<id> subject`);
      }
      return lower;
    }
    if (lower === 'member' || lower === 'agent-member') {
      return lower;
    }
    const bareName = lower.startsWith('subrole:') ? lower.slice('subrole:'.length) : lower;
    if (!AGENT_SUBROLE_REGEX.test(trimmed) || RESERVED_AGENT_SUBROLES.has(bareName) || FORBIDDEN_OBJECT_KEYS.has(bareName)) {
      throw new GrantStoreError(400, 'invalid_role', `invalid agent role: ${JSON.stringify(rawRole)}`);
    }
    return trimmed;
  }

  // scope.kind === 'skill'
  if (lower === 'content-owner') {
    if (subjectKind !== 'user') {
      throw new GrantStoreError(400, 'invalid_role', `skill role 'content-owner' requires a human user:<id> subject`);
    }
    return lower;
  }
  if (lower === 'member') {
    return lower;
  }
  throw new GrantStoreError(400, 'invalid_role', `invalid skill role: ${JSON.stringify(rawRole)}`);
}

function sameScope(a: GrantScope, b: GrantScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'fleet' && b.kind === 'fleet') return true;
  return (a as { id: string }).id === (b as { id: string }).id;
}

function sameRole(scope: GrantScope, a: string, b: string): boolean {
  return scope.kind === 'agent' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isGrantExpired(g: GrantRecord, nowMs: number): boolean {
  return g.expiresAt !== null && Date.parse(g.expiresAt) <= nowMs;
}

function isPendingTransferExpired(g: GrantRecord, nowMs: number): boolean {
  return typeof g.pendingExpiresAt === 'string' && Date.parse(g.pendingExpiresAt) <= nowMs;
}

/**
 * Whether a grant currently occupies a live slot (not expired, and not an unaccepted or expired `pending-accepted`).
 */
function isGrantOccupyingSlot(g: GrantRecord, nowMs: number): boolean {
  if (isGrantExpired(g, nowMs)) return false;
  if (g.state === 'pending-accepted') return false;
  return true;
}

function countActiveHumanAdmins(grants: Iterable<GrantRecord>, nowMs: number): number {
  const humans = new Set<string>();
  for (const g of grants) {
    if (
      g.scope.kind === 'fleet' &&
      g.role === 'admin' &&
      isValidUserPrincipalId(g.subject) &&
      !isGrantExpired(g, nowMs) &&
      (g.state === 'active' || (g.state === 'pending-revoked' && isPendingTransferExpired(g, nowMs)))
    ) {
      humans.add(g.subject);
    }
  }
  return humans.size;
}

function isKnownGroup(groupId: string, knownGroups?: KnownGroupsCheck): boolean {
  if (!knownGroups) return false;
  return typeof knownGroups === 'function' ? knownGroups(groupId) : knownGroups.has(groupId);
}

function defaultDisplayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  return (local.trim() || 'user').slice(0, 256);
}

/**
 * Versioned, fail-closed factory grant store (R2, R3, R8, D5, D6, D7, D10, D11, D13, D15, D25, D26, D32, S2).
 */
export class GrantStore {
  private byId = new Map<string, GrantRecord>();
  private docVersion = 0;
  private unhealthy?: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly principals?: PrincipalStore;
  private readonly knownGroups?: KnownGroupsCheck;

  private constructor(private readonly backend: VersionedDocBackend<GrantsDoc>, opts?: GrantStoreOptions) {
    this.now = opts?.now ?? (() => new Date());
    this.principals = opts?.principals;
    this.knownGroups = opts?.knownGroups;
  }

  static async open(
    backend: VersionedDocBackend<GrantsDoc> = new MemoryDocBackend(),
    opts?: GrantStoreOptions,
  ): Promise<GrantStore> {
    const store = new GrantStore(backend, opts);
    await store.reload();
    return store;
  }

  static inMemory(opts?: GrantStoreOptions): GrantStore {
    return new GrantStore(new MemoryDocBackend(), opts);
  }

  get description(): string {
    return this.backend.description;
  }

  get version(): number {
    return this.docVersion;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  markUnhealthy(err: unknown): void {
    this.unhealthy = err ?? new Error('marked unhealthy');
  }

  private assertHealthy(): void {
    if (this.unhealthy !== undefined) {
      throw new GrantStoreUnavailableError(this.unhealthy);
    }
  }

  async reload(): Promise<void> {
    try {
      const state = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();
      const snap = state.snapshot;
      if (snap !== undefined && (!snap.data || typeof snap.data !== 'object' || !Array.isArray(snap.data.grants))) {
        throw new Error('corrupt grants snapshot: data.grants must be an array');
      }
      const nextById = new Map<string, GrantRecord>();
      const nowMs = this.now().getTime();
      const activeContentOwners = new Map<string, string>();
      const activeTeamLeads = new Map<string, string>();
      let activeBudgetOwner: string | undefined;

      for (const raw of snap?.data?.grants ?? []) {
        if (!raw || typeof raw !== 'object') {
          throw new Error('corrupt grant record in store');
        }
        if (typeof raw.id !== 'string' || !GRANT_ID_REGEX.test(raw.id) || nextById.has(raw.id)) {
          throw new Error(`invalid or duplicate grant id in store: ${JSON.stringify(raw.id)}`);
        }
        const { subject, kind: subjectKind } = parseGrantSubject(raw.subject);
        const scope = normalizeGrantScope(raw.scope);
        const role = validateAndNormalizeRole(scope, raw.role, subjectKind);
        if (typeof raw.state !== 'string' || !(GRANT_STATES as readonly string[]).includes(raw.state)) {
          throw new Error(`invalid grant state on ${raw.id}: ${JSON.stringify(raw.state)}`);
        }
        const trimmedTransferId =
          typeof raw.transferId === 'string' && raw.transferId.trim() ? raw.transferId.trim() : undefined;
        if (raw.state !== 'active' && !trimmedTransferId) {
          throw new Error(`corrupt grant ${raw.id}: state '${raw.state}' requires transferId`);
        }
        const expiresAt = raw.expiresAt === null || raw.expiresAt === undefined ? null : parseIsoTimestamp(raw.expiresAt, 'expiresAt').iso;
        const pendingExpiresAt =
          raw.pendingExpiresAt === undefined || raw.pendingExpiresAt === null
            ? raw.pendingExpiresAt
            : parseIsoTimestamp(raw.pendingExpiresAt, 'pendingExpiresAt').iso;
        if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
          throw new Error(`invalid grant version on ${raw.id}`);
        }
        const createdAt = parseIsoTimestamp(raw.createdAt, 'createdAt').iso;
        const updatedAt = parseIsoTimestamp(raw.updatedAt, 'updatedAt').iso;
        if (typeof raw.createdBy !== 'string' || !raw.createdBy.trim() || typeof raw.updatedBy !== 'string' || !raw.updatedBy.trim()) {
          throw new Error(`missing provenance actor on ${raw.id}`);
        }

        const record: GrantRecord = {
          id: raw.id,
          subject,
          scope,
          role,
          state: raw.state as GrantState,
          expiresAt,
          ...(trimmedTransferId !== undefined ? { transferId: trimmedTransferId } : {}),
          ...(pendingExpiresAt !== undefined ? { pendingExpiresAt } : {}),
          ...(typeof raw.onBehalfOf === 'string' && raw.onBehalfOf.trim() ? { onBehalfOf: raw.onBehalfOf.trim().toLowerCase() } : {}),
          version: raw.version,
          createdAt,
          createdBy: raw.createdBy.trim(),
          updatedAt,
          updatedBy: raw.updatedBy.trim(),
        };

        if (isGrantOccupyingSlot(record, nowMs)) {
          if ((scope.kind === 'agent' || scope.kind === 'skill') && role === 'content-owner') {
            const key = `${scope.kind}:${scope.id}`;
            if (activeContentOwners.has(key) && activeContentOwners.get(key) !== subject) {
              throw new Error(`corrupt grants store: duplicate active content-owner on ${key}`);
            }
            if (scope.kind === 'agent' && activeTeamLeads.has(scope.id)) {
              throw new Error(`corrupt grants store: agent:${scope.id} has both content-owner and accountable-lead`);
            }
            activeContentOwners.set(key, subject);
          }
          if (scope.kind === 'agent' && role === 'accountable-lead') {
            if (activeTeamLeads.has(scope.id) && activeTeamLeads.get(scope.id) !== subject) {
              throw new Error(`corrupt grants store: duplicate active accountable-lead on agent:${scope.id}`);
            }
            if (activeContentOwners.has(`agent:${scope.id}`)) {
              throw new Error(`corrupt grants store: agent:${scope.id} has both content-owner and accountable-lead`);
            }
            activeTeamLeads.set(scope.id, subject);
          }
          if (scope.kind === 'fleet' && role === 'budget-owner') {
            if (activeBudgetOwner !== undefined && activeBudgetOwner !== subject) {
              throw new Error('corrupt grants store: multiple active budget-owner grants');
            }
            activeBudgetOwner = subject;
          }
        }

        nextById.set(record.id, record);
      }

      this.byId = nextById;
      this.docVersion = Math.max(snap?.version ?? 0, state.maxSeenVersion);
      this.unhealthy = undefined;
    } catch (err) {
      this.byId = new Map();
      this.unhealthy = err;
      throw new GrantStoreUnavailableError(err);
    }
  }

  get(id: string): GrantRecord | undefined {
    this.assertHealthy();
    if (typeof id !== 'string') return undefined;
    const rec = this.byId.get(id.trim());
    return rec ? structuredClone(rec) : undefined;
  }

  list(filter?: {
    subject?: string;
    scopeKind?: GrantScope['kind'];
    scopeId?: string;
    includeExpired?: boolean;
    at?: Date;
  }): GrantRecord[] {
    this.assertHealthy();
    const nowMs = (filter?.at ?? this.now()).getTime();
    const subjectFilter = filter?.subject ? filter.subject.trim().toLowerCase() : undefined;
    const scopeIdFilter = filter?.scopeId ? filter.scopeId.trim().toLowerCase() : undefined;
    return [...this.byId.values()]
      .filter((g) => {
        if (!filter?.includeExpired && isGrantExpired(g, nowMs)) return false;
        if (subjectFilter && g.subject !== subjectFilter) return false;
        if (filter?.scopeKind && g.scope.kind !== filter.scopeKind) return false;
        if (scopeIdFilter !== undefined) {
          if (g.scope.kind === 'fleet' || g.scope.id !== scopeIdFilter) return false;
        }
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((g) => structuredClone(g));
  }

  hasActiveDomainGrant(domain: string, at?: Date): boolean {
    this.assertHealthy();
    let normDomain: string;
    try {
      normDomain = normalizeDomain(domain.trim().toLowerCase().replace(/^domain:/, ''));
    } catch {
      return false;
    }
    const target = `domain:${normDomain}`;
    const nowMs = (at ?? this.now()).getTime();
    for (const g of this.byId.values()) {
      if (g.subject === target && g.state === 'active' && !isGrantExpired(g, nowMs)) {
        return true;
      }
    }
    return false;
  }

  effectiveGrantsForPrincipal(
    record: PrincipalRecord,
    opts?: { groupIds?: readonly string[]; at?: Date },
  ): EffectiveGrant[] {
    return this.effectiveGrantsFor({
      subject: record.id,
      emails: record.emails,
      groupIds: opts?.groupIds,
      at: opts?.at,
    });
  }

  effectiveGrantsFor(query: EffectiveGrantQuery): EffectiveGrant[] {
    this.assertHealthy();
    if (this.principals && !this.principals.healthy) {
      throw new PrincipalStoreUnavailableError('principal store unhealthy');
    }

    const nowMs = (query.at ?? this.now()).getTime();
    let directSubject: string | undefined;
    let subjectKind: GrantSubjectKind | undefined;
    if (query.subject !== undefined) {
      const parsed = parseGrantSubject(query.subject);
      if (parsed.kind !== 'user' && parsed.kind !== 'service') {
        throw new GrantStoreError(
          400,
          'invalid_subject',
          `effectiveGrantsFor subject must be user:<id> or service:<name>, got '${query.subject}'`,
        );
      }
      directSubject = parsed.subject;
      subjectKind = parsed.kind;
    }

    if (subjectKind === 'service') {
      const out: EffectiveGrant[] = [];
      for (const g of this.byId.values()) {
        if (g.subject !== directSubject) continue;
        if (isGrantExpired(g, nowMs) || g.state !== 'active') continue;
        out.push({ grant: structuredClone(g), source: 'direct', readOnly: false });
      }
      return out.sort((a, b) => a.grant.id.localeCompare(b.grant.id));
    }

    const domainSubjects = new Set<string>();
    const emailsToCheck = new Set<string>();
    if (query.emails !== undefined) {
      for (const e of query.emails) {
        emailsToCheck.add(normalizeEmail(e));
      }
    } else if (directSubject && this.principals) {
      const rec = this.principals.get(directSubject);
      for (const e of rec?.emails ?? []) {
        emailsToCheck.add(normalizeEmail(e));
      }
    }
    for (const email of emailsToCheck) {
      const atIdx = email.indexOf('@');
      if (atIdx !== -1) {
        domainSubjects.add(`domain:${email.slice(atIdx + 1)}`);
      }
    }

    const groupSubjects = new Set<string>();
    for (const gid of query.groupIds ?? []) {
      groupSubjects.add(`group:${normalizeGroupSubjectId(gid)}`);
    }

    const out: EffectiveGrant[] = [];
    for (const g of this.byId.values()) {
      if (isGrantExpired(g, nowMs)) continue;
      if (g.state === 'pending-accepted') continue;
      const readOnly = g.state === 'pending-revoked' && !isPendingTransferExpired(g, nowMs);

      if (directSubject && g.subject === directSubject) {
        out.push({ grant: structuredClone(g), source: 'direct', readOnly });
      } else if (groupSubjects.has(g.subject)) {
        out.push({ grant: structuredClone(g), source: 'group', readOnly });
      } else if (domainSubjects.has(g.subject)) {
        out.push({ grant: structuredClone(g), source: 'domain', readOnly });
      }
    }

    return out.sort((a, b) => a.grant.id.localeCompare(b.grant.id));
  }

  async loadEffectiveGrantsFor(
    query: EffectiveGrantQuery,
    opts?: { refresh?: boolean },
  ): Promise<EffectiveGrant[]> {
    if (opts?.refresh) {
      await this.reload();
    }
    return this.effectiveGrantsFor(query);
  }

  effectiveFleetRolesFor(query: EffectiveGrantQuery): Role[] {
    const grants = this.effectiveGrantsFor(query);
    const out = new Set<Role>();
    for (const { grant, readOnly } of grants) {
      if (readOnly || grant.scope.kind !== 'fleet') continue;
      if (AUTH_ROLE_SET.has(grant.role)) {
        out.add(grant.role as Role);
      }
    }
    return [...out];
  }

  effectiveFleetGrantRolesFor(query: EffectiveGrantQuery): FleetGrantRole[] {
    const grants = this.effectiveGrantsFor(query);
    const out = new Set<FleetGrantRole>();
    for (const { grant, readOnly } of grants) {
      if (readOnly || grant.scope.kind !== 'fleet') continue;
      out.add(grant.role as FleetGrantRole);
    }
    return [...out];
  }

  evaluateEffectiveGrants(query: EffectiveGrantQuery): EvaluateEffectiveGrantsResult {
    try {
      const grants = this.effectiveGrantsFor(query);
      const roles = new Set<Role>();
      const fleetRoles = new Set<FleetGrantRole>();
      for (const { grant, readOnly } of grants) {
        if (readOnly || grant.scope.kind !== 'fleet') continue;
        fleetRoles.add(grant.role as FleetGrantRole);
        if (AUTH_ROLE_SET.has(grant.role)) {
          roles.add(grant.role as Role);
        }
      }
      return {
        ok: true,
        allowed: grants.length > 0,
        grants,
        roles: [...roles],
        fleetRoles: [...fleetRoles],
      };
    } catch (err) {
      if (err instanceof PrincipalStoreUnavailableError) {
        return {
          ok: false,
          allowed: false,
          status: 503,
          code: 'principal_store_unavailable',
          message: err.message,
        };
      }
      if (err instanceof GrantStoreUnavailableError) {
        return {
          ok: false,
          allowed: false,
          status: 503,
          code: 'grant_store_unavailable',
          message: err.message,
        };
      }
      throw err;
    }
  }

  isActiveContentOwner(subject: string, scope: { kind: 'agent' | 'skill'; id: string }, at?: Date): boolean {
    const normScope = normalizeGrantScope(scope);
    const grants = this.effectiveGrantsFor({ subject, at });
    return grants.some(
      (eg) =>
        eg.source === 'direct' &&
        !eg.readOnly &&
        sameScope(eg.grant.scope, normScope) &&
        eg.grant.role === 'content-owner',
    );
  }

  assertCanRemovePrincipal(principalId: string, at?: Date): void {
    this.assertHealthy();
    const { subject, kind } = parseGrantSubject(principalId);
    if (kind !== 'user') return;
    const nowMs = (at ?? this.now()).getTime();
    const beforeAdmins = countActiveHumanAdmins(this.byId.values(), nowMs);
    if (beforeAdmins >= 1) {
      const remaining = [...this.byId.values()].filter((g) => g.subject !== subject);
      if (countActiveHumanAdmins(remaining, nowMs) === 0) {
        throw new GrantStoreError(409, 'last_admin', 'cannot remove principal holding the last active human admin grant');
      }
    }
  }

  /**
   * Resolves or materializes a canonical principal on verified IdP sign-in (`AC1`, `D2`, `D6`, `D32`, `R8`, `R13`).
   * - Refuses unverified emails (`emailVerified !== true`) with zero writes.
   * - Fails closed (`503`) if either `GrantStore` or `PrincipalStore` is unhealthy.
   * - If `PrincipalStore` already maps `email`, updates IdP binding and returns live effective grants (including domain grants across all mapped emails).
   * - If `PrincipalStore` does NOT map `email`:
   *   - When `domain:<emailDomain>` holds >= 1 active grant, auto-creates the principal in `PrincipalStore` and returns effective grants (`materialized: true`).
   *   - Otherwise creates NO principal or shadow record (`materialized: false`, `principal: null`, `grants: []`).
   */
  async materializeOnVerifiedSignIn(input: MaterializeSignInInput): Promise<MaterializeSignInResult> {
    this.assertHealthy();
    const principals = input.principals ?? this.principals;
    if (!principals) {
      throw new GrantStoreUnavailableError('no PrincipalStore configured for materializeOnVerifiedSignIn');
    }
    if (!principals.healthy) {
      throw new PrincipalStoreUnavailableError('principal store unhealthy');
    }

    if (input.emailVerified !== true) {
      return { ok: false, reason: 'email_not_verified' };
    }
    const idp = typeof input.idp === 'string' ? input.idp.trim().toLowerCase() : '';
    if (!idp) {
      return { ok: false, reason: 'invalid_idp' };
    }
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(input.email);
    } catch {
      return { ok: false, reason: 'invalid_email' };
    }

    const now = this.now();
    const existing = principals.findByEmail(normalizedEmail);
    if (existing) {
      const signedIn = await principals.recordSignIn({
        idp,
        sub: input.sub,
        email: normalizedEmail,
        emailVerified: true,
      });
      if (!signedIn.ok || !signedIn.principal) {
        return { ok: false, reason: signedIn.ok ? 'invalid_email' : signedIn.reason };
      }
      if (!principals.healthy) {
        throw new PrincipalStoreUnavailableError('principal store unhealthy');
      }
      const grants = this.effectiveGrantsForPrincipal(signedIn.record, {
        groupIds: input.groupIds,
        at: this.now(),
      });
      const roles = this.rolesFromEffectiveGrants(grants);
      const fleetRoles = this.fleetRolesFromEffectiveGrants(grants);
      return {
        ok: true,
        admitted: grants.length > 0,
        materialized: false,
        principal: { actor: signedIn.record.id, roles },
        record: signedIn.record,
        normalizedEmail,
        grants,
        fleetRoles,
      };
    }

    const emailDomain = normalizedEmail.slice(normalizedEmail.indexOf('@') + 1);
    if (!this.hasActiveDomainGrant(emailDomain, now)) {
      return {
        ok: true,
        admitted: false,
        materialized: false,
        principal: null,
        record: null,
        normalizedEmail,
        grants: [],
        fleetRoles: [],
      };
    }

    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 256)
        : defaultDisplayNameFromEmail(normalizedEmail);

    let record: PrincipalRecord;
    let materialized = false;
    try {
      record = await principals.create({
        displayName,
        emails: [normalizedEmail],
        by: `domain:${emailDomain}`,
      });
      materialized = true;
    } catch (err) {
      if (err instanceof DuplicatePrincipalEmailError) {
        const raced = principals.findByEmail(normalizedEmail);
        if (!raced) throw err;
        record = raced;
      } else {
        throw err;
      }
    }

    if (typeof input.sub === 'string' && input.sub.trim()) {
      const signedIn = await principals.recordSignIn({
        idp,
        sub: input.sub,
        email: normalizedEmail,
        emailVerified: true,
      });
      if (signedIn.ok && signedIn.principal) {
        record = signedIn.record;
      }
    }

    if (!principals.healthy) {
      throw new PrincipalStoreUnavailableError('principal store unhealthy');
    }
    const grants = this.effectiveGrantsForPrincipal(record, {
      groupIds: input.groupIds,
      at: this.now(),
    });
    const roles = this.rolesFromEffectiveGrants(grants);
    const fleetRoles = this.fleetRolesFromEffectiveGrants(grants);

    return {
      ok: true,
      admitted: grants.length > 0,
      materialized,
      principal: { actor: record.id, roles },
      record,
      normalizedEmail,
      grants,
      fleetRoles,
    };
  }

  grant(input: CreateGrantInput): Promise<GrantRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const principals = input.principals ?? this.principals;
      if (principals && !principals.healthy) {
        throw new PrincipalStoreUnavailableError('principal store unhealthy');
      }
      const knownGroups = input.knownGroups ?? this.knownGroups;

      const by = typeof input.by === 'string' ? input.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const onBehalfOf =
        typeof input.onBehalfOf === 'string' && input.onBehalfOf.trim()
          ? input.onBehalfOf.trim().toLowerCase()
          : undefined;
      if (onBehalfOf !== undefined && !isValidUserPrincipalId(onBehalfOf)) {
        throw new GrantStoreError(400, 'invalid_grant', `invalid onBehalfOf principal: ${JSON.stringify(input.onBehalfOf)}`);
      }

      const isAdmin =
        input.granterRole !== undefined
          ? input.granterRole === 'admin'
          : input.granterIsAdmin !== undefined
            ? input.granterIsAdmin
            : true;

      const scope = normalizeGrantScope(input.scope);

      // Parse subject or bare email (D13, D32).
      if (typeof input.subject !== 'string' || !input.subject.trim()) {
        throw new GrantStoreError(400, 'invalid_subject', `invalid grant subject: ${JSON.stringify(input.subject)}`);
      }
      const rawTrimmedSubject = input.subject.trim();
      let resolvedSubject: string;
      let subjectKind: GrantSubjectKind;
      let emailToAutoProvision: string | undefined;

      if (!rawTrimmedSubject.includes(':')) {
        let normEmail: string;
        try {
          normEmail = normalizeEmail(rawTrimmedSubject);
        } catch {
          throw new GrantStoreError(400, 'invalid_subject', `invalid grant subject: ${JSON.stringify(input.subject)}`);
        }
        subjectKind = 'user';
        const existingByEmail = principals?.findByEmail(normEmail);
        if (existingByEmail) {
          resolvedSubject = existingByEmail.id;
        } else if (!isAdmin) {
          throw new GrantStoreError(
            403,
            'unknown_subject',
            `non-admin granters may only grant to already-known principals (unknown email '${normEmail}')`,
          );
        } else if (principals) {
          emailToAutoProvision = normEmail;
          resolvedSubject = `user:${normEmail}`;
        } else {
          resolvedSubject = `user:${normEmail}`;
        }
      } else {
        const parsed = parseGrantSubject(rawTrimmedSubject);
        resolvedSubject = parsed.subject;
        subjectKind = parsed.kind;
        if (subjectKind === 'user') {
          const rest = resolvedSubject.slice('user:'.length);
          const isEmailUser = rest.includes('@');
          const found = principals?.get(resolvedSubject) ?? (isEmailUser ? principals?.findByEmail(rest) : undefined);
          if (found) {
            resolvedSubject = found.id;
          } else if (!isAdmin) {
            throw new GrantStoreError(
              403,
              'unknown_subject',
              `non-admin granters may only grant to already-known principals ('${resolvedSubject}' not found)`,
            );
          } else if (principals) {
            if (isEmailUser) {
              emailToAutoProvision = rest;
            } else {
              throw new GrantStoreError(
                404,
                'unknown_subject',
                `principal '${resolvedSubject}' not found in principal store`,
              );
            }
          }
        }
      }

      // Enforce non-admin delegation boundaries BEFORE any write (D10, D11, D13, D24, S2).
      if (!isAdmin) {
        if (scope.kind === 'fleet') {
          throw new GrantStoreError(403, 'forbidden', 'fleet grants require admin authority');
        }
        if (subjectKind === 'domain' || subjectKind === 'service') {
          throw new GrantStoreError(403, 'forbidden', `${subjectKind} grants require admin authority`);
        }
        if (input.granterRole === 'accountable-lead' && scope.kind !== 'agent') {
          throw new GrantStoreError(403, 'forbidden', 'accountable-lead may only grant member roles on their team agent');
        }
        if (subjectKind === 'group') {
          const gid = resolvedSubject.slice('group:'.length);
          if (!isKnownGroup(gid, knownGroups)) {
            throw new GrantStoreError(
              403,
              'unknown_subject',
              `non-admin granters may only grant to already-known groups ('${resolvedSubject}' not found)`,
            );
          }
        }
      }

      const role = validateAndNormalizeRole(scope, input.role, subjectKind);
      if (!isAdmin && (role === 'content-owner' || role === 'accountable-lead')) {
        throw new GrantStoreError(403, 'forbidden', `granting '${role}' requires admin authority or dedicated transfer`);
      }
      if (input.granterRole === 'accountable-lead' && role !== 'member') {
        throw new GrantStoreError(403, 'forbidden', `accountable-lead may only grant 'member' on their team agent`);
      }

      if (scope.kind === 'agent' && input.agentKind !== undefined) {
        if (input.agentKind === 'team' && role === 'content-owner') {
          throw new GrantStoreError(409, 'agent_kind_conflict', 'team agents cannot have a content-owner');
        }
        if (input.agentKind === 'personal' && role === 'accountable-lead') {
          throw new GrantStoreError(409, 'agent_kind_conflict', 'personal agents cannot have an accountable-lead');
        }
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      let expiresAt: string | null = null;
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        const parsedExp = parseIsoTimestamp(input.expiresAt, 'expiresAt');
        if (parsedExp.ms <= nowMs) {
          throw new GrantStoreError(400, 'expired_timestamp', 'expiresAt must be in the future');
        }
        expiresAt = parsedExp.iso;
      }

      const state: GrantState = input.state ?? 'active';
      if (!(GRANT_STATES as readonly string[]).includes(state)) {
        throw new GrantStoreError(400, 'invalid_grant', `invalid grant state: ${JSON.stringify(input.state)}`);
      }
      const trimmedTransferId =
        typeof input.transferId === 'string' && input.transferId.trim() ? input.transferId.trim() : undefined;
      if (state !== 'active' && !trimmedTransferId) {
        throw new GrantStoreError(400, 'invalid_grant', `grant state '${state}' requires a transferId`);
      }
      let pendingExpiresAt: string | null | undefined = input.pendingExpiresAt;
      if (pendingExpiresAt !== undefined && pendingExpiresAt !== null) {
        const parsedPending = parseIsoTimestamp(pendingExpiresAt, 'pendingExpiresAt');
        if (parsedPending.ms <= nowMs) {
          throw new GrantStoreError(400, 'expired_timestamp', 'pendingExpiresAt must be in the future');
        }
        pendingExpiresAt = parsedPending.iso;
      }

      if (input.id !== undefined) {
        const cleanId = input.id.trim();
        if (!GRANT_ID_REGEX.test(cleanId)) {
          throw new GrantStoreError(400, 'invalid_grant', `invalid grant id: ${JSON.stringify(input.id)}`);
        }
        if (this.byId.has(cleanId)) {
          throw new GrantStoreError(409, 'invalid_grant', `grant '${cleanId}' already exists`);
        }
      }

      // Check uniqueness & conflict constraints BEFORE auto-provisioning any unseen principal in PrincipalStore.
      const toRemoveIds = new Set<string>();
      for (const existing of this.byId.values()) {
        if (isGrantExpired(existing, nowMs)) continue;

        if ((scope.kind === 'agent' || scope.kind === 'skill') && role === 'content-owner') {
          if (sameScope(existing.scope, scope)) {
            if (existing.role === 'accountable-lead' && isGrantOccupyingSlot(existing, nowMs)) {
              throw new GrantStoreError(
                409,
                'agent_kind_conflict',
                `agent '${scope.id}' already has an accountable-lead and cannot also have a content-owner`,
              );
            }
            if (existing.role === 'content-owner' && isGrantOccupyingSlot(existing, nowMs)) {
              const pendingLocked =
                existing.state === 'pending-revoked' && !isPendingTransferExpired(existing, nowMs);
              if (pendingLocked || emailToAutoProvision !== undefined || existing.subject !== resolvedSubject) {
                throw new GrantStoreError(
                  409,
                  'owner_exists',
                  `${scope.kind} '${scope.id}' already has an active content-owner ('${existing.subject}')`,
                );
              }
            }
          }
        }

        if (scope.kind === 'agent' && role === 'accountable-lead' && sameScope(existing.scope, scope)) {
          if (existing.role === 'content-owner' && isGrantOccupyingSlot(existing, nowMs)) {
            throw new GrantStoreError(
              409,
              'agent_kind_conflict',
              `personal agent '${scope.id}' already has a content-owner and cannot have an accountable-lead`,
            );
          }
          if (existing.role === 'accountable-lead' && isGrantOccupyingSlot(existing, nowMs)) {
            if (emailToAutoProvision !== undefined || existing.subject !== resolvedSubject) {
              if (input.replaceExisting && isAdmin) {
                toRemoveIds.add(existing.id);
              } else {
                throw new GrantStoreError(
                  409,
                  'lead_exists',
                  `team agent '${scope.id}' already has an active accountable-lead ('${existing.subject}')`,
                );
              }
            }
          }
        }

        if (scope.kind === 'fleet' && role === 'budget-owner' && existing.scope.kind === 'fleet') {
          if (existing.role === 'budget-owner' && isGrantOccupyingSlot(existing, nowMs)) {
            if (emailToAutoProvision !== undefined || existing.subject !== resolvedSubject) {
              if (input.replaceExisting && isAdmin) {
                toRemoveIds.add(existing.id);
              } else {
                throw new GrantStoreError(
                  409,
                  'budget_owner_exists',
                  `factory already has an active budget-owner ('${existing.subject}')`,
                );
              }
            }
          }
        }
      }

      // Now safe to auto-provision unseen email in PrincipalStore for admin pre-grant (D32).
      if (emailToAutoProvision !== undefined && principals) {
        const displayName =
          typeof input.subjectDisplayName === 'string' && input.subjectDisplayName.trim()
            ? input.subjectDisplayName.trim().slice(0, 256)
            : defaultDisplayNameFromEmail(emailToAutoProvision);
        try {
          const created = await principals.create({
            displayName,
            emails: [emailToAutoProvision],
            by,
          });
          resolvedSubject = created.id;
        } catch (err) {
          if (err instanceof DuplicatePrincipalEmailError) {
            const raced = principals.findByEmail(emailToAutoProvision);
            if (!raced) throw err;
            resolvedSubject = raced.id;
          } else {
            throw err;
          }
        }
        this.assertHealthy();
      }

      // Check for idempotent existing active grant on exact (subject, scope, role) when state === 'active' and no custom id.
      if (input.id === undefined && state === 'active') {
        const existingMatch = [...this.byId.values()].find(
          (g) =>
            !toRemoveIds.has(g.id) &&
            !isGrantExpired(g, nowMs) &&
            g.state === 'active' &&
            g.subject === resolvedSubject &&
            sameScope(g.scope, scope) &&
            sameRole(scope, g.role, role),
        );
        if (existingMatch) {
          if (existingMatch.expiresAt === expiresAt && existingMatch.role === role && toRemoveIds.size === 0) {
            return structuredClone(existingMatch);
          }
          const updated: GrantRecord = {
            ...structuredClone(existingMatch),
            role,
            expiresAt,
            ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
            version: existingMatch.version + 1,
            updatedAt: nowIso,
            updatedBy: by,
          };
          const nextMap = new Map(this.byId);
          for (const remId of toRemoveIds) nextMap.delete(remId);
          nextMap.set(updated.id, updated);
          await this.commitMap(nextMap, by, nowIso);
          return structuredClone(updated);
        }
      }

      const id = input.id !== undefined ? input.id.trim() : `g_${randomUUID().replace(/-/g, '')}`;
      const record: GrantRecord = {
        id,
        subject: resolvedSubject,
        scope,
        role,
        state,
        expiresAt,
        ...(trimmedTransferId !== undefined ? { transferId: trimmedTransferId } : {}),
        ...(pendingExpiresAt !== undefined ? { pendingExpiresAt } : {}),
        ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
        version: 1,
        createdAt: nowIso,
        createdBy: by,
        updatedAt: nowIso,
        updatedBy: by,
      };

      const nextMap = new Map(this.byId);
      for (const remId of toRemoveIds) nextMap.delete(remId);
      // Prune any already-expired identical (subject, scope, role) grant on fresh re-grant.
      for (const [oldId, oldGrant] of nextMap) {
        if (
          isGrantExpired(oldGrant, nowMs) &&
          oldGrant.subject === resolvedSubject &&
          sameScope(oldGrant.scope, scope) &&
          sameRole(scope, oldGrant.role, role)
        ) {
          nextMap.delete(oldId);
        }
      }
      nextMap.set(record.id, record);
      await this.commitMap(nextMap, by, nowIso);
      return structuredClone(record);
    });
  }

  update(id: string, patch: UpdateGrantInput): Promise<GrantRecord> {
    return this.enqueue(() => this.applyUpdate(id, patch));
  }

  private async applyUpdate(id: string, patch: UpdateGrantInput): Promise<GrantRecord> {
    this.assertHealthy();
    const by = typeof patch.by === 'string' ? patch.by.trim() : '';
    if (!by) {
      throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
    }
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const current = this.byId.get(cleanId);
    if (!current) {
      throw new GrantStoreError(404, 'grant_not_found', `grant '${id}' not found`);
    }

    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const { kind: subjectKind } = parseGrantSubject(current.subject);
    const nextRole =
      patch.role !== undefined ? validateAndNormalizeRole(current.scope, patch.role, subjectKind) : current.role;
    const nextState = patch.state !== undefined ? patch.state : current.state;
    if (!(GRANT_STATES as readonly string[]).includes(nextState)) {
      throw new GrantStoreError(400, 'invalid_grant', `invalid grant state: ${JSON.stringify(patch.state)}`);
    }
    if (nextState !== 'active' && !current.transferId) {
      throw new GrantStoreError(400, 'invalid_grant', `grant state '${nextState}' requires an active transferId`);
    }

    let nextExpiresAt = current.expiresAt;
    let parsedExpiresMs: number | undefined;
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt === null) {
        nextExpiresAt = null;
      } else {
        const parsed = parseIsoTimestamp(patch.expiresAt, 'expiresAt');
        nextExpiresAt = parsed.iso;
        parsedExpiresMs = parsed.ms;
      }
    }

    const onBehalfOf =
      typeof patch.onBehalfOf === 'string' && patch.onBehalfOf.trim()
        ? patch.onBehalfOf.trim().toLowerCase()
        : current.onBehalfOf;
    if (onBehalfOf !== undefined && !isValidUserPrincipalId(onBehalfOf)) {
      throw new GrantStoreError(400, 'invalid_grant', `invalid onBehalfOf principal: ${JSON.stringify(patch.onBehalfOf)}`);
    }

    const candidate: GrantRecord = {
      ...structuredClone(current),
      role: nextRole,
      state: nextState,
      expiresAt: nextExpiresAt,
      ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
      version: current.version + 1,
      updatedAt: nowIso,
      updatedBy: by,
    };

    const nextMap = new Map(this.byId);
    nextMap.set(candidate.id, candidate);

    // AC2 / D5: Check last active human admin BEFORE expired_timestamp so attempting to expire/downgrade the sole human admin always returns 409 last_admin.
    const beforeAdmins = countActiveHumanAdmins(this.byId.values(), nowMs);
    const afterAdmins = countActiveHumanAdmins(nextMap.values(), nowMs);
    if (beforeAdmins >= 1 && afterAdmins === 0) {
      throw new GrantStoreError(409, 'last_admin', 'cannot revoke or downgrade the last active human admin');
    }

    if (parsedExpiresMs !== undefined && parsedExpiresMs <= nowMs) {
      throw new GrantStoreError(400, 'expired_timestamp', 'expiresAt must be in the future');
    }

    // Check uniqueness constraints if role changed onto a unique role.
    if (isGrantOccupyingSlot(candidate, nowMs)) {
      for (const other of nextMap.values()) {
        if (other.id === candidate.id || !isGrantOccupyingSlot(other, nowMs)) continue;
        if (
          (candidate.scope.kind === 'agent' || candidate.scope.kind === 'skill') &&
          candidate.role === 'content-owner' &&
          sameScope(other.scope, candidate.scope)
        ) {
          if (other.role === 'content-owner' && other.subject !== candidate.subject) {
            throw new GrantStoreError(
              409,
              'owner_exists',
              `${candidate.scope.kind} '${candidate.scope.id}' already has an active content-owner ('${other.subject}')`,
            );
          }
          if (other.role === 'accountable-lead') {
            throw new GrantStoreError(
              409,
              'agent_kind_conflict',
              `agent '${candidate.scope.id}' already has an accountable-lead`,
            );
          }
        }
        if (
          candidate.scope.kind === 'agent' &&
          candidate.role === 'accountable-lead' &&
          sameScope(other.scope, candidate.scope)
        ) {
          if (other.role === 'accountable-lead' && other.subject !== candidate.subject) {
            throw new GrantStoreError(
              409,
              'lead_exists',
              `team agent '${candidate.scope.id}' already has an active accountable-lead ('${other.subject}')`,
            );
          }
          if (other.role === 'content-owner') {
            throw new GrantStoreError(
              409,
              'agent_kind_conflict',
              `personal agent '${candidate.scope.id}' already has a content-owner`,
            );
          }
        }
        if (
          candidate.scope.kind === 'fleet' &&
          candidate.role === 'budget-owner' &&
          other.scope.kind === 'fleet' &&
          other.role === 'budget-owner' &&
          other.subject !== candidate.subject
        ) {
          throw new GrantStoreError(
            409,
            'budget_owner_exists',
            `factory already has an active budget-owner ('${other.subject}')`,
          );
        }
      }
    }

    // Collapse duplicate active grant if downgrading onto a role the subject already holds on the same scope.
    for (const [otherId, other] of nextMap) {
      if (
        otherId !== candidate.id &&
        !isGrantExpired(other, nowMs) &&
        other.state === 'active' &&
        candidate.state === 'active' &&
        other.subject === candidate.subject &&
        sameScope(other.scope, candidate.scope) &&
        sameRole(candidate.scope, other.role, candidate.role)
      ) {
        nextMap.delete(otherId);
      }
    }

    await this.commitMap(nextMap, by, nowIso);
    return structuredClone(candidate);
  }

  /**
   * Downgrades (or changes) a grant's role by grant ID or by fleet subject (`user:<id>`), enforcing `409 last_admin` (`AC2`, `D5`).
   */
  downgrade(grantIdOrSubject: string, newRole: string, opts: RevokeGrantOptions): Promise<GrantRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const trimmed = typeof grantIdOrSubject === 'string' ? grantIdOrSubject.trim() : '';
      if (trimmed.includes(':')) {
        const { subject } = parseGrantSubject(trimmed);
        const nowMs = this.now().getTime();
        const matches = [...this.byId.values()].filter((g) => g.subject === subject && g.scope.kind === 'fleet');
        const target =
          matches.find((g) => !isGrantExpired(g, nowMs) && g.role === 'admin') ??
          matches.find((g) => !isGrantExpired(g, nowMs)) ??
          matches[0];
        if (!target) {
          throw new GrantStoreError(404, 'grant_not_found', `no fleet grant found for subject '${subject}'`);
        }
        return this.applyUpdate(target.id, { role: newRole, by: opts.by, onBehalfOf: opts.onBehalfOf });
      }
      return this.applyUpdate(trimmed, { role: newRole, by: opts.by, onBehalfOf: opts.onBehalfOf });
    });
  }

  revoke(id: string, opts: RevokeGrantOptions): Promise<GrantRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const by = typeof opts.by === 'string' ? opts.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const existing = this.byId.get(id.trim());
      if (!existing) {
        throw new GrantStoreError(404, 'grant_not_found', `grant '${id}' not found`);
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      const nextMap = new Map(this.byId);
      nextMap.delete(existing.id);

      const beforeAdmins = countActiveHumanAdmins(this.byId.values(), nowMs);
      const afterAdmins = countActiveHumanAdmins(nextMap.values(), nowMs);
      if (beforeAdmins >= 1 && afterAdmins === 0) {
        throw new GrantStoreError(409, 'last_admin', 'cannot revoke or downgrade the last active human admin');
      }

      await this.commitMap(nextMap, by, nowIso);
      return structuredClone(existing);
    });
  }

  revokeMatching(
    criteria: { subject: string; scope: GrantScope; role: string },
    opts: RevokeGrantOptions,
  ): Promise<GrantRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const by = typeof opts.by === 'string' ? opts.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const { subject, kind: subjectKind } = parseGrantSubject(criteria.subject);
      const scope = normalizeGrantScope(criteria.scope);
      const role = validateAndNormalizeRole(scope, criteria.role, subjectKind);

      const target = [...this.byId.values()].find(
        (g) => g.subject === subject && sameScope(g.scope, scope) && sameRole(scope, g.role, role),
      );
      if (!target) {
        throw new GrantStoreError(404, 'grant_not_found', `matching grant not found for '${subject}'`);
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      const nextMap = new Map(this.byId);
      nextMap.delete(target.id);

      const beforeAdmins = countActiveHumanAdmins(this.byId.values(), nowMs);
      const afterAdmins = countActiveHumanAdmins(nextMap.values(), nowMs);
      if (beforeAdmins >= 1 && afterAdmins === 0) {
        throw new GrantStoreError(409, 'last_admin', 'cannot revoke or downgrade the last active human admin');
      }

      await this.commitMap(nextMap, by, nowIso);
      return structuredClone(target);
    });
  }

  /**
   * Revokes all grants held by `subject` in a single atomic versioned write, enforcing `409 last_admin` BEFORE writing (`AC2`, `D5`).
   */
  revokeAllForSubject(subjectRaw: string, opts: RevokeGrantOptions): Promise<GrantRecord[]> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const by = typeof opts.by === 'string' ? opts.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const { subject } = parseGrantSubject(subjectRaw);
      const removed = [...this.byId.values()].filter((g) => g.subject === subject);
      if (removed.length === 0) {
        return [];
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      const nextMap = new Map(this.byId);
      for (const g of removed) {
        nextMap.delete(g.id);
      }

      const beforeAdmins = countActiveHumanAdmins(this.byId.values(), nowMs);
      const afterAdmins = countActiveHumanAdmins(nextMap.values(), nowMs);
      if (beforeAdmins >= 1 && afterAdmins === 0) {
        throw new GrantStoreError(409, 'last_admin', 'cannot revoke or downgrade the last active human admin');
      }

      await this.commitMap(nextMap, by, nowIso);
      return removed.map((g) => structuredClone(g));
    });
  }

  /**
   * Starts a two-phase content ownership transfer (`pending-revoked` + `pending-accepted` in one versioned write; `D15`, `S2`, `S3b`).
   */
  startOwnershipTransfer(input: StartOwnershipTransferInput): Promise<{
    transferId: string;
    outgoing: GrantRecord;
    incoming: GrantRecord;
  }> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const principals = input.principals ?? this.principals;
      if (principals && !principals.healthy) {
        throw new PrincipalStoreUnavailableError('principal store unhealthy');
      }
      const by = typeof input.by === 'string' ? input.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const scope = normalizeGrantScope(input.scope);
      if (scope.kind !== 'agent' && scope.kind !== 'skill') {
        throw new GrantStoreError(400, 'invalid_scope', 'ownership transfer applies only to agent or skill scope');
      }

      const fromParsed = parseGrantSubject(input.fromSubject);
      const toParsed = parseGrantSubject(input.toSubject);
      if (fromParsed.kind !== 'user' || toParsed.kind !== 'user') {
        throw new GrantStoreError(400, 'invalid_subject', 'ownership transfer subjects must be human user:<id> principals');
      }

      const isAdmin = input.granterIsAdmin ?? false;
      let toSubject = toParsed.subject;
      let toEmailToAutoProvision: string | undefined;
      if (principals) {
        const rest = toSubject.slice('user:'.length);
        const isEmailUser = rest.includes('@');
        const found = principals.get(toSubject) ?? (isEmailUser ? principals.findByEmail(rest) : undefined);
        if (found) {
          toSubject = found.id;
        } else if (!isAdmin) {
          throw new GrantStoreError(
            403,
            'unknown_subject',
            `transfer recipient '${toSubject}' is not a known principal`,
          );
        } else if (isEmailUser) {
          toEmailToAutoProvision = rest;
        } else {
          throw new GrantStoreError(
            404,
            'unknown_subject',
            `transfer recipient '${toSubject}' not found in principal store`,
          );
        }
      }
      if (fromParsed.subject === toSubject) {
        throw new GrantStoreError(400, 'invalid_grant', 'cannot transfer ownership to the current owner');
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      const ttlMs = input.ttlMs ?? DEFAULT_TRANSFER_TTL_MS;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new GrantStoreError(400, 'invalid_expiry', 'ttlMs must be a positive number');
      }
      const pendingExpiresAt = new Date(nowMs + ttlMs).toISOString();

      // Team agents (holding accountable-lead) reject ownership transfer with 409 (D11, S3b).
      for (const g of this.byId.values()) {
        if (
          scope.kind === 'agent' &&
          sameScope(g.scope, scope) &&
          g.role === 'accountable-lead' &&
          isGrantOccupyingSlot(g, nowMs)
        ) {
          throw new GrantStoreError(409, 'agent_kind_conflict', `team agent '${scope.id}' does not support ownership transfer`);
        }
      }

      const ownerGrant = [...this.byId.values()].find(
        (g) =>
          g.subject === fromParsed.subject &&
          sameScope(g.scope, scope) &&
          g.role === 'content-owner' &&
          !isGrantExpired(g, nowMs) &&
          (g.state === 'active' || (g.state === 'pending-revoked' && isPendingTransferExpired(g, nowMs))),
      );
      if (!ownerGrant) {
        throw new GrantStoreError(
          409,
          'transfer_conflict',
          `'${fromParsed.subject}' does not hold active content-owner on ${scope.kind}:${scope.id}`,
        );
      }

      if (toEmailToAutoProvision !== undefined && principals) {
        try {
          const created = await principals.create({
            displayName: defaultDisplayNameFromEmail(toEmailToAutoProvision),
            emails: [toEmailToAutoProvision],
            by,
          });
          toSubject = created.id;
        } catch (err) {
          if (err instanceof DuplicatePrincipalEmailError) {
            const raced = principals.findByEmail(toEmailToAutoProvision);
            if (!raced) throw err;
            toSubject = raced.id;
          } else {
            throw err;
          }
        }
        if (fromParsed.subject === toSubject) {
          throw new GrantStoreError(400, 'invalid_grant', 'cannot transfer ownership to the current owner');
        }
        this.assertHealthy();
      }

      const transferId = input.transferId?.trim() || `tx_${randomUUID().replace(/-/g, '')}`;
      const onBehalfOf =
        typeof input.onBehalfOf === 'string' && input.onBehalfOf.trim()
          ? input.onBehalfOf.trim().toLowerCase()
          : undefined;

      const outgoing: GrantRecord = {
        ...structuredClone(ownerGrant),
        state: 'pending-revoked',
        transferId,
        pendingExpiresAt,
        ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
        version: ownerGrant.version + 1,
        updatedAt: nowIso,
        updatedBy: by,
      };

      const incoming: GrantRecord = {
        id: `g_${randomUUID().replace(/-/g, '')}`,
        subject: toSubject,
        scope,
        role: 'content-owner',
        state: 'pending-accepted',
        expiresAt: null,
        transferId,
        pendingExpiresAt,
        ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
        version: 1,
        createdAt: nowIso,
        createdBy: by,
        updatedAt: nowIso,
        updatedBy: by,
      };

      const nextMap = new Map(this.byId);
      // Clean up any stale expired pending-accepted grants on the same scope.
      for (const [gid, g] of nextMap) {
        if (sameScope(g.scope, scope) && g.state === 'pending-accepted') {
          nextMap.delete(gid);
        }
      }
      nextMap.set(outgoing.id, outgoing);
      nextMap.set(incoming.id, incoming);
      await this.commitMap(nextMap, by, nowIso);

      return {
        transferId,
        outgoing: structuredClone(outgoing),
        incoming: structuredClone(incoming),
      };
    });
  }

  /**
   * Resolves a pending content-ownership transfer (`accept` | `decline` | `cancel`) atomically (`D15`, `S2`, `S3b`).
   */
  resolveOwnershipTransfer(input: ResolveOwnershipTransferInput): Promise<{
    action: 'accept' | 'decline' | 'cancel';
    activeOwner: GrantRecord;
  }> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const by = typeof input.by === 'string' ? input.by.trim() : '';
      if (!by) {
        throw new GrantStoreError(400, 'invalid_grant', 'by actor is required');
      }
      const txId = typeof input.transferId === 'string' ? input.transferId.trim() : '';
      if (!txId) {
        throw new GrantStoreError(400, 'invalid_grant', 'transferId is required');
      }

      const outgoing = [...this.byId.values()].find((g) => g.transferId === txId && g.state === 'pending-revoked');
      const incoming = [...this.byId.values()].find((g) => g.transferId === txId && g.state === 'pending-accepted');
      if (!outgoing || !incoming) {
        throw new GrantStoreError(404, 'transfer_not_found', `pending transfer '${txId}' not found`);
      }

      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      const onBehalfOf =
        typeof input.onBehalfOf === 'string' && input.onBehalfOf.trim()
          ? input.onBehalfOf.trim().toLowerCase()
          : undefined;

      if (input.action === 'accept') {
        if (isPendingTransferExpired(outgoing, nowMs) || isPendingTransferExpired(incoming, nowMs)) {
          throw new GrantStoreError(409, 'transfer_expired', `pending transfer '${txId}' has expired`);
        }
        const promoted: GrantRecord = {
          ...structuredClone(incoming),
          state: 'active',
          ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
          version: incoming.version + 1,
          updatedAt: nowIso,
          updatedBy: by,
        };
        delete promoted.transferId;
        delete promoted.pendingExpiresAt;

        const nextMap = new Map(this.byId);
        nextMap.delete(outgoing.id);
        nextMap.set(promoted.id, promoted);
        await this.commitMap(nextMap, by, nowIso);
        return { action: 'accept', activeOwner: structuredClone(promoted) };
      }

      if (input.action === 'decline' || input.action === 'cancel') {
        const restored: GrantRecord = {
          ...structuredClone(outgoing),
          state: 'active',
          ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
          version: outgoing.version + 1,
          updatedAt: nowIso,
          updatedBy: by,
        };
        delete restored.transferId;
        delete restored.pendingExpiresAt;

        const nextMap = new Map(this.byId);
        nextMap.delete(incoming.id);
        nextMap.set(restored.id, restored);
        await this.commitMap(nextMap, by, nowIso);
        return { action: input.action, activeOwner: structuredClone(restored) };
      }

      throw new GrantStoreError(400, 'invalid_grant', `invalid transfer action: ${JSON.stringify(input.action)}`);
    });
  }

  /**
   * Sweeps expired `pending-revoked` / `pending-accepted` transfers and restores the outgoing owner's active write grant (`D15`).
   */
  sweepExpiredTransfers(by = 'system'): Promise<GrantRecord[]> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const actor = by.trim() || 'system';
      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      const nextMap = new Map(this.byId);
      const restored: GrantRecord[] = [];
      let changed = false;

      for (const [id, g] of this.byId) {
        if (g.state === 'pending-accepted' && isPendingTransferExpired(g, nowMs)) {
          nextMap.delete(id);
          changed = true;
        } else if (g.state === 'pending-revoked' && isPendingTransferExpired(g, nowMs)) {
          const next: GrantRecord = {
            ...structuredClone(g),
            state: 'active',
            version: g.version + 1,
            updatedAt: nowIso,
            updatedBy: actor,
          };
          delete next.transferId;
          delete next.pendingExpiresAt;
          nextMap.set(id, next);
          restored.push(structuredClone(next));
          changed = true;
        }
      }

      if (changed) {
        await this.commitMap(nextMap, actor, nowIso);
      }
      return restored;
    });
  }

  private rolesFromEffectiveGrants(grants: readonly EffectiveGrant[]): Role[] {
    const out = new Set<Role>();
    for (const { grant, readOnly } of grants) {
      if (readOnly || grant.scope.kind !== 'fleet') continue;
      if (AUTH_ROLE_SET.has(grant.role)) {
        out.add(grant.role as Role);
      }
    }
    return [...out];
  }

  private fleetRolesFromEffectiveGrants(grants: readonly EffectiveGrant[]): FleetGrantRole[] {
    const out = new Set<FleetGrantRole>();
    for (const { grant, readOnly } of grants) {
      if (readOnly || grant.scope.kind !== 'fleet') continue;
      out.add(grant.role as FleetGrantRole);
    }
    return [...out];
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async commitMap(nextMap: Map<string, GrantRecord>, updatedBy: string, updatedAt: string): Promise<void> {
    const grants = [...nextMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const data: GrantsDoc = { grants };
    const nextVersion = this.docVersion + 1;
    try {
      await this.backend.write({
        version: nextVersion,
        updatedAt,
        updatedBy,
        sha256: snapshotSha256(data),
        data,
      });
    } catch (err) {
      this.byId = new Map();
      this.unhealthy = err;
      throw err;
    }
    this.byId = nextMap;
    this.docVersion = nextVersion;
  }
}
