/**
 * The skill registry (DESIGN_AUTHORITY.md §6.14 SK1, SK5): every version of every skill, in memory, written through to
 * one JSON file per version (`<dir>/<id>/<version>.json`); the semver precedence that picks the latest version; the
 * summary of a skill; the skill's folder rule; and reading a skill's `skill.yaml` at a pinned commit.
 *
 * The control plane's side (the registry held per control plane, approval and the ledger rows, the checks it starts, and
 * the routes) is in `packages/control-plane/src/skills.ts`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SKILL_ID, type SkillManifest, type SkillRequires, type SkillVisibility } from '@beercanlabs/factory-contract';
import { cleanFailure } from './skill-checks.js';
import { FULL_SHA, SourceError, type SkillSource } from './source.js';

export type SkillStatus = 'pending' | 'approved' | 'rejected';
export type SkillChecks = 'pending-build' | 'passed' | 'failed';

export type SkillVersionRecord = {
  id: string;
  version: string;
  repo: string;
  /** The skill's folder inside the repository; `.` is the repository root. */
  path: string;
  commit: string;
  manifest: SkillManifest;
  status: SkillStatus;
  /**
   * The factory's checks on the skill's code (SK1): build, the skill's own tests, and the design rules (no secrets, no
   * direct hosts, no provider SDKs). Run by the build step (TSK-054) and recorded with `recordSkillChecks`. A version
   * can be approved only once they have passed, as a pull request merges only when its required checks are green.
   */
  tests: SkillChecks;
  /** The last finished check: when it ended, its run, and its failures (absent when it passed). */
  checks?: { at: string; run?: string; failures?: string[] };
  /** The check in progress, while `tests` is `pending-build`. A newer run supersedes it (an admin re-run). */
  checkRun?: { id: string; checker: string; startedAt: string; startedBy: string };
  registeredBy: string;
  registeredAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  /** Set when the rejection revoked a version that had been approved (SK1 revocation). */
  revoked?: boolean;
  /**
   * SK6: set on every version of a skill when an admin retires it. A retired version stays recorded but can no longer
   * be approved or adopted. Absent on records written before retirement existed.
   */
  retired?: boolean;
  retiredBy?: string;
  retiredAt?: string;
  retiredReason?: string;
  /** SHA256 hex digest of the skill package tarball (.tar.gz) when registered from a package (A5). */
  packageHash?: string;
  /** Named human user who owns the skill (H4, A11). */
  owner?: string;
  /** Group the skill is assigned to (H5, A18). */
  groupId?: string;
  /** Pending ownership transfer (A24). */
  transferPending?: { recipient: string; requestedAt: string; requestedBy: string };
  /** H8, H9: whether the skill is published for adoption by non-owners. */
  published?: boolean;
  publishedAt?: string;
  publishedBy?: string;
  publishRequested?: { requestedAt: string; requestedBy: string; notes?: string };
  unpublishedAt?: string;
  unpublishedBy?: string;
  unpublishedReason?: string;
};

/**
 * SK1: a skill is public or private, and a private skill names its one owner agent. The manifest carries both, and a
 * record written before they existed has neither: it is a public skill. Records load without a schema parse, so never
 * read `manifest.visibility` directly.
 */
export function visibilityOf(rec: Pick<SkillVersionRecord, 'manifest'>): SkillVisibility {
  return rec.manifest.visibility === 'private' ? 'private' : 'public';
}

/** The owner agent of a private skill; undefined for a public skill. */
export function ownerOf(rec: Pick<SkillVersionRecord, 'manifest'>): string | undefined {
  return visibilityOf(rec) === 'private' ? rec.manifest.owner : undefined;
}

/** Who is looking: an admin sees every skill; anyone else sees public skills and the private skills of agents they own. */
export type SkillViewer = { admin: boolean; ownedAgents: readonly string[] };

