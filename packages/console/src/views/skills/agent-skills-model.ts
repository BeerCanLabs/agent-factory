/**
 * The per-agent Skills tab's logic, with no React and no browser (DESIGN_AUTHORITY.md §6.14 SK3, SK4, SK5, TSK-161). The
 * console has no component test runner, so what the tab shows and offers is decided here, where `tsx --test` can prove
 * it. The components only draw what this says.
 *
 * The control plane enforces every role and rule (A2): this only decides what to *offer*. A button hidden here is still
 * refused there, and a button shown here can still be refused (the skill may have been retired since the list loaded).
 */
import type { AgentAdoptedSkill, AgentSkillRequest, AgentSkills, AvailableSkill, SkillVisibility } from '../../api/types.js';

/** The principal name the factory knows a Cloudflare e-mail by. */
export const actorOf = (email: string | undefined): string | undefined => (email ? `cloudflare:${email.trim().toLowerCase()}` : undefined);

/** Whether this e-mail is one of the agent's owners (a verified owner may ask for and remove skills; an admin may always). */
export const isOwnerOf = (owners: readonly string[], email: string | undefined): boolean => {
  const actor = actorOf(email);
  return !!actor && owners.some((o) => o.trim().toLowerCase() === actor);
};

// ---- Versions -------------------------------------------------------------------------------------------------

type Core = { nums: [number, number, number]; pre: string };
function parse(v: string): Core | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : undefined;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal; `undefined` when either is not a semantic version. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release is newer than its own pre-release
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// ---- What a person may do -------------------------------------------------------------------------------------

export type AgentSkillsPerms = {
  /** An admin decides requests; the control plane lets only an admin approve or reject. */
  canDecide: boolean;
  /** The agent's owner, or an admin: may ask for a skill, cancel a request and remove an adoption. */
  canManage: boolean;
};

export const permsFor = (opts: { isAdmin: boolean; isOwner: boolean }): AgentSkillsPerms => ({ canDecide: opts.isAdmin, canManage: opts.isAdmin || opts.isOwner });

// ---- The three lists ------------------------------------------------------------------------------------------

export type AdoptedRow = AgentAdoptedSkill & {
  /** The newest approved version, when it is newer than the one this agent runs. */
  updateTo?: string;
  /** Who put it there, in words. */
  source: string;
  offer: { upgrade: boolean; rollBack: boolean; remove: boolean };
};

export type PendingRow = AgentSkillRequest & { offer: { cancel: boolean; approve: boolean; reject: boolean } };

export type AvailableRow = AvailableSkill & { offer: { request: boolean } };

export type AgentSkillsRows = { adopted: AdoptedRow[]; pending: PendingRow[]; available: AvailableRow[]; refused: AgentSkillRequest[] };

const byId = <T>(rows: readonly T[], id: (r: T) => string): T[] => [...rows].sort((a, b) => id(a).localeCompare(id(b)));

const sourceOf = (a: AgentAdoptedSkill): string =>
  a.auto ? `adopted for its owner${a.approvedBy ? `, approved by ${a.approvedBy}` : ''}` : a.approvedBy ? `approved by ${a.approvedBy}${a.requestedBy && a.requestedBy !== a.approvedBy ? `, asked by ${a.requestedBy}` : ''}` : 'in its configuration';

/**
 * The tab's lists. `adopted` are in the configuration (an update is offered when a newer approved version exists, never
 * for an equal or older one, or one whose version cannot be compared). `pending` are requests waiting for an admin.
 * `available` are the skills the agent does not run and has not asked for. `refused` are private skills its owner removed,
 * which are not adopted again by themselves.
 */
