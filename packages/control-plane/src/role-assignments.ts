/**
 * Who holds which of an agent's roles (DESIGN_AUTHORITY.md §6.18 CF2, CF4; E12).
 *
 *   GET    /api/v1/agents/:id/role-assignments                      who holds a role on this agent (admin, or its owner)
 *   PUT    /api/v1/agents/:id/role-assignments/:provider/:identity  `{ roles }`: the roles this person holds on THIS agent
 *                                                                   (admin, or its owner; ledgered). `[]` removes them.
 *   POST   /api/v1/runs/:runId/role-requests                        the agent asks (run token): `{ provider, identity, roles }`
 *
 * An owner assigns an identity an admin has already linked (so a person is known to the factory), to a role the agent's
 * configuration defines (never `Owner`), on that agent only: it changes nothing else about the person and creates no reach
 * beyond what the agent's policy already grants (E12). The agent may only ASK, and only when the run's verified
 * requester is one of its owners; the request is held for approval and the factory applies it when the requester-owner (or an
 * admin) approves. The agent never assigns, approves or sees the decision.
 */
import http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import type { Approval, ChangeRequest } from '@beercanlabs/factory-bouncer';
import { isProvider, type IdentityProvider } from './identity-links.js';
import { effectiveRoles } from './agent-settings.js';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { requesterOfRun } from './schedules.js';
import type { Run } from '@beercanlabs/factory-property-manager';

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ROLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const ROLE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_AGENT = 5;
const MAX_ROLES_PER_REQUEST = 20;

const LIST = /^\/api\/v1\/agents\/([^/]+)\/role-assignments$/;
const ONE = /^\/api\/v1\/agents\/([^/]+)\/role-assignments\/([^/]+)\/([^/]+)$/;

type Checked = { ok: true; roles: string[]; actor: string } | { ok: false; status: number; body: Record<string, unknown> };

/** The roles a person may be given on this agent, checked the same way for a direct change and an approved one. */
function check(state: FactoryState, agentId: string, provider: string, identity: string, rolesIn: unknown): Checked {
  const agent = state.agents.get(agentId);
  if (!agent || agentId.startsWith('__')) return { ok: false, status: 404, body: { error: 'not_found' } };
  if (!isProvider(provider) || !EXTERNAL_ID.test(identity)) return { ok: false, status: 400, body: { error: 'unknown_identity' } };
  const link = state.identityLinks?.resolveLink(provider, identity);
  if (!link) return { ok: false, status: 404, body: { error: 'identity_not_linked', message: 'an admin links a person to the factory first' } };
  if (!Array.isArray(rolesIn) || rolesIn.length > MAX_ROLES_PER_REQUEST || !rolesIn.every((r) => typeof r === 'string' && ROLE_NAME.test(r))) {
    return { ok: false, status: 400, body: { error: 'invalid_roles', message: `roles must be a list of at most ${MAX_ROLES_PER_REQUEST} role names` } };
  }
  const roles = [...new Set(rolesIn as string[])];
  const assignable = effectiveRoles(state, agent).map((r) => r.name).filter((n) => n.toLowerCase() !== 'owner');
  const kept = Object.prototype.hasOwnProperty.call(link.agentRoles ?? {}, agentId) ? (link.agentRoles![agentId] ?? []) : [];
  const refused = roles.filter((r) => !assignable.includes(r) && !kept.includes(r));
  if (refused.length) return { ok: false, status: 400, body: { error: 'unknown_agent_role', roles: refused, assignable } };
  return { ok: true, roles, actor: link.actor };
}

/** Sets the roles this person holds on this agent (and nothing else about them). Returns whether anything changed. */
export function assignRoles(state: FactoryState, agentId: string, provider: string, identity: string, rolesIn: unknown, by: string, via: string): { status: number; body: Record<string, unknown> } {
  const c = check(state, agentId, provider, identity, rolesIn);
  if (!c.ok) return { status: c.status, body: c.body };
  const store = state.identityLinks!;
  const link = store.resolveLink(provider, identity)!;
  const agentRoles: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(link.agentRoles ?? {})) agentRoles[k] = [...v];
  if (c.roles.length) agentRoles[agentId] = c.roles;
  else delete agentRoles[agentId];
  const { changed } = store.link(provider as IdentityProvider, identity, link.actor, link.linkedBy ?? by, {
    ...(link.name ? { name: link.name } : {}),
    ...(link.roles ? { roles: link.roles } : {}),
    agentRoles,
  });
  if (changed) {
    // A hash of the person and roles, never the external id (as the identity-link ledger rows).
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_ROLES_ASSIGNED',
      actor: by,
      requestId: `roles:${agentId}:${via}`,
      payloadSha256: payloadHash({ provider, identity, person: link.actor, roles: c.roles }),
    });
  }
  return { status: 200, body: { agentId, changed, roles: c.roles } };
}

