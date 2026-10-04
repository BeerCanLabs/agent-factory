/**
 * Skill registry (DESIGN_AUTHORITY.md §6.14 SK1, SK2).
 *
 * A skill is registered by naming a repository, a path inside it and a commit. The caller either sends the parsed
 * `skill.yaml` with a full commit SHA, or omits it and the control plane reads `skill.yaml` at that path and commit itself
 * with the factory's read-only source token (TSK-055); then `commit` may be a branch or tag, which is resolved here to
 * the full SHA it points at and recorded as that SHA, so the pin never moves.
 * Admission pins the commit and checks the manifest (schema, a new version, the design rules). Registering a version
 * starts the factory's checks on its code (skill-checks.ts, TSK-054): `tests: 'pending-build'` until they end, then
 * `passed` or `failed` with short reasons. Every version is approved or rejected by a factory admin, and approval waits
 * for the checks to pass; only approved versions can be adopted (`approvedSkill`). Registration, refusals, checks and
 * decisions are ledgered.
 *
 *   POST /api/v1/registry/skills                                     any user: { repo, path, commit, manifest? }
 *   POST /api/v1/registry/skills/:id/versions/:version/checks        admin: re-run the checks
 *   POST /api/v1/registry/skills/:id/versions/:version/approve       admin: { reason? }
 *   POST /api/v1/registry/skills/:id/versions/:version/reject        admin: { reason?, force? }
 *   GET  /api/v1/skills                                              viewer: the catalog
 *   GET  /api/v1/skills/:id                                          viewer: one skill and every version
 *   GET  /api/v1/skills/:id/versions/:version                        viewer: one version's record
 *
 * Records live in `<data dir>/skills/<id>/<version>.json` (the control plane's backed-up volume, R1). They are read
 * once, when the registry is first used, and served from memory: no request reads the disk or the network (GAP-056).
 */
import http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { SEMVER, SKILL_ID, skillDesignIssues, validateSkillManifest, type SkillManifest, type SkillRequires } from '@beercanlabs/factory-contract';
import { applyKillSwitch, json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { FULL_SHA } from './runtime.js';
import { parse as parseYaml } from 'yaml';
import { checkRefName, checkRepoUrl, gitSkillSource, SourceError, type SkillSource } from './source.js';
import { cleanFailure, skillCheckerFromEnv, type SkillChecker, type SkillCheckOutcome } from './skill-checks.js';

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
};

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  /** The highest approved version (semver precedence), or null when none is approved yet. */
  latestApproved: string | null;
  /** Requirements of the latest approved version, or of the newest registered version when none is approved. */
  requires: SkillRequires;
  versions: Array<
    Pick<
      SkillVersionRecord,
      'version' | 'status' | 'repo' | 'path' | 'commit' | 'tests' | 'checks' | 'checkRun' | 'registeredBy' | 'registeredAt' | 'decidedBy' | 'decidedAt' | 'reason' | 'revoked'
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

  constructor(private readonly dir?: string) {
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
          console.warn(`[control-plane] skipping unreadable skill record ${join(dir, id, file)}:`, err);
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

  /** Every version of a skill, oldest to newest by semver precedence. */
  versions(id: string): SkillVersionRecord[] {
    return [...(this.skills.get(id)?.values() ?? [])].sort((a, b) => compareSemver(a.version, b.version)).map((r) => structuredClone(r));
  }
}

const registries = new WeakMap<FactoryState, SkillRegistry>();

