/**
 * What a person who holds some roles on an agent may use (DESIGN_AUTHORITY.md E12). One rule, no dependencies, so the
 * screen that describes a person's access and the gatekeeper-egress that enforces it say the same thing: both ask this.
 *
 * Roles are skill-based. A role lists skills (the key `*` is every skill), and for each, the actions it allows and the
 * actions it denies (`*` is every action). A person holds several roles at once; the rule is:
 *   - what any of their roles allows is allowed, and what any of their roles denies is denied: deny wins;
 *   - a skill none of their roles lists is not allowed (and not denied: it is simply not theirs);
 *   - the egress sees routes, not skills, so a route is allowed when an allowed skill declares it and no skill that
 *     declares it is denied outright.
 */

/** One role, as the agent record carries it (`DeclaredRole` in the registrar): skill id to the actions it allows and denies. */
export type AccessRole = { name: string; skills: Record<string, { allow: string[]; deny: string[] }> };

/**
 * What the person may do with one skill. `none` says why: `denied` (some role denies it outright) or `unlisted` (no role
 * of theirs mentions it). `only` lists the actions allowed when no role allows them all; `except` lists the ones denied
 * when a role allows them all.
 */
export type SkillAccess =
  | { kind: 'all' }
  | { kind: 'only'; actions: string[] }
  | { kind: 'except'; actions: string[] }
  | { kind: 'none'; why: 'denied' | 'unlisted' };

export type RouteAccess = 'allowed' | 'denied';

export type EffectiveAccess = {
  /** The roles that were held and exist on the agent; any other name held is listed in `unknownRoles`. */
  held: string[];
  unknownRoles: string[];
  skills: Array<{ skill: string; access: SkillAccess; routes: string[] }>;
  /** Each route a declared skill uses, and whether the person may reach it. */
  routes: Record<string, RouteAccess>;
};

const has = (list: readonly string[], v: string) => list.includes(v);

/** An own property only: a skill id such as `__proto__` or `constructor` must never find what Object.prototype holds. */
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

function skillAccess(rules: Array<{ allow: string[]; deny: string[] }>): SkillAccess {
  if (rules.length === 0) return { kind: 'none', why: 'unlisted' };
  const allow = new Set(rules.flatMap((r) => r.allow));
  const deny = new Set(rules.flatMap((r) => r.deny));
  if (deny.has('*')) return { kind: 'none', why: 'denied' };
  const denied = [...deny].sort();
  if (allow.has('*')) return denied.length ? { kind: 'except', actions: denied } : { kind: 'all' };
  const only = [...allow].filter((a) => !deny.has(a)).sort();
  if (only.length) return { kind: 'only', actions: only };
  // Nothing is left. If something was allowed and all of it denied, that is a denial. If roles only denied some actions
  // and allowed none, nothing was granted and nothing was refused outright: the skill is simply not theirs.
  return { kind: 'none', why: allow.size > 0 ? 'denied' : 'unlisted' };
}

/**
 * The effective access of someone who holds `held` on an agent whose declared roles are `roles`, over the skills the
 * cartridge declares (`skills`) and the routes each uses (`skillRoutes`). Skills come in a stable order (as listed).
 */
export function effectiveAccess(
  roles: readonly AccessRole[],
  held: readonly string[],
  skills: readonly string[],
  skillRoutes: Readonly<Record<string, readonly string[]>> = {},
): EffectiveAccess {
  const byName = new Map(roles.map((r) => [r.name, r]));
  const heldKnown = [...new Set(held)].filter((n) => byName.has(n));
  const unknownRoles = [...new Set(held)].filter((n) => !byName.has(n));
  const heldRoles = heldKnown.map((n) => byName.get(n)!);

  const rows = skills.map((skill) => {
    // A role's own entry for the skill, and its `*` entry, both apply.
    const rules = heldRoles.flatMap((r) => [own(r.skills, skill), own(r.skills, '*')].filter((x): x is { allow: string[]; deny: string[] } => !!x));
    return { skill, access: skillAccess(rules), routes: [...(own(skillRoutes, skill) ?? [])] };
  });

  const routes: Record<string, RouteAccess> = {};
  const allRoutes = [...new Set(rows.flatMap((r) => r.routes))].sort();
  for (const route of allRoutes) {
    const users = rows.filter((r) => has(r.routes, route));
    const allowed = users.some((u) => u.access.kind !== 'none');
    const denied = users.some((u) => u.access.kind === 'none' && u.access.why === 'denied');
    routes[route] = allowed && !denied ? 'allowed' : 'denied';
  }
  return { held: heldKnown, unknownRoles, skills: rows, routes };
}
