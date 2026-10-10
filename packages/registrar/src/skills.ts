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
  /** SK6: every version is retired. */
  retired: boolean;
  /** The highest approved version (semver precedence), or null when none is approved yet. */
  latestApproved: string | null;
  /** Requirements of the latest approved version, or of the newest registered version when none is approved. */
  requires: SkillRequires;
  versions: Array<
    Pick<
      SkillVersionRecord,
      'version' | 'status' | 'repo' | 'path' | 'commit' | 'tests' | 'checks' | 'checkRun' | 'registeredBy' | 'registeredAt' | 'decidedBy' | 'decidedAt' | 'reason' | 'revoked' | 'retired' | 'retiredBy' | 'retiredAt' | 'retiredReason'
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
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
      renameSync(tmp, path);
    }
    this.put(rec);
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

  /** Every version of a skill, oldest to newest by semver precedence. */
  versions(id: string): SkillVersionRecord[] {
    return [...(this.skills.get(id)?.values() ?? [])].sort((a, b) => compareSemver(a.version, b.version)).map((r) => structuredClone(r));
  }
}

export function summarizeSkill(registry: SkillRegistry, id: string): SkillSummary | undefined {
  const versions = registry.versions(id);
  if (!versions.length) return undefined;
  const approved = versions.filter((v) => v.status === 'approved' && !v.retired);
  const latestApproved = approved.at(-1);
  const shown = latestApproved ?? versions.at(-1)!;
  const owner = ownerOf(versions[0]);
  return {
    id,
    name: shown.manifest.name,
    description: shown.manifest.description,
    visibility: visibilityOf(versions[0]),
    ...(owner ? { owner } : {}),
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
      ...(v.decidedBy ? { decidedBy: v.decidedBy, decidedAt: v.decidedAt } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.revoked ? { revoked: true } : {}),
      ...(v.retired ? { retired: true, ...(v.retiredBy ? { retiredBy: v.retiredBy } : {}), ...(v.retiredAt ? { retiredAt: v.retiredAt } : {}), ...(v.retiredReason ? { retiredReason: v.retiredReason } : {}) } : {}),
    })),
  };
}

export type AdoptRefusal = 'not_found' | 'skill_private' | 'skill_retired' | 'skill_not_approved';
export type AdoptCheck = { ok: true; record: SkillVersionRecord } | { ok: false; error: AdoptRefusal; message: string };

/**
 * SK1, SK3: may this agent be given this skill version? Only an approved, unretired version, and a private skill only
 * for its owner agent. Pure: it asks the registry and decides nothing about who is asking (that is the Bouncer's).
 */
export function canAdopt(registry: SkillRegistry, agentId: string, id: string, version: string): AdoptCheck {
  const rec = registry.get(id, version);
  if (!rec) return { ok: false, error: 'not_found', message: `skill ${id}@${version} is not registered` };
  const owner = ownerOf(rec);
  if (visibilityOf(rec) === 'private' && owner !== agentId) {
    return { ok: false, error: 'skill_private', message: `skill ${id} is private to ${owner ?? 'another agent'}; agent ${agentId} cannot adopt it (SK3)` };
  }
  if (rec.retired) return { ok: false, error: 'skill_retired', message: `skill ${id} is retired (SK6)` };
  if (rec.status !== 'approved') return { ok: false, error: 'skill_not_approved', message: `skill ${id}@${version} is ${rec.status}; only an approved version can be adopted (SK1)` };
  return { ok: true, record: rec };
}

export type AvailableSkill = { id: string; name: string; description: string; visibility: SkillVisibility; owner?: string; version: string; requires: SkillRequires };

/**
 * The skills an agent could be given now: the latest approved, unretired version of each public skill, and of each
 * private skill the agent owns. A private skill of another agent is never listed (SK3).
 */
export function availableTo(registry: SkillRegistry, agentId: string): AvailableSkill[] {
  const out: AvailableSkill[] = [];
  for (const id of registry.ids()) {
    const latest = registry.versions(id).filter((v) => v.status === 'approved' && !v.retired).at(-1);
    if (!latest || !canAdopt(registry, agentId, id, latest.version).ok) continue;
    const owner = ownerOf(latest);
    out.push({
      id,
      name: latest.manifest.name,
      description: latest.manifest.description,
      visibility: visibilityOf(latest),
      ...(owner ? { owner } : {}),
      version: latest.version,
      requires: latest.manifest.requires,
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
