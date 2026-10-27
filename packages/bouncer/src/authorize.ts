import type { Principal, Role } from '@beercanlabs/factory-auth';
import { AGENT_SCOPED, SKILL_SCOPED, DERIVED_ROLE_PRIVILEGES, ROLE_PRIVILEGES, type Privilege } from './privileges.js';

/** The order `required` is found in: the least powerful role that holds the privilege comes first. */
const ROLE_ORDER: readonly Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'gatekeeper-ingress', 'admin'];

/**
 * The resource a privilege is asked for, and what the Bouncer needs to know about it. `owners` are the agent's owners
 * (principal actors). `requester` is present when the run has a requesting user; its `actor` is that person's
 * principal actor, absent when the requester is not linked to anyone. `memberRoles` are the roles the caller holds on
 * this agent, from their identity link (the Bouncer's own data), never `Owner`: only `authorizeIngress` sets it.
 *
 * For skills: `skillOwner` is the named human user who owns the skill (H4), and `groupRoles` are the roles the caller
 * holds via group membership for the group the skill is assigned to (H5, A9, A17, A18).
 */
export type AuthorizeResource = {
  agentId?: string;
  owners?: readonly string[];
  requester?: { actor?: string };
  memberRoles?: readonly string[];
  ownsAnyAgent?: boolean;
  skillId?: string;
  skillOwner?: string;
  uploader?: string;
  groupRoles?: readonly string[];
};

export type AuthorizeRequest = { principal: Principal; privilege: Privilege; resource?: AuthorizeResource };
export type AuthorizeResult = { allowed: true } | { allowed: false; required: Role };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A2, E4, E9: may this caller do this? The principal's identity is already verified by the Gatekeeper's
 * authentication; this maps its roles to privileges. On a denial `required` is the first role (in the order above)
 * that holds it.
 *
 * With a `resource`, derived roles can apply:
 * - Agent-scoped: `agent-owner`, `requester`, `agent-member`.
 * - Skill-scoped: `skill-owner` (human owner, or group member whose group holds `skill-owner`).
 *   An owner also holds `skills.transfer`; group members never hold `skills.transfer` (A9).
 * - `skills.register` is fleet-wide, held by admin, by anyone who owns any agent (`ownsAnyAgent`), or by members of a group with `skills.register` (H3, A8, A17).
 */
export function authorize(req: AuthorizeRequest): AuthorizeResult {
  const { principal, privilege, resource } = req;
  if (principal.roles.some((r) => ROLE_PRIVILEGES[r]?.includes(privilege))) return { allowed: true };
  if (privilege === 'skills.register' && (resource?.ownsAnyAgent || resource?.groupRoles?.includes('skills.register'))) {
    return { allowed: true };
  }
  if (resource && resource.owners && AGENT_SCOPED.has(privilege)) {
    const actor = principal.actor;
    const owner =
      resource.owners.some((o) => same(o, actor)) &&
      DERIVED_ROLE_PRIVILEGES['agent-owner'].includes(privilege) &&
      !(privilege === 'approvals.decide' && resource.requester);
    const requester =
      resource.requester?.actor !== undefined && same(resource.requester.actor, actor) && DERIVED_ROLE_PRIVILEGES.requester.includes(privilege);
    const member =
      (resource.memberRoles ?? []).some((r) => typeof r === 'string' && r.trim() !== '' && r.trim().toLowerCase() !== 'owner') &&
      DERIVED_ROLE_PRIVILEGES['agent-member'].includes(privilege);
    if (owner || requester || member) return { allowed: true };
  }
  if (resource && SKILL_SCOPED.has(privilege)) {
    const actor = principal.actor;
    // Human owner holds scoped privileges and skills.transfer (H4, A8, A9)
    if (resource.skillOwner && same(resource.skillOwner, actor)) {
      if (privilege === 'skills.transfer') return { allowed: true };
      if (DERIVED_ROLE_PRIVILEGES['skill-owner'].includes(privilege)) return { allowed: true };
    }
    // Uploader of version can read package (A21)
    if (privilege === 'skills.package.read' && resource.uploader && same(resource.uploader, actor)) {
      return { allowed: true };
    }
    // Group members hold privileges granted to the assigned group (H5, A9, A17, A18)
    if (resource.groupRoles && resource.groupRoles.length > 0) {
      for (const gr of resource.groupRoles) {
        if (gr === 'skill-owner' && DERIVED_ROLE_PRIVILEGES['skill-owner'].includes(privilege)) {
          return { allowed: true };
        }
      }
    }
  }
  const required = ROLE_ORDER.find((r) => ROLE_PRIVILEGES[r].includes(privilege));
  if (!required) throw new Error(`no role holds privilege ${privilege}`);
  return { allowed: false, required };
}

