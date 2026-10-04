import type { Principal, Role } from '@beercanlabs/factory-auth';
import { ROLE_PRIVILEGES, type Privilege } from './privileges.js';

/** The order `required` is found in: the least powerful role that holds the privilege comes first. */
const ROLE_ORDER: readonly Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'admin'];

export type AuthorizeRequest = { principal: Principal; privilege: Privilege };
export type AuthorizeResult = { allowed: true } | { allowed: false; required: Role };

/**
 * A2, E4: may this caller do this? The principal's identity is already verified by the Gatekeeper's authentication;
 * this maps its roles to privileges. On a denial `required` is the first role (in the order above) that holds it.
 */
export function authorize(req: AuthorizeRequest): AuthorizeResult {
  if (req.principal.roles.some((r) => ROLE_PRIVILEGES[r]?.includes(req.privilege))) return { allowed: true };
  const required = ROLE_ORDER.find((r) => ROLE_PRIVILEGES[r].includes(req.privilege));
  if (!required) throw new Error(`no role holds privilege ${req.privilege}`);
  return { allowed: false, required };
}
