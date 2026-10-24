// E12 item 4 (TSK-174): what a run's requesting person may reach through the agent's skills' routes. The gatekeeper-egress
// asks the control plane for the answer with the rest of the run (`GET /api/v1/gatekeeper-egress/runs/:id`) and refuses a
// call the person's roles do not allow, before any credential is injected. The agent is never asked and cannot change it.
import { effectiveAccess, type RouteAccess } from '@beercanlabs/factory-contract';
import type { Run } from '@beercanlabs/factory-property-manager';
import type { AgentRecord } from '@beercanlabs/factory-registrar';
import type { FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { requesterOfRun } from './schedules.js';

/**
 * `restricted: false`: the rule does not apply to this run. `restricted: true`: each route some skill declares is
 * `allowed` or `denied` for the person; a route in no skill's list is not restricted by roles (policy still applies).
 */
export type RunAccess = { restricted: false } | { restricted: true; routes: Record<string, RouteAccess> };

const NOT_RESTRICTED: RunAccess = { restricted: false };

function adminEmails(): string[] {
  return (process.env.FACTORY_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
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
  return accessForRequester(state, agent, requesterOfRun(state, run), run.trigger === 'schedule');
}

/**
 * The same rule for a requester the caller already holds (a message about to be handed to an agent's live run).
 * `scheduled`: the requester could not be read from a scheduled run, which is unknown, not "no person".
 */
export function accessForRequester(state: FactoryState, agent: AgentRecord, requester: ReturnType<typeof requesterOfRun>, scheduled = false): RunAccess {
  const agentId = agent.id;
  // E12 item 5: no requesting person (a cartridge cron, a system caller) is not restricted. A scheduled run whose
  // requester cannot be read (the schedule is gone or malformed) is not "no person": it is unknown, and fails closed.
  if (!requester) return scheduled ? restrictedTo(agent, []) : NOT_RESTRICTED;
  if (requester.kind === 'system') return NOT_RESTRICTED;
  // A console or API caller is an authenticated principal holding a factory role: the Bouncer admitted it as such.
  if (requester.kind === 'principal') return NOT_RESTRICTED;

  const link = state.identityLinks?.resolveLink(requester.provider, requester.id);
  if (!link) return restrictedTo(agent, []);

  const actor = link.actor.toLowerCase();
  const owners = ownersOf(state, agentId).map((o) => o.toLowerCase());
  if (owners.includes(actor)) return NOT_RESTRICTED;
  const roles = link.roles ?? [];
  const email = actor.startsWith('cloudflare:') ? actor.slice('cloudflare:'.length).trim() : '';
  const isAdmin = roles.includes('admin') || (email !== '' && adminEmails().includes(email));
  // Admins are not restricted (E12 item 4). A factory operator is admitted to every agent (E12 item 3) and is likewise
  // not narrowed to a role: to limit a person to an agent role, they hold no operator role.
  if (isAdmin || roles.includes('operator')) return NOT_RESTRICTED;

  const held = Object.prototype.hasOwnProperty.call(link.agentRoles ?? {}, agentId) ? (link.agentRoles![agentId] ?? []) : [];
  return restrictedTo(agent, held);
}

function restrictedTo(agent: AgentRecord, held: readonly string[]): RunAccess {
  const roles = (agent.roles ?? []).filter((r) => r.name.toLowerCase() !== 'owner');
  const e = effectiveAccess(roles, held, skillIdsOf(agent), agent.skillRoutes ?? {});
  return { restricted: true, routes: e.routes };
}

/** True when the person has at least one skill route denied: only then can their message leak authority into another's run. */
export function hasDeniedRoute(access: RunAccess): boolean {
  return access.restricted && Object.values(access.routes).some((v) => v !== 'allowed');
}
