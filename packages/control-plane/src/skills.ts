/**
 * Skill registry (DESIGN_AUTHORITY.md §6.14 SK1, SK2).
 *
 * A skill is registered by naming a repository, a path inside it and a commit. The caller either sends the parsed
 * `skill.yaml` with a full commit SHA, or omits it and the control plane reads `skill.yaml` at that path and commit itself
 * with the factory's read-only source token (TSK-055); then `commit` may be a branch or tag, which is resolved here to
 * the full SHA it points at and recorded as that SHA, so the pin never moves.
 * Admission pins the commit and checks the manifest (schema, a new version, the design rules). Registering a version
 * starts the factory's checks on its code (the Registrar's skill checks, TSK-054): `tests: 'pending-build'` until they end, then
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
 *   GET  /api/v1/skills/:id/adopters                                 viewer: the agents that use it, and pending requests
 *   POST /api/v1/registry/skills/:id/retire                          admin: { reason?, force? }
 *   GET  /api/v1/agents/:id/skills                                   the agent's owner or a viewer: adopted, requested, revoked, available
 *   POST /api/v1/agents/:id/skills                                   the agent's owner or an admin: { skillId, version, reason? } asks to adopt
 *   POST /api/v1/agents/:id/skills/:skillId/adoption/approve|reject  admin: { reason? } decides the request
 *   DELETE /api/v1/agents/:id/skills/:skillId                        the agent's owner or an admin: { reason? } removes the adoption
 *
 * SK1, SK3, SK6, SK7: a private skill is visible only to admins and to the owners of its owner agent, and is adopted
 * for that agent automatically when a version is approved (unless its adoption was revoked). Every adoption, upgrade
 * and removal is a configuration change: a new version with the adoption's provenance, and a ledger row.
 *
 * Records live in `<data dir>/skills/<id>/<version>.json` (the control plane's backed-up volume, R1). They are read
 * once, when the registry is first used, and served from memory: no request reads the disk or the network (GAP-056).
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { SEMVER, SKILL_ID, skillDesignIssues, validateSkillManifest, type SkillManifest } from '@beercanlabs/factory-contract';
import { authorize } from '@beercanlabs/factory-bouncer';
import type { Principal } from '@beercanlabs/factory-auth';
import { applyKillSwitch, json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { configOf, ledgerVersion, ownersOf } from './config-store.js';
import {
  AdoptionStore,
  FULL_SHA,
  SkillRegistry,
  adopters,
  availableTo,
  canAdopt,
  ownerOf,
  skillVisibleTo,
  skillsOf,
  visibilityOf,
  type AccessAdded,
  type ConfigSkill,
  type SkillViewer,
  checkRefName,
  checkRepoUrl,
  checkSkillPath,
  cleanFailure,
  fetchManifest,
  gitSkillSource,
  localSkillChecker,
  summarizeSkill,
  type SkillCheckOutcome,
  type SkillChecker,
  type SkillSource,
  type SkillStatus,
  type SkillVersionRecord,
} from '@beercanlabs/factory-registrar';

/**
 * The checker this deployment uses (see the header). Called once per control plane; `undefined` means none is
 * configured. The CodeBuild checker is loaded only when selected, so the kernel does not load a cloud SDK otherwise.
 */
export async function skillCheckerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SkillChecker | undefined> {
  const provider = env.FACTORY_DEPLOY_PROVIDER || (env.FACTORY_RUNTIME === 'ecs' ? 'aws' : undefined);
  const kind = env.FACTORY_SKILL_CHECKER || (provider === 'aws' ? 'codebuild' : 'none');
  if (kind === 'codebuild') {
    const { codeBuildSkillChecker } = await import('./aws/codebuild.js');
    return codeBuildSkillChecker();
  }
  if (kind === 'local') return localSkillChecker();
  if (kind !== 'none') console.warn(`[control-plane] FACTORY_SKILL_CHECKER=${kind} is not a checker (codebuild, local, none); skill checks are off`);
  return undefined;
}

/** The registrar reports through a callback; the control plane's log lines keep their prefix. */
const warnFromControlPlane = (message: string, err: unknown): void => console.warn(`[control-plane] ${message}`, err);

