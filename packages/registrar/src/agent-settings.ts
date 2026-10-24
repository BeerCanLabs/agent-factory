/**
 * An agent's own settings in its configuration record (DESIGN_AUTHORITY.md §6.18 CF1): the soul, the roles (what each may
 * use, E12) and the memory settings. They are an optional `agent` section of the record, counted in the content hash
 * only when present, so every record without one keeps the hash (and the image tag) it had.
 *
 * `parseAgentSettings` is strict where the cartridge reader (`rolesOf`) is forgiving: this is what a person submitted,
 * so a bad value is refused and said, never dropped. Roles are held in maps without a prototype so a skill id such as
 * `__proto__` can reach nothing. Nothing here is a grant: a role only decides which people may use what the agent's
 * policy already grants (E7, E12).
 */
import { ROLE_NAME } from '@beercanlabs/factory-contract';
import type { DeclaredRole } from './catalog.js';

export const MEMORY_ARCHETYPES = ['purpose-built', 'personal-assistant', 'team-member'] as const;
export type MemoryArchetype = (typeof MEMORY_ARCHETYPES)[number];

export type AgentMemorySettings = { archetype: MemoryArchetype; maxMessages?: number; maxChars?: number };

export type AgentSettings = {
  /** The persona and instructions, opaque text: the factory never reads it to decide anything (CF1). */
  soul?: string;
  roles?: DeclaredRole[];
  memory?: AgentMemorySettings;
};

export const MAX_SOUL_CHARS = 65_536;
export const MAX_ROLES = 50;
const SKILL_KEY = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const ACTION = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/;

export type SettingsResult = { ok: true; settings: AgentSettings } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function actions(v: unknown, where: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) return `${where} must be a list of at most 50 actions`;
  const out: string[] = [];
  for (const a of v) {
    if (typeof a !== 'string' || !ACTION.test(a)) return `${where} has an action that is not a plain name or "*"`;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export function parseRoles(input: unknown): { ok: true; roles: DeclaredRole[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length > MAX_ROLES) return { ok: false, error: `roles must be a list of at most ${MAX_ROLES} roles` };
  const roles: DeclaredRole[] = [];
  const seen = new Set<string>();
  for (const r of input) {
    if (!isObject(r) || typeof r.name !== 'string' || !ROLE_NAME.test(r.name)) return { ok: false, error: 'each role needs a name of letters, digits, dash or underscore' };
    const lower = r.name.toLowerCase();
    if (seen.has(lower)) return { ok: false, error: `role "${r.name}" is defined twice (names differ only in case at most)` };
    seen.add(lower);
    if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > 500)) return { ok: false, error: `role "${r.name}" description must be text of at most 500 characters` };
    if (!isObject(r.skills)) return { ok: false, error: `role "${r.name}" needs a skills map` };
    const skills: Record<string, { allow: string[]; deny: string[] }> = Object.create(null);
    for (const [skill, rule] of Object.entries(r.skills)) {
      if (!SKILL_KEY.test(skill)) return { ok: false, error: `role "${r.name}" names "${skill}", which is not a skill id or "*"` };
      if (!isObject(rule)) return { ok: false, error: `role "${r.name}" skill "${skill}" needs allow and deny lists` };
      const allow = actions(rule.allow, `role "${r.name}" skill "${skill}" allow`);
      const deny = actions(rule.deny, `role "${r.name}" skill "${skill}" deny`);
      if (typeof allow === 'string') return { ok: false, error: allow };
      if (typeof deny === 'string') return { ok: false, error: deny };
      if (!allow.length && !deny.length) return { ok: false, error: `role "${r.name}" skill "${skill}" allows and denies nothing` };
      skills[skill] = { allow, deny };
    }
    roles.push({ name: r.name, ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}), skills });
  }
  roles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  return { ok: true, roles };
}

export function parseMemory(input: unknown): { ok: true; memory: AgentMemorySettings } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: 'memory must be an object with an archetype' };
  const allowed = new Set(['archetype', 'maxMessages', 'maxChars']);
  for (const k of Object.keys(input)) if (!allowed.has(k)) return { ok: false, error: `memory has an unknown setting "${k}"` };
  if (typeof input.archetype !== 'string' || !(MEMORY_ARCHETYPES as readonly string[]).includes(input.archetype)) {
    return { ok: false, error: `memory.archetype must be one of ${MEMORY_ARCHETYPES.join(', ')}` };
  }
  const out: AgentMemorySettings = { archetype: input.archetype as MemoryArchetype };
  for (const k of ['maxMessages', 'maxChars'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1_000_000) return { ok: false, error: `memory.${k} must be a whole number from 1 to 1000000` };
    out[k] = v;
  }
  return { ok: true, memory: out };
}

export function parseSoul(input: unknown): { ok: true; soul: string } | { ok: false; error: string } {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'soul must be non-empty text' };
  if (input.length > MAX_SOUL_CHARS) return { ok: false, error: `soul is at most ${MAX_SOUL_CHARS} characters` };
  if (input.includes('\0')) return { ok: false, error: 'soul must be text' };
  return { ok: true, soul: input };
}

/**
 * A change to the settings: each key present replaces that part, `null` removes it. Anything else is refused. The result
 * is the new section (`{}` when nothing is left, which means "back to the repository").
 */
export function applySettingsChange(current: AgentSettings | undefined, change: unknown): SettingsResult {
  if (!isObject(change)) return { ok: false, error: 'the change must be an object with soul, roles and/or memory' };
  for (const k of Object.keys(change)) if (k !== 'soul' && k !== 'roles' && k !== 'memory') return { ok: false, error: `unknown setting "${k}"` };
  if (!Object.keys(change).length) return { ok: false, error: 'nothing to change: send soul, roles and/or memory' };
  const next: AgentSettings = { ...(current ?? {}) };
  if ('soul' in change) {
    if (change.soul === null) delete next.soul;
    else {
      const r = parseSoul(change.soul);
      if (!r.ok) return r;
      next.soul = r.soul;
    }
  }
  if ('roles' in change) {
    if (change.roles === null) delete next.roles;
    else {
      const r = parseRoles(change.roles);
      if (!r.ok) return r;
      next.roles = r.roles;
    }
  }
  if ('memory' in change) {
    if (change.memory === null) delete next.memory;
    else {
      const r = parseMemory(change.memory);
      if (!r.ok) return r;
      next.memory = r.memory;
    }
  }
  return { ok: true, settings: next };
}

/** Which parts differ, by name only (a ledger row and a message never carry the soul). */
export function changedParts(before: AgentSettings | undefined, after: AgentSettings | undefined): Array<'soul' | 'roles' | 'memory'> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (['soul', 'roles', 'memory'] as const).filter((k) => !same(before?.[k], after?.[k]));
}
