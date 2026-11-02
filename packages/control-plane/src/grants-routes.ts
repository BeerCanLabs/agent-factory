import http from 'node:http';
import { ROLES, type Principal, type Role } from '@beercanlabs/factory-auth';
import {
  AGENT_SCOPED,
  DuplicatePrincipalEmailError,
  DuplicatePrincipalIdError,
  GrantStoreError,
  GrantStoreUnavailableError,
  PRIVILEGES,
  PrincipalStoreUnavailableError,
  SKILL_SCOPED,
  authorize,
  isValidUserPrincipalId,
  normalizeActorToPrincipal,
  normalizeEmail,
  requiredRoleForPrivilege,
  type AuthorizeResource,
  type EffectiveGrant,
  type GrantRecord,
  type GrantScope,
  type PrincipalRecord,
  type Privilege,
} from '@beercanlabs/factory-bouncer';
import { canAdopt, effectiveAgentKind, ownerOf, skillVisibleTo, visibilityOf } from '@beercanlabs/factory-registrar';
import {
  actorIsAdmin,
  agentKindOf,
  checkOwnsAnyAgent,
  effectiveGrantsForActor,
  findAgentRecord,
  identify,
  json,
  readJson,
  requirePrivilege,
  type FactoryState,
} from './app.js';
import { ownersOf } from './config-store.js';
import { adoptContextForAgent, resolveSkillContentOwner, skillRegistry } from './skills.js';

const PRIVILEGE_SET: ReadonlySet<string> = new Set<string>(PRIVILEGES);
const AUTH_ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES);

const PRINCIPAL_ONE = /^\/api\/v1\/principals\/([^/]+)$/;
const PRINCIPAL_EMAILS = /^\/api\/v1\/principals\/([^/]+)\/emails$/;
const PRINCIPAL_EMAIL_ONE = /^\/api\/v1\/principals\/([^/]+)\/emails\/([^/]+)$/;
const GRANT_ONE = /^\/api\/v1\/grants\/([^/]+)$/;

export type RouteOutcome = {
  status: number;
  body: Record<string, unknown>;
};

export function extractVerifiedEmailFromActor(actor: string): { idp: string; email: string } | undefined {
  const trimmed = actor.trim();
  const lower = trimmed.toLowerCase();
  let idp: string | undefined;
  let candidate: string | undefined;
  if (lower.startsWith('cloudflare:')) {
    idp = 'cloudflare';
    candidate = lower.slice('cloudflare:'.length).trim();
  } else if (lower.startsWith('oidc:')) {
    idp = 'oidc';
    candidate = lower.slice('oidc:'.length).trim();
  } else if (lower.startsWith('user:') && lower.slice('user:'.length).includes('@')) {
    idp = 'session';
    candidate = lower.slice('user:'.length).trim();
  }
  if (!idp || !candidate) return undefined;
  try {
    return { idp, email: normalizeEmail(candidate) };
  } catch {
    return undefined;
  }
}

export function rolesForSubjectActor(
  state: FactoryState,
  subjectActor: string,
  grants: EffectiveGrant[] | undefined,
  baseRoles?: readonly Role[],
): Role[] {
  const out = new Set<Role>(baseRoles ?? []);
  if (grants) {
    for (const eg of grants) {
      if (!eg.readOnly && eg.grant.scope.kind === 'fleet' && AUTH_ROLE_SET.has(eg.grant.role)) {
        out.add(eg.grant.role as Role);
      }
    }
  }
  if (actorIsAdmin(state, subjectActor, [...out])) {
    out.add('admin');
  }
  return [...out];
}

function normalizedOwnersForAgent(state: FactoryState, agentId: string): string[] {
  return ownersOf(state, agentId).map((o) => {
    try {
      return normalizeActorToPrincipal(o, state.principals);
    } catch {
      return o;
    }
  });
}

function serializeEffectiveGrant(eg: EffectiveGrant): GrantRecord & { source: EffectiveGrant['source']; readOnly: boolean } {
  return {
    ...eg.grant,
    source: eg.source,
    readOnly: eg.readOnly,
  };
}