/** The control plane's data directory, as `index.ts` derives it (the ledger's directory), plus `skills`. */
function defaultSkillsDir(): string {
  if (process.env.FACTORY_SKILLS_DIR) return process.env.FACTORY_SKILLS_DIR;
  return join(dirname(process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl')), 'skills');
}

/** Opens the registry at `dir` (or the default data directory) and loads it into memory. Call once at start. */
export function loadSkills(state: FactoryState, dir: string | undefined = defaultSkillsDir()): SkillRegistry {
  const registry = new SkillRegistry(dir);
  registries.set(state, registry);
  return registry;
}

/** The loaded registry; loaded from the default data directory on first use if `loadSkills` was not called. */
export function skillRegistry(state: FactoryState): SkillRegistry {
  return registries.get(state) ?? loadSkills(state);
}

/** SK1: a version an agent may adopt. Only approved versions; anything else (unknown, pending, rejected) is undefined. */
export function approvedSkill(state: FactoryState, id: string, version: string): SkillVersionRecord | undefined {
  const rec = skillRegistry(state).get(id, version);
  return rec?.status === 'approved' ? rec : undefined;
}

export function summarizeSkill(registry: SkillRegistry, id: string): SkillSummary | undefined {
  const versions = registry.versions(id);
  if (!versions.length) return undefined;
  const approved = versions.filter((v) => v.status === 'approved');
  const latestApproved = approved.at(-1);
  const shown = latestApproved ?? versions.at(-1)!;
  return {
    id,
    name: shown.manifest.name,
    description: shown.manifest.description,
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
    })),
  };
}

/** The skill's folder inside the repository: relative, normalized, never outside the repository. */
function checkSkillPath(raw: unknown): string | undefined {
  if (raw === undefined || raw === '' || raw === '.' || raw === './') return '.';
  if (typeof raw !== 'string' || raw.length > 512) return undefined;
  if (raw.startsWith('/') || raw.includes('\\') || /[\s\0]/.test(raw)) return undefined;
  const parts = raw.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return undefined;
  return parts.join('/');
}

/** Ledger key for a skill version: the ledger is keyed by agent, so skills are `skill:<id>@<version>`. */
function ledgerKey(id: unknown, version?: unknown): string {
  const safeId = typeof id === 'string' && SKILL_ID.test(id) && id.length <= 64 ? id : '(invalid)';
  const safeVersion = typeof version === 'string' && SEMVER.test(version) && version.length <= 64 ? `@${version}` : '';
  return `skill:${safeId}${safeVersion}`;
}