const registries = new WeakMap<FactoryState, SkillRegistry>();
const adoptionStores = new WeakMap<FactoryState, AdoptionStore>();

/** The control plane's data directory, as `index.ts` derives it (the ledger's directory), plus `skills`. */
function defaultSkillsDir(): string {
  if (process.env.FACTORY_SKILLS_DIR) return process.env.FACTORY_SKILLS_DIR;
  return join(dirname(process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl')), 'skills');
}

/** Opens the registry at `dir` (or the default data directory) and loads it into memory. Call once at start. */
export function loadSkills(state: FactoryState, dir: string | undefined = defaultSkillsDir()): SkillRegistry {
  const registry = new SkillRegistry(dir, warnFromControlPlane);
  registries.set(state, registry);
  // Adoption requests and revocations sit beside the skills (R1: the control plane's backed-up volume).
  adoptionStores.set(state, new AdoptionStore(dir ? join(dirname(dir), 'skill-adoptions') : undefined, warnFromControlPlane));
  return registry;
}

/** The adoption requests, rejections and revocations (SK3, SK6); loaded with the registry. */
export function adoptionStore(state: FactoryState): AdoptionStore {
  skillRegistry(state);
  return adoptionStores.get(state)!;
}

/** The loaded registry; loaded from the default data directory on first use if `loadSkills` was not called. */
export function skillRegistry(state: FactoryState): SkillRegistry {
  return registries.get(state) ?? loadSkills(state);
}

/** SK1, SK6: a version an agent may adopt. Only approved, unretired versions; anything else is undefined. */
export function approvedSkill(state: FactoryState, id: string, version: string): SkillVersionRecord | undefined {
  const rec = skillRegistry(state).get(id, version);
  return rec?.status === 'approved' && !rec.retired ? rec : undefined;
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
      const fetched = await fetchManifest(skillSourceFor(state), repo, path, commit, ref, warnFromControlPlane);
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
      // SK1: visibility and owner never change for a skill; a retired skill takes no new version (SK6).
      const identity = registry.identityIssue(manifest);
      if (identity) reasons.push(`manifest.visibility: ${identity}`);
      const known = registry.versions(manifest.id);
      if (known.length && known.every((v) => v.retired)) {
        reasons.push(`id: ${manifest.id} is retired; no new version can be registered (SK6), so give the skill a different id`);
      }
      // SK1: a private skill names an agent that exists, and only an admin or an owner of that agent may register it.
      if (manifest.visibility === 'private' && manifest.owner) {
        if (!state.agents.has(manifest.owner)) {
          reasons.push(`manifest.owner: agent ${manifest.owner} is not registered`);
        } else if (!authorize({ principal, privilege: 'skills.adopt.request', resource: { agentId: manifest.owner, owners: ownersOf(state, manifest.owner) } }).allowed) {
          reasons.push(`manifest.owner: only an admin or an owner of ${manifest.owner} may register a skill private to it`);
        }
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
  if (decision === 'approve' && rec.retired) {
    json(res, 409, { error: 'skill_retired', id, version, message: 'a retired skill takes no new approved version (SK6)' });
    return;
  }
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
  // SK3: approving a version of a private skill adopts it for its owner agent in the same change (unless revoked).
  const auto = decision === 'approve' ? await autoAdoptPrivate(state, next, principal) : undefined;
  json(res, 200, { ...(users.length ? { ...next, paused } : next), ...(auto ? { adopted: auto.adopted, ...(auto.failed ? { adoptionFailed: auto.failed } : {}) } : {}) });
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

// ---- Adoption (SK3, SK6, SK7) ------------------------------------------------------------------------------------

/** One adoption change per agent at a time: it reads the configuration, then writes the next version. */
const agentLocks = new WeakMap<FactoryState, Map<string, Promise<unknown>>>();
function withAgentLock<T>(state: FactoryState, agentId: string, fn: () => Promise<T>): Promise<T> {
  let locks = agentLocks.get(state);
  if (!locks) agentLocks.set(state, (locks = new Map()));
  const run = (locks.get(agentId) ?? Promise.resolve()).then(fn, fn);
  locks.set(agentId, run.catch(() => undefined));
  return run;
}

/** Ledger row for an adoption event: keyed by the agent, with the skill version as the request id (as skills are keyed). */
function ledgerAdoption(state: FactoryState, agentId: string, action: string, actor: string, skillId: string, version: string, reason?: string, commit?: string): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId,
    type: 'action',
    action,
    actor,
    requestId: `skill:${skillId}@${version}`,
    ...(commit ? { commit } : {}),
    ...(reason ? { payloadSha256: payloadHash(reason) } : {}),
  });
}

type SkillsWrite = { ok: true; created: boolean; version: number; hash: string } | { ok: false; error: string };

/**
 * Writes the agent's next configuration version with `skills`, and ledgers it (SK3). Raises nothing: a store that is
 * missing or fails is reported, so the caller can leave its request in place and say so. Call inside `withAgentLock`.
 */
async function writeSkills(
  state: FactoryState,
  agentId: string,
  skills: ConfigSkill[],
  meta: { actor: string; reason: string; provenance?: import('@beercanlabs/factory-registrar').SkillAdoptionProvenance[] },
): Promise<SkillsWrite> {
  const store = state.configs;
  if (!store) return { ok: false, error: 'config_store_unavailable' };
  try {
    const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
    const { record, created } = await store.put({ ...configOf(state, agentId), skills: sorted }, { updatedBy: meta.actor, reason: meta.reason, ...(meta.provenance?.length ? { skillAdoptions: meta.provenance } : {}) });
    if (created) ledgerVersion(state, record, meta.actor);
    return { ok: true, created, version: record.version, hash: record.hash };
  } catch (err) {
    console.error(`[control-plane] skills for ${agentId} not stored: ${err instanceof Error ? err.message : String(err)}`);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CONFIG_VERSION_FAILED', actor: meta.actor });
    return { ok: false, error: 'adoption_not_stored' };
  }
}

const currentSkills = (state: FactoryState, agentId: string): ConfigSkill[] => state.configs?.current(agentId)?.skills ?? [];

/** What adopting a skill would add to an agent's access beyond its policy (SK3, E7), for the admin who decides. */
function accessAddedFor(state: FactoryState, agentId: string, rec: SkillVersionRecord): AccessAdded {
  const policy = state.policies.has(agentId) ? state.policies.get(agentId) : undefined;
  const r = rec.manifest.requires;
  return {
    routes: r.routes.filter((x) => !policy?.routes.includes(x)),
    models: r.models.filter((x) => !policy?.models?.includes(x)),
    credentials: r.credentials.map((c) => c.name),
    connections: r.connections.map((c) => c.provider),
  };
}

const REFUSAL_STATUS = { not_found: 404, skill_private: 403, skill_retired: 409, skill_not_approved: 409 } as const;

/**
 * SK3: a private skill's approved version is adopted for its owner agent in the same change, unless the owner's
 * adoption was revoked (SK6). The admin who approved the version is the adoption's approver; the row is marked
 * automatic. A failure never undoes the approval: it is ledgered and a request is left for an admin to approve.
 */
async function autoAdoptPrivate(state: FactoryState, rec: SkillVersionRecord, principal: Principal): Promise<{ adopted: string[]; failed?: string } | undefined> {
  const owner = ownerOf(rec);
  if (visibilityOf(rec) !== 'private' || !owner) return undefined;
  const adoptions = adoptionStore(state);
  if (adoptions.blocksAutoAdopt(owner, rec.id)) return { adopted: [] };
  if (!state.agents.has(owner)) {
    ledgerAdoption(state, owner, 'SKILL_ADOPTION_FAILED', principal.actor, rec.id, rec.version, `owner agent ${owner} is not registered`, rec.commit);
    return { adopted: [], failed: 'owner_unknown' };
  }
  const result = await withAgentLock(state, owner, async () => {
    const skills = currentSkills(state, owner);
    if (skills.some((k) => k.id === rec.id && k.version === rec.version)) return { ok: true as const, created: false };
    const now = new Date().toISOString();
    return writeSkills(state, owner, [...skills.filter((k) => k.id !== rec.id), { id: rec.id, version: rec.version }], {
      actor: principal.actor,
      reason: `adopt private skill ${rec.id}@${rec.version}`,
      provenance: [{ id: rec.id, version: rec.version, requestedBy: rec.registeredBy, requestedAt: rec.registeredAt, approvedBy: principal.actor, approvedAt: now, auto: true }],
    });
  });
  if (result.ok) {
    if (result.created) ledgerAdoption(state, owner, 'SKILL_ADOPTED_PRIVATE', principal.actor, rec.id, rec.version, undefined, rec.commit);
    return { adopted: result.created ? [owner] : [] };
  }
  ledgerAdoption(state, owner, 'SKILL_ADOPTION_FAILED', principal.actor, rec.id, rec.version, result.error, rec.commit);
  adoptions.request({ agentId: owner, skillId: rec.id, version: rec.version, requestedBy: rec.registeredBy, reason: 'automatic adoption failed; approve to retry', accessAdded: accessAddedFor(state, owner, rec) });
  return { adopted: [], failed: result.error };
}

/** SK7: who is looking. An admin sees every skill; anyone else sees public skills and the private skills of agents they own. */
function viewerOf(state: FactoryState, principal: Principal): SkillViewer {
  const admin = authorize({ principal, privilege: 'skills.decide' }).allowed;
  const actor = principal.actor.toLowerCase();
  const ownedAgents = (state.configs?.agentIds() ?? []).filter((id) => ownersOf(state, id).some((o) => o.toLowerCase() === actor));
  return { admin, ownedAgents };
}

function adoptersOf(state: FactoryState, id: string, version?: string) {
  return state.configs ? adopters(state.configs, adoptionStore(state), id, version) : [];
}

async function readOptionalJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJson(req);
  } catch {
    return {};
  }
}

