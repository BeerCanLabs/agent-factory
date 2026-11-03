import type { Principal, Role } from '@beercanlabs/factory-auth';
import type { EffectiveGrant } from './grants.js';
import {
  AGENT_SCOPED,
  DERIVED_ROLE_PRIVILEGES,
  ROLE_PRIVILEGES,
  SKILL_CONTENT_OWNER_READONLY_PRIVILEGES,
  SKILL_SCOPED,
  type Privilege,
} from './privileges.js';

/** The order `required` is found in: the least powerful role that holds the privilege comes first. */
const ROLE_ORDER: readonly Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'gatekeeper-ingress', 'admin'];

/**
 * The resource a privilege is asked for, and what the Bouncer needs to know about it. `owners` are the agent's owners
 * (principal actors). `requester` is present when the run has a requesting user; its `actor` is that person's
 * principal actor, absent when the requester is not linked to anyone. `memberRoles` are the roles the caller holds on
 * this agent, from their identity link (the Bouncer's own data), never `Owner`: only `authorizeIngress` sets it.
 *
 * `agentKind` (`'personal' | 'team'`) and `grants` (`EffectiveGrant[]` from `GrantStore`) drive S2b / D7 / D11 / D15 / D29
 * authorization for personal `content-owner` (active vs `pending-revoked` read-only), team `accountable-lead`, team `member`,
 * personal `agent-member`, and skill `content-owner`.
 *
 * For skills: `skillOwner` is the named human user who owns the skill (H4), and `groupRoles` are the roles the caller
 * holds via group membership for the group the skill is assigned to (H5, A9, A17, A18).
 */
export type AuthorizeResource = {
  agentId?: string;
  agentKind?: 'personal' | 'team';
  owners?: readonly string[];
  requester?: { actor?: string };
  memberRoles?: readonly string[];
  ownsAnyAgent?: boolean;
  skillId?: string;
  skillOwner?: string;
  uploader?: string;
  groupRoles?: readonly string[];
  grants?: readonly EffectiveGrant[];
};

export type AuthorizeRequest = { principal: Principal; privilege: Privilege; resource?: AuthorizeResource };
export type AuthorizeResult = { allowed: true } | { allowed: false; required: Role };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A2, E4, E9, D7, D11, D15, D29, S2b: may this caller do this? The principal's identity is already verified by the
 * Gatekeeper's authentication; this maps its roles and effective grants to privileges. On a denial `required` is the
 * first role (in the order above) that holds it.
 */
/**
 * S5 (D14): a factory API key narrows its owner's live grants. A privilege outside `keyScopes.privileges`, or an
 * agent outside `keyScopes.agents`, is refused even when the owner holds it; the owner's grants still cap the key.
 */
export function authorize(req: AuthorizeRequest): AuthorizeResult {
  const scopes = req.principal.keyScopes;
  if (scopes) {
    if (scopes.privileges && !scopes.privileges.includes(req.privilege)) return { allowed: false, required: 'admin' };
    const agentId = req.resource?.agentId?.toLowerCase();
    if (scopes.agents && (agentId === undefined ? req.privilege !== 'mcp.use' : !scopes.agents.includes(agentId))) {
      return { allowed: false, required: 'admin' };
    }
  }
  return authorizeUnscoped(req);
}