/** SK7: a private skill is visible only to admins and to the owners of its owner agent. */
export function skillVisibleTo(skill: { visibility: SkillVisibility; owner?: string }, viewer: SkillViewer): boolean {
  if (skill.visibility === 'public' || viewer.admin) return true;
  return skill.owner !== undefined && viewer.ownedAgents.includes(skill.owner);
}

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  /** SK1: public, or private to `owner`. Fixed at registration and the same for every version. */
  visibility: SkillVisibility;
  owner?: string;
  userOwner?: string;
  groupId?: string;
  transferPending?: { recipient: string; requestedAt: string; requestedBy: string };
  published?: boolean;
  publishedAt?: string;
  publishedBy?: string;
  publishRequested?: { requestedAt: string; requestedBy: string; notes?: string };
  unpublishedAt?: string;
  unpublishedBy?: string;
  unpublishedReason?: string;
  /** SK6: every version is retired. */
  retired: boolean;
  /** The highest approved version (semver precedence), or null when none is approved yet. */
  latestApproved: string | null;
  /** Requirements of the latest approved version, or of the newest registered version when none is approved. */
  requires: SkillRequires;
  versions: Array<
    Pick<
      SkillVersionRecord,
      | 'version'
      | 'status'
      | 'repo'
      | 'path'
      | 'commit'
      | 'tests'
      | 'checks'
      | 'checkRun'
      | 'registeredBy'
      | 'registeredAt'
      | 'decidedBy'
      | 'decidedAt'
      | 'reason'
      | 'revoked'
      | 'retired'
      | 'retiredBy'
      | 'retiredAt'
      | 'retiredReason'
      | 'packageHash'
      | 'owner'
      | 'groupId'
      | 'transferPending'
      | 'published'
      | 'publishedAt'
      | 'publishedBy'
      | 'publishRequested'
      | 'unpublishedAt'
      | 'unpublishedBy'
      | 'unpublishedReason'
    >
  >;
};

/** Semver precedence (semver.org §11): -1, 0 or 1. Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s);
    return { nums: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The registry: every version of every skill, in memory, written through to one JSON file per version. */
export class SkillRegistry {
  private readonly skills = new Map<string, Map<string, SkillVersionRecord>>();