function reasonOf(res: http.ServerResponse, body: Record<string, unknown>): string | undefined | null {
  if (body.reason === undefined) return undefined;
  if (typeof body.reason !== 'string' || body.reason.length > 2000) {
    json(res, 400, { error: 'invalid_reason', message: 'reason must be a string of at most 2000 characters' });
    return null;
  }
  return body.reason.trim() || undefined;
}

async function agentSkillsList(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'config.read', { agentId });
  if (!principal) return;
  if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' });
  if (!state.configs) return json(res, 503, { error: 'config_store_unavailable' });
  const registry = skillRegistry(state);
  const viewer = viewerOf(state, principal);
  // SK7: this route is open to every viewer, so a private skill the viewer may not see is left out of every list.
  const visible = (skillId: string): boolean => {
    const summary = summarizeSkill(registry, skillId);
    return !summary || skillVisibleTo(summary, viewer);
  };
  const mine = skillsOf(state.configs, adoptionStore(state), agentId);
  json(res, 200, {
    agentId,
    adopted: mine.adopted.filter((a) => visible(a.id)),
    requests: mine.requests.filter((r) => visible(r.skillId)),
    revoked: mine.revoked.filter((r) => visible(r.skillId)),
    available: availableTo(registry, agentId).filter((s) => visible(s.id)),
  });
}

