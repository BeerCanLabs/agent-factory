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
import { SKILL_ID } from '@beercanlabs/factory-contract';
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
};

export type AdoptionRequest = {
  agentId: string;
  skillId: string;
  version: string;
  requestedBy: string;
  reason?: string;
  accessAdded?: AccessAdded;
};

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
  adopted: Array<{ id: string; version: string; requestedBy?: string; approvedBy?: string; approvedAt?: string; auto?: true }>;
  /** Pending requests. */
  requests: AdoptionRecord[];
  /** Revoked adoptions (SK6), which stop a private skill's later versions from being adopted by themselves. */
  revoked: AdoptionRecord[];
};

/** The reverse of `adopters` (SK7): the skills one agent uses, asks for and has had revoked. */
export function skillsOf(configs: Pick<ConfigStore, 'current' | 'history'>, adoptions: AdoptionStore, agentId: string): AgentSkills {
  const adopted = (configs.current(agentId)?.skills ?? []).map((k) => {
    const p = adoptionProvenance(configs, agentId, k.id);
    return { id: k.id, version: k.version, ...(p ? { requestedBy: p.requestedBy, approvedBy: p.approvedBy, approvedAt: p.approvedAt, ...(p.auto ? { auto: true as const } : {}) } : {}) };
  });
  const records = adoptions.forAgent(agentId);
  return {
    adopted,
    requests: records.filter((r) => r.state === 'requested'),
    revoked: records.filter((r) => r.state === 'revoked'),
  };
}
