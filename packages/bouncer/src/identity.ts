import type { Principal, Role } from '@beercanlabs/factory-auth';
import { authorize } from './authorize.js';
import { ROLE_PRIVILEGES, type Privilege } from './privileges.js';

export const SUPPORTED_PROVIDERS = ['discord', 'slack', 'teams', 'webui', 'cli'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export type ExternalIdentity = {
  provider: string;
  id: string;
};

export type AuthenticatedCaller = {
  actor: string;
  name?: string;
  role: Role | 'agent-owner';
  roles: readonly Role[];
  provider?: string;
  id?: string;
};

export type IngressPrivilege = 'agents.wake' | 'agents.converse';

export type IngressAuthorizeRequest = {
  requestedBy?: ExternalIdentity;
  agentId: string;
  privilege?: IngressPrivilege;
  owners?: readonly string[];
  link?: {
    actor: string;
    name?: string;
    roles?: readonly Role[];
  };
  adminEmails?: readonly string[];
  isIngressCaller?: boolean;
};

export type IngressAuthorizeResult =
  | { allowed: true; caller?: AuthenticatedCaller }
  | { allowed: false; error: 'unauthorized_caller'; reason: string; required?: Role };

/**
 * Perimeter ingress authorization (GAP-090, A1, A2).
 * When an interaction originates from an external surface (Discord, Slack, Teams, WebUI, CLI),
 * the Bouncer verifies that the external identity is mapped to a primary actor and possesses
 * authorization to wake or converse with the agent. Unmapped or unauthorized callers are refused
 * before any compute is provisioned.
 */
export function authorizeIngress(req: IngressAuthorizeRequest): IngressAuthorizeResult {
  const privilege: Privilege = req.privilege ?? 'agents.wake';

  // An external ingress caller (e.g. gatekeeper-ingress) must provide a resolvable requestedBy
  if (req.isIngressCaller && !req.requestedBy) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: 'missing requestedBy for external ingress caller',
      required: 'operator',
    };
  }

  // Internal calls (cron, schedule, mcp, queue) without external requestedBy are allowed
  if (!req.requestedBy) {
    return { allowed: true };
  }

  const { requestedBy, agentId, owners = [], link } = req;
  if (!link) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `unmapped external identity: ${requestedBy.provider}:${requestedBy.id}`,
      required: 'operator',
    };
  }

  const actor = link.actor;
  const isCloudflare = actor.startsWith('cloudflare:');
  const email = isCloudflare ? actor.slice('cloudflare:'.length).trim().toLowerCase() : '';
  const isEmailAdmin =
    (email && req.adminEmails?.some((e) => e.trim().toLowerCase() === email)) ||
    actor === 'token:admin';

  // Resolve roles: explicit link roles, otherwise admin email lookup, otherwise legacy link fallback ('viewer')
  const resolvedRoles: readonly Role[] =
    link.roles && link.roles.length > 0
      ? link.roles
      : isEmailAdmin
        ? (['admin', 'operator', 'approver', 'viewer', 'ingest'] as const)
        : (['viewer'] as const);

  const principal: Principal = { actor, roles: [...resolvedRoles] };

  const auth = authorize({
    principal,
    privilege,
    resource: { agentId, owners },
  });

  if (!auth.allowed) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `principal '${actor}' does not hold ${privilege} on agent '${agentId}'`,
      required: auth.required,
    };
  }

  const isOwner = owners.some((o) => o.toLowerCase() === actor.toLowerCase());

  // Determine the primary role that actually satisfied the privilege
  let satisfyingRole: Role | 'agent-owner';
  if (resolvedRoles.includes('admin')) {
    satisfyingRole = 'admin';
  } else if (isOwner) {
    satisfyingRole = 'agent-owner';
  } else {
    // Find the granted role that holds the required privilege (e.g. ['viewer', 'operator'] -> 'operator')
    satisfyingRole = resolvedRoles.find((r) => ROLE_PRIVILEGES[r]?.includes(privilege)) ?? resolvedRoles[0] ?? 'operator';
  }

  // Report faithfully: link's explicitly granted roles, or admin if derived from email, or empty
  const faithfulRoles: readonly Role[] = link.roles
    ? [...link.roles]
    : isEmailAdmin
      ? (['admin'] as const)
      : (['viewer'] as const);

  return {
    allowed: true,
    caller: {
      actor,
      name: link.name,
      role: satisfyingRole,
      roles: faithfulRoles,
      provider: requestedBy.provider,
      id: requestedBy.id,
    },
  };
}
