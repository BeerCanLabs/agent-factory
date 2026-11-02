/**
 * Adoption requests and revocations (DESIGN_AUTHORITY.md §6.14 SK3, SK6), and the two questions the console and the
 * API ask: which agents use a skill, and which skills an agent uses.
 *
 * What an agent runs is its configuration (`config.skills`, hashed, SK4). A request that changes nothing yet, a
 * rejected request and a revocation are not configuration: they live here, create no configuration version and so
 * trigger no build. Only an approved adoption (or a removal) writes a version. A revoked private adoption is kept so
 * that a later version of the skill is not adopted for its owner again by itself (SK6).
 *
 * Records live in `<dir>/<agentId>/<skillId>.json`, one per (agent, skill), read once and served from memory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ID, skillActionHoldDefaults, type SkillAction, type SkillManifest } from '@beercanlabs/factory-contract';
import { AGENT_ID, adoptionProvenance, type ConfigStore } from './config-store.js';

export type AdoptionState = 'requested' | 'rejected' | 'revoked';
const STATES: readonly AdoptionState[] = ['requested', 'rejected', 'revoked'];

/** What a skill would add to an agent's access, shown to the admin who decides (SK3, E7). Computed by the caller. */
export type AccessAdded = { routes: string[]; models: string[]; credentials: string[]; connections: string[] };

export type AdoptionRecord = {
  agentId: string;
  skillId: string;
  /** The version asked for; an upgrade is a request for a newer version of a skill the agent already runs. */
  version: string;
  state: AdoptionState;
  requestedBy: string;
  requestedAt: string;
  reason?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  accessAdded?: AccessAdded;
  /** S23 (D31): effective per-action holds requested on adoption (skill defaults plus any stricter owner overrides). */
  holds?: Record<string, boolean>;
};

export type AdoptionRequest = {
  agentId: string;
  skillId: string;
  version: string;
  requestedBy: string;
  reason?: string;
  accessAdded?: AccessAdded;
  holds?: Record<string, boolean>;
};

function setHoldKey(target: Record<string, boolean>, key: string, value: boolean): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainHoldMap(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (k === '__proto__' || typeof (value as Record<string, unknown>)[k] !== 'boolean') return false;
  }
  return true;
}

type ManifestActionsLike = { actions?: ReadonlyArray<Pick<SkillAction, 'id' | 'hold'>> } | Pick<SkillManifest, 'actions'> | undefined | null;

/** S23 (D31): per-action default hold map declared by a skill manifest (`{ [action.id]: action.hold }`). */
export function defaultSkillActionHolds(manifest?: ManifestActionsLike): Record<string, boolean> {
  return skillActionHoldDefaults(manifest);
}

/**
 * S23 (D31): computes effective per-action hold settings for `manifest`, monotonically combining manifest defaults
 * with any stored agent hold settings (`manifest.hold || Boolean(storedHolds[action.id])`). A skill-declared
 * `hold: true` can never evaluate to `false`, even if `storedHolds` came from an older version or tampered record.
 */
export function effectiveSkillHolds(
  manifest: ManifestActionsLike,
  storedHolds?: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const action of manifest?.actions ?? []) {
    const tightened =
      storedHolds !== undefined &&
      Object.prototype.hasOwnProperty.call(storedHolds, action.id) &&
      storedHolds[action.id] === true;
    setHoldKey(out, action.id, action.hold || tightened);
  }
  return out;
}

export type SkillHoldValidationResult =
  | {
      ok: true;
      holds: Record<string, boolean>;
      overrides: Record<string, boolean>;
    }
  | {
      ok: false;
      status: 400 | 422;
      error: 'invalid_holds' | 'unknown_skill_action' | 'hold_loosening_forbidden';
      action?: string;
      message: string;
    };

/**
 * S23 (D31): validates per-action hold overrides against `manifest.actions`.
 * - Owners/leads/admins may tighten an autonomous action (`hold: false` -> `true`) or reset it back to `false`.
 * - Loosening a mandatory skill-declared hold (`hold: true` -> `false`) is rejected with `422 hold_loosening_forbidden`.
 * - Unknown action ids are rejected with `422 unknown_skill_action`.
 * - Malformed payloads or non-boolean values are rejected with `400 invalid_holds`.
 */
