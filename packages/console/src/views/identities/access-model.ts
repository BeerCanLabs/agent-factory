/**
 * The agent-access part of the Identities screen, with no React and no browser (DESIGN_AUTHORITY.md E12). The console has
 * no component test runner, so what the screen shows and sends is decided here, where `tsx --test` can prove it.
 *
 * What a set of roles may use is NOT decided here: the factory says (`GET /agents/:id/roles?held=`), by the same rule the
 * egress applies, and this file only puts that into words. Nothing here can make the screen and the enforcement disagree.
 */
import type { EffectiveAccess, FactoryRole, SkillAccess } from '../../api/types.js';

/** A person's agent roles: agent id to the role names held there. */
export type AgentRoleMap = Record<string, string[]>;

const cmp = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);

/** The map in the one form it is compared and sent in: agents and roles sorted and unique, empty lists dropped. */
export function canonicalRoles(map: AgentRoleMap | undefined): AgentRoleMap {
  const out: AgentRoleMap = {};
  for (const agentId of Object.keys(map ?? {}).sort(cmp)) {
    const roles = [...new Set((map?.[agentId] ?? []).filter((r) => r.trim() !== ''))].sort(cmp);
    if (roles.length) out[agentId] = roles;
  }
  return out;
}

export const sameRoles = (a: AgentRoleMap | undefined, b: AgentRoleMap | undefined): boolean => JSON.stringify(canonicalRoles(a)) === JSON.stringify(canonicalRoles(b));

/** The map with `role` held (or not) on `agentId`. An agent left with no role is dropped from the map. */
export function withRole(map: AgentRoleMap | undefined, agentId: string, role: string, held: boolean): AgentRoleMap {
  const next: AgentRoleMap = { ...canonicalRoles(map) };
  const roles = new Set(next[agentId] ?? []);
  if (held) roles.add(role);
  else roles.delete(role);
  if (roles.size) next[agentId] = [...roles];
  else delete next[agentId];
  return canonicalRoles(next);
}

/** The map without any role on `agentId`. */
export function withoutAgent(map: AgentRoleMap | undefined, agentId: string): AgentRoleMap {
  const next: AgentRoleMap = { ...canonicalRoles(map) };
  delete next[agentId];
  return next;
}

/** An agent the person holds nothing on yet, added so its roles can be chosen. It is not in the map until a role is. */
export const unassignedAgents = <T extends { id: string }>(agents: readonly T[], map: AgentRoleMap | undefined, pending: readonly string[] = []): T[] =>
  agents.filter((a) => !(map && Object.prototype.hasOwnProperty.call(map, a.id)) && !pending.includes(a.id)).sort((a, b) => cmp(a.id, b.id));

/** The one-line form for a table cell: `Family on donna; Realtor on higgins`. Empty when the person holds none. */
export function summarizeRoles(map: AgentRoleMap | undefined): string[] {
  const c = canonicalRoles(map);
  return Object.keys(c).flatMap((agentId) => c[agentId].map((r) => `${r} on ${agentId}`));
}

// ---- Saying what a set of roles may use ------------------------------------------------------------------------

const list = (actions: readonly string[]) => actions.join(', ');

/** One skill, in words, for the side it falls on. */
function lineFor(skill: string, access: SkillAccess): { side: 'can' | 'cannot' | 'not-theirs'; text: string } {
  switch (access.kind) {
    case 'all':
      return { side: 'can', text: skill };
    case 'only':
      return { side: 'can', text: `${skill} (only ${list(access.actions)})` };
    case 'except':
      return { side: 'can', text: `${skill} (not ${list(access.actions)})` };
    case 'none':
      return access.why === 'denied' ? { side: 'cannot', text: skill } : { side: 'not-theirs', text: skill };
  }
}

export type AccessWords = { can: string[]; cannot: string[]; notTheirs: string[]; unknownRoles: string[]; holdsNothing: boolean };

/**
 * What the factory said someone may use, in three groups: what they can use (with any limit on its actions), what is
 * refused to them outright (a role of theirs denies it), and what is simply not theirs (no role of theirs lists it).
 */
export function describeAccess(effective: EffectiveAccess): AccessWords {
  const words: AccessWords = { can: [], cannot: [], notTheirs: [], unknownRoles: [...effective.unknownRoles], holdsNothing: effective.held.length === 0 };
  for (const s of effective.skills) {
    const l = lineFor(s.skill, s.access);
    (l.side === 'can' ? words.can : l.side === 'cannot' ? words.cannot : words.notTheirs).push(l.text);
  }
  return words;
}

/** The sentence under a role picker: what this person can and cannot use, or that they can use nothing. */
export function accessSentence(words: AccessWords): string {
  if (words.holdsNothing && words.can.length === 0) return 'Holds no role here, so the agent will do nothing for them.';
  const parts: string[] = [];
  parts.push(words.can.length ? `Can use ${words.can.join(', ')}.` : 'Can use none of its skills.');
  if (words.cannot.length) parts.push(`Refused ${words.cannot.join(', ')}.`);
  return parts.join(' ');
}

// ---- Factory roles beside agent roles ---------------------------------------------------------------------------

/**
 * A factory role reaches every agent, which is not what an agent role is for. Say so where it matters, so that giving
 * someone `Family` on one agent while they also hold `operator` is not mistaken for limiting them.
 */
export function factoryRoleWarnings(roles: readonly FactoryRole[] | undefined, map: AgentRoleMap | undefined): string[] {
  const held = new Set(roles ?? []);
  const hasAgentRoles = Object.keys(canonicalRoles(map)).length > 0;
  const out: string[] = [];
  if (held.has('admin')) {
    out.push('Admin can do everything on every agent, so the agent roles below add nothing for this person.');
  } else if (held.has('operator')) {
    out.push(
      hasAgentRoles
        ? 'Operator reaches every agent: it can start runs, converse, pause and reset any of them. To limit this person to the roles below, remove Operator.'
        : 'Operator reaches every agent: it can start runs, converse, pause and reset any of them. To give this person access to one agent only, remove Operator and give them a role on that agent below.',
    );
  }
  return out;
}