async function register(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // SK1: any authenticated user may register a skill; nothing is adoptable until an admin approves it.
  const principal = await requirePrivilege(req, res, state, 'skills.register');
  if (!principal) return;
  const body = await readJson(req);
  const registry = skillRegistry(state);
  const reasons: string[] = [];

  const repo = checkRepoUrl(body.repo);
  if (!repo) reasons.push('repo: must be an https git URL without embedded credentials');
  const path = checkSkillPath(body.path);
  if (!path) reasons.push('path: must be a relative folder inside the repository (no "..", no leading "/")');
  let commit = typeof body.commit === 'string' && FULL_SHA.test(body.commit) ? body.commit : undefined;
  let resolvedFrom: string | undefined;

  let raw: Record<string, unknown> | undefined;
  if (body.manifest === undefined || body.manifest === null) {
    // TSK-055: no manifest sent. The factory reads skill.yaml at the pin itself; a branch or tag is resolved to its SHA now.
    const ref = commit ? undefined : checkRefName(body.commit);
    if (!commit && !ref) reasons.push('commit: must be a full 40-character git SHA, or a branch or tag name that the factory resolves to one');
    if (repo && path && (commit || ref)) {
      const fetched = await fetchManifest(skillSourceFor(state), repo, path, commit, ref);
      reasons.push(...fetched.reasons);
      commit = fetched.commit;
      resolvedFrom = fetched.commit && ref ? ref : undefined;
      raw = fetched.raw;
    }
  } else {
    if (!commit) reasons.push('commit: must be a full 40-character lowercase git SHA when a manifest is sent (omit the manifest to register a branch or tag; the factory resolves it)');
    const rawManifest = body.manifest;
    raw = typeof rawManifest === 'object' && !Array.isArray(rawManifest) ? (rawManifest as Record<string, unknown>) : undefined;
    if (!raw) reasons.push('manifest: must be the parsed skill.yaml (an object), or omitted for the factory to read it');
  }
  let manifest: SkillManifest | undefined;
  if (raw) {
    const checked = validateSkillManifest(raw);
    if (!checked.ok) {
      for (const i of checked.issues) reasons.push(`manifest.${i.path}: ${i.message}`);
    } else {
      manifest = checked.manifest;
      if (registry.get(manifest.id, manifest.version)) {
        reasons.push(`version: ${manifest.id}@${manifest.version} is already registered; versions are immutable, register a new version`);
      }
      // SK1: a skill is its source. A different repository or path is a different skill, never a new version of this one.
      const existing = registry.versions(manifest.id)[0];
      if (existing && repo && path && (existing.repo !== repo || existing.path !== path)) {
        reasons.push(`id: ${manifest.id} is registered from ${existing.repo} (${existing.path}); a different repository or path is a different skill, so give it a different id`);
      }
      for (const i of skillDesignIssues(manifest, { gatekeeperEgressHeld: state.gatekeeperEgressHeldSecrets })) {
        reasons.push(`manifest.${i.path}: ${i.message}`);
      }
    }
  }

  const now = new Date().toISOString();
  if (reasons.length || !manifest || !repo || !commit || !path) {
    state.ledger.append({
      timestamp: now,
      agentId: ledgerKey(raw?.id, raw?.version),
      type: 'action',
      action: 'SKILL_REFUSED',
      actor: principal.actor,
      ...(commit ? { commit } : {}),
      payloadSha256: payloadHash(reasons),
    });
    json(res, 422, { error: 'skill_refused', reasons });
    return;
  }

  const rec: SkillVersionRecord = {
    id: manifest.id,
    version: manifest.version,
    repo,
    path,
    commit,
    manifest,
    status: 'pending',
    tests: 'pending-build',
    registeredBy: principal.actor,
    registeredAt: now,
  };
  try {
    registry.save(rec);
  } catch (err) {
    console.warn(`[control-plane] failed to persist skill ${rec.id}@${rec.version}:`, err);
    json(res, 500, { error: 'persist_failed', message: 'the skill record could not be written; nothing was registered' });
    return;
  }
  state.ledger.append({
    timestamp: now,
    agentId: ledgerKey(rec.id, rec.version),
    type: 'action',
    action: 'SKILL_REGISTERED',
    actor: principal.actor,
    commit,
    payloadSha256: payloadHash(manifest),
  });
  // SK1: registering a version starts the factory's checks on its code; approval waits for them.
  const started = await startSkillChecks(state, rec.id, rec.version, principal.actor);
  json(res, 201, { ...(started.record ?? rec), ...(resolvedFrom ? { resolvedFrom } : {}) });
}

/** The source registration reads `skill.yaml` from: `state.skillSource`, else git with the factory's source token. */
const defaultSources = new WeakMap<FactoryState, SkillSource>();
function skillSourceFor(state: FactoryState): SkillSource {
  if (state.skillSource) return state.skillSource;
  let source = defaultSources.get(state);
  if (!source) defaultSources.set(state, (source = gitSkillSource()));
  return source;
}

/**
 * TSK-055: resolves `ref` (when no full SHA was given) and reads `<path>/skill.yaml` at that commit. Every failure is a
 * reason the caller can act on: the repository is unreachable with the factory's token, the branch or tag or commit does
 * not exist, or there is no readable `skill.yaml` there.
 */
async function fetchManifest(
  source: SkillSource,
  repo: string,
  path: string,
  sha: string | undefined,
  ref: string | undefined,
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
    console.warn(`[control-plane] could not read skill source ${repo}:`, err instanceof Error ? err.message : err);
    return {
      reasons: [
        `repo: cannot fetch ${repo}; check that the factory's source token can read this repository (a private repository must grant it read access)`,
      ],
    };
  }
}

