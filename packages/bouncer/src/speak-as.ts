import { isValidUserPrincipalId } from './principals.js';
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from './principals.js';

/** A household member this client may open conversations as. */
export type SpeakAsMember = {
  /** Canonical `user:<id>` principal. */
  principalId: string;
  /** Short names the client may send in `speaker` (e.g. 'dale'). Unique per grant. */
  aliases?: string[];
  /** If omitted or empty, every target agent is allowed. Otherwise only these agent ids. */
  targetAgents?: string[];
  /** Optional household relationship stamped onto the delivered caller. */
  relationship?: SpeakAsRelationship;
};

/** Household relationship of a speak-as member, when set. */
export type SpeakAsRelationship = 'owner' | 'family' | 'child';

/** Standing grant: this client may open conversations as any enrolled member. */
export type SpeakAsGrant = {
  id: string;
  /** The client that may speak as enrolled users, e.g. `agent:rosie` or `service:reachy-rosie-body`. */
  client: string;
  members: SpeakAsMember[];
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
  purpose?: string;
};

export type SpeakAsDoc = { grants: SpeakAsGrant[] };

export type SpeakAsMode = 'call' | 'errand';

/** What a receiving agent is shown. Never includes onBehalfOf. */
export type DeliveredCaller = {
  actor: string;
  verified: true;
  channel: string;
  via: string;
  assurance: string;
  mode: SpeakAsMode;
  /** Principal display name, when the factory knows one. */
  name?: string;
  /** From the grant member, when set. */
  relationship?: SpeakAsRelationship;
  /** True when this speaker is the agent's owner (relationship=owner). Tools use this, not `via`. */
  isOwner?: boolean;
  /** Agent-declared roles for this speaker, e.g. Owner or Family. Never taken from the via client. */
  agentRoles?: string[];
};

export type SpeakAsVerifyInput = {
  client: string;
  asUser: string;
  targetAgentId: string;
  at?: Date;
};

export type SpeakAsVerifyOk = { ok: true; grant: SpeakAsGrant; member: SpeakAsMember; actor: string };
export type SpeakAsVerifyErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};
export type SpeakAsVerifyResult = SpeakAsVerifyOk | SpeakAsVerifyErr;

export class SpeakAsStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CLIENT_RE = /^(?:agent|service):[a-z0-9][a-z0-9-]{0,62}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function normalizeClient(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!CLIENT_RE.test(s)) {
    throw new SpeakAsStoreError(400, 'invalid_client', 'client must be agent:<id> or service:<name>');
  }
  return s;
}

export function normalizeUserPrincipal(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s.startsWith('user:') || !isValidUserPrincipalId(s)) {
    throw new SpeakAsStoreError(400, 'invalid_principal', 'member must be a user:<id> principal');
  }
  return s;
}

export function normalizeTargetAgents(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new SpeakAsStoreError(400, 'invalid_target_agents', 'targetAgents must be a list of agent ids');
  }
  const ids = [...new Set(raw.map((x) => String(x).trim().toLowerCase()))];
  for (const id of ids) {
    if (!AGENT_ID_RE.test(id)) {
      throw new SpeakAsStoreError(400, 'invalid_target_agents', `invalid agent id '${id}'`);
    }
  }
  return ids.length ? ids : undefined;
}


const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeAliases(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new SpeakAsStoreError(400, 'invalid_aliases', 'aliases must be a list of short names');
  }
  const aliases = [...new Set(raw.map((x) => String(x).trim().toLowerCase()))];
  for (const a of aliases) {
    if (!ALIAS_RE.test(a) || a.startsWith('user:')) {
      throw new SpeakAsStoreError(400, 'invalid_aliases', `invalid alias '${a}'`);
    }
  }
  return aliases.length ? aliases : undefined;
}

/** Resolve a `speaker` field (user:<id> or enrolled alias) to a principal id on these grants. */
export function resolveSpeaker(
  grants: readonly SpeakAsGrant[],
  client: string,
  speaker: unknown,
  at: Date = new Date(),
): { ok: true; principalId: string } | SpeakAsVerifyErr {
  const raw = String(speaker ?? '').trim();
  if (!raw) {
    return { ok: false, status: 400, error: 'speaker_required', message: 'speaker is required to open a conversation as an enrolled person' };
  }
  const want = raw.toLowerCase();
  const active = grants.filter((g) => g.client === client.trim().toLowerCase() && isGrantActive(g, at));
  if (active.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'no_speak_as_grant',
      message: `no active speak-as grant for client '${client.trim().toLowerCase()}'`,
    };
  }
  const matches: string[] = [];
  for (const g of active) {
    for (const m of g.members) {
      const aliases = (m.aliases ?? []).map((a) => a.toLowerCase());
      if (m.principalId === want || aliases.includes(want)) {
        if (!matches.includes(m.principalId)) matches.push(m.principalId);
      }
    }
  }
  if (matches.length === 1) return { ok: true, principalId: matches[0] };
  if (matches.length > 1) {
    return { ok: false, status: 409, error: 'ambiguous_speaker', message: `speaker '${raw}' matches more than one enrolled person` };
  }
  if (want.startsWith('user:')) {
    return {
      ok: false,
      status: 403,
      error: 'person_not_enrolled',
      message: `'${want}' is not enrolled on a speak-as grant for client '${client.trim().toLowerCase()}'`,
    };
  }
  return { ok: false, status: 404, error: 'unknown_speaker', message: `speaker '${raw}' does not match an enrolled user id or alias` };
}

