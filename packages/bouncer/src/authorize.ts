import type { Principal, Role } from '@beercanlabs/factory-auth';
import { AGENT_SCOPED, DERIVED_ROLE_PRIVILEGES, ROLE_PRIVILEGES, type Privilege } from './privileges.js';

/** The order `required` is found in: the least powerful role that holds the privilege comes first. */
const ROLE_ORDER: readonly Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'admin'];

/**
 * The agent a privilege is asked for, and what the Bouncer needs to know about it. `owners` are the agent's owners
 * (principal actors). `requester` is present when the run has a requesting user; its `actor` is that person's
 * principal actor, absent when the requester is not linked to anyone.
 */
export type AuthorizeResource = { agentId: string; owners: readonly string[]; requester?: { actor?: string } };

export type AuthorizeRequest = { principal: Principal; privilege: Privilege; resource?: AuthorizeResource };
export type AuthorizeResult = { allowed: true } | { allowed: false; required: Role };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A2, E4, E9: may this caller do this? The principal's identity is already verified by the Gatekeeper's
 * authentication; this maps its roles to privileges. On a denial `required` is the first role (in the order above)
 * that holds it.
 *
 * With a `resource`, two more roles can apply, derived from data and never from `principal.roles`, and only for an
 * agent-scoped privilege: `agent-owner` when the caller is one of the agent's owners, and `requester` when the caller
 * is the run's requesting user. An owner decides (`approvals.decide`) only when the run has no requesting user.
 */
export function authorize(req: AuthorizeRequest): AuthorizeResult {
  const { principal, privilege, resource } = req;
  if (principal.roles.some((r) => ROLE_PRIVILEGES[r]?.includes(privilege))) return { allowed: true };
  if (resource && AGENT_SCOPED.has(privilege)) {
    const actor = principal.actor;
    const owner =
      resource.owners.some((o) => same(o, actor)) &&
      DERIVED_ROLE_PRIVILEGES['agent-owner'].includes(privilege) &&
      !(privilege === 'approvals.decide' && resource.requester);
    const requester =
      resource.requester?.actor !== undefined && same(resource.requester.actor, actor) && DERIVED_ROLE_PRIVILEGES.requester.includes(privilege);
    if (owner || requester) return { allowed: true };
  }
  const required = ROLE_ORDER.find((r) => ROLE_PRIVILEGES[r].includes(privilege));
  if (!required) throw new Error(`no role holds privilege ${privilege}`);
  return { allowed: false, required };
}