async function decide(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  version: string,
  decision: 'approve' | 'reject',
): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.decide');
  if (!principal) return;
  const body = await readJson(req);
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 2000)) {
    json(res, 400, { error: 'invalid_reason', message: 'reason must be a string of at most 2000 characters' });
    return;
  }
  const registry = skillRegistry(state);
  const rec = registry.get(id, version);
  if (!rec) {
    json(res, 404, { error: 'not_found', id, version });
    return;
  }
  const status: SkillStatus = decision === 'approve' ? 'approved' : 'rejected';
  // SK1: like a pull request, a version is approved only after the factory's checks on its code have passed.
  if (decision === 'approve' && rec.tests !== 'passed') {
    json(res, 409, {
      error: rec.tests === 'failed' ? 'checks_failed' : 'checks_pending',
      id,
      version,
      tests: rec.tests,
      ...(rec.checks?.failures ? { failures: rec.checks.failures } : {}),
      message: 'a skill version can be approved only after the factory has built it, run its tests and checked its code',
    });
    return;
  }
  if (rec.status === status) {
    json(res, 409, { error: `already_${status}`, id, version });
    return;
  }
  // SK1 revocation: an approved version in use cannot be revoked until every agent using it is redeployed without it.
  // An admin override (force) revokes now and pauses each of those agents until they are redeployed without it.
  const revoking = decision === 'reject' && rec.status === 'approved';
  const users = revoking ? skillUsers(state, id, version) : [];
  if (users.length && body.force !== true) {
    json(res, 409, {
      error: 'skill_in_use',
      id,
      version,
      agents: users,
      message: 'redeploy these agents without this skill version first, or revoke with "force": true to pause them until they are',
    });
    return;
  }
  const paused: string[] = [];
  for (const agentId of users) {
    const out = await applyKillSwitch(state, agentId, 'PAUSE', principal.actor);
    if (out.status === 200) paused.push(agentId);
  }
  const now = new Date().toISOString();
  const next: SkillVersionRecord = { ...rec, status, decidedBy: principal.actor, decidedAt: now };
  if (revoking) next.revoked = true;
  else delete next.revoked;
  if (typeof body.reason === 'string' && body.reason.trim()) next.reason = body.reason.trim();
  else delete next.reason;
  try {
    registry.save(next);
  } catch (err) {
    console.warn(`[control-plane] failed to persist skill decision ${id}@${version}:`, err);
    json(res, 500, { error: 'persist_failed', message: 'the decision could not be written; nothing changed' });
    return;
  }
  state.ledger.append({
    timestamp: now,
    agentId: ledgerKey(id, version),
    type: 'action',
    action: decision === 'approve' ? 'SKILL_APPROVED' : revoking ? (users.length ? 'SKILL_REVOKED_FORCED' : 'SKILL_REVOKED') : 'SKILL_REJECTED',
    actor: principal.actor,
    commit: rec.commit,
    ...(next.reason ? { payloadSha256: payloadHash(next.reason) } : {}),
  });
  json(res, 200, users.length ? { ...next, paused } : next);
}

/**
 * SK1: record the outcome of the factory's checks on a version's code (build, tests, design rules). Called by the build
 * step (TSK-054). Ledgered as SKILL_CHECKS_PASSED or SKILL_CHECKS_FAILED; failures are short reasons, never code.
 */
export function recordSkillChecks(
  state: FactoryState,
  id: string,
  version: string,
  outcome: { passed: boolean; failures?: string[]; run?: string },
): SkillVersionRecord | undefined {
  const registry = skillRegistry(state);
  const rec = registry.get(id, version);
  if (!rec) return undefined;
  // A run an admin has since superseded with a re-run reports nothing: only the latest run decides.
  if (outcome.run !== undefined && rec.checkRun?.id !== outcome.run) return undefined;
  const at = new Date().toISOString();
  const failures = (outcome.failures ?? []).map(cleanFailure).filter(Boolean).slice(0, 50);
  const next: SkillVersionRecord = {
    ...rec,
    tests: outcome.passed ? 'passed' : 'failed',
    checks: { at, ...(outcome.run ? { run: outcome.run } : {}), ...(outcome.passed || !failures.length ? {} : { failures }) },
  };
  delete next.checkRun;
  registry.save(next);
  state.ledger.append({
    timestamp: at,
    agentId: ledgerKey(id, version),
    type: 'action',
    action: outcome.passed ? 'SKILL_CHECKS_PASSED' : 'SKILL_CHECKS_FAILED',
    actor: 'factory:admission',
    commit: rec.commit,
    ...(failures.length ? { payloadSha256: payloadHash(failures) } : {}),
  });
  return next;
}