export function normalizeMember(raw: unknown): SpeakAsMember {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpeakAsStoreError(400, 'invalid_member', 'member must be { principalId, targetAgents? }');
  }
  const o = raw as Record<string, unknown>;
  const principalId = normalizeUserPrincipal(o.principalId ?? o.user ?? o.actor);
  const targetAgents = normalizeTargetAgents(o.targetAgents ?? o.agents);
  const aliases = normalizeAliases(o.aliases);
  const relationship = normalizeRelationship(o.relationship);
  if (relationship === 'child' && (!targetAgents || targetAgents.length === 0)) {
    throw new SpeakAsStoreError(400, 'child_requires_allowlist', 'a child member must have a non-empty targetAgents allowlist');
  }
  return {
    principalId,
    ...(targetAgents ? { targetAgents } : {}),
    ...(aliases ? { aliases } : {}),
    ...(relationship ? { relationship } : {}),
  };
}

export function isGrantActive(g: SpeakAsGrant, at: Date): boolean {
  if (g.revokedAt) return false;
  if (g.expiresAt !== null && Date.parse(g.expiresAt) <= at.getTime()) return false;
  return true;
}

export function memberAllowsAgent(member: SpeakAsMember, targetAgentId: string): boolean {
  const want = targetAgentId.trim().toLowerCase();
  if (!member.targetAgents || member.targetAgents.length === 0) return true;
  return member.targetAgents.includes(want);
}

export function verifySpeakAsRequest(
  grants: readonly SpeakAsGrant[],
  input: { client: string; speaker: unknown; targetAgentId: string; at?: Date },
): SpeakAsVerifyResult {
  const client = String(input.client ?? '').trim().toLowerCase();
  const resolved = resolveSpeaker(grants, client, input.speaker, input.at ?? new Date());
  if (!resolved.ok) return resolved;
  return verifySpeakAs(grants, { client, asUser: resolved.principalId, targetAgentId: input.targetAgentId, at: input.at });
}

export function verifySpeakAs(grants: readonly SpeakAsGrant[], input: SpeakAsVerifyInput): SpeakAsVerifyResult {
  const client = String(input.client ?? '').trim().toLowerCase();
  let asUser: string;
  try {
    asUser = normalizeUserPrincipal(input.asUser);
  } catch (err) {
    if (err instanceof SpeakAsStoreError) {
      return { ok: false, status: err.status, error: err.code, message: err.message };
    }
    throw err;
  }
  const target = String(input.targetAgentId ?? '').trim().toLowerCase();
  if (!AGENT_ID_RE.test(target)) {
    return { ok: false, status: 400, error: 'invalid_target_agent', message: 'target agent id is invalid' };
  }
  const at = input.at ?? new Date();
  const matches = grants.filter((g) => g.client === client && isGrantActive(g, at));
  if (matches.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'no_speak_as_grant',
      message: `no active speak-as grant for client '${client}'`,
    };
  }
  for (const grant of matches) {
    const member = grant.members.find((m) => m.principalId === asUser);
    if (!member) continue;
    if (member.relationship === 'child' && (!member.targetAgents || member.targetAgents.length === 0 || !memberAllowsAgent(member, target))) {
      return {
        ok: false,
        status: 403,
        error: 'child_restricted',
        message: `a child speaker cannot be connected to agent '${target}'`,
      };
    }
    if (!memberAllowsAgent(member, target)) {
      return {
        ok: false,
        status: 403,
        error: 'agent_not_allowed',
        message: `'${asUser}' is not allowed to be connected to agent '${target}'`,
      };
    }
    return { ok: true, grant, member, actor: asUser };
  }
  return {
    ok: false,
    status: 403,
    error: 'person_not_enrolled',
    message: `'${asUser}' is not enrolled on a speak-as grant for client '${client}'`,
  };
}