/** CF4: the factory applies an approved role-assignment itself. Re-checked now: the link or the roles may have changed. */
export function applyApprovedChange(state: FactoryState, a: Approval, approvedBy: string): { status: number; body: Record<string, unknown> } {
  const c = a.change;
  if (!c || c.type !== 'role-assignment') return { status: 400, body: { error: 'unknown_change' } };
  return assignRoles(state, a.agentId, c.provider, c.identity, c.roles, approvedBy, `approval:${a.approvalId}`);
}

/** Whether this principal may approve a change to this agent: an admin, or one of its owners (CF4). */
export function mayApproveChange(state: FactoryState, principal: { actor: string; roles?: readonly string[] }, agentId: string): boolean {
  if (principal.roles?.includes('admin')) return true;
  const actor = principal.actor.toLowerCase();
  return ownersOf(state, agentId).some((o) => o.toLowerCase() === actor);
}

/** The run's verified requester, when it is one of the agent's owners; undefined otherwise. */
function ownerRequester(state: FactoryState, run: Run): string | undefined {
  const who = requesterOfRun(state, run);
  if (who?.kind !== 'identity') return undefined;
  const actor = state.identityLinks?.resolve(who.provider, who.id);
  if (!actor) return undefined;
  return ownersOf(state, run.agentId).some((o) => o.toLowerCase() === actor.toLowerCase()) ? actor : undefined;
}

/** The agent asks. Accepted only when the run's verified requester is an owner; held for that owner's approval. */
export async function handleRoleRequest(state: FactoryState, run: Run, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJson(req)) as Record<string, unknown>;
  const owner = ownerRequester(state, run);
  if (!owner) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: run.agentId, runId: run.runId, type: 'action', action: 'ROLE_REQUEST_REFUSED_REQUESTER_NOT_OWNER', actor: `run:${run.agentId}` });
    return json(res, 403, { error: 'requester_not_owner', message: 'a role can be requested only while an owner of this agent is the person asking' });
  }
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const identity = typeof body.identity === 'string' ? body.identity : '';
  const c = check(state, run.agentId, provider, identity, body.roles);
  if (!c.ok) return json(res, c.status, c.body);
  if (state.approvals.pendingChanges(run.agentId).length >= MAX_PENDING_PER_AGENT) {
    return json(res, 429, { error: 'too_many_pending_requests' });
  }
  const change: ChangeRequest = { type: 'role-assignment', provider, identity, roles: c.roles };
  const { approval, created } = state.approvals.requestChange({ runId: run.runId, agentId: run.agentId, change, ttlMs: ROLE_REQUEST_TTL_MS });
  if (created) {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: run.agentId,
      runId: run.runId,
      type: 'action',
      action: 'ROLE_ASSIGNMENT_REQUESTED',
      actor: `run:${run.agentId}`,
      approvalId: approval.approvalId,
      payloadSha256: payloadHash({ provider, identity, roles: c.roles }),
    });
  }
  // The agent learns only that the request is waiting; the decision is the owner's, in the owner's own channel.
  json(res, created ? 202 : 200, { approvalId: approval.approvalId, state: approval.state, expiresAt: approval.expiresAt });
}

export async function handleRoleAssignments(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const list = path.match(LIST);
  if (list && req.method === 'GET') {
    const agentId = decodeURIComponent(list[1]);
    if (!(await requirePrivilege(req, res, state, 'agents.roles.assign', { agentId }))) return true;
    if (!state.agents.get(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const people = (state.identityLinks?.list() ?? [])
      .filter((l) => Object.prototype.hasOwnProperty.call(l.agentRoles ?? {}, agentId) && (l.agentRoles![agentId] ?? []).length)
      .map((l) => ({ provider: l.provider, identity: l.id, ...(l.name ? { name: l.name } : {}), roles: l.agentRoles![agentId] }));
    json(res, 200, { agentId, assignments: people, pending: state.approvals.pendingChanges(agentId).map((a) => ({ approvalId: a.approvalId, change: a.change, expiresAt: a.expiresAt })) });
    return true;
  }
  const one = path.match(ONE);
  if (!one || req.method !== 'PUT') return false;
  const agentId = decodeURIComponent(one[1]);
  const principal = await requirePrivilege(req, res, state, 'agents.roles.assign', { agentId });
  if (!principal) return true;
  const out = assignRoles(state, agentId, decodeURIComponent(one[2]), decodeURIComponent(one[3]), (await readJson(req)).roles, principal.actor, 'direct');
  json(res, out.status, out.body);
  return true;
}