export function agentSkillRows(data: AgentSkills, perms: AgentSkillsPerms): AgentSkillsRows {
  const latest = new Map<string, string>();
  for (const a of data.available) latest.set(a.id, a.version);
  const adoptedIds = new Set(data.adopted.map((a) => a.id));
  const pendingIds = new Set(data.requests.map((r) => r.skillId));

  const adopted = byId(data.adopted, (a) => a.id).map((a): AdoptedRow => {
    const l = latest.get(a.id);
    const cmp = l ? compareVersions(a.version, l) : undefined;
    return {
      ...a,
      ...(l && cmp !== undefined && cmp < 0 ? { updateTo: l } : {}),
      source: sourceOf(a),
      offer: { upgrade: perms.canManage && !!l && cmp !== undefined && cmp < 0, rollBack: perms.canManage, remove: perms.canManage },
    };
  });
  const pending = byId(data.requests, (r) => r.skillId).map((r): PendingRow => ({ ...r, offer: { cancel: perms.canManage, approve: perms.canDecide, reject: perms.canDecide } }));
  const available = byId(data.available, (s) => s.id)
    .filter((s) => !adoptedIds.has(s.id) && !pendingIds.has(s.id))
    .map((s): AvailableRow => ({ ...s, offer: { request: perms.canManage } }));
  return { adopted, pending, available, refused: byId(data.revoked, (r) => r.skillId) };
}

// ---- What running means ---------------------------------------------------------------------------------------

export type Rebuild =
  | { kind: 'none' }
  /** The factory is building and deploying the agent with its new skills now. */
  | { kind: 'rebuilding' }
  /** The configuration and the deployed image differ and no deploy is running: the change is waiting. */
  | { kind: 'waiting'; missing: string[]; extra: string[] };

const pin = (s: { id: string; version: string }) => `${s.id}@${s.version}`;

/**
 * SK3, SK4: whether the agent is being rebuilt for a change in its skills. `deployedSkills` is what the image holds; the
 * configuration says what should run. A built-in agent has no composed image, so it never waits.
 */
export function rebuildState(agent: { state: string; isBuiltin?: boolean; deployedSkills?: ReadonlyArray<{ id: string; version: string }> }, adopted: readonly { id: string; version: string }[]): Rebuild {
  if (agent.state === 'DEPLOYING') return { kind: 'rebuilding' };
  if (agent.isBuiltin) return { kind: 'none' };
  const running = new Set((agent.deployedSkills ?? []).map(pin));
  const should = new Set(adopted.map(pin));
  const missing = [...should].filter((p) => !running.has(p)).sort();
  const extra = [...running].filter((p) => !should.has(p)).sort();
  return missing.length || extra.length ? { kind: 'waiting', missing, extra } : { kind: 'none' };
}

export const rebuildText = (r: Rebuild): string | undefined =>
  r.kind === 'rebuilding'
    ? 'Rebuilding: the factory is building and deploying this agent with its new skills. Nothing needs doing.'
    : r.kind === 'waiting'
      ? `Waiting to be applied: the configuration ${[r.missing.length ? `adds ${r.missing.join(', ')}` : '', r.extra.length ? `removes ${r.extra.join(', ')}` : ''].filter(Boolean).join(' and ')}, and the running image does not have the change yet.`
      : undefined;

// ---- Choosing a version ---------------------------------------------------------------------------------------

/** Versions an agent may be moved to: approved and not retired, newest first, the one it runs left out. */
export function choosableVersions(versions: ReadonlyArray<{ version: string; status: string; retired?: boolean }>, current?: string): string[] {
  return versions
    .filter((v) => v.status === 'approved' && !v.retired && v.version !== current)
    .map((v) => v.version)
    .sort((a, b) => -(compareVersions(a, b) ?? 0));
}

/** Whether moving from `from` to `to` goes back. A version that cannot be compared is not called a roll back. */
export const isRollBack = (from: string, to: string): boolean => (compareVersions(to, from) ?? 0) < 0;

export const visibilityNote = (s: { visibility?: SkillVisibility; owner?: string }, agentId: string): string | undefined =>
  s.visibility === 'private' ? (s.owner === agentId ? 'private to this agent' : `private to ${s.owner ?? 'another agent'}`) : undefined;