/** Map a speak-as relationship to the agent roles tools and egress must honor (never the via client). */
export function privilegesForSpeakAsRelationship(relationship?: SpeakAsRelationship): { isOwner: boolean; agentRoles: string[] } {
  if (relationship === 'owner') return { isOwner: true, agentRoles: ['Owner'] };
  if (relationship === 'family') return { isOwner: false, agentRoles: ['Family'] };
  return { isOwner: false, agentRoles: [] };
}

export function deliveredCaller(opts: {
  actor: string;
  via: string;
  channel: string;
  assurance: string;
  mode: SpeakAsMode;
  name?: string;
  relationship?: SpeakAsRelationship;
  isOwner?: boolean;
  agentRoles?: string[];
}): DeliveredCaller {
  const name = typeof opts.name === 'string' ? opts.name.trim() : '';
  const priv = privilegesForSpeakAsRelationship(opts.relationship);
  const isOwner = opts.isOwner === true || priv.isOwner;
  const agentRoles = opts.agentRoles && opts.agentRoles.length ? opts.agentRoles : priv.agentRoles;
  return {
    actor: opts.actor,
    verified: true,
    channel: opts.channel,
    via: opts.via,
    assurance: opts.assurance,
    mode: opts.mode,
    ...(name ? { name: name.slice(0, 60) } : {}),
    ...(opts.relationship ? { relationship: opts.relationship } : {}),
    ...(isOwner ? { isOwner: true } : {}),
    ...(agentRoles.length ? { agentRoles } : {}),
  };
}

const RELATIONSHIPS = new Set<SpeakAsRelationship>(['owner', 'family', 'child']);

export function normalizeRelationship(raw: unknown): SpeakAsRelationship | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new SpeakAsStoreError(400, 'invalid_relationship', "relationship must be 'owner', 'family', or 'child'");
  }
  const value = raw.trim().toLowerCase();
  if (!RELATIONSHIPS.has(value as SpeakAsRelationship)) {
    throw new SpeakAsStoreError(400, 'invalid_relationship', "relationship must be 'owner', 'family', or 'child'");
  }
  return value as SpeakAsRelationship;
}

function normalizeExpiry(raw: unknown, now: Date): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) {
    throw new SpeakAsStoreError(400, 'invalid_expiry', 'expiresAt must be a future ISO timestamp or null');
  }
  return new Date(t).toISOString();
}

export class SpeakAsGrantStore {
  private byId = new Map<string, SpeakAsGrant>();
  private docVersion = 0;
  private unhealthy?: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private seq = 0;