export function validateSkillHoldOverrides(
  manifest: ManifestActionsLike,
  rawOverrides: unknown,
  baseHolds?: Record<string, boolean>,
): SkillHoldValidationResult {
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_holds',
      message: 'holds must be an object mapping declared skill action ids to booleans',
    };
  }
  const actions = manifest?.actions ?? [];
  const actionMap = new Map<string, boolean>();
  for (const action of actions) {
    actionMap.set(action.id, action.hold);
  }
  const input = rawOverrides as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    const val = input[key];
    if (typeof val !== 'boolean') {
      return {
        ok: false,
        status: 400,
        error: 'invalid_holds',
        action: key,
        message: `hold value for action "${key}" must be true or false`,
      };
    }
    if (!actionMap.has(key)) {
      return {
        ok: false,
        status: 422,
        error: 'unknown_skill_action',
        action: key,
        message: `skill does not declare action "${key}"`,
      };
    }
    const manifestHold = actionMap.get(key)!;
    if (manifestHold && val === false) {
      return {
        ok: false,
        status: 422,
        error: 'hold_loosening_forbidden',
        action: key,
        message: `action "${key}" declares hold: true in skill.yaml and cannot be loosened to hold: false (D31, S23)`,
      };
    }
  }

  const holds: Record<string, boolean> = {};
  const overrides: Record<string, boolean> = {};
  for (const action of actions) {
    let effective: boolean;
    if (Object.prototype.hasOwnProperty.call(input, action.id)) {
      effective = action.hold || (input[action.id] as boolean);
    } else if (baseHolds && Object.prototype.hasOwnProperty.call(baseHolds, action.id)) {
      effective = action.hold || Boolean(baseHolds[action.id]);
    } else {
      effective = action.hold;
    }
    setHoldKey(holds, action.id, effective);
    if (!action.hold && effective) {
      setHoldKey(overrides, action.id, true);
    }
  }
  return { ok: true, holds, overrides };
}

function check(agentId: string, skillId: string): void {
  if (!AGENT_ID.test(agentId)) throw new Error(`agent id ${JSON.stringify(agentId)} cannot name an adoption`);
  if (!SKILL_ID.test(skillId)) throw new Error(`skill id ${JSON.stringify(skillId)} cannot name an adoption`);
}

export class AdoptionStore {
  private readonly records = new Map<string, AdoptionRecord>();