async function requestAdoption(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.adopt.request', { agentId });
  if (!principal) return;
  if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' });
  const body = await readJson(req);
  const reason = reasonOf(res, body);
  if (reason === null) return;
  const skillId = body.skillId;
  const version = body.version;
  if (typeof skillId !== 'string' || !SKILL_ID.test(skillId) || typeof version !== 'string' || !SEMVER.test(version)) {
    return json(res, 400, { error: 'invalid_skill', message: 'skillId (kebab-case) and version (semantic version) are required' });
  }
  const check = canAdopt(skillRegistry(state), agentId, skillId, version);
  if (!check.ok) return json(res, REFUSAL_STATUS[check.error], { error: check.error, skillId, version, message: check.message });
  if (currentSkills(state, agentId).some((k) => k.id === skillId && k.version === version)) {
    return json(res, 409, { error: 'already_adopted', skillId, version, message: `${agentId} already runs ${skillId}@${version}` });
  }
  const record = adoptionStore(state).request({ agentId, skillId, version, requestedBy: principal.actor, ...(reason ? { reason } : {}), accessAdded: accessAddedFor(state, agentId, check.record) });
  ledgerAdoption(state, agentId, 'SKILL_ADOPTION_REQUESTED', principal.actor, skillId, version, reason, check.record.commit);
  json(res, 201, record);
}