function authorizeUnscoped(req: AuthorizeRequest): AuthorizeResult {
  const { principal, privilege, resource } = req;
  if (principal.roles.some((r) => ROLE_PRIVILEGES[r]?.includes(privilege))) return { allowed: true };

  if (resource?.grants) {
    for (const eg of resource.grants) {
      if (!eg.readOnly && eg.grant.scope.kind === 'fleet') {
        const fleetPrivs = ROLE_PRIVILEGES[eg.grant.role as Role];
        if (fleetPrivs?.includes(privilege)) return { allowed: true };
      }
    }
  }

  if (privilege === 'mcp.use' && !resource?.agentId && !resource?.skillId) {
    if (
      resource?.ownsAnyAgent ||
      resource?.grants?.some(
        (eg) => !eg.readOnly && (eg.grant.scope.kind === 'agent' || eg.grant.scope.kind === 'skill'),
      )
    ) {
      return { allowed: true };
    }
  }

  if (privilege === 'skills.register') {
    if (resource?.ownsAnyAgent || resource?.groupRoles?.includes('skills.register')) {
      return { allowed: true };
    }
    if (
      resource?.grants?.some(
        (eg) =>
          !eg.readOnly &&
          eg.grant.scope.kind === 'agent' &&
          (eg.grant.role === 'content-owner' || eg.grant.role === 'accountable-lead'),
      )
    ) {
      return { allowed: true };
    }
  }

  if (resource && AGENT_SCOPED.has(privilege)) {
    // F1/D11/D15: When grant-backed authorization is active (`resource.grants` provided) or the agent is `team`,
    // `GrantStore` is authoritative for agent ownership; legacy `resource.owners` never resurrects transferred/revoked owners.
    let suppressLegacyOwner = resource.agentKind === 'team' || resource.grants !== undefined;
    // D29: When grant-backed authorization is active (`resource.grants` provided), holds go strictly to the content side
    // (`content-owner` on personal agents; `accountable-lead` or `member` on team agents), never to a personal `agent-member` requester.
    const suppressLegacyRequester = resource.grants !== undefined;

    if (resource.grants && resource.agentId) {
      const agentGrants = resource.grants.filter(
        (eg) => eg.grant.scope.kind === 'agent' && same(eg.grant.scope.id, resource.agentId!),
      );
      const effectiveKind =
        resource.agentKind ?? (agentGrants.some((eg) => eg.grant.role === 'accountable-lead') ? 'team' : 'personal');

      if (effectiveKind === 'team') {
        suppressLegacyOwner = true;
        for (const eg of agentGrants) {
          if (eg.readOnly) continue;
          if (
            eg.grant.role === 'accountable-lead' &&
            eg.source === 'direct' &&
            DERIVED_ROLE_PRIVILEGES['accountable-lead'].includes(privilege)
          ) {
            return { allowed: true };
          }
          if (eg.grant.role === 'member' && DERIVED_ROLE_PRIVILEGES['team-member'].includes(privilege)) {
            return { allowed: true };
          }
          if (
            eg.grant.role !== 'content-owner' &&
            eg.grant.role !== 'accountable-lead' &&
            eg.grant.role !== 'member' &&
            eg.grant.role.trim().toLowerCase() !== 'owner' &&
            DERIVED_ROLE_PRIVILEGES['agent-member'].includes(privilege)
          ) {
            return { allowed: true };
          }
        }
      } else {
        for (const eg of agentGrants) {
          if (eg.grant.role === 'content-owner' && eg.source === 'direct') {
            suppressLegacyOwner = true;
            if (eg.readOnly) {
              if (DERIVED_ROLE_PRIVILEGES['content-owner-readonly'].includes(privilege)) {
                return { allowed: true };
              }
            } else if (DERIVED_ROLE_PRIVILEGES['content-owner'].includes(privilege)) {
              return { allowed: true };
            }
          } else if (
            !eg.readOnly &&
            eg.grant.role !== 'accountable-lead' &&
            eg.grant.role.trim().toLowerCase() !== 'owner' &&
            DERIVED_ROLE_PRIVILEGES['agent-member'].includes(privilege)
          ) {
            return { allowed: true };
          }
        }
      }
    }

    if (resource.owners || resource.requester || resource.memberRoles) {
      const actor = principal.actor;
      const owner =
        !suppressLegacyOwner &&
        (resource.owners ?? []).some((o) => same(o, actor)) &&
        DERIVED_ROLE_PRIVILEGES['agent-owner'].includes(privilege) &&
        !(privilege === 'approvals.decide' && resource.requester);
      const requester =
        !suppressLegacyRequester &&
        resource.requester?.actor !== undefined &&
        same(resource.requester.actor, actor) &&
        DERIVED_ROLE_PRIVILEGES.requester.includes(privilege);
      const member =
        (resource.memberRoles ?? []).some((r) => typeof r === 'string' && r.trim() !== '' && r.trim().toLowerCase() !== 'owner') &&
        DERIVED_ROLE_PRIVILEGES['agent-member'].includes(privilege);
      if (owner || requester || member) return { allowed: true };
    }
  }

  if (resource && SKILL_SCOPED.has(privilege)) {
    let suppressLegacySkillOwner = false;
    if (resource.grants && resource.skillId) {
      const skillGrants = resource.grants.filter(
        (eg) => eg.grant.scope.kind === 'skill' && same(eg.grant.scope.id, resource.skillId!),
      );
      for (const eg of skillGrants) {
        if (eg.grant.role === 'content-owner' && eg.source === 'direct') {
          suppressLegacySkillOwner = true;
          if (eg.readOnly) {
            if (SKILL_CONTENT_OWNER_READONLY_PRIVILEGES.includes(privilege)) return { allowed: true };
          } else {
            if (privilege === 'skills.transfer') return { allowed: true };
            if (DERIVED_ROLE_PRIVILEGES['skill-owner'].includes(privilege)) return { allowed: true };
          }
        } else if (
          !eg.readOnly &&
          eg.grant.role === 'member' &&
          DERIVED_ROLE_PRIVILEGES['skill-owner'].includes(privilege)
        ) {
          return { allowed: true };
        }
      }
    }

    const actor = principal.actor;
    // Human owner holds scoped privileges and skills.transfer (H4, A8, A9)
    if (!suppressLegacySkillOwner && resource.skillOwner && same(resource.skillOwner, actor)) {
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

/**
 * R6, R7, S3: Returns the most specific role name a caller would need to hold `privilege` on `resource`
 * (e.g., `'member'` or `'accountable-lead'` on a team agent, `'agent-member'` or `'content-owner'` on a personal agent,
 * `'content-owner'` on a skill, or the fleet `Role` otherwise).
 */
export function requiredRoleForPrivilege(
  privilege: Privilege,
  resource?: AuthorizeResource,
  fallback?: Role,
): string {
  const defaultRole = fallback ?? ROLE_ORDER.find((r) => ROLE_PRIVILEGES[r].includes(privilege)) ?? 'admin';
  if (resource?.agentId && AGENT_SCOPED.has(privilege)) {
    const agentGrants = resource.grants?.filter(
      (eg) => eg.grant.scope.kind === 'agent' && same(eg.grant.scope.id, resource.agentId!),
    );
    const effectiveKind =
      resource.agentKind ??
      (agentGrants?.some((eg) => eg.grant.role === 'accountable-lead') ? 'team' : undefined);
    if (effectiveKind === 'team') {
      if (DERIVED_ROLE_PRIVILEGES['team-member'].includes(privilege)) return 'member';
      if (DERIVED_ROLE_PRIVILEGES['accountable-lead'].includes(privilege)) return 'accountable-lead';
      return defaultRole;
    }
    if (effectiveKind === 'personal' || resource.grants !== undefined || resource.owners !== undefined) {
      if (DERIVED_ROLE_PRIVILEGES['agent-member'].includes(privilege)) return 'agent-member';
      if (DERIVED_ROLE_PRIVILEGES['content-owner'].includes(privilege)) return 'content-owner';
      return defaultRole;
    }
  }
  if (resource?.skillId && SKILL_SCOPED.has(privilege)) {
    if (privilege === 'skills.transfer' || DERIVED_ROLE_PRIVILEGES['skill-owner'].includes(privilege)) {
      return 'content-owner';
    }
  }
  return defaultRole;
}

