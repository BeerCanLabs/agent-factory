// E12 item 4 (TSK-174): what a run's requesting person may reach through the agent's skills' routes. The gatekeeper-egress
// asks the control plane for the answer with the rest of the run (`GET /api/v1/gatekeeper-egress/runs/:id`) and refuses a
// call the person's roles do not allow, before any credential is injected. The agent is never asked and cannot change it.
import { effectiveAccess, type RouteAccess } from '@beercanlabs/factory-contract';
import type { Run } from '@beercanlabs/factory-property-manager';
import { effectiveAgentKind, type AgentRecord } from '@beercanlabs/factory-registrar';
import { agentKindOf, effectiveGrantsForActor, type FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { requesterOfRun } from './schedules.js';
import { agentInForce } from './agent-settings.js';
import { legacyAdminEmails } from './legacy-env-roles.js';

/**
 * `restricted: false`: the rule does not apply to this run. `restricted: true`: each route some skill declares is
 * `allowed` or `denied` for the person; a route in no skill's list is not restricted by roles (policy still applies).
 */
export type RunAccess = { restricted: false } | { restricted: true; routes: Record<string, RouteAccess> };

const NOT_RESTRICTED: RunAccess = { restricted: false };

function adminEmails(): string[] {
  return legacyAdminEmails();
}

/** Every skill the record can name: the declared ids, the skills that have routes, and the skills a role mentions. */
function skillIdsOf(agent: Pick<AgentRecord, 'skillIds' | 'skillRoutes' | 'roles'>): string[] {
  const ids = new Set(agent.skillIds ?? []);
  for (const s of Object.keys(agent.skillRoutes ?? {})) ids.add(s);
  for (const r of agent.roles ?? []) for (const s of Object.keys(r.skills ?? {})) if (s !== '*') ids.add(s);
  return [...ids];
}

/** Everything that fails here fails closed: a person the factory cannot place is restricted to nothing. */
export function accessForRun(state: FactoryState, run: Run, agent: AgentRecord): RunAccess {
  return accessForRequester(state, agent, requesterOfRun(state, run), run.trigger === 'schedule', run.caller?.roles);
}

function evaluateGrantStoreAccess(
  state: FactoryState,
  agent: AgentRecord,
  agentId: string,
  actor: string,
  explicitRoles: readonly string[],
  legacyHeldRoles: readonly string[],
): RunAccess {
  const lowerActor = actor.toLowerCase();
  const email = lowerActor.startsWith('cloudflare:') ? lowerActor.slice('cloudflare:'.length).trim() : '';
  const isAdmin =
    explicitRoles.includes('admin') || (explicitRoles.length === 0 && email !== '' && adminEmails().includes(email));

  const grantRes = effectiveGrantsForActor(state, actor);
  if (!grantRes.ok || !grantRes.grants) return restrictedTo(agent, []);

  if (isAdmin || explicitRoles.includes('operator')) return NOT_RESTRICTED;
  for (const eg of grantRes.grants) {
    if (!eg.readOnly && eg.grant.scope.kind === 'fleet' && (eg.grant.role === 'admin' || eg.grant.role === 'operator')) {
      return NOT_RESTRICTED;
    }
  }

  const lowerAgentId = agentId.toLowerCase();
  const agentGrants = grantRes.grants.filter(
    (eg) => !eg.readOnly && eg.grant.scope.kind === 'agent' && eg.grant.scope.id.toLowerCase() === lowerAgentId,
  );
  const kind = agentKindOf(state, agentId) ?? effectiveAgentKind(agent);
  const declaredRoles = agent.roles ?? [];
  const definesMemberRole = declaredRoles.some((r) => r.name === 'member');

  if (kind === 'personal') {
    if (agentGrants.some((eg) => eg.source === 'direct' && eg.grant.role === 'content-owner')) {
      return NOT_RESTRICTED;
    }
  } else if (kind === 'team') {
    if (agentGrants.some((eg) => eg.source === 'direct' && eg.grant.role === 'accountable-lead')) {
      return NOT_RESTRICTED;
    }
    if (!definesMemberRole && agentGrants.some((eg) => eg.grant.role === 'member')) {
      return NOT_RESTRICTED;
    }
  }

  const heldSet = new Set<string>(legacyHeldRoles);
  for (const eg of agentGrants) {
    const r = eg.grant.role;
    if (r === 'content-owner' || r === 'accountable-lead' || r === 'agent-member' || r === 'owner') continue;
    if (kind === 'team' && r === 'member' && !definesMemberRole) continue;
    const normalized = r.toLowerCase().startsWith('subrole:') ? r.slice('subrole:'.length) : r;
    if (normalized) heldSet.add(normalized);
  }
  return restrictedTo(agent, [...heldSet]);
}

/**
 * The same rule for a requester the caller already holds (a message about to be handed to an agent's live run).
 * `scheduled`: the requester could not be read from a scheduled run, which is unknown, not "no person".
 */
export function accessForRequester(
  state: FactoryState,
  agent: AgentRecord,
  requester: ReturnType<typeof requesterOfRun>,
  scheduled = false,
  callerRoles?: readonly string[],
): RunAccess {
  const agentId = agent.id;
  agent = agentInForce(state, agent);
  // E12 item 5: no requesting person (a cartridge cron, a system caller) is not restricted. A scheduled run whose
  // requester cannot be read (the schedule is gone or malformed) is not "no person": it is unknown, and fails closed.
  if (!requester) return scheduled ? restrictedTo(agent, []) : NOT_RESTRICTED;
  if (requester.kind === 'system') return NOT_RESTRICTED;

  if (requester.kind === 'principal') {
    const principalRoles = callerRoles ?? [];
    if (state.grants) {
      return evaluateGrantStoreAccess(state, agent, agentId, requester.actor, principalRoles, []);
    }
    // Legacy non-GrantStore mode: canonical `user:<id>` principals without GrantStore still enforce owner/role ceilings,
    // whereas legacy `token:` / `cloudflare:` / `oidc:` / `test` console/API principals hold factory operator/admin access.
    const lowerActor = requester.actor.toLowerCase();
    if (!lowerActor.startsWith('user:')) {
      return NOT_RESTRICTED;
    }
    const kind = agentKindOf(state, agentId) ?? effectiveAgentKind(agent);
    if (kind !== 'team') {
      const owners = ownersOf(state, agentId).map((o) => o.toLowerCase());
      if (owners.includes(lowerActor)) return NOT_RESTRICTED;
    }
    if (principalRoles.includes('admin') || principalRoles.includes('operator')) return NOT_RESTRICTED;
    return restrictedTo(agent, []);
  }

  const link = state.identityLinks?.resolveLink(requester.provider, requester.id);
  if (!link) return restrictedTo(agent, []);

  const actor = link.actor.toLowerCase();
  const roles = link.roles ?? [];
  const legacyHeld = Object.prototype.hasOwnProperty.call(link.agentRoles ?? {}, agentId)
    ? (link.agentRoles![agentId] ?? [])
    : [];

  if (state.grants) {
    return evaluateGrantStoreAccess(state, agent, agentId, link.actor, roles, legacyHeld);
  }

  const email = actor.startsWith('cloudflare:') ? actor.slice('cloudflare:'.length).trim() : '';
  // As the Bouncer reads a link (`authorizeIngress`): explicit roles replace the email-admin default.
  const isAdmin = roles.includes('admin') || (roles.length === 0 && email !== '' && adminEmails().includes(email));

  const kind = agentKindOf(state, agentId) ?? effectiveAgentKind(agent);
  if (kind !== 'team') {
    const owners = ownersOf(state, agentId).map((o) => o.toLowerCase());
    if (owners.includes(actor)) return NOT_RESTRICTED;
  }
  // Admins are not restricted (E12 item 4). A factory operator is admitted to every agent (E12 item 3) and is likewise
  // not narrowed to a role: to limit a person to an agent role, they hold no operator role.
  if (isAdmin || roles.includes('operator')) return NOT_RESTRICTED;

  return restrictedTo(agent, legacyHeld);
}

function restrictedTo(agent: AgentRecord, held: readonly string[]): RunAccess {
  const roles = (agent.roles ?? []).filter((r) => r.name.toLowerCase() !== 'owner');
  const e = effectiveAccess(roles, held, skillIdsOf(agent), agent.skillRoutes ?? {});
  return { restricted: true, routes: { ...e.routes } };
}

/** True when the person has at least one skill route denied: only then can their message leak authority into another's run. */
export function hasDeniedRoute(access: RunAccess): boolean {
  return access.restricted && Object.values(access.routes).some((v) => v !== 'allowed');
}