  constructor(
    private readonly dir?: string,
    private readonly warn: (message: string, err: unknown) => void = (message, err) => console.warn(`[registrar] ${message}`, err),
  ) {
    if (!dir || !existsSync(dir)) return;
    for (const id of readdirSync(dir)) {
      if (!SKILL_ID.test(id)) continue;
      let files: string[];
      try {
        files = readdirSync(join(dir, id));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(readFileSync(join(dir, id, file), 'utf8')) as SkillVersionRecord;
          if (rec.id !== id || `${rec.version}.json` !== file) throw new Error('record does not match its file name');
          this.put(rec);
        } catch (err) {
          this.warn(`skipping unreadable skill record ${join(dir, id, file)}:`, err);
        }
      }
    }
  }

  private put(rec: SkillVersionRecord): void {
    const versions = this.skills.get(rec.id) ?? new Map<string, SkillVersionRecord>();
    versions.set(rec.version, rec);
    this.skills.set(rec.id, versions);
  }

  /** Persists first, then serves: a record the volume does not hold is never reported as registered. */
  save(rec: SkillVersionRecord): void {
    if (this.dir) {
      const folder = join(this.dir, rec.id);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `${rec.version}.json`);
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
      renameSync(tmp, path);
    }
    this.put(rec);
  }

  /**
   * Saves `rec` only if no record exists for `rec.id@rec.version` AND, if provided,
   * `validate` succeeds against existing versions of `rec.id`.
   * Synchronous and atomic on the in-memory map.
   */
  saveIfAbsent(rec: SkillVersionRecord): boolean;
  saveIfAbsent(rec: SkillVersionRecord, validate: (existing: SkillVersionRecord[]) => { ok: boolean; reason?: string }): { saved: boolean; reason?: string };
  saveIfAbsent(
    rec: SkillVersionRecord,
    validate?: (existing: SkillVersionRecord[]) => { ok: boolean; reason?: string },
  ): boolean | { saved: boolean; reason?: string } {
    if (this.skills.get(rec.id)?.has(rec.version)) {
      return validate ? { saved: false, reason: `version: ${rec.id}@${rec.version} is already registered; versions are immutable, register a new version` } : false;
    }
    if (this.dir) {
      const folder = join(this.dir, rec.id);
      const path = join(folder, `${rec.version}.json`);
      if (existsSync(path)) {
        return validate ? { saved: false, reason: `version: ${rec.id}@${rec.version} is already registered; versions are immutable, register a new version` } : false;
      }
    }
    const existing = this.versions(rec.id);
    if (existing.length > 0) {
      // H9: New versions of a published skill are available for adoption automatically.
      if (existing.some((v) => v.published)) {
        rec.published = true;
        rec.publishedAt = existing.find((v) => v.publishedAt)?.publishedAt ?? new Date().toISOString();
        rec.publishedBy = existing.find((v) => v.publishedBy)?.publishedBy ?? 'system:auto-publish';
      }
      const existingOwner = existing.find((v) => v.owner)?.owner;
      if (existingOwner && !rec.owner) rec.owner = existingOwner;
      const existingGroup = existing.find((v) => v.groupId)?.groupId;
      if (existingGroup && !rec.groupId) rec.groupId = existingGroup;
    }
    if (validate) {
      const check = validate(existing);
      if (!check.ok) {
        return { saved: false, reason: check.reason ?? 'registration_refused' };
      }
    }
    this.save(rec);
    return validate ? { saved: true } : true;
  }

  get(id: string, version: string): SkillVersionRecord | undefined {
    const rec = this.skills.get(id)?.get(version);
    return rec ? structuredClone(rec) : undefined;
  }

  ids(): string[] {
    return [...this.skills.keys()].sort();
  }

  /**
   * SK1: visibility and owner belong to the skill, not to a version, and never change; to change either, register a new
   * skill. The refusal for a manifest that would change them, or undefined when it does not (or the skill is new).
   */
  identityIssue(manifest: Pick<SkillManifest, 'id' | 'visibility' | 'owner'>): string | undefined {
    if ((manifest as any).spec === 1) return undefined;
    const first = this.versions(manifest.id)[0];
    if (!first) return undefined;
    const visibility = manifest.visibility === 'private' ? 'private' : 'public';
    const owner = visibility === 'private' ? manifest.owner : undefined;
    if (visibility === visibilityOf(first) && owner === ownerOf(first)) return undefined;
    const was = visibilityOf(first) === 'private' ? `private to ${ownerOf(first)}` : 'public';
    const now = visibility === 'private' ? `private to ${owner}` : 'public';
    return `skill ${manifest.id} is ${was}; a version cannot make it ${now}. Visibility and owner never change: register a new skill (SK1)`;
  }

  /**
   * SK6: retires every version of a skill and persists each. Returns the versions it changed (none: unknown skill or
   * already retired). A retired version stays recorded; it can no longer be approved or adopted.
   */
  retire(id: string, by: string, reason?: string, now: Date = new Date()): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      if (rec.retired) continue;
      const next: SkillVersionRecord = { ...rec, retired: true, retiredBy: by, retiredAt: now.toISOString(), ...(reason ? { retiredReason: reason } : {}) };
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Sets or updates the human owner on all versions of a skill and persists each (H4, A11). */
  setOwner(id: string, newOwner: string): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = { ...rec, owner: newOwner };
      delete next.transferPending;
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Requests a transfer of skill ownership to a recipient (A24). */
  requestTransfer(id: string, recipient: string, requestedBy: string, now: Date = new Date()): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    const transferPending = { recipient, requestedAt: now.toISOString(), requestedBy };
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = { ...rec, transferPending };
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Accepts a pending transfer of skill ownership (A24). */
  acceptTransfer(id: string, recipient: string): SkillVersionRecord[] {
    const versions = this.versions(id);
    const currentPending = versions.find((v) => v.transferPending)?.transferPending;
    if (!currentPending || currentPending.recipient.toLowerCase() !== recipient.toLowerCase()) {
      throw new Error(`no pending transfer for recipient ${recipient}`);
    }
    return this.setOwner(id, recipient);
  }

  /** Cancels a pending transfer of skill ownership. */
  cancelTransfer(id: string): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      if (!rec.transferPending) continue;
      const next: SkillVersionRecord = { ...rec };
      delete next.transferPending;
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Assigns a skill to a group (H5, A18). */
  assignGroup(id: string, groupId: string): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = { ...rec, groupId };
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Unassigns a skill from a group. */
  unassignGroup(id: string): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      if (!rec.groupId) continue;
      const next: SkillVersionRecord = { ...rec };
      delete next.groupId;
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Requests publication of a skill (H8, A8). */
  requestPublish(id: string, requestedBy: string, notes?: string, now: Date = new Date()): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    const publishRequested = { requestedAt: now.toISOString(), requestedBy, ...(notes ? { notes } : {}) };
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = { ...rec, publishRequested };
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Decides a pending publication request (H8, H9, A8). */
  decidePublish(
    id: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
    reason?: string,
    now: Date = new Date(),
  ): { ok: boolean; status: 'published' | 'unpublished'; changed: SkillVersionRecord[] } {
    const changed: SkillVersionRecord[] = [];
    const isApprove = decision === 'approve';
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = { ...rec };
      delete next.publishRequested;
      if (isApprove) {
        next.published = true;
        next.publishedAt = now.toISOString();
        next.publishedBy = decidedBy;
        delete next.unpublishedAt;
        delete next.unpublishedBy;
        delete next.unpublishedReason;
      }
      this.save(next);
      changed.push(structuredClone(next));
    }
    return { ok: true, status: isApprove ? 'published' : 'unpublished', changed };
  }

  /** Unpublishes a skill (A13). Stops new adoptions by non-owners. */
  unpublish(id: string, unpublishedBy: string, reason?: string, now: Date = new Date()): SkillVersionRecord[] {
    const changed: SkillVersionRecord[] = [];
    for (const rec of this.versions(id)) {
      const next: SkillVersionRecord = {
        ...rec,
        published: false,
        unpublishedAt: now.toISOString(),
        unpublishedBy,
        ...(reason ? { unpublishedReason: reason } : {}),
      };
      this.save(next);
      changed.push(structuredClone(next));
    }
    return changed;
  }

  /** Every version of a skill, oldest to newest by semver precedence. */
  versions(id: string): SkillVersionRecord[] {
    return [...(this.skills.get(id)?.values() ?? [])].sort((a, b) => compareSemver(a.version, b.version)).map((r) => structuredClone(r));
  }
}