async function decideAdoption(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string, skillId: string, decision: 'approve' | 'reject'): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.adopt.decide');
  if (!principal) return;
  const body = await readOptionalJson(req);
  const reason = reasonOf(res, body);
  if (reason === null) return;
  const adoptions = adoptionStore(state);
  if (decision === 'reject') {
    const rejected = adoptions.reject(agentId, skillId, principal.actor, reason);
    if (!rejected) return json(res, 409, { error: 'no_request', agentId, skillId, message: 'there is no pending adoption request for this agent and skill' });
    ledgerAdoption(state, agentId, 'SKILL_ADOPTION_REJECTED', principal.actor, skillId, rejected.version, reason);
    return json(res, 200, rejected);
  }
  const outcome = await withAgentLock(state, agentId, async () => {
    const request = adoptions.get(agentId, skillId);
    if (!request || request.state !== 'requested') return { status: 409, body: { error: 'no_request', agentId, skillId, message: 'there is no pending adoption request for this agent and skill' } };
    if (!state.agents.has(agentId)) return { status: 404, body: { error: 'not_found' } };
    // The skill may have been retired or revoked since the request was made.
    const check = canAdopt(skillRegistry(state), agentId, skillId, request.version);
    if (!check.ok) return { status: REFUSAL_STATUS[check.error], body: { error: check.error, skillId, version: request.version, message: check.message } };
    const skills = currentSkills(state, agentId);
    if (skills.some((k) => k.id === skillId && k.version === request.version)) {
      return { status: 409, body: { error: 'already_adopted', skillId, version: request.version, message: `${agentId} already runs ${skillId}@${request.version}` } };
    }
    const written = await writeSkills(state, agentId, [...skills.filter((k) => k.id !== skillId), { id: skillId, version: request.version }], {
      actor: principal.actor,
      reason: reason ?? `adopt ${skillId}@${request.version}`,
      provenance: [{ id: skillId, version: request.version, requestedBy: request.requestedBy, requestedAt: request.requestedAt, approvedBy: principal.actor, approvedAt: new Date().toISOString() }],
    });
    if (!written.ok) return { status: 500, body: { error: written.error, message: 'the adoption could not be written; the request is still pending' } };
    adoptions.clear(agentId, skillId);
    ledgerAdoption(state, agentId, 'SKILL_ADOPTION_APPROVED', principal.actor, skillId, request.version, reason, check.record.commit);
    return { status: 200, body: { agentId, skillId, version: request.version, configVersion: written.version, hash: written.hash } };
  });
  json(res, outcome.status, outcome.body);
}

async function removeAdoption(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string, skillId: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.adopt.remove', { agentId });
  if (!principal) return;
  const body = await readOptionalJson(req);
  const reason = reasonOf(res, body);
  if (reason === null) return;
  const adoptions = adoptionStore(state);
  const outcome = await withAgentLock(state, agentId, async () => {
    const skills = currentSkills(state, agentId);
    const adopted = skills.find((k) => k.id === skillId);
    const pending = adoptions.get(agentId, skillId);
    if (!adopted && pending?.state !== 'requested') return { status: 404, body: { error: 'not_adopted', agentId, skillId } };
    let configVersion: number | undefined;
    if (adopted) {
      const written = await writeSkills(state, agentId, skills.filter((k) => k.id !== skillId), { actor: principal.actor, reason: reason ?? `remove ${skillId}` });
      if (!written.ok) return { status: 500, body: { error: written.error, message: 'the removal could not be written; nothing changed' } };
      configVersion = written.version;
    }
    // SK6: removing a private skill from its owner stops its later versions from being adopted by themselves.
    const rec = skillRegistry(state).get(skillId, adopted?.version ?? pending?.version ?? '');
    if (adopted && rec && visibilityOf(rec) === 'private' && ownerOf(rec) === agentId) adoptions.revoke(agentId, skillId, adopted.version, principal.actor, reason);
    else adoptions.clear(agentId, skillId);
    ledgerAdoption(state, agentId, 'SKILL_ADOPTION_REMOVED', principal.actor, skillId, adopted?.version ?? pending?.version ?? '', reason, rec?.commit);
    return { status: 200, body: { agentId, skillId, removed: true, ...(configVersion ? { configVersion } : {}) } };
  });
  json(res, outcome.status, outcome.body);
}