export function getWhoami(
  state: FactoryState,
  principal: Principal,
  opts?: { forceCanonical?: boolean },
): RouteOutcome {
  if (!state.principals && !state.grants && !principal.onBehalfOf && !opts?.forceCanonical) {
    return {
      status: 200,
      body: {
        actor: principal.actor,
        roles: [...principal.roles],
      },
    };
  }

  if (state.principals && !state.principals.healthy) {
    return { status: 503, body: { error: 'principal_store_unavailable', message: 'principal store is unhealthy' } };
  }
  if (state.grants && !state.grants.healthy) {
    return { status: 503, body: { error: 'grant_store_unavailable', message: 'grant store is unhealthy' } };
  }

  const targetActor = principal.onBehalfOf ?? principal.actor;
  const grantRes = effectiveGrantsForActor(state, targetActor);
  if (!grantRes.ok) {
    return { status: 503, body: { error: grantRes.error } };
  }

  let canonicalPrincipal = targetActor;
  try {
    canonicalPrincipal = normalizeActorToPrincipal(targetActor, state.principals);
  } catch {
    canonicalPrincipal = targetActor;
  }

  const extractedEmail = extractVerifiedEmailFromActor(targetActor);
  const record: PrincipalRecord | undefined =
    state.principals?.get(canonicalPrincipal) ??
    (extractedEmail ? state.principals?.findByEmail(extractedEmail.email) : undefined);

  if (record) {
    canonicalPrincipal = record.id;
  }

  const emails = record
    ? [...record.emails]
    : extractedEmail
      ? [extractedEmail.email]
      : [];

  const effectiveGrants = grantRes.grants ?? [];
  const evalRoles = principal.onBehalfOf
    ? rolesForSubjectActor(state, canonicalPrincipal, grantRes.grants)
    : rolesForSubjectActor(state, canonicalPrincipal, grantRes.grants, principal.roles);
  const evalPrincipal: Principal = { actor: canonicalPrincipal, roles: evalRoles };

  const ownsAny = checkOwnsAnyAgent(state, canonicalPrincipal);
  const userGroupRoles = state.groups
    ? state.groups.listUserGroups(canonicalPrincipal).flatMap((g) => g.roles)
    : undefined;

  const fleetPrivileges: Privilege[] = [];
  for (const priv of PRIVILEGES) {
    if (
      authorize({
        principal: evalPrincipal,
        privilege: priv,
        resource: {
          ownsAnyAgent: ownsAny,
          groupRoles: userGroupRoles,
          ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
        },
      }).allowed
    ) {
      fleetPrivileges.push(priv);
    }
  }
  fleetPrivileges.sort();

  const agentPrivileges: Record<string, Privilege[]> = {};
  const candidateAgentIds = new Set<string>();
  for (const [id, agent] of state.agents.entries()) {
    if (!agent.ephemeral) candidateAgentIds.add(id);
  }
  for (const eg of effectiveGrants) {
    if (eg.grant.scope.kind === 'agent') candidateAgentIds.add(eg.grant.scope.id);
  }
  for (const agentId of [...candidateAgentIds].sort()) {
    const allowedOnAgent: Privilege[] = [];
    const agentKind = agentKindOf(state, agentId);
    const owners = normalizedOwnersForAgent(state, agentId);
    for (const priv of AGENT_SCOPED) {
      if (
        authorize({
          principal: evalPrincipal,
          privilege: priv,
          resource: {
            agentId,
            agentKind,
            owners,
            ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
          },
        }).allowed
      ) {
        allowedOnAgent.push(priv);
      }
    }
    if (allowedOnAgent.length > 0) {
      agentPrivileges[agentId] = allowedOnAgent.sort();
    }
  }

  const skillPrivileges: Record<string, Privilege[]> = {};
  const candidateSkillIds = new Set<string>();
  const sReg = skillRegistry(state);
  for (const id of sReg.ids()) candidateSkillIds.add(id);
  for (const eg of effectiveGrants) {
    if (eg.grant.scope.kind === 'skill') candidateSkillIds.add(eg.grant.scope.id);
  }
  for (const skillId of [...candidateSkillIds].sort()) {
    const allowedOnSkill: Privilege[] = [];
    const skillRec = sReg.versions(skillId).at(-1);
    const skillOwner = resolveSkillContentOwner(state, skillId, skillRec);
    const skillGroupRoles =
      skillRec?.groupId && state.groups
        ? state.groups.getGroup(skillRec.groupId)?.members.some((m) => {
            try {
              return normalizeActorToPrincipal(m, state.principals) === canonicalPrincipal;
            } catch {
              return m.toLowerCase() === canonicalPrincipal.toLowerCase();
            }
          })
          ? state.groups.getGroup(skillRec.groupId)?.roles
          : []
        : undefined;
    for (const priv of SKILL_SCOPED) {
      if (
        authorize({
          principal: evalPrincipal,
          privilege: priv,
          resource: {
            skillId,
            ...(skillOwner ? { skillOwner } : {}),
            ...(skillGroupRoles ? { groupRoles: skillGroupRoles } : {}),
            ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
          },
        }).allowed
      ) {
        allowedOnSkill.push(priv);
      }
    }
    if (allowedOnSkill.length > 0) {
      skillPrivileges[skillId] = allowedOnSkill.sort();
    }
  }

  return {
    status: 200,
    body: {
      actor: principal.actor,
      principal: canonicalPrincipal,
      ...(record ? { displayName: record.displayName, materialized: true } : { materialized: false }),
      emails,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      roles: evalRoles,
      grants: effectiveGrants.map(serializeEffectiveGrant),
      privileges: {
        fleet: fleetPrivileges,
        agents: agentPrivileges,
        skills: skillPrivileges,
      },
    },
  };
}

/**
 * R5, R7: Side-effect-free authorization preflight (`GET /api/v1/authz/check` and MCP `authz_check`).
 * Performs zero writes to `PrincipalStore`, `GrantStore`, or `LedgerStore` (no `AUTHZ_DENIED` noise).
 */
