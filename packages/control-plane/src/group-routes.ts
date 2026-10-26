/**
 * Group management and membership routes (DESIGN_AUTHORITY.md H6, A10, A17, A26, GAP-203).
 *
 * REST Endpoints:
 *   GET    /api/v1/groups                   List all groups, optional ?member=<id> filter (groups.manage)
 *   POST   /api/v1/groups                   Create a group (groups.manage, ledgered)
 *   GET    /api/v1/groups/:id               Get a group by ID (groups.manage)
 *   PUT    /api/v1/groups/:id               Update group name, description, roles (groups.manage, ledgered)
 *   DELETE /api/v1/groups/:id               Delete a group (groups.manage, ledgered)
 *   POST   /api/v1/groups/:id/members       Add a member to a group (groups.manage, ledgered)
 *   DELETE /api/v1/groups/:id/members       Remove a member from a group (groups.manage, ledgered)
 *   DELETE /api/v1/groups/:id/members/:m    Remove a member from a group via path (groups.manage, ledgered)
 */

import type http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

const GROUP_BASE = /^\/api\/v1\/groups$/;
const GROUP_ITEM = /^\/api\/v1\/groups\/([^/]+)$/;
const GROUP_MEMBERS = /^\/api\/v1\/groups\/([^/]+)\/members(?:\/([^/]+))?$/;

export async function handleGroupRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const [pathname] = path.split('?');
  if (!pathname.startsWith('/api/v1/groups')) return false;

  // Base list and create: /api/v1/groups
  if (GROUP_BASE.test(pathname)) {
    if (req.method === 'GET') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const url = new URL(req.url ?? path, 'http://localhost');
      const member = url.searchParams.get('member');
      const groups = member ? state.groups.listUserGroups(member) : state.groups.listGroups();
      return json(res, 200, { groups }), true;
    }

    if (req.method === 'POST') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { error: 'invalid_json', message: 'body must be a JSON object' }), true;
      }

      try {
        const group = state.groups.createGroup(body as any);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'factory',
          type: 'action',
          action: 'GROUP_CREATED',
          actor: principal.actor,
          groupId: group.id,
          payloadSha256: payloadHash(group),
        });
        return json(res, 201, { group }), true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('already exists')) {
          return json(res, 409, { error: 'group_already_exists', message: msg }), true;
        }
        return json(res, 400, { error: 'invalid_group', message: msg }), true;
      }
    }

    return false;
  }

  // Member management: /api/v1/groups/:id/members or /api/v1/groups/:id/members/:member
  const membersMatch = pathname.match(GROUP_MEMBERS);
  if (membersMatch) {
    const id = decodeURIComponent(membersMatch[1]);

    if (req.method === 'POST') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const body = await readJson(req);
      const member = body && typeof body === 'object' && !Array.isArray(body) ? (body as any).member : undefined;
      if (!member || typeof member !== 'string') {
        return json(res, 400, { error: 'invalid_member', message: 'body must include a member string' }), true;
      }

      try {
        const group = state.groups.addMember(id, member);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'factory',
          type: 'action',
          action: 'GROUP_MEMBER_ADDED',
          actor: principal.actor,
          groupId: group.id,
          member: member.trim().toLowerCase(),
          payloadSha256: payloadHash({ groupId: group.id, member: member.trim().toLowerCase() }),
        });
        return json(res, 200, { group }), true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('not found')) {
          return json(res, 404, { error: 'group_not_found', message: msg }), true;
        }
        return json(res, 400, { error: 'invalid_member', message: msg }), true;
      }
    }

    if (req.method === 'DELETE') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      let member = membersMatch[2] ? decodeURIComponent(membersMatch[2]) : undefined;
      if (!member) {
        const body = await readJson(req);
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          member = (body as any).member;
        }
      }

      if (!member || typeof member !== 'string') {
        return json(res, 400, { error: 'invalid_member', message: 'member must be specified in URL path or body' }), true;
      }

      try {
        const group = state.groups.removeMember(id, member);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'factory',
          type: 'action',
          action: 'GROUP_MEMBER_REMOVED',
          actor: principal.actor,
          groupId: group.id,
          member: member.trim().toLowerCase(),
          payloadSha256: payloadHash({ groupId: group.id, member: member.trim().toLowerCase() }),
        });
        return json(res, 200, { group }), true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('not found')) {
          return json(res, 404, { error: 'group_not_found', message: msg }), true;
        }
        return json(res, 400, { error: 'invalid_member', message: msg }), true;
      }
    }

    return false;
  }

  // Single group CRUD: /api/v1/groups/:id
  const itemMatch = pathname.match(GROUP_ITEM);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);

    if (req.method === 'GET') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const group = state.groups.getGroup(id);
      if (!group) {
        return json(res, 404, { error: 'group_not_found', message: `group ${JSON.stringify(id)} not found` }), true;
      }
      return json(res, 200, { group }), true;
    }

    if (req.method === 'PUT') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { error: 'invalid_json', message: 'body must be a JSON object' }), true;
      }

      try {
        const group = state.groups.updateGroup(id, body as any);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'factory',
          type: 'action',
          action: 'GROUP_UPDATED',
          actor: principal.actor,
          groupId: group.id,
          payloadSha256: payloadHash(group),
        });
        return json(res, 200, { group }), true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('not found')) {
          return json(res, 404, { error: 'group_not_found', message: msg }), true;
        }
        return json(res, 400, { error: 'invalid_group_update', message: msg }), true;
      }
    }

    if (req.method === 'DELETE') {
      const principal = await requirePrivilege(req, res, state, 'groups.manage');
      if (!principal) return true;
      if (!state.groups) return json(res, 503, { error: 'groups_unavailable' }), true;

      const existing = state.groups.getGroup(id);
      if (!existing) {
        return json(res, 404, { error: 'group_not_found', message: `group ${JSON.stringify(id)} not found` }), true;
      }

      state.groups.deleteGroup(id);
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: 'factory',
        type: 'action',
        action: 'GROUP_DELETED',
        actor: principal.actor,
        groupId: id,
        payloadSha256: payloadHash({ id }),
      });
      return json(res, 200, { deleted: true, id }), true;
    }

    return false;
  }

  return false;
}
