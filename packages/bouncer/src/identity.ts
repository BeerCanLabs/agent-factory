import type { Principal, Role } from '@beercanlabs/factory-auth';
import { authorize } from './authorize.js';

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

export type IngressAuthorizeRequest = {
  requestedBy?: ExternalIdentity;
  agentId: string;
  owners?: readonly string[];
  link?: {
    actor: string;
    name?: string;
    roles?: readonly Role[];
  };
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
  if (!req.requestedBy) {
    return { allowed: true };
  }

  const { requestedBy, agentId, owners = [], link } = req;
  if (!link) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `unmapped external identity: ${requestedBy.provider}:${requestedBy.id}`,
    };
  }

  const actor = link.actor;
  const roles: readonly Role[] = link.roles && link.roles.length > 0 ? link.roles : ['viewer'];
  const principal: Principal = { actor, roles: [...roles] };

  const auth = authorize({
    principal,
    privilege: 'agents.wake',
    resource: { agentId, owners },
  });

  if (!auth.allowed) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `principal '${actor}' does not hold agents.wake on agent '${agentId}'`,
      required: auth.required,
    };
  }

  const isOwner = owners.some((o) => o.toLowerCase() === actor.toLowerCase());
  const primaryRole: Role | 'agent-owner' = roles.includes('admin')
    ? 'admin'
    : isOwner
      ? 'agent-owner'
      : (roles[0] ?? 'operator');

  return {
    allowed: true,
    caller: {
      actor,
      name: link.name,
      role: primaryRole,
      roles,
      provider: requestedBy.provider,
      id: requestedBy.id,
    },
  };
}