const envCheckers = new WeakMap<FactoryState, Promise<SkillChecker | undefined>>();

/** `state.skillChecker` when set (null: none), else the deployment's checker from the environment, chosen once. */
async function checkerFor(state: FactoryState): Promise<SkillChecker | undefined> {
  if (state.skillChecker !== undefined) return state.skillChecker ?? undefined;
  let checker = envCheckers.get(state);
  if (!checker) {
    checker = skillCheckerFromEnv().catch((err) => {
      console.warn('[control-plane] skill checker unavailable; skill checks are off:', err);
      return undefined;
    });
    envCheckers.set(state, checker);
  }
  return checker;
}

/** Waits for a run in the background (the checker polls its build service, never an API request) and records it. */
function watchSkillChecks(state: FactoryState, checker: SkillChecker, id: string, version: string, runId: string): void {
  void checker
    .result(runId)
    .catch((err): SkillCheckOutcome => ({ passed: false, failures: [`checks: the check run could not be followed (${err instanceof Error ? err.message : String(err)})`] }))
    .then((outcome) => recordSkillChecks(state, id, version, { ...outcome, run: runId }))
    .catch((err) => console.warn(`[control-plane] failed to record skill checks for ${id}@${version}:`, err));
}

export type StartChecksResult = {
  record?: SkillVersionRecord;
  error?: 'not_found' | 'already_approved' | 'checker_not_configured' | 'start_failed';
  message?: string;
};

/**
 * SK1: starts the factory's checks on a version's code (at registration, or an admin re-run). The version goes back to
 * `pending-build` with the new run; its outcome is recorded by `recordSkillChecks` when the run ends. An approved
 * version's checks are settled and are not re-run.
 */
export async function startSkillChecks(state: FactoryState, id: string, version: string, actor: string): Promise<StartChecksResult> {
  const registry = skillRegistry(state);
  const rec = registry.get(id, version);
  if (!rec) return { error: 'not_found' };
  if (rec.status === 'approved') return { record: rec, error: 'already_approved', message: 'an approved version has passed its checks; they are not re-run' };
  const checker = await checkerFor(state);
  if (!checker) {
    return { record: rec, error: 'checker_not_configured', message: 'no skill checker is configured (FACTORY_SKILL_CHECKER); the version stays pending-build' };
  }
  let runId: string;
  try {
    runId = await checker.start({ id, version, repo: rec.repo, path: rec.path, commit: rec.commit, manifest: rec.manifest });
  } catch (err) {
    const message = `the check run could not be started: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[control-plane] skill checks for ${id}@${version}: ${message}`);
    return { record: rec, error: 'start_failed', message };
  }
  const latest = registry.get(id, version) ?? rec;
  if (latest.status === 'approved') return { record: latest, error: 'already_approved', message: 'the version was approved while its checks started' };
  const startedAt = new Date().toISOString();
  const next: SkillVersionRecord = { ...latest, tests: 'pending-build', checkRun: { id: runId, checker: checker.name, startedAt, startedBy: actor } };
  delete next.checks;
  registry.save(next);
  state.ledger.append({
    timestamp: startedAt,
    agentId: ledgerKey(id, version),
    type: 'action',
    action: 'SKILL_CHECKS_STARTED',
    actor,
    commit: rec.commit,
  });
  watchSkillChecks(state, checker, id, version, runId);
  return { record: next };
}

/**
 * Follows the runs a previous control plane started and did not see end (a deploy or restart during a check). Runs of
 * another checker, or none, stay pending until an admin re-runs them. Returns how many it follows.
 */
export async function resumeSkillChecks(state: FactoryState): Promise<number> {
  const checker = await checkerFor(state);
  if (!checker) return 0;
  const registry = skillRegistry(state);
  let n = 0;
  for (const id of registry.ids()) {
    for (const rec of registry.versions(id)) {
      if (rec.tests !== 'pending-build' || rec.checkRun?.checker !== checker.name) continue;
      watchSkillChecks(state, checker, id, rec.version, rec.checkRun.id);
      n++;
    }
  }
  return n;
}