export function checkAuthz(
  state: FactoryState,
  principal: Principal,
  query: { privilege?: unknown; agentId?: unknown; skillId?: unknown },
): RouteOutcome {
  if (state.principals && !state.principals.healthy) {
    return { status: 503, body: { error: 'principal_store_unavailable', message: 'principal store is unhealthy' } };
  }
  if (state.grants && !state.grants.healthy) {
    return { status: 503, body: { error: 'grant_store_unavailable', message: 'grant store is unhealthy' } };
  }

  const rawPrivilege = typeof query.privilege === 'string' ? query.privilege.trim() : '';
  if (!rawPrivilege || !PRIVILEGE_SET.has(rawPrivilege)) {
    return {
      status: 400,
      body: {
        error: 'invalid_privilege',
        message: rawPrivilege ? `unknown privilege '${rawPrivilege}'` : 'privilege query parameter is required',
      },
    };
  }
  const targetPrivilege = rawPrivilege as Privilege;
  const agentId = typeof query.agentId === 'string' && query.agentId.trim() ? query.agentId.trim() : undefined;
  const skillId = typeof query.skillId === 'string' && query.skillId.trim() ? query.skillId.trim() : undefined;

  const targetActor = principal.onBehalfOf ?? principal.actor;
  const grantRes = effectiveGrantsForActor(state, targetActor);
  if (!grantRes.ok) {
    return { status: 503, body: { error: grantRes.error } };
  }

  let canonicalActor = targetActor;
  try {
    canonicalActor = normalizeActorToPrincipal(targetActor, state.principals);
  } catch {
    canonicalActor = targetActor;
  }

  const evalRoles = principal.onBehalfOf
    ? rolesForSubjectActor(state, canonicalActor, grantRes.grants)
    : rolesForSubjectActor(state, canonicalActor, grantRes.grants, principal.roles);
  const evalPrincipal: Principal = { actor: canonicalActor, roles: evalRoles };

  const sReg = skillRegistry(state);
  const skillVersions = skillId ? sReg.versions(skillId) : [];
  const skillRec = skillVersions.at(-1);
  const skillOwner = skillId ? resolveSkillContentOwner(state, skillId, skillRec) : undefined;
  const ownsAny = targetPrivilege === 'skills.register' || targetPrivilege === 'mcp.use'
    ? checkOwnsAnyAgent(state, canonicalActor)
    : false;
  const userGroupRoles = state.groups
    ? state.groups.listUserGroups(canonicalActor).flatMap((g) => g.roles)
    : undefined;

  const resource: AuthorizeResource = {
    ...(agentId
      ? {
          agentId,
          agentKind: agentKindOf(state, agentId),
          owners: normalizedOwnersForAgent(state, agentId),
        }
      : {}),
    ...(skillId ? { skillId } : {}),
    ...(skillOwner ? { skillOwner } : {}),
    groupRoles: userGroupRoles,
    ownsAnyAgent: ownsAny,
    ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
  };

  const decision = authorize({
    principal: evalPrincipal,
    privilege: targetPrivilege,
    resource,
  });

  if (!decision.allowed) {
    const requiredRole = requiredRoleForPrivilege(targetPrivilege, resource, decision.required);
    return {
      status: 200,
      body: {
        allowed: false,
        requiredRole,
        reason: `requires ${requiredRole}`,
      },
    };
  }

  if (
    (targetPrivilege === 'skills.adopt.request' || targetPrivilege === 'skills.decide.private') &&
    skillId &&
    skillRec &&
    agentId
  ) {
    const isAdmin = authorize({
      principal: evalPrincipal,
      privilege: 'grants.manage',
      ...(grantRes.grants !== undefined ? { resource: { grants: grantRes.grants } } : {}),
    }).allowed;
    const legacyOwner = ownerOf(skillRec);
    const resolvedOwner = skillOwner ?? (skillRec.owner ?? skillRec.registeredBy);
    const visible = skillVisibleTo(
      {
        visibility: visibilityOf(skillRec),
        ...(legacyOwner ? { owner: legacyOwner } : {}),
        ...(resolvedOwner ? { userOwner: resolvedOwner } : {}),
      },
      {
        admin: isAdmin,
        ownedAgents: [agentId],
        actor: canonicalActor,
      },
    );
    if (!visible) {
      const targetKind = agentKindOf(state, agentId);
      const requiredRole = targetKind === 'team' ? 'accountable-lead' : 'content-owner';
      return {
        status: 200,
        body: {
          allowed: false,
          requiredRole,
          reason: 'private skill may only be assigned to agents controlled by its content-owner',
        },
      };
    }
    const adoptVerdict = canAdopt(sReg, agentId, skillId, skillRec.version, adoptContextForAgent(state, agentId));
    if (!adoptVerdict.ok && adoptVerdict.error === 'skill_private') {
      const targetKind = agentKindOf(state, agentId);
      const requiredRole = targetKind === 'team' ? 'accountable-lead' : 'content-owner';
      return {
        status: 200,
        body: {
          allowed: false,
          requiredRole,
          reason: adoptVerdict.message,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      allowed: true,
      requiredRole: null,
    },
  };
}

function assertPrincipalStoreReady(state: FactoryState): RouteOutcome | null {
  if (!state.principals || !state.principals.healthy) {
    return {
      status: 503,
      body: { error: 'principal_store_unavailable', message: 'principal store is unavailable' },
    };
  }
  if (state.grants && !state.grants.healthy) {
    return {
      status: 503,
      body: { error: 'grant_store_unavailable', message: 'grant store is unavailable' },
    };
  }
  return null;
}

function assertGrantStoreReady(state: FactoryState): RouteOutcome | null {
  if (!state.grants || !state.grants.healthy) {
    return {
      status: 503,
      body: { error: 'grant_store_unavailable', message: 'grant store is unavailable' },
    };
  }
  if (state.principals && !state.principals.healthy) {
    return {
      status: 503,
      body: { error: 'principal_store_unavailable', message: 'principal store is unavailable' },
    };
  }
  return null;
}

export function listPrincipals(state: FactoryState): RouteOutcome {
  const unready = assertPrincipalStoreReady(state);
  if (unready) return unready;
  try {
    return { status: 200, body: { principals: state.principals!.list() } };
  } catch (err) {
    if (err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    throw err;
  }
}

export function getPrincipal(state: FactoryState, rawId: string): RouteOutcome {
  const unready = assertPrincipalStoreReady(state);
  if (unready) return unready;
  const trimmed = rawId.trim().toLowerCase();
  const found =
    state.principals!.get(trimmed) ??
    (!trimmed.includes(':') && trimmed.includes('@') ? state.principals!.findByEmail(trimmed) : undefined);
  if (!found) {
    return { status: 404, body: { error: 'not_found', message: `principal '${rawId}' not found` } };
  }
  return { status: 200, body: { principal: found } };
}

export async function createPrincipal(
  state: FactoryState,
  principal: Principal,
  body: Record<string, unknown>,
): Promise<RouteOutcome> {
  const unready = assertPrincipalStoreReady(state);
  if (unready) return unready;

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName || displayName.length > 256) {
    return { status: 400, body: { error: 'invalid_principal', message: 'displayName must be 1..256 characters' } };
  }

  const rawEmails = Array.isArray(body.emails)
    ? body.emails
    : typeof body.email === 'string'
      ? [body.email]
      : undefined;
  if (!rawEmails || rawEmails.length === 0 || !rawEmails.every((e) => typeof e === 'string')) {
    return { status: 400, body: { error: 'invalid_principal', message: 'emails must be a non-empty array of strings' } };
  }

  let requestedId: string | undefined;
  if (body.id !== undefined && body.id !== null) {
    if (typeof body.id !== 'string' || !isValidUserPrincipalId(body.id.trim().toLowerCase())) {
      return {
        status: 400,
        body: { error: 'invalid_principal', message: 'id must match user:<slug> or user:<email>' },
      };
    }
    requestedId = body.id.trim().toLowerCase();
  }

  try {
    const created = await state.principals!.create({
      ...(requestedId ? { id: requestedId } : {}),
      displayName,
      emails: rawEmails as string[],
      by: principal.actor,
    });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: 'PRINCIPAL_CREATED',
      actor: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      subject: created.id,
      before: null,
      after: created,
    });
    return { status: 201, body: { principal: created } };
  } catch (err) {
    if (err instanceof DuplicatePrincipalEmailError) {
      return {
        status: 409,
        body: {
          error: err.code,
          message: err.message,
          email: err.email,
          existingPrincipalId: err.existingPrincipalId,
        },
      };
    }
    if (err instanceof DuplicatePrincipalIdError) {
      return {
        status: 409,
        body: { error: err.code, message: err.message, principalId: err.principalId },
      };
    }
    if (err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    return {
      status: 400,
      body: { error: 'invalid_principal', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function addPrincipalEmail(
  state: FactoryState,
  principal: Principal,
  rawId: string,
  body: Record<string, unknown>,
): Promise<RouteOutcome> {
  const unready = assertPrincipalStoreReady(state);
  if (unready) return unready;

  const targetId = rawId.trim().toLowerCase();
  const before = state.principals!.get(targetId);
  if (!before) {
    return { status: 404, body: { error: 'not_found', message: `principal '${rawId}' not found` } };
  }
  if (typeof body.email !== 'string' || !body.email.trim()) {
    return { status: 400, body: { error: 'invalid_email', message: 'email is required' } };
  }

  try {
    const after = await state.principals!.addEmail(before.id, body.email, principal.actor);
    if (after.version !== before.version) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: 'control-plane',
        type: 'action',
        action: 'PRINCIPAL_EMAIL_ADDED',
        actor: principal.actor,
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
        subject: after.id,
        before,
        after,
      });
    }
    return { status: 200, body: { principal: after } };
  } catch (err) {
    if (err instanceof DuplicatePrincipalEmailError) {
      return {
        status: 409,
        body: {
          error: err.code,
          message: err.message,
          email: err.email,
          existingPrincipalId: err.existingPrincipalId,
        },
      };
    }
    if (err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    return {
      status: 400,
      body: { error: 'invalid_email', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function removePrincipalEmail(
  state: FactoryState,
  principal: Principal,
  rawId: string,
  rawEmail: string,
): Promise<RouteOutcome> {
  const unready = assertPrincipalStoreReady(state);
  if (unready) return unready;

  const targetId = rawId.trim().toLowerCase();
  const before = state.principals!.get(targetId);
  if (!before) {
    return { status: 404, body: { error: 'not_found', message: `principal '${rawId}' not found` } };
  }

  let normEmail: string;
  try {
    normEmail = normalizeEmail(rawEmail);
  } catch (err) {
    return {
      status: 400,
      body: { error: 'invalid_email', message: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!before.emails.includes(normEmail)) {
    return {
      status: 404,
      body: { error: 'email_not_found', message: `email '${normEmail}' is not mapped to '${before.id}'` },
    };
  }
  if (before.emails.length <= 1) {
    return {
      status: 409,
      body: {
        error: 'last_principal_email',
        message: `cannot remove the last email from principal '${before.id}'`,
      },
    };
  }

  try {
    const after = await state.principals!.removeEmail(before.id, normEmail, principal.actor);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: 'PRINCIPAL_EMAIL_REMOVED',
      actor: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      subject: after.id,
      before,
      after,
    });
    return { status: 200, body: { principal: after } };
  } catch (err) {
    if (err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    return {
      status: 400,
      body: { error: 'invalid_email', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function parseGrantScopeInput(raw: unknown): GrantScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'fleet') return { kind: 'fleet' };
  if ((obj.kind === 'agent' || obj.kind === 'skill') && typeof obj.id === 'string' && obj.id.trim()) {
    return { kind: obj.kind, id: obj.id.trim().toLowerCase() };
  }
  return null;
}

export function callerMayUseScopedGrantTools(
  state: FactoryState,
  principal: Principal,
  grants?: EffectiveGrant[],
): boolean {
  if (
    authorize({
      principal,
      privilege: 'grants.manage',
      ...(grants !== undefined ? { resource: { grants } } : {}),
    }).allowed
  ) {
    return true;
  }
  if (checkOwnsAnyAgent(state, principal.actor)) return true;
  if (
    grants?.some(
      (eg) =>
        !eg.readOnly &&
        ((eg.grant.scope.kind === 'agent' &&
          (eg.grant.role === 'content-owner' || eg.grant.role === 'accountable-lead')) ||
          (eg.grant.scope.kind === 'skill' && eg.grant.role === 'content-owner')),
    )
  ) {
    return true;
  }
  return false;
}

export function listGrants(
  state: FactoryState,
  principal: Principal,
  filter: {
    subject?: unknown;
    scopeKind?: unknown;
    scopeId?: unknown;
    includeExpired?: unknown;
  },
): RouteOutcome {
  const grantRes = effectiveGrantsForActor(state, principal.actor);
  if (!grantRes.ok) {
    return { status: 503, body: { error: grantRes.error } };
  }

  const isAdmin = authorize({
    principal,
    privilege: 'grants.manage',
    ...(grantRes.grants !== undefined ? { resource: { grants: grantRes.grants } } : {}),
  }).allowed;

  const scopeKind =
    filter.scopeKind === 'fleet' || filter.scopeKind === 'agent' || filter.scopeKind === 'skill'
      ? filter.scopeKind
      : undefined;
  if (filter.scopeKind !== undefined && filter.scopeKind !== '' && !scopeKind) {
    return { status: 400, body: { error: 'invalid_scope', message: 'scopeKind must be fleet, agent, or skill' } };
  }
  const scopeId = typeof filter.scopeId === 'string' && filter.scopeId.trim() ? filter.scopeId.trim().toLowerCase() : undefined;

  if (!isAdmin) {
    if (scopeKind === 'agent' && scopeId) {
      const resource: AuthorizeResource = {
        agentId: scopeId,
        agentKind: agentKindOf(state, scopeId),
        owners: normalizedOwnersForAgent(state, scopeId),
        ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'agents.roles.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('agents.roles.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
    } else if (scopeKind === 'skill' && scopeId) {
      const skillRec = skillRegistry(state).versions(scopeId).at(-1);
      const skillOwner = resolveSkillContentOwner(state, scopeId, skillRec);
      const resource: AuthorizeResource = {
        skillId: scopeId,
        ...(skillOwner ? { skillOwner } : {}),
        ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'skills.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('skills.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
    } else {
      return {
        status: 403,
        body: { error: 'forbidden', required: 'admin', requiredRole: 'admin' },
      };
    }
  }

  const unready = assertGrantStoreReady(state);
  if (unready) return unready;

  try {
    const subject = typeof filter.subject === 'string' && filter.subject.trim() ? filter.subject.trim() : undefined;
    const includeExpired = filter.includeExpired === true || filter.includeExpired === 'true';
    const grants = state.grants!.list({
      ...(subject ? { subject } : {}),
      ...(scopeKind ? { scopeKind } : {}),
      ...(scopeId ? { scopeId } : {}),
      includeExpired,
    });
    return { status: 200, body: { grants } };
  } catch (err) {
    if (err instanceof GrantStoreError) {
      return { status: err.status, body: { error: err.code, message: err.message } };
    }
    if (err instanceof GrantStoreUnavailableError || err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    throw err;
  }
}

export async function grantRole(
  state: FactoryState,
  principal: Principal,
  body: Record<string, unknown>,
): Promise<RouteOutcome> {
  const callerGrantRes = effectiveGrantsForActor(state, principal.actor);
  if (!callerGrantRes.ok) {
    return { status: 503, body: { error: callerGrantRes.error } };
  }

  const isAdmin = authorize({
    principal,
    privilege: 'grants.manage',
    ...(callerGrantRes.grants !== undefined ? { resource: { grants: callerGrantRes.grants } } : {}),
  }).allowed;

  const parsedScope = parseGrantScopeInput(body.scope);
  if (!parsedScope) {
    if (!isAdmin) {
      return { status: 403, body: { error: 'forbidden', required: 'admin', requiredRole: 'admin' } };
    }
    return {
      status: 400,
      body: { error: 'invalid_scope', message: 'scope must be { kind: "fleet" } or { kind: "agent" | "skill", id }' },
    };
  }

  let granterRole: 'admin' | 'content-owner' | 'accountable-lead' = 'admin';
  let targetAgentKind: 'personal' | 'team' | undefined;

  if (!isAdmin) {
    // Fleet grants, domain grants, and service grants are strictly admin-only in v1 (D10, D13, S3).
    if (parsedScope.kind === 'fleet') {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'fleet grants require admin authority',
        },
      };
    }

    const rawSubject = typeof body.subject === 'string' ? body.subject.trim().toLowerCase() : '';
    if (rawSubject.startsWith('domain:') || rawSubject.startsWith('service:')) {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'domain and service grants require admin authority',
        },
      };
    }

    if (parsedScope.kind === 'agent') {
      const agent = findAgentRecord(state, parsedScope.id);
      const kind = agent ? effectiveAgentKind(agent) : agentKindOf(state, parsedScope.id);
      const resource: AuthorizeResource = {
        agentId: parsedScope.id,
        agentKind: kind,
        owners: normalizedOwnersForAgent(state, parsedScope.id),
        ...(callerGrantRes.grants !== undefined ? { grants: callerGrantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'agents.roles.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('agents.roles.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
      targetAgentKind = kind ?? 'personal';
      granterRole = targetAgentKind === 'team' ? 'accountable-lead' : 'content-owner';
    } else {
      const skillRec = skillRegistry(state).versions(parsedScope.id).at(-1);
      const skillOwner = resolveSkillContentOwner(state, parsedScope.id, skillRec);
      const resource: AuthorizeResource = {
        skillId: parsedScope.id,
        ...(skillOwner ? { skillOwner } : {}),
        ...(callerGrantRes.grants !== undefined ? { grants: callerGrantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'skills.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('skills.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
      // H5/D24: Only direct active skill content-owner (not group member) may delegate grants in GrantStore.
      if (
        state.grants &&
        !callerGrantRes.grants?.some(
          (eg) =>
            eg.source === 'direct' &&
            !eg.readOnly &&
            eg.grant.scope.kind === 'skill' &&
            eg.grant.scope.id.toLowerCase() === parsedScope.id &&
            eg.grant.role === 'content-owner',
        )
      ) {
        return {
          status: 403,
          body: { error: 'forbidden', required: 'admin', requiredRole: 'content-owner' },
        };
      }
      granterRole = 'content-owner';
    }
  }

  const unready = assertGrantStoreReady(state);
  if (unready) return unready;

  if (parsedScope.kind === 'agent') {
    const agent = findAgentRecord(state, parsedScope.id);
    if (!agent) {
      return { status: 404, body: { error: 'agent_not_found', message: `agent '${parsedScope.id}' not found` } };
    }
    targetAgentKind = effectiveAgentKind(agent);
  } else if (parsedScope.kind === 'skill') {
    const skillVersions = skillRegistry(state).versions(parsedScope.id);
    if (skillVersions.length === 0) {
      return { status: 404, body: { error: 'skill_not_found', message: `skill '${parsedScope.id}' not found` } };
    }
  }

  if (typeof body.subject !== 'string' || !body.subject.trim()) {
    return { status: 400, body: { error: 'invalid_subject', message: 'subject is required' } };
  }
  if (typeof body.role !== 'string' || !body.role.trim()) {
    return { status: 400, body: { error: 'invalid_role', message: 'role is required' } };
  }
  if (body.state !== undefined && body.state !== 'active') {
    return {
      status: 400,
      body: { error: 'invalid_grant', message: 'pending transfer states require the dedicated transfer endpoint' },
    };
  }

  const principalsBefore = state.principals ? new Set(state.principals.list().map((p) => p.id)) : undefined;
  const grantsBefore = new Map(state.grants!.list({ includeExpired: true }).map((g) => [g.id, g]));

  try {
    const created = await state.grants!.grant({
      ...(typeof body.id === 'string' && body.id.trim() ? { id: body.id.trim() } : {}),
      subject: body.subject.trim(),
      ...(typeof body.subjectDisplayName === 'string' ? { subjectDisplayName: body.subjectDisplayName } : {}),
      scope: parsedScope,
      role: body.role.trim(),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt as string | null } : {}),
      by: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      granterIsAdmin: isAdmin,
      granterRole,
      ...(targetAgentKind ? { agentKind: targetAgentKind } : {}),
      ...(isAdmin && body.replaceExisting === true ? { replaceExisting: true } : {}),
      principals: state.principals,
      ...(state.groups ? { knownGroups: (gid: string) => Boolean(state.groups?.getGroup(gid)) } : {}),
    });

    // If an admin pre-grant auto-provisioned an unseen email in PrincipalStore, ledger PRINCIPAL_CREATED first (R5, D32).
    if (state.principals && principalsBefore && created.subject.startsWith('user:') && !principalsBefore.has(created.subject)) {
      const autoCreated = state.principals.get(created.subject);
      if (autoCreated) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'control-plane',
          type: 'action',
          action: 'PRINCIPAL_CREATED',
          actor: principal.actor,
          ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
          subject: autoCreated.id,
          before: null,
          after: autoCreated,
        });
      }
    }

    // Ledger any replaced grants when replaceExisting === true.
    const grantsAfterIds = new Set(state.grants!.list({ includeExpired: true }).map((g) => g.id));
    for (const [oldId, oldGrant] of grantsBefore.entries()) {
      if (!grantsAfterIds.has(oldId)) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: parsedScope.kind === 'agent' ? parsedScope.id : 'control-plane',
          type: 'action',
          action: 'GRANT_REVOKED',
          actor: principal.actor,
          ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
          subject: oldGrant.subject,
          scope: oldGrant.scope,
          before: oldGrant,
          after: null,
        });
      }
    }

    const previousSameId = grantsBefore.get(created.id);
    if (!previousSameId || previousSameId.version !== created.version) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: parsedScope.kind === 'agent' ? parsedScope.id : 'control-plane',
        type: 'action',
        action: 'GRANT_CREATED',
        actor: principal.actor,
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
        subject: created.subject,
        scope: created.scope,
        before: previousSameId ?? null,
        after: created,
      });
    }

    return { status: previousSameId ? 200 : 201, body: { grant: created } };
  } catch (err) {
    if (err instanceof GrantStoreError) {
      if (err.status === 403) {
        return {
          status: 403,
          body: {
            error: err.code === 'unknown_subject' ? 'unknown_subject' : 'forbidden',
            message: err.message,
            required: 'admin',
            requiredRole: 'admin',
          },
        };
      }
      return { status: err.status, body: { error: err.code, message: err.message } };
    }
    if (err instanceof GrantStoreUnavailableError || err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    throw err;
  }
}

export async function revokeGrant(
  state: FactoryState,
  principal: Principal,
  rawGrantId: string,
): Promise<RouteOutcome> {
  const callerGrantRes = effectiveGrantsForActor(state, principal.actor);
  if (!callerGrantRes.ok) {
    return { status: 503, body: { error: callerGrantRes.error } };
  }

  const isAdmin = authorize({
    principal,
    privilege: 'grants.manage',
    ...(callerGrantRes.grants !== undefined ? { resource: { grants: callerGrantRes.grants } } : {}),
  }).allowed;

  // Callers with zero admin OR scoped grant-delegation authority are refused 403 before probing grant IDs.
  if (!isAdmin && !callerMayUseScopedGrantTools(state, principal, callerGrantRes.grants)) {
    return {
      status: 403,
      body: { error: 'forbidden', required: 'admin', requiredRole: 'admin' },
    };
  }

  const unready = assertGrantStoreReady(state);
  if (unready) return unready;

  const grantId = rawGrantId.trim();
  const existing = state.grants!.get(grantId);
  if (!existing) {
    if (!isAdmin) {
      return {
        status: 403,
        body: { error: 'forbidden', required: 'admin', requiredRole: 'admin' },
      };
    }
    return { status: 404, body: { error: 'grant_not_found', message: `grant '${grantId}' not found` } };
  }

  if (!isAdmin) {
    if (existing.scope.kind === 'fleet') {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'fleet grants may only be revoked by an admin',
        },
      };
    }

    if (existing.role === 'content-owner' || existing.role === 'accountable-lead') {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: `revoking '${existing.role}' requires admin authority or dedicated transfer`,
        },
      };
    }

    if (existing.scope.kind === 'agent') {
      const kind = agentKindOf(state, existing.scope.id);
      const resource: AuthorizeResource = {
        agentId: existing.scope.id,
        agentKind: kind,
        owners: normalizedOwnersForAgent(state, existing.scope.id),
        ...(callerGrantRes.grants !== undefined ? { grants: callerGrantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'agents.roles.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('agents.roles.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
      if (kind === 'team' && existing.role !== 'member') {
        return {
          status: 403,
          body: {
            error: 'forbidden',
            required: 'admin',
            requiredRole: 'admin',
            message: `accountable-lead may only revoke 'member' grants on their team agent`,
          },
        };
      }
    } else if (existing.scope.kind === 'skill') {
      const skillRec = skillRegistry(state).versions(existing.scope.id).at(-1);
      const skillOwner = resolveSkillContentOwner(state, existing.scope.id, skillRec);
      const resource: AuthorizeResource = {
        skillId: existing.scope.id,
        ...(skillOwner ? { skillOwner } : {}),
        ...(callerGrantRes.grants !== undefined ? { grants: callerGrantRes.grants } : {}),
      };
      const decision = authorize({ principal, privilege: 'skills.assign', resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege('skills.assign', resource, decision.required);
        return {
          status: 403,
          body: { error: 'forbidden', required: decision.required, requiredRole },
        };
      }
    }
  }

  try {
    const revoked = await state.grants!.revoke(grantId, {
      by: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: revoked.scope.kind === 'agent' ? revoked.scope.id : 'control-plane',
      type: 'action',
      action: 'GRANT_REVOKED',
      actor: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      subject: revoked.subject,
      scope: revoked.scope,
      before: revoked,
      after: null,
    });
    return { status: 200, body: { ok: true, grant: revoked } };
  } catch (err) {
    if (err instanceof GrantStoreError) {
      return { status: err.status, body: { error: err.code, message: err.message } };
    }
    if (err instanceof GrantStoreUnavailableError || err instanceof PrincipalStoreUnavailableError) {
      return { status: 503, body: { error: err.code, message: err.message } };
    }
    throw err;
  }
}

export async function handleGrantsRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (path === '/api/v1/whoami' && req.method === 'GET') {
    const who = await identify(req, state);
    if (!who.ok) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    const out = getWhoami(state, who.principal);
    json(res, out.status, out.body);
    return true;
  }

  if (path === '/api/v1/authz/check' && req.method === 'GET') {
    const who = await identify(req, state, { allowMaterialize: false });
    if (!who.ok) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const out = checkAuthz(state, who.principal, {
      privilege: url.searchParams.get('privilege') ?? undefined,
      agentId: url.searchParams.get('agentId') ?? undefined,
      skillId: url.searchParams.get('skillId') ?? undefined,
    });
    json(res, out.status, out.body);
    return true;
  }

  if (path === '/api/v1/principals') {
    if (req.method === 'GET') {
      if (!(await requirePrivilege(req, res, state, 'grants.manage'))) return true;
      const out = listPrincipals(state);
      json(res, out.status, out.body);
      return true;
    }
    if (req.method === 'POST') {
      const principal = await requirePrivilege(req, res, state, 'grants.manage');
      if (!principal) return true;
      const out = await createPrincipal(state, principal, await readJson(req));
      json(res, out.status, out.body);
      return true;
    }
  }

  const principalMatch = path.match(PRINCIPAL_ONE);
  if (principalMatch && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'grants.manage'))) return true;
    const out = getPrincipal(state, decodeURIComponent(principalMatch[1]));
    json(res, out.status, out.body);
    return true;
  }

  const principalEmailsMatch = path.match(PRINCIPAL_EMAILS);
  if (principalEmailsMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'grants.manage');
    if (!principal) return true;
    const out = await addPrincipalEmail(
      state,
      principal,
      decodeURIComponent(principalEmailsMatch[1]),
      await readJson(req),
    );
    json(res, out.status, out.body);
    return true;
  }

  const principalEmailOneMatch = path.match(PRINCIPAL_EMAIL_ONE);
  if (principalEmailOneMatch && req.method === 'DELETE') {
    const principal = await requirePrivilege(req, res, state, 'grants.manage');
    if (!principal) return true;
    const out = await removePrincipalEmail(
      state,
      principal,
      decodeURIComponent(principalEmailOneMatch[1]),
      decodeURIComponent(principalEmailOneMatch[2]),
    );
    json(res, out.status, out.body);
    return true;
  }

  if (path === '/api/v1/grants') {
    if (req.method === 'GET') {
      const who = await identify(req, state);
      if (!who.ok) {
        json(res, 401, { error: 'unauthorized' });
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://factory.local');
      const out = listGrants(state, who.principal, {
        subject: url.searchParams.get('subject') ?? undefined,
        scopeKind: url.searchParams.get('scopeKind') ?? undefined,
        scopeId: url.searchParams.get('scopeId') ?? undefined,
        includeExpired: url.searchParams.get('includeExpired') ?? undefined,
      });
      json(res, out.status, out.body);
      return true;
    }
    if (req.method === 'POST') {
      const who = await identify(req, state);
      if (!who.ok) {
        json(res, 401, { error: 'unauthorized' });
        return true;
      }
      const out = await grantRole(state, who.principal, await readJson(req));
      json(res, out.status, out.body);
      return true;
    }
  }

  const grantOneMatch = path.match(GRANT_ONE);
  if (grantOneMatch && req.method === 'DELETE') {
    const who = await identify(req, state);
    if (!who.ok) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    const out = await revokeGrant(state, who.principal, decodeURIComponent(grantOneMatch[1]));
    json(res, out.status, out.body);
    return true;
  }

  return false;
}