export function summarizeSkill(registry: SkillRegistry, id: string): SkillSummary | undefined {
  const versions = registry.versions(id);
  if (!versions.length) return undefined;
  const approved = versions.filter((v) => v.status !== 'rejected' && (v.status === 'approved' || v.tests === 'passed') && !v.retired);
  const latestApproved = approved.at(-1);
  const shown = latestApproved ?? versions.at(-1)!;
  const humanOwner = versions.find((v) => v.owner)?.owner;
  const legacyAgentOwner = ownerOf(versions[0]);
  const owner = legacyAgentOwner ?? humanOwner;
  const groupId = versions.find((v) => v.groupId)?.groupId;
  const transferPending = versions.find((v) => v.transferPending)?.transferPending;
  const hasPublishedField = versions.some((v) => v.published !== undefined);
  const published = versions.some((v) => v.published);
  const publishedAt = versions.find((v) => v.publishedAt)?.publishedAt;
  const publishedBy = versions.find((v) => v.publishedBy)?.publishedBy;
  const publishRequested = versions.find((v) => v.publishRequested)?.publishRequested;
  const unpublishedAt = versions.find((v) => v.unpublishedAt)?.unpublishedAt;
  const unpublishedBy = versions.find((v) => v.unpublishedBy)?.unpublishedBy;
  const unpublishedReason = versions.find((v) => v.unpublishedReason)?.unpublishedReason;
  return {
    id,
    name: shown.manifest.name,
    description: shown.manifest.description,
    visibility: published ? 'public' : visibilityOf(versions[0]),
    ...(owner ? { owner } : {}),
    ...(humanOwner ? { userOwner: humanOwner } : {}),
    ...(groupId ? { groupId } : {}),
    ...(transferPending ? { transferPending } : {}),
    ...(hasPublishedField ? { published } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(publishedBy ? { publishedBy } : {}),
    ...(publishRequested ? { publishRequested } : {}),
    ...(unpublishedAt ? { unpublishedAt } : {}),
    ...(unpublishedBy ? { unpublishedBy } : {}),
    ...(unpublishedReason ? { unpublishedReason } : {}),
    retired: versions.every((v) => v.retired === true),
    latestApproved: latestApproved?.version ?? null,
    requires: shown.manifest.requires,
    versions: versions.map((v) => ({
      version: v.version,
      status: v.status,
      repo: v.repo,
      path: v.path,
      commit: v.commit,
      tests: v.tests,
      ...(v.checks ? { checks: v.checks } : {}),
      ...(v.checkRun ? { checkRun: v.checkRun } : {}),
      registeredBy: v.registeredBy,
      registeredAt: v.registeredAt,
      ...(v.owner ? { owner: v.owner } : {}),
      ...(v.groupId ? { groupId: v.groupId } : {}),
      ...(v.transferPending ? { transferPending: v.transferPending } : {}),
      ...(v.published ? { published: v.published } : {}),
      ...(v.publishedAt ? { publishedAt: v.publishedAt } : {}),
      ...(v.publishedBy ? { publishedBy: v.publishedBy } : {}),
      ...(v.publishRequested ? { publishRequested: v.publishRequested } : {}),
      ...(v.unpublishedAt ? { unpublishedAt: v.unpublishedAt } : {}),
      ...(v.unpublishedBy ? { unpublishedBy: v.unpublishedBy } : {}),
      ...(v.unpublishedReason ? { unpublishedReason: v.unpublishedReason } : {}),
      ...(v.decidedBy ? { decidedBy: v.decidedBy, decidedAt: v.decidedAt } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.revoked ? { revoked: true } : {}),
      ...(v.packageHash ? { packageHash: v.packageHash } : {}),
      ...(v.retired ? { retired: true, ...(v.retiredBy ? { retiredBy: v.retiredBy } : {}), ...(v.retiredAt ? { retiredAt: v.retiredAt } : {}), ...(v.retiredReason ? { retiredReason: v.retiredReason } : {}) } : {}),
    })),
  };
}

export type AdoptRefusal = 'not_found' | 'skill_private' | 'skill_retired' | 'skill_not_approved';
export type AdoptCheck = { ok: true; record: SkillVersionRecord } | { ok: false; error: AdoptRefusal; message: string };

export type AdoptContext = {
  agentOwners?: readonly string[];
  userGroups?: readonly string[];
};

/**
 * H7, H8, H10, A7, A12: may this agent be given this skill version?
 * Checks guardrails (tests passed or legacy approved, unretired),
 * and adoption rule (published, owner agent, owner human user, or assigned group member).
 */
export function canAdopt(
  registry: SkillRegistry,
  agentId: string,
  id: string,
  version: string,
  ctx?: AdoptContext,
): AdoptCheck {
  const rec = registry.get(id, version);
  if (!rec) return { ok: false, error: 'not_found', message: `skill ${id}@${version} is not registered` };
  if (rec.retired) return { ok: false, error: 'skill_retired', message: `skill ${id} is retired (SK6)` };

  // Guardrails gate (A7): tests passed, or legacy approved status
  const passed = rec.status !== 'rejected' && (rec.status === 'approved' || rec.tests === 'passed');
  if (!passed) {
    return { ok: false, error: 'skill_not_approved', message: `skill ${id}@${version} is ${rec.status}; only a version that passed checks can be adopted (A7)` };
  }

  // Adoption eligibility (A12, H7, H8, H10):
  // 1. Published skill is adoptable by any agent (H8)
  const legacyAgentOwner = ownerOf(rec);
  const isLegacyPrivate = visibilityOf(rec) === 'private';
  const isPublished =
    rec.published === true ||
    (!isLegacyPrivate &&
      rec.published !== false &&
      (rec.status === 'approved'
        ? !rec.owner || rec.owner.startsWith('token:admin') || rec.owner === 'admin'
        : !rec.owner));
  if (isPublished) return { ok: true, record: rec };

  // 2. Legacy agent-owned private skill (SK1, SK3)
  if (legacyAgentOwner && legacyAgentOwner === agentId) return { ok: true, record: rec };

  // 3. Human user owner matches one of the agent's owners (H7, A12)
  const humanOwner = rec.owner;
  if (humanOwner && ctx?.agentOwners) {
    const isOwner = ctx.agentOwners.some((o) => o.toLowerCase() === humanOwner.toLowerCase());
    if (isOwner) return { ok: true, record: rec };
  }

  // 4. Assigned to a group the agent's owner belongs to (H5, A12)
  if (rec.groupId && ctx?.userGroups) {
    const isGroupMember = ctx.userGroups.some((g) => g.toLowerCase() === rec.groupId!.toLowerCase());
    if (isGroupMember) return { ok: true, record: rec };
  }

  return {
    ok: false,
    error: 'skill_private',
    message: `skill ${id} is private; agent ${agentId} is not owned by the skill owner or assigned group members, and the skill is not published (A12, H8)`,
  };
}

export type AvailableSkill = {
  id: string;
  name: string;
  description: string;
  visibility: SkillVisibility;
  owner?: string;
  version: string;
  requires: SkillRequires;
  published?: boolean;
};

/**
 * The skills an agent could be given now: the latest usable, unretired version of each published skill,
 * and of each skill adoptable by the agent under A12.
 */
export function availableTo(registry: SkillRegistry, agentId: string, ctx?: AdoptContext): AvailableSkill[] {
  const out: AvailableSkill[] = [];
  for (const id of registry.ids()) {
    const latest = registry.versions(id).filter((v) => v.status !== 'rejected' && (v.status === 'approved' || v.tests === 'passed') && !v.retired).at(-1);
    if (!latest || !canAdopt(registry, agentId, id, latest.version, ctx).ok) continue;
    const owner = ownerOf(latest) ?? latest.owner;
    out.push({
      id,
      name: latest.manifest.name,
      description: latest.manifest.description,
      visibility: latest.published ? 'public' : visibilityOf(latest),
      ...(owner ? { owner } : {}),
      version: latest.version,
      requires: latest.manifest.requires,
      ...(latest.published ? { published: true } : {}),
    });
  }
  return out;
}

/** The skill's folder inside the repository: relative, normalized, never outside the repository. */
export function checkSkillPath(raw: unknown): string | undefined {
  if (raw === undefined || raw === '' || raw === '.' || raw === './') return '.';
  if (typeof raw !== 'string' || raw.length > 512) return undefined;
  if (raw.startsWith('/') || raw.includes('\\') || /[\s\0]/.test(raw)) return undefined;
  const parts = raw.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return undefined;
  return parts.join('/');
}

/**
 * TSK-055: resolves `ref` (when no full SHA was given) and reads `<path>/skill.yaml` at that commit. Every failure is a
 * reason the caller can act on: the repository is unreachable with the factory's token, the branch or tag or commit does
 * not exist, or there is no readable `skill.yaml` there.
 */
export async function fetchManifest(
  source: SkillSource,
  repo: string,
  path: string,
  sha: string | undefined,
  ref: string | undefined,
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(`[registrar] ${message}`, err),
): Promise<{ commit?: string; raw?: Record<string, unknown>; reasons: string[] }> {
  const file = path === '.' ? 'skill.yaml' : `${path}/skill.yaml`;
  let commit = sha;
  try {
    if (!commit && ref) {
      commit = await source.resolveRef(repo, ref);
      if (!commit) return { reasons: [`commit: ${repo} has no branch or tag named "${ref}"`] };
      if (!FULL_SHA.test(commit)) return { reasons: [`commit: "${ref}" did not resolve to a full commit SHA`] };
    }
    if (!commit) return { reasons: [] };
    const text = await source.readFile(repo, commit, file);
    if (text === undefined) {
      return { commit, reasons: [`skill.yaml: there is no skill.yaml at "${path}" in ${repo} at ${commit.slice(0, 12)}; check the path and the commit`] };
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(text, { maxAliasCount: 50 });
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { commit, reasons: [`skill.yaml: ${file} at ${commit.slice(0, 12)} is not valid YAML (${cleanFailure(why)})`] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { commit, reasons: [`skill.yaml: ${file} at ${commit.slice(0, 12)} is not a mapping of keys to values`] };
    }
    return { commit, raw: parsed as Record<string, unknown>, reasons: [] };
  } catch (err) {
    if (err instanceof SourceError && err.kind === 'no_commit') return { reasons: [`commit: ${cleanFailure(err.message)}`] };
    if (err instanceof SourceError && err.kind === 'ambiguous') return { reasons: [`commit: ${cleanFailure(err.message)}`] };
    if (err instanceof SourceError && err.kind === 'too_large') return { commit, reasons: [`skill.yaml: ${cleanFailure(err.message)}`] };
    warn(`could not read skill source ${repo}:`, err instanceof Error ? err.message : err);
    return {
      reasons: [
        `repo: cannot fetch ${repo}; check that the factory's source token can read this repository (a private repository must grant it read access)`,
      ],
    };
  }
}
