// GAP-088, DESIGN_AUTHORITY.md "Bouncer flow": which person a Discord user is. The Gatekeeper's ingress reports the
// author Discord verified; an admin links that id to a principal actor (the identity the person signs in as), and the
// control plane resolves it when it decides who may approve what an agent did in that person's name. This is
// authentication data: it holds no authority by itself, and the Bouncer still decides what the person may do.
//
//   GET    /api/v1/identity-links                    every link (admin)
//   PUT    /api/v1/identity-links/:provider/:id      `{ actor }`: link, or replace the link (admin; ledgered)
//   DELETE /api/v1/identity-links/:provider/:id      unlink (admin; ledgered)
import type http from 'node:http';
import type { Role } from '@beercanlabs/factory-auth';
import { ROLES } from '@beercanlabs/factory-auth';
import { payloadHash } from '@beercanlabs/factory-ledger';
import {
  IdentityLinkStore,
  PRINCIPAL_ACTOR,
  PROVIDERS,
  isProvider,
  parseActor,
  type IdentityLink,
  type IdentityProvider,
} from '@beercanlabs/factory-bouncer';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

export {
  IdentityLinkStore,
  PRINCIPAL_ACTOR,
  PROVIDERS,
  isProvider,
  parseActor,
  type IdentityLink,
  type IdentityProvider,
};

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;
const AGENT_ID_REGEX = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const ROLE_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

const ONE = /^\/api\/v1\/identity-links\/([^/]+)\/([^/]+)$/;

