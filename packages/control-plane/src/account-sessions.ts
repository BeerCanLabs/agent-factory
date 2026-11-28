// Front-door Phase 1 Slice 3 (#564): list and revoke the caller's sessions and refresh families.
// An admin may pass ?owner=user:<id>, the same shape as connected-app consent (and #436 revoke-all).
import type http from 'node:http';
import { ACCESS_TOKEN_TTL_SECONDS } from '@beercanlabs/factory-auth';
import { actorIsAdmin, identify, json, type FactoryState } from './app.js';
import { principalAuthMethod, requestAuthMethod, type AuthMethod } from './auth-method.js';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, SESSION_IDLE_MS, cookieValue, sameOrigin, sessionEmail, type Session } from './login.js';
import { REFRESH_DEVICE_MS, REFRESH_PERSON_MS, applyFamilyRevocation } from './mcp-oauth.js';

const BLOCKED: ReadonlySet<AuthMethod> = new Set(['api-key', 'oauth', 'static-token', 'run-token', 'insecure-no-auth', 'none']);

/** D-4 numbers, derived from the clocks the stores enforce. */
export function authLifetimes(): {
  sessionIdleHours: number;
  sessionAbsoluteDays: number;
  refreshPeopleDays: number;
  refreshDeviceDays: number;
} {
  return {
    sessionIdleHours: SESSION_IDLE_MS / 3_600_000,
    sessionAbsoluteDays: SESSION_ABSOLUTE_MS / 86_400_000,
    refreshPeopleDays: REFRESH_PERSON_MS / 86_400_000,
    refreshDeviceDays: REFRESH_DEVICE_MS / 86_400_000,
  };
}