  constructor(
    private readonly dir?: string,
    private readonly warn: (message: string, err: unknown) => void = (message, err) => console.warn(`[registrar] ${message}`, err),
  ) {
    if (!dir || !existsSync(dir)) return;
    for (const agentId of readdirSync(dir)) {
      if (!AGENT_ID.test(agentId)) continue;
      let files: string[];
      try {
        files = readdirSync(join(dir, agentId));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(readFileSync(join(dir, agentId, file), 'utf8')) as AdoptionRecord;
          if (rec.agentId !== agentId || `${rec.skillId}.json` !== file) throw new Error('record does not match its file name');
          if (!STATES.includes(rec.state)) throw new Error(`unknown adoption state ${JSON.stringify(rec.state)}`);
          for (const k of ['version', 'requestedBy', 'requestedAt'] as const) {
            if (typeof rec[k] !== 'string' || !rec[k]) throw new Error(`adoption record has no ${k}`);
          }
          if (rec.holds !== undefined && !isPlainHoldMap(rec.holds)) {
            throw new Error('adoption record has invalid holds map');
          }
          this.records.set(`${agentId}/${rec.skillId}`, rec);
        } catch (err) {
          this.warn(`skipping unreadable adoption record ${join(dir, agentId, file)}:`, err);
        }
      }
    }
  }

  /** Persists first, then serves: a record the volume does not hold is never reported. */
  private save(rec: AdoptionRecord): AdoptionRecord {
    if (this.dir) {
      const folder = join(this.dir, rec.agentId);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `${rec.skillId}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
      renameSync(tmp, path);
    }
    this.records.set(`${rec.agentId}/${rec.skillId}`, rec);
    return structuredClone(rec);
  }

  get(agentId: string, skillId: string): AdoptionRecord | undefined {
    const rec = this.records.get(`${agentId}/${skillId}`);
    return rec ? structuredClone(rec) : undefined;
  }

  forAgent(agentId: string): AdoptionRecord[] {
    return [...this.records.values()].filter((r) => r.agentId === agentId).sort((a, b) => a.skillId.localeCompare(b.skillId)).map((r) => structuredClone(r));
  }

  forSkill(skillId: string): AdoptionRecord[] {
    return [...this.records.values()].filter((r) => r.skillId === skillId).sort((a, b) => a.agentId.localeCompare(b.agentId)).map((r) => structuredClone(r));
  }

  /**
   * Records a request. A newer request for the same (agent, skill) replaces an earlier request, rejection or revocation,
   * and replacing a revocation lifts the block on automatic adoption (SK6). So only an explicit request by the owner or
   * an admin may call this for a revoked private skill; the automatic path asks `blocksAutoAdopt` and never calls it.
   */
  request(input: AdoptionRequest, now: Date = new Date()): AdoptionRecord {
    check(input.agentId, input.skillId);
    return this.save({
      agentId: input.agentId,
      skillId: input.skillId,
      version: input.version,
      state: 'requested',
      requestedBy: input.requestedBy,
      requestedAt: now.toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.accessAdded ? { accessAdded: structuredClone(input.accessAdded) } : {}),
      ...(input.holds && Object.keys(input.holds).length ? { holds: structuredClone(input.holds) } : {}),
    });
  }

  /**
   * S23 (D31): updates per-action `holds` on a pending (`requested`) adoption record while preserving
   * the original `requestedBy` and `requestedAt` provenance. Returns `undefined` when no pending request exists.
   */
  updateHolds(
    agentId: string,
    skillId: string,
    holds: Record<string, boolean>,
    reason?: string,
  ): AdoptionRecord | undefined {
    check(agentId, skillId);
    const rec = this.records.get(`${agentId}/${skillId}`);
    if (!rec || rec.state !== 'requested') return undefined;
    return this.save({
      agentId: rec.agentId,
      skillId: rec.skillId,
      version: rec.version,
      state: 'requested',
      requestedBy: rec.requestedBy,
      requestedAt: rec.requestedAt,
      ...(reason ?? rec.reason ? { reason: (reason ?? rec.reason)! } : {}),
      ...(rec.accessAdded ? { accessAdded: structuredClone(rec.accessAdded) } : {}),
      ...(Object.keys(holds).length ? { holds: structuredClone(holds) } : {}),
    });
  }

  /** Rejects a pending request. Undefined when there is none. */
  reject(agentId: string, skillId: string, by: string, reason?: string, now: Date = new Date()): AdoptionRecord | undefined {
    const rec = this.records.get(`${agentId}/${skillId}`);
    if (!rec || rec.state !== 'requested') return undefined;
    return this.save({ ...rec, state: 'rejected', decidedBy: by, decidedAt: now.toISOString(), ...(reason ? { decisionReason: reason } : {}) });
  }

  /**
   * SK6: records that an agent's adoption of a skill was revoked. A private skill's later versions are then not adopted
   * for the owner by themselves: `revoked` says so until a new request replaces it.
   */
  revoke(agentId: string, skillId: string, version: string, by: string, reason?: string, now: Date = new Date()): AdoptionRecord {
    check(agentId, skillId);
    const rec = this.records.get(`${agentId}/${skillId}`);
    return this.save({
      agentId,
      skillId,
      version,
      state: 'revoked',
      requestedBy: rec?.requestedBy ?? by,
      requestedAt: rec?.requestedAt ?? now.toISOString(),
      decidedBy: by,
      decidedAt: now.toISOString(),
      ...(reason ? { decisionReason: reason } : {}),
    });
  }

  /** SK3, SK6: a private skill's new version is adopted for its owner by itself unless the owner's adoption was revoked. */
  blocksAutoAdopt(agentId: string, skillId: string): boolean {
    return this.records.get(`${agentId}/${skillId}`)?.state === 'revoked';
  }

  /** Forgets the record: after an approval writes the configuration, or when a request is withdrawn. True when there was one. */
  clear(agentId: string, skillId: string): boolean {
    const key = `${agentId}/${skillId}`;
    if (!this.records.has(key)) return false;
    if (this.dir) rmSync(join(this.dir, agentId, `${skillId}.json`), { force: true });
    this.records.delete(key);
    return true;
  }
}

/** An agent's use of a skill as the API says it: asked for, or approved and in the agent's configuration. */
export type AdopterState = 'requested' | 'approved';

export type Adopter = {
  agentId: string;
  version: string;
  state: AdopterState;
  requestedBy?: string;
  /** Present for `approved` when provenance was recorded (an adoption made before it was has none). */
  approvedBy?: string;
  /** When the request was made (`requested`) or approved (`approved`). */
  since?: string;
  auto?: true;
};

/**
 * Which agents use a skill (SK7): every agent whose current configuration adopts it, and every pending request. Give
 * `version` to narrow to one version. `approved` here means in the configuration, not yet shown to be running: whether
 * the deployed image has it is the Landlord's (SK4).
 */
export function adopters(configs: Pick<ConfigStore, 'agentIds' | 'current' | 'history'>, adoptions: AdoptionStore, skillId: string, version?: string): Adopter[] {
  const out: Adopter[] = [];
  for (const agentId of configs.agentIds()) {
    const adopted = configs.current(agentId)?.skills.find((k) => k.id === skillId);
    if (!adopted || (version && adopted.version !== version)) continue;
    const p = adoptionProvenance(configs, agentId, skillId);
    out.push({
      agentId,
      version: adopted.version,
      state: 'approved',
      ...(p ? { requestedBy: p.requestedBy, approvedBy: p.approvedBy, since: p.approvedAt, ...(p.auto ? { auto: true as const } : {}) } : {}),
    });
  }
  for (const r of adoptions.forSkill(skillId)) {
    if (r.state !== 'requested' || (version && r.version !== version)) continue;
    out.push({ agentId: r.agentId, version: r.version, state: 'requested', requestedBy: r.requestedBy, since: r.requestedAt });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.state.localeCompare(b.state));
}

export type AgentSkills = {
  /** What the agent's current configuration adopts, with who asked and who approved when that was recorded. */
  adopted: Array<{
    id: string;
    version: string;
    holds?: Record<string, boolean>;
    requestedBy?: string;
    approvedBy?: string;
    approvedAt?: string;
    auto?: true;
  }>;
  /** Pending requests. */
  requests: AdoptionRecord[];
  /** Revoked adoptions (SK6), which stop a private skill's later versions from being adopted by themselves. */
  revoked: AdoptionRecord[];
};

/** The reverse of `adopters` (SK7): the skills one agent uses, asks for and has had revoked. */
export function skillsOf(configs: Pick<ConfigStore, 'current' | 'history'>, adoptions: AdoptionStore, agentId: string): AgentSkills {
  const adopted = (configs.current(agentId)?.skills ?? []).map((k) => {
    const p = adoptionProvenance(configs, agentId, k.id);
    return {
      id: k.id,
      version: k.version,
      ...(k.holds && Object.keys(k.holds).length ? { holds: structuredClone(k.holds) } : {}),
      ...(p ? { requestedBy: p.requestedBy, approvedBy: p.approvedBy, approvedAt: p.approvedAt, ...(p.auto ? { auto: true as const } : {}) } : {}),
    };
  });
  const records = adoptions.forAgent(agentId);
  return {
    adopted,
    requests: records.filter((r) => r.state === 'requested'),
    revoked: records.filter((r) => r.state === 'revoked'),
  };
}