/** Handles the identity link routes. Returns false for any other path or method. */
export async function handleIdentityLinks(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const one = path.match(ONE);
  if (path === '/api/v1/identity-links' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'identity.links.read'))) return true;
    if (!state.identityLinks) return json(res, 503, { error: 'identity_links_unavailable' }), true;
    json(res, 200, { links: state.identityLinks.list() });
    return true;
  }
  if (!one || (req.method !== 'PUT' && req.method !== 'DELETE')) return false;
  const principal = await requirePrivilege(req, res, state, 'identity.links.set');
  if (!principal) return true;
  const store = state.identityLinks;
  if (!store) return json(res, 503, { error: 'identity_links_unavailable' }), true;
  const [provider, id] = [decodeURIComponent(one[1]), decodeURIComponent(one[2])];
  if (!isProvider(provider) || !EXTERNAL_ID.test(id)) {
    return json(res, 400, { error: 'unknown_identity', message: `provider must be one of ${PROVIDERS.join(', ')} and id letters, digits, dot, dash or underscore` }), true;
  }
  const ledger = (
    action: 'IDENTITY_LINKED' | 'IDENTITY_UNLINKED',
    actor: string,
    details?: { name?: string; roles?: Role[]; agentRoles?: Record<string, string[]> },
  ) =>
    // Never the external id itself: only a hash of the provider, id, person, name and roles.
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'factory',
      type: 'action',
      action,
      actor: principal.actor,
      payloadSha256: payloadHash({
        provider,
        id,
        actor,
        ...(details?.name ? { name: details.name } : {}),
        ...(details?.roles ? { roles: details.roles } : {}),
        ...(details?.agentRoles ? { agentRoles: details.agentRoles } : {}),
      }),
    });
  if (req.method === 'DELETE') {
    const removed = store.unlink(provider, id);
    if (!removed) return json(res, 404, { error: 'not_found' }), true;
    ledger('IDENTITY_UNLINKED', removed.actor, { name: removed.name, roles: removed.roles, agentRoles: removed.agentRoles });
    json(res, 200, { ok: true });
    return true;
  }
  const body = await readJson(req);
  const actor = parseActor(body.actor);
  if (!actor) return json(res, 400, { error: 'actor must be a principal actor such as cloudflare:alice@example.com, oidc:... or token:...' }), true;
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string' || body.name.length > 128) {
      return json(res, 400, { error: 'name must be a string of at most 128 characters' }), true;
    }
    name = body.name.trim() || undefined;
  }
  let roles: Role[] | undefined;
  if (body.roles !== undefined && body.roles !== null) {
    if (!Array.isArray(body.roles) || !body.roles.every((r: unknown) => typeof r === 'string' && (ROLES as readonly string[]).includes(r))) {
      return json(res, 400, { error: `roles must be an array of valid roles: ${ROLES.join(', ')}` }), true;
    }
    roles = [...new Set(body.roles as Role[])];
    // Escalation check: caller cannot grant roles above their own unless admin
    if (!principal.roles?.includes('admin')) {
      for (const r of roles) {
        if (!principal.roles?.includes(r)) {
          return json(res, 403, { error: 'privilege_escalation', message: `cannot grant role '${r}' above caller roles` }), true;
        }
      }
    }
  }
  let agentRoles: Record<string, string[]> | undefined;
  if (body.agentRoles !== undefined && body.agentRoles !== null) {
    if (typeof body.agentRoles !== 'object' || Array.isArray(body.agentRoles)) {
      return json(res, 400, { error: 'agentRoles must be a map of agentId to array of role strings' }), true;
    }
    // Escalation check: caller cannot grant agent roles unless admin
    if (!principal.roles?.includes('admin')) {
      return json(res, 403, { error: 'privilege_escalation', message: 'cannot grant agentRoles: caller must be admin' }), true;
    }
    const entries = Object.entries(body.agentRoles);
    if (entries.length > 50) {
      return json(res, 400, { error: 'agentRoles exceeds maximum limit of 50 agents' }), true;
    }
    if (Object.prototype.hasOwnProperty.call(body.agentRoles, '__proto__')) {
      return json(res, 400, { error: "invalid agentId '__proto__': prototype properties forbidden" }), true;
    }
    const map: Record<string, string[]> = Object.create(null);
    for (const [agentId, rolesList] of entries) {
      if (
        typeof agentId !== 'string' ||
        !AGENT_ID_REGEX.test(agentId) ||
        agentId === '__proto__' ||
        agentId === 'constructor' ||
        agentId === 'prototype'
      ) {
        return json(res, 400, { error: `invalid agentId '${agentId}': must be a valid slug (letters, digits, dash, underscore)` }), true;
      }
      if (!Array.isArray(rolesList) || rolesList.length > 20) {
        return json(res, 400, { error: `agentRoles for '${agentId}' must be an array of at most 20 role strings` }), true;
      }
      const cleanedRoles: string[] = [];
      for (const r of rolesList) {
        if (typeof r !== 'string' || !ROLE_NAME_REGEX.test(r)) {
          return json(res, 400, { error: `invalid role name in '${agentId}': must be 1-64 alphanumeric characters, dash or underscore` }), true;
        }
        if (r.toLowerCase() === 'owner') {
          return json(res, 400, { error: 'invalid_agent_roles', message: `role 'Owner' in '${agentId}' is reserved and derived strictly from agent ownership` }), true;
        }
        cleanedRoles.push(r);
      }
      map[agentId] = [...new Set(cleanedRoles)];
    }
    // E12: a role is assignable only if the agent's admitted cartridge declares it (never `Owner`: that comes from
    // ownership). A role this link already holds is never refused on a later edit, so a role the cartridge has since
    // dropped cannot block an unrelated change; only adding an undeclared one is refused. An empty list removes, always.
    const current = store.resolveLink(provider, id);
    const kept: Record<string, string[]> = current && current.actor === actor && current.agentRoles ? current.agentRoles : {};
    for (const [agentId, list] of Object.entries(map)) {
      if (list.length === 0) continue;
      const already = Object.prototype.hasOwnProperty.call(kept, agentId) ? kept[agentId] : [];
      // Nothing new for this agent (every role is already held): an agent since unregistered cannot block the edit.
      if (list.every((r) => already.includes(r))) continue;
      const agent = state.agents.get(agentId);
      if (!agent) {
        return json(res, 400, { error: 'unknown_agent', agentId, message: `agent '${agentId}' is not registered, so it has no roles to give` }), true;
      }
      const assignable = (agent.roles ?? []).map((r) => r.name).filter((n) => n.toLowerCase() !== 'owner');
      const refused = list.filter((r) => !assignable.includes(r) && !already.includes(r));
      if (refused.length) {
        return json(res, 400, {
          error: 'unknown_agent_role',
          agentId,
          roles: refused,
          assignable,
          message: `agent '${agentId}' does not declare ${refused.map((r) => `'${r}'`).join(', ')}; it declares ${assignable.length ? assignable.map((r) => `'${r}'`).join(', ') : 'no roles that can be given'}`,
        }), true;
      }
    }
    agentRoles = map;
  }
  const { link, changed } = store.link(provider, id, actor, principal.actor, { name, roles, agentRoles });
  if (changed) ledger('IDENTITY_LINKED', actor, { name: link.name, roles: link.roles, agentRoles: link.agentRoles });
  json(res, 200, link);
  return true;
}
