import type http from 'node:http';
import type { KeyScopes } from '@beercanlabs/factory-auth';

/**
 * Front-door Phase 0 (docs/design/front-door-auth.md §7): how a request authenticated, recorded from the credential the
 * factory actually verified (never inferred from which headers happen to be present), so whoami reports it truthfully
 * and every request can be logged by sign-in method. Carries no secret material.
 *
 * - `api-key`: a factory `fk_` key (person device key or `service:<name>` key; see `keyKind`)
 * - `oauth`: a legacy `fk_at_` access token minted by the factory's OAuth 2.1 authorization server
 * - `access-jwt`: an RFC 9068 JWT access token from `/token` (front-door Phase 1 Slice 2). Role claims in the token are hints only.
 * - `google` | `meta` | `cloudflare` | `oidc`: the factory's own login session, labelled by the IdP used at `/login`
 * - `static-token`: the legacy `FACTORY_TOKEN` bearer
 * - `oidc-bearer`: an external OIDC JWT verified via `FACTORY_OIDC_ISSUER`
 * - `cloudflare-access`: a Cloudflare Access assertion (`Cf-Access-Jwt-Assertion` / `CF_Authorization`)
 * - `run-token`: an agent run's short-lived run token
 * - `insecure-no-auth`: dev-only `FACTORY_AUTH=none`
 * - `none`: no credential was verified for this request
 */
export type AuthMethod =
  | 'api-key'
  | 'oauth'
  | 'access-jwt'
  | 'google'
  | 'meta'
  | 'cloudflare'
  | 'oidc'
  | 'static-token'
  | 'oidc-bearer'
  | 'cloudflare-access'
  | 'run-token'
  | 'insecure-no-auth'
  | 'none';

export type KeyKind = 'person' | 'service' | 'break-glass' | 'oauth';

/** Per request: the verified sign-in method (set by identify(), run-token checks and MCP in-process dispatch). */
export const requestAuthMethod = new WeakMap<http.IncomingMessage, AuthMethod>();

/**
 * Per principal object returned by identify(): the method that verified it. MCP tool calls hand that same principal to
 * in-process requests that carry no Authorization header, so this is how they inherit the original caller's method.
 */
export const principalAuthMethod = new WeakMap<object, AuthMethod>();

/**
 * A verified factory JWT access token (Slice 2). `roles` / `grants_v` / `agents` from the token are not stored here:
 * identify() loads the subject's live grants and must not trust those hints (D-5; the unified check is Slice 5).
 * `sid` is the refresh-family id. Tokens issued before Slice 3 still carry the OAuth key id.
 */
export type AccessJwtContext = {
  sub: string;
  clientId: string;
  sid: string;
  jti: string;
  scope?: string;
  scopes?: KeyScopes;
};

export const requestAccessJwt = new WeakMap<http.IncomingMessage, AccessJwtContext>();

/** Per request: non-secret detail about the key used, for the request log. */
export const requestKeyInfo = new WeakMap<http.IncomingMessage, { keyId: string; keyKind: KeyKind; oauthClientId?: string }>();

/** Per request: the actor to log when it was not resolved through identify() (run-token routes). */
export const requestLogActor = new WeakMap<http.IncomingMessage, string>();

export function keyKindOf(rec: { owner: string; secretPrefix?: string; deviceFamily?: string }, breakGlassOwner: string): KeyKind {
  if (rec.secretPrefix === 'fk_at_') return 'oauth';
  if (rec.owner === breakGlassOwner) return 'break-glass';
  return rec.owner.startsWith('service:') ? 'service' : 'person';
}

export function keyAuthMethod(rec: { secretPrefix?: string }): AuthMethod {
  return rec.secretPrefix === 'fk_at_' ? 'oauth' : 'api-key';
}

/** The method for a principal verified through `state.auth` (bearer providers), by the actor shape each provider mints. */
export function bearerAuthMethod(actor: string): AuthMethod {
  if (actor.startsWith('token:')) return 'static-token';
  if (actor === 'anonymous') return 'insecure-no-auth';
  return 'oidc-bearer';
}

export function authMethodOf(req: http.IncomingMessage): AuthMethod | undefined {
  return requestAuthMethod.get(req);
}

export type AuthRequestLogEntry = {
  event: 'auth.request';
  ts: string;
  method: string;
  /** Path only: the query string is dropped because it can carry OAuth codes and state. */
  path: string;
  status: number;
  authMethod: AuthMethod;
  actor?: string;
  keyId?: string;
  keyKind?: KeyKind;
  oauthClientId?: string;
  durationMs: number;
};

/** The request path without query or fragment, capped in length so the log never echoes long opaque values. */
export function logPath(rawUrl: string | undefined): string {
  const p = (rawUrl ?? '/').split('?')[0].split('#')[0];
  return p.length > 256 ? p.slice(0, 256) : p;
}

export function buildAuthRequestLogEntry(
  req: http.IncomingMessage,
  status: number,
  startedAt: number,
  actor: string | undefined,
  now: () => number = Date.now,
): AuthRequestLogEntry {
  const key = requestKeyInfo.get(req);
  return {
    event: 'auth.request',
    ts: new Date(now()).toISOString(),
    method: req.method ?? 'GET',
    path: logPath(req.url),
    status,
    authMethod: requestAuthMethod.get(req) ?? 'none',
    ...(actor ? { actor } : {}),
    ...(key ? { keyId: key.keyId, keyKind: key.keyKind, ...(key.oauthClientId ? { oauthClientId: key.oauthClientId } : {}) } : {}),
    durationMs: Math.max(0, now() - startedAt),
  };
}

/** Default sink: one JSON line on stdout (CloudWatch on AWS). `FACTORY_AUTH_REQUEST_LOG=off` disables it. */
export function stdoutAuthRequestLog(entry: AuthRequestLogEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}