/**
 * SK6: retires every version of a skill. While any agent's configuration still adopts it this is refused; `force` pauses
 * each of those agents, removes the skill from its configuration (a new version) and retires the skill. Redeploying
 * them without it and resuming them is the apply step (TSK-159).
 */
async function retireSkill(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'skills.retire');
  if (!principal) return;
  const body = await readOptionalJson(req);
  const reason = reasonOf(res, body);
  if (reason === null) return;
  const registry = skillRegistry(state);
  const versions = registry.versions(id);
  if (!versions.length) return json(res, 404, { error: 'not_found', id });
  if (versions.every((v) => v.retired)) return json(res, 409, { error: 'already_retired', id });
  const users = adoptersOf(state, id).filter((a) => a.state === 'approved').map((a) => a.agentId);
  if (users.length && body.force !== true) {
    return json(res, 409, { error: 'skill_in_use', id, agents: users, message: 'remove the skill from these agents first, or retire with "force": true to pause them and remove it' });
  }
  const paused: string[] = [];
  const removedFrom: string[] = [];
  const failed: string[] = [];
  for (const agentId of users) {
    const out = await applyKillSwitch(state, agentId, 'PAUSE', principal.actor);
    if (out.status === 200) paused.push(agentId);
    const removed = await withAgentLock(state, agentId, async () => {
      const skills = currentSkills(state, agentId);
      const adopted = skills.find((k) => k.id === id);
      if (!adopted) return true;
      const written = await writeSkills(state, agentId, skills.filter((k) => k.id !== id), { actor: principal.actor, reason: reason ?? `skill ${id} retired` });
      if (written.ok) ledgerAdoption(state, agentId, 'SKILL_ADOPTION_REMOVED', principal.actor, id, adopted.version, reason ?? `skill ${id} retired`);
      return written.ok;
    });
    (removed ? removedFrom : failed).push(agentId);
  }
  if (failed.length) return json(res, 500, { error: 'adopters_not_updated', id, paused, removedFrom, failed, message: 'the skill was not retired; retry to finish removing it from the remaining agents' });
  const adoptions = adoptionStore(state);
  for (const r of adoptions.forSkill(id)) if (r.state === 'requested') adoptions.clear(r.agentId, id);
  let changed: SkillVersionRecord[];
  try {
    changed = registry.retire(id, principal.actor, reason);
  } catch (err) {
    console.warn(`[control-plane] failed to persist retirement of ${id}:`, err);
    return json(res, 500, { error: 'persist_failed', message: 'the retirement could not be written' });
  }
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: ledgerKey(id),
    type: 'action',
    action: users.length ? 'SKILL_RETIRED_FORCED' : 'SKILL_RETIRED',
    actor: principal.actor,
    ...(reason ? { payloadSha256: payloadHash(reason) } : {}),
  });
  json(res, 200, { id, retired: changed.map((v) => v.version), ...(users.length ? { paused, removedFrom } : {}) });
}