/** Sign-out: the session id and every refresh family approved in that browser session. */
export async function endSessionCredentials(state: FactoryState, session: Session, reason: string): Promise<void> {
  await state.revocations?.revoke({
    id: session.sid,
    kind: 'sid',
    expiresAt: Math.max(session.absoluteExpiresAt, Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    reason,
  });
  const families = (await state.mcpOAuthStore?.revokeFamiliesForSession(session.sid, reason)) ?? [];
  await applyFamilyRevocation(state, families, reason);
}

/** #436: every refresh family of this principal, plus the session ids just ended. */
export async function endPrincipalRefresh(state: FactoryState, principalId: string, sessionSids: readonly string[]): Promise<string[]> {
  const until = Date.now() + SESSION_ABSOLUTE_MS;
  if (sessionSids.length > 0) {
    await state.revocations?.revokeMany(
      sessionSids.map((id) => ({ id, kind: 'sid' as const, expiresAt: until, reason: 'revoke-all' })),
    );
  }
  const families = (await state.mcpOAuthStore?.revokeFamiliesForPrincipal(principalId, 'revoke-all')) ?? [];
  await applyFamilyRevocation(state, families, 'revoke-all');
  return families.map((family) => family.familyId);
}

/** Revoking an OAuth anchor key also kills the family whose access tokens named it, and any JWT still carrying that id. */
export async function noteRevokedKey(
  state: FactoryState,
  key: { id: string; owner: string; oauthClientId?: string },
): Promise<void> {
  const until = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  await state.revocations?.revoke({ id: key.id, kind: 'sid', expiresAt: until, reason: 'key-revoked' });
  if (!key.oauthClientId || !state.mcpOAuthStore) return;
  const families = await state.mcpOAuthStore.revokeFamiliesForClient(key.owner, key.oauthClientId, 'key-revoked');
  await applyFamilyRevocation(state, families, 'key-revoked');
}

type AccountSubject = { actor: string; principalId: string; emails: string[]; currentSid?: string };

async function accountSubject(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<AccountSubject | undefined> {
  const who = await identify(req, state);
  if (!who.ok) return void json(res, 401, { error: 'unauthorized' });
  const method = principalAuthMethod.get(who.principal) ?? requestAuthMethod.get(req) ?? 'none';
  if (BLOCKED.has(method)) {
    return void json(res, 403, { error: 'forbidden', message: 'API keys cannot manage sessions; sign in' });
  }
  const isAdmin = actorIsAdmin(state, who.principal.actor, who.principal.roles);
  const ownerQ = new URL(req.url ?? '/', 'http://x').searchParams.get('owner')?.trim().toLowerCase();
  const principalId = isAdmin && ownerQ ? ownerQ : who.principal.actor;
  const emails = new Set<string>();
  for (const email of state.principals?.get(principalId)?.emails ?? []) emails.add(email.trim().toLowerCase());
  if (principalId === who.principal.actor) {
    const own = sessionEmail(state, req);
    if (own) emails.add(own.trim().toLowerCase());
  }
  if (principalId.startsWith('user:') && principalId.includes('@')) emails.add(principalId.slice('user:'.length));
  const currentSid = state.sessions?.get(cookieValue(req, SESSION_COOKIE))?.sid;
  return { actor: who.principal.actor, principalId, emails: [...emails], currentSid };
}

function sessionView(s: Session, currentSid: string | undefined) {
  return {
    sid: s.sid,
    idp: s.idp,
    createdAt: new Date(s.createdAt).toISOString(),
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    absoluteExpiresAt: new Date(s.absoluteExpiresAt).toISOString(),
    idleExpiresAt: new Date(Math.min(s.lastSeenAt + SESSION_IDLE_MS, s.absoluteExpiresAt)).toISOString(),
    current: s.sid === currentSid,
  };
}

/** GET/DELETE /api/v1/account/sessions and /api/v1/account/refresh-families. */
export async function handleAccountSessionRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (!path.startsWith('/api/v1/account/')) return false;
  try {
    // Another task may have issued or revoked a family. Sessions are reloaded with the revocation set.
    await state.mcpOAuthStore?.reload();
  } catch {
    return json(res, 503, { error: 'auth_store_unavailable', message: 'Sign-in state could not be read' }), true;
  }
  if (path === '/api/v1/account/sessions' && req.method === 'GET') {
    const subject = await accountSubject(state, req, res);
    if (!subject) return true;
    const sessions = state.sessions?.listForEmails(subject.emails) ?? [];
    return json(res, 200, { lifetimes: authLifetimes(), sessions: sessions.map((s) => sessionView(s, subject.currentSid)) }), true;
  }

  const sessionRevoke = path.match(/^\/api\/v1\/account\/sessions\/([^/]+)$/);
  if (sessionRevoke && req.method === 'DELETE') {
    const subject = await accountSubject(state, req, res);
    if (!subject) return true;
    if (!sameOrigin(state, req)) return json(res, 403, { error: 'cross_origin' }), true;
    const sid = decodeURIComponent(sessionRevoke[1] ?? '');
    const owned = state.sessions?.listForEmails(subject.emails).some((s) => s.sid === sid) ?? false;
    if (!owned) return json(res, 404, { error: 'not_found', message: 'Session not found' }), true;
    const ended = state.sessions?.revokeBySid(sid);
    try {
      await state.sessions?.flush();
    } catch {
      return json(res, 503, { error: 'session_store_unavailable', message: 'The session could not be revoked' }), true;
    }
    if (ended) await endSessionCredentials(state, ended, 'session-revoked');
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: 'SESSION_REVOKED',
      actor: subject.actor,
      subject: `session:${sid}`,
    });
    if (subject.currentSid === sid) {
      res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    }
    return json(res, 200, { ok: true, revoked: sid }), true;
  }

  if (path === '/api/v1/account/refresh-families' && req.method === 'GET') {
    const subject = await accountSubject(state, req, res);
    if (!subject) return true;
    const refreshFamilies = state.mcpOAuthStore?.listFamilies(subject.principalId) ?? [];
    return json(res, 200, { lifetimes: authLifetimes(), refreshFamilies }), true;
  }

  const familyRevoke = path.match(/^\/api\/v1\/account\/refresh-families\/([^/]+)$/);
  if (familyRevoke && req.method === 'DELETE') {
    const subject = await accountSubject(state, req, res);
    if (!subject) return true;
    if (!sameOrigin(state, req)) return json(res, 403, { error: 'cross_origin' }), true;
    const familyId = decodeURIComponent(familyRevoke[1] ?? '');
    const owned = state.mcpOAuthStore?.listFamilies(subject.principalId).some((family) => family.familyId === familyId) ?? false;
    if (!owned) return json(res, 404, { error: 'not_found', message: 'Refresh family not found' }), true;
    const keyIds = (await state.mcpOAuthStore?.revokeRefreshTokenFamily(familyId, subject.actor)) ?? [];
    await applyFamilyRevocation(state, [{ familyId, keyIds }], 'family-revoked');
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: 'REFRESH_FAMILY_REVOKED',
      actor: subject.actor,
      subject: `family:${familyId}`,
    });
    return json(res, 200, { ok: true, revoked: familyId }), true;
  }

  return false;
}
