import http from 'node:http';
import type { KeyScopes, Principal, Role } from '@beercanlabs/factory-auth';
import { ROLES } from '@beercanlabs/factory-auth';
import { ApiKeyStoreError, publicKeyView, type ApiKeyRecord } from '@beercanlabs/factory-bouncer';
import { actorIsAdmin, identify, json, readJson, type FactoryState } from './app.js';

/**
 * S5 (R6, D3, D10, D14, D23): issue, rotate, revoke and list factory API keys.
 * - A person manages keys they own. An admin manages anyone's (directly with `owner`, or by acting as them).
 * - `service:<name>` machine keys and their roles are admin-only.
 * - A request authenticated by an API key cannot manage keys (no key minting keys).
 * - The plaintext is returned once, on create/rotate, and never logged.
 */
const KEY_ONE = /^\/api\/v1\/keys\/([^/]+)$/;
const KEY_ROTATE = /^\/api\/v1\/keys\/([^/]+)\/rotate$/;

type Caller = { principal: Principal; isAdmin: boolean; self: string };

async function caller(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse): Promise<Caller | undefined> {
  const who = await identify(req, state);
  if (!who.ok) {
    json(res, 401, { error: 'unauthorized' });
    return undefined;
  }
  const p = who.principal;
  if (p.keyId) {
    json(res, 403, { error: 'forbidden', message: 'API keys cannot manage API keys; sign in', required: 'admin', requiredRole: 'admin' });
    return undefined;
  }
  if (!state.keys) {
    json(res, 503, { error: 'key_store_unavailable' });
    return undefined;
  }
  const isAdmin = actorIsAdmin(state, p.actor, p.roles);
  return { principal: p, isAdmin, self: (p.onBehalfOf ?? p.actor).toLowerCase() };
}

function mayManage(c: Caller, owner: string): boolean {
  return c.isAdmin || (owner === c.self && owner.startsWith('user:'));
}

function forbid(res: http.ServerResponse): void {
  json(res, 403, { error: 'forbidden', required: 'admin', requiredRole: 'admin' });
}

function ledger(state: FactoryState, action: string, c: Caller, key: ApiKeyRecord): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action: `${action}:${key.id}`,
    actor: c.principal.actor,
    subject: key.owner,
  });
}

function storeError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ApiKeyStoreError) {
    json(res, err.status, { error: err.code, message: err.message });
    return;
  }
  throw err;
}

export async function handleKeysRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (path === '/api/v1/keys' && req.method === 'GET') {
    const c = await caller(state, req, res);
    if (!c) return true;
    const ownerQ = new URL(req.url ?? '/', 'http://factory.local').searchParams.get('owner')?.toLowerCase();
    const owner = c.isAdmin && !c.principal.onBehalfOf ? ownerQ : c.self;
    json(res, 200, { keys: state.keys!.list({ ...(owner ? { owner } : {}) }).map(publicKeyView) });
    return true;
  }

  if (path === '/api/v1/keys' && req.method === 'POST') {
    const c = await caller(state, req, res);
    if (!c) return true;
    const body = await readJson(req);
    const owner = (typeof body.owner === 'string' && body.owner.trim() ? body.owner : c.self).trim().toLowerCase();
    if (!mayManage(c, owner)) {
      forbid(res);
      return true;
    }
    const roles = Array.isArray(body.roles) ? (body.roles as unknown[]) : undefined;
    if (roles && (!c.isAdmin || roles.some((r) => typeof r !== 'string' || !(ROLES as readonly string[]).includes(r)))) {
      json(res, 400, { error: 'invalid_roles', message: 'roles are admin-set on service keys and must be known roles' });
      return true;
    }
    try {
      const out = await state.keys!.create({
        owner,
        ...(typeof body.deviceFamily === 'string' ? { deviceFamily: body.deviceFamily } : {}),
        ...(body.scopes !== undefined ? { scopes: body.scopes as KeyScopes } : {}),
        ...(roles ? { roles: roles as Role[] } : {}),
        expiresAt: (body.expiresAt as string | null | undefined) ?? null,
        by: c.principal.actor,
      });
      ledger(state, 'KEY_ISSUED', c, out.record);
      json(res, 201, { key: publicKeyView(out.record), secret: out.plaintext });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  const rot = path.match(KEY_ROTATE);
  if (rot && req.method === 'POST') {
    const c = await caller(state, req, res);
    if (!c) return true;
    const cur = state.keys!.get(decodeURIComponent(rot[1]));
    if (!cur || !mayManage(c, cur.owner)) {
      json(res, 404, { error: 'key_not_found' });
      return true;
    }
    const body = await readJson(req);
    try {
      const out = await state.keys!.rotate(cur.id, { graceSeconds: Number(body.graceSeconds ?? 0), by: c.principal.actor });
      ledger(state, 'KEY_ROTATED', c, out.record);
      json(res, 200, { key: publicKeyView(out.record), secret: out.plaintext });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }

  const one = path.match(KEY_ONE);
  if (one && req.method === 'DELETE') {
    const c = await caller(state, req, res);
    if (!c) return true;
    const cur = state.keys!.get(decodeURIComponent(one[1]));
    if (!cur || !mayManage(c, cur.owner)) {
      json(res, 404, { error: 'key_not_found' });
      return true;
    }
    try {
      const out = await state.keys!.revoke(cur.id, { by: c.principal.actor });
      ledger(state, 'KEY_REVOKED', c, out);
      json(res, 200, { key: publicKeyView(out) });
    } catch (err) {
      storeError(res, err);
    }
    return true;
  }
  return false;
}