const CHECKS = /^\/api\/v1\/registry\/skills\/([^/]+)\/versions\/([^/]+)\/checks$/;
const DECISION = /^\/api\/v1\/registry\/skills\/([^/]+)\/versions\/([^/]+)\/(approve|reject)$/;
const ONE_SKILL = /^\/api\/v1\/skills\/([^/]+)$/;
const ONE_VERSION = /^\/api\/v1\/skills\/([^/]+)\/versions\/([^/]+)$/;
const ADOPTERS = /^\/api\/v1\/skills\/([^/]+)\/adopters$/;
const RETIRE = /^\/api\/v1\/registry\/skills\/([^/]+)\/retire$/;
const AGENT_SKILLS = /^\/api\/v1\/agents\/([^/]+)\/skills$/;
const AGENT_SKILL = /^\/api\/v1\/agents\/([^/]+)\/skills\/([^/]+)$/;
const ADOPTION_DECISION = /^\/api\/v1\/agents\/([^/]+)\/skills\/([^/]+)\/adoption\/(approve|reject)$/;

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

  const retire = path.match(RETIRE);
  if (retire && req.method === 'POST') {
    await retireSkill(state, req, res, decode(retire[1]));
    return true;
  }

  const adoptionDecision = path.match(ADOPTION_DECISION);
  if (adoptionDecision && req.method === 'POST') {
    await decideAdoption(state, req, res, decode(adoptionDecision[1]), decode(adoptionDecision[2]), adoptionDecision[3] as 'approve' | 'reject');
    return true;
  }

  const agentSkills = path.match(AGENT_SKILLS);
  if (agentSkills && req.method === 'GET') {
    await agentSkillsList(state, req, res, decode(agentSkills[1]));
    return true;
  }
  if (agentSkills && req.method === 'POST') {
    await requestAdoption(state, req, res, decode(agentSkills[1]));
    return true;
  }

  const agentSkill = path.match(AGENT_SKILL);
  if (agentSkill && req.method === 'DELETE') {
    await removeAdoption(state, req, res, decode(agentSkill[1]), decode(agentSkill[2]));
    return true;
  }

  if (req.method !== 'GET') return false;

  if (path === '/api/v1/skills') {
    const principal = await requirePrivilege(req, res, state, 'skills.read');
    if (!principal) return true;
    const registry = skillRegistry(state);
    const viewer = viewerOf(state, principal);
    json(
      res,
      200,
      registry
        .ids()
        .map((id) => summarizeSkill(registry, id))
        .filter((s): s is NonNullable<typeof s> => !!s && skillVisibleTo(s, viewer))
        .map((s) => ({ ...s, adopters: adoptersOf(state, s.id) })),
    );
    return true;
  }

  const adoptersPath = path.match(ADOPTERS);
  if (adoptersPath) {
    const principal = await requirePrivilege(req, res, state, 'skills.read');
    if (!principal) return true;
    const id = decode(adoptersPath[1]);
    const summary = summarizeSkill(skillRegistry(state), id);
    if (!summary || !skillVisibleTo(summary, viewerOf(state, principal))) return json(res, 404, { error: 'not_found', id }), true;
    json(res, 200, adoptersOf(state, id).map((a) => {
      const latest = summary.latestApproved;
      return { ...a, upgradeAvailable: !!latest && a.state === 'approved' && latest !== a.version };
    }));
    return true;
  }

  const one = path.match(ONE_SKILL);
  if (one) {
    const principal = await requirePrivilege(req, res, state, 'skills.read');
    if (!principal) return true;
    const registry = skillRegistry(state);
    const id = decode(one[1]);
    const summary = summarizeSkill(registry, id);
    // SK7: a private skill the viewer may not see does not exist for them.
    if (!summary || !skillVisibleTo(summary, viewerOf(state, principal))) return json(res, 404, { error: 'not_found', id }), true;
    json(res, 200, { ...summary, versions: registry.versions(id), adopters: adoptersOf(state, id) });
    return true;
  }

  const ver = path.match(ONE_VERSION);
  if (ver) {
    const principal = await requirePrivilege(req, res, state, 'skills.read');
    if (!principal) return true;
    const [id, version] = [decode(ver[1]), decode(ver[2])];
    const rec = skillRegistry(state).get(id, version);
    const owner = rec ? ownerOf(rec) : undefined;
    if (!rec || !skillVisibleTo({ visibility: visibilityOf(rec), ...(owner ? { owner } : {}) }, viewerOf(state, principal))) return json(res, 404, { error: 'not_found', id, version }), true;
    json(res, 200, rec);
    return true;
  }

  return false;
}