  private constructor(
    private readonly backend: VersionedDocBackend<SpeakAsDoc>,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  static async open(
    backend: VersionedDocBackend<SpeakAsDoc> = new MemoryDocBackend(),
    opts?: { now?: () => Date },
  ): Promise<SpeakAsGrantStore> {
    const store = new SpeakAsGrantStore(backend, opts);
    try {
      await store.reload();
    } catch {
      // stays unhealthy: fail closed
    }
    return store;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  async reload(): Promise<void> {
    try {
      const st = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();
      const next = new Map<string, SpeakAsGrant>();
      for (const raw of st.snapshot?.data?.grants ?? []) {
        if (!raw || typeof raw.id !== 'string' || next.has(raw.id)) {
          throw new Error('invalid or duplicate speak-as grant in store');
        }
        next.set(raw.id, structuredClone(raw));
      }
      this.byId = next;
      this.docVersion = Math.max(st.snapshot?.version ?? 0, st.maxSeenVersion);
      this.unhealthy = undefined;
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
  }

  get(id: string): SpeakAsGrant | undefined {
    const g = this.byId.get(id);
    return g ? structuredClone(g) : undefined;
  }

  list(filter?: { client?: string; includeRevoked?: boolean }): SpeakAsGrant[] {
    const at = this.now();
    return [...this.byId.values()]
      .filter((g) => (filter?.client ? g.client === filter.client.trim().toLowerCase() : true))
      .filter((g) => (filter?.includeRevoked ? true : isGrantActive(g, at)))
      .map((g) => structuredClone(g));
  }

  verify(input: SpeakAsVerifyInput): SpeakAsVerifyResult {
    if (!this.healthy) {
      return { ok: false, status: 503, error: 'speak_as_store_unavailable', message: 'speak-as grant store is unhealthy' };
    }
    return verifySpeakAs([...this.byId.values()], { ...input, at: input.at ?? this.now() });
  }

  verifyRequest(input: { client: string; speaker: unknown; targetAgentId: string }): SpeakAsVerifyResult {
    if (!this.healthy) {
      return { ok: false, status: 503, error: 'speak_as_store_unavailable', message: 'speak-as grant store is unhealthy' };
    }
    return verifySpeakAsRequest([...this.byId.values()], { ...input, at: this.now() });
  }

  resolveSpeaker(client: string, speaker: unknown): { ok: true; principalId: string } | SpeakAsVerifyErr {
    if (!this.healthy) {
      return { ok: false, status: 503, error: 'speak_as_store_unavailable', message: 'speak-as grant store is unhealthy' };
    }
    return resolveSpeaker([...this.byId.values()], client, speaker, this.now());
  }

  create(input: {
    client: string;
    members?: unknown[];
    expiresAt?: string | null;
    purpose?: string;
    by: string;
  }): Promise<SpeakAsGrant> {
    return this.serial(async () => {
      this.assertHealthy();
      const client = normalizeClient(input.client);
      const members = (input.members ?? []).map(normalizeMember);
      const seen = new Set<string>();
      const seenAliases = new Set<string>();
      for (const m of members) {
        if (seen.has(m.principalId)) throw new SpeakAsStoreError(400, 'duplicate_member', `member '${m.principalId}' listed twice`);
        seen.add(m.principalId);
        for (const a of m.aliases ?? []) {
          if (seenAliases.has(a)) throw new SpeakAsStoreError(400, 'duplicate_alias', `alias '${a}' is already used`);
          seenAliases.add(a);
        }
      }
      const expiresAt = normalizeExpiry(input.expiresAt, this.now());
      const purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim().slice(0, 500) : undefined;
      this.seq += 1;
      const record: SpeakAsGrant = {
        id: 'sag_' + this.now().getTime().toString(16) + this.seq.toString(16).padStart(2, '0'),
        client,
        members,
        expiresAt,
        createdAt: this.now().toISOString(),
        createdBy: input.by,
        ...(purpose ? { purpose } : {}),
      };
      await this.commit(record, input.by);
      return structuredClone(record);
    });
  }

  enroll(id: string, rawMember: unknown, by: string): Promise<SpeakAsGrant> {
    return this.serial(async () => {
      this.assertHealthy();
      const cur = this.requireActive(id);
      const member = normalizeMember(rawMember);
      const others = cur.members.filter((m) => m.principalId !== member.principalId);
      const taken = new Set(others.flatMap((m) => m.aliases ?? []));
      for (const a of member.aliases ?? []) {
        if (taken.has(a)) throw new SpeakAsStoreError(400, 'duplicate_alias', `alias '${a}' is already used`);
      }
      const nextMembers = [...others, member];
      const next: SpeakAsGrant = { ...structuredClone(cur), members: nextMembers };
      await this.commit(next, by);
      return structuredClone(next);
    });
  }

  unenroll(id: string, principalId: string, by: string): Promise<SpeakAsGrant> {
    return this.serial(async () => {
      this.assertHealthy();
      const cur = this.requireActive(id);
      const pid = normalizeUserPrincipal(principalId);
      if (!cur.members.some((m) => m.principalId === pid)) {
        throw new SpeakAsStoreError(404, 'member_not_found', `member '${pid}' is not enrolled`);
      }
      const next: SpeakAsGrant = { ...structuredClone(cur), members: cur.members.filter((m) => m.principalId !== pid) };
      await this.commit(next, by);
      return structuredClone(next);
    });
  }

  revoke(id: string, by: string): Promise<SpeakAsGrant> {
    return this.serial(async () => {
      this.assertHealthy();
      const cur = this.byId.get(id);
      if (!cur) throw new SpeakAsStoreError(404, 'grant_not_found', `no speak-as grant '${id}'`);
      if (cur.revokedAt) return structuredClone(cur);
      const next: SpeakAsGrant = { ...structuredClone(cur), revokedAt: this.now().toISOString(), revokedBy: by };
      await this.commit(next, by);
      return structuredClone(next);
    });
  }

  private requireActive(id: string): SpeakAsGrant {
    const cur = this.byId.get(id);
    if (!cur || !isGrantActive(cur, this.now())) {
      throw new SpeakAsStoreError(404, 'grant_not_found', `no active speak-as grant '${id}'`);
    }
    return cur;
  }

  private assertHealthy(): void {
    if (this.unhealthy !== undefined) {
      throw new SpeakAsStoreError(503, 'speak_as_store_unavailable', 'speak-as grant store is unhealthy');
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(record: SpeakAsGrant, by: string): Promise<void> {
    const nextMap = new Map(this.byId);
    nextMap.set(record.id, record);
    const data: SpeakAsDoc = { grants: [...nextMap.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    const version = this.docVersion + 1;
    try {
      await this.backend.write({
        version,
        updatedAt: this.now().toISOString(),
        updatedBy: by,
        sha256: snapshotSha256(data),
        data,
      });
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
    this.byId = nextMap;
    this.docVersion = version;
  }
}