async function rerunChecks(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, id: string, version: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.checks.run');
  if (!principal) return;
  const out = await startSkillChecks(state, id, version, principal.actor);
  if (out.error === 'not_found') return json(res, 404, { error: 'not_found', id, version });
  if (out.error === 'already_approved') return json(res, 409, { error: 'already_approved', id, version, message: out.message });
  if (out.error === 'checker_not_configured') return json(res, 501, { error: 'checker_not_configured', id, version, message: out.message });
  if (out.error === 'start_failed') return json(res, 502, { error: 'start_failed', id, version, message: out.message });
  json(res, 202, out.record);
}

/**
 * Which agents' deployed configuration uses a skill version (SK1 revocation, SK3, SK4). By default the configuration
 * store answers (`configStoreSkillUsage`); `setSkillUsage` replaces it (tests, or a later source of deployed state).
 */
const usage = new WeakMap<FactoryState, (id: string, version: string) => string[]>();
export function setSkillUsage(state: FactoryState, fn: (id: string, version: string) => string[]): void {
  usage.set(state, fn);
}

/** SK3: an agent uses a skill version when its current configuration's `skills` list pins that version. */
export function configStoreSkillUsage(state: FactoryState): (id: string, version: string) => string[] {
  return (id, version) => {
    const store = state.configs;
    if (!store) return [];
    return store
      .agentIds()
      .filter((agentId) => store.current(agentId)?.skills.some((s) => s.id === id && s.version === version))
      .sort();
  };
}

function skillUsers(state: FactoryState, id: string, version: string): string[] {
  return (usage.get(state) ?? configStoreSkillUsage(state))(id, version);
}

const CHECKS = /^\/api\/v1\/registry\/skills\/([^/]+)\/versions\/([^/]+)\/checks$/;
const DECISION = /^\/api\/v1\/registry\/skills\/([^/]+)\/versions\/([^/]+)\/(approve|reject)$/;
const ONE_SKILL = /^\/api\/v1\/skills\/([^/]+)$/;
const ONE_VERSION = /^\/api\/v1\/skills\/([^/]+)\/versions\/([^/]+)$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

/** Handles the skill registry and catalog routes. Returns false for any other path or method. */
export async function handleSkills(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/registry/skills' && req.method === 'POST') {
    await register(state, req, res);
    return true;
  }

  const checks = path.match(CHECKS);
  if (checks && req.method === 'POST') {
    await rerunChecks(state, req, res, decode(checks[1]), decode(checks[2]));
    return true;
  }

  const decision = path.match(DECISION);
  if (decision && req.method === 'POST') {
    await decide(state, req, res, decode(decision[1]), decode(decision[2]), decision[3] as 'approve' | 'reject');
    return true;
  }

  if (req.method !== 'GET') return false;

  if (path === '/api/v1/skills') {
    if (!(await requirePrivilege(req, res, state, 'skills.read'))) return true;
    const registry = skillRegistry(state);
    json(res, 200, registry.ids().map((id) => summarizeSkill(registry, id)).filter(Boolean));
    return true;
  }

  const one = path.match(ONE_SKILL);
  if (one) {
    if (!(await requirePrivilege(req, res, state, 'skills.read'))) return true;
    const registry = skillRegistry(state);
    const id = decode(one[1]);
    const summary = summarizeSkill(registry, id);
    if (!summary) return json(res, 404, { error: 'not_found', id }), true;
    json(res, 200, { ...summary, versions: registry.versions(id) });
    return true;
  }

  const ver = path.match(ONE_VERSION);
  if (ver) {
    if (!(await requirePrivilege(req, res, state, 'skills.read'))) return true;
    const [id, version] = [decode(ver[1]), decode(ver[2])];
    const rec = skillRegistry(state).get(id, version);
    if (!rec) return json(res, 404, { error: 'not_found', id, version }), true;
    json(res, 200, rec);
    return true;
  }

  return false;
}
