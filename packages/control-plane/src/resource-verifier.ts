// Front-door Phase 1 Slice 5 (#566, D-5). One resource-server check for /api/v1/* and /mcp.
// A factory access JWT is verified from the public JWKS (signature, kid, issuer including the Phase 3
// alias, audience api or mcp, expiry), then against the revocation set. Token scopes only narrow the
// caller's live grants. Role and grant claims stay hints. The Bouncer (requirePrivilege) makes the decision.
// Legacy fk_ and fk_at_ credentials stay accepted until Phase 3.
import type http from 'node:http';
import {
  canonicalAccessResource,
  isFactoryAccessJwt,
  verifyAccessToken,
  apiKeyFromAuthorization,
  type KeyScopes,
} from '@beercanlabs/factory-auth';
import { authorize, BREAK_GLASS_OWNER, PRIVILEGES, type EffectiveGrant, type Privilege } from '@beercanlabs/factory-bouncer';
import type { Principal } from '@beercanlabs/factory-auth';
import { allowedIssuerOrigins, ensureAsKeys } from './as-discovery.js';
import {
  keyAuthMethod,
  keyKindOf,
  requestAccessJwt,
  requestAuthMethod,
  requestKeyInfo,
} from './auth-method.js';
import { getOAuthIssuer, mapOAuthScopeToKeyScopes } from './mcp-oauth.js';
import { effectiveGrantsForActor, json, requestApiKey, resolveVerifiedPrincipal, type FactoryState } from './app.js';

const PRIVILEGE_NAMES = new Set<string>(PRIVILEGES);

export function resourceAudiences(issuers: readonly string[], kind: 'api' | 'mcp'): string[] {
  const out: string[] = [];
  for (const issuer of issuers) {
    const audience = canonicalAccessResource(issuer, kind);
    if (!out.includes(audience)) out.push(audience);
  }
  return out;
}

/**
 * D-5: a token scope list only narrows. A privilege the caller no longer holds is dropped, so a
 * revocation applies on this request. An `admin` scope (no privilege list) does not narrow; the
 * Bouncer still reads live grants and will deny a role that was revoked.
 */
export function intersectTokenScopesWithLiveGrants(
  principal: Principal,
  tokenScopes: KeyScopes | undefined,
  liveGrants: readonly EffectiveGrant[] | undefined,
): KeyScopes | undefined {
  if (!tokenScopes?.privileges) return tokenScopes;
  const bare: Principal = { actor: principal.actor, roles: [...principal.roles] };
  const privileges = tokenScopes.privileges.filter((name) => {
    if (!PRIVILEGE_NAMES.has(name)) return false;
    return authorize({
      principal: bare,
      privilege: name as Privilege,
      resource: liveGrants ? { grants: liveGrants } : {},
    }).allowed;
  });
  return { ...tokenScopes, privileges };
}

/**
 * S5 / D-5: an `fk_` / `fk_at_` key, or a factory access JWT, on /api/v1 or /mcp is checked before
 * anything else, including body reads. An unknown, revoked or expired credential gets 401 here; a
 * valid one is remembered for identify(), which loads live grants and does not copy JWT role hints.
 * Other bearers (static token, external OIDC, run token) pass through to identify().
 */
export async function verifyResourceRequest(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const isMcp = path === '/mcp' || (path.startsWith('/mcp/') && !path.startsWith('/mcp/run'));
  // S16: health and metrics take a machine key too, so probes can present one.
  if (!(isMcp || path.startsWith('/api/v1/') || path === '/healthz' || path === '/' || path === '/metrics')) return true;
  const plaintext = apiKeyFromAuthorization(req.headers.authorization);
  if (plaintext === undefined) {
    const bearer = bearerCredential(req.headers.authorization);
    if (bearer && isFactoryAccessJwt(bearer)) return acceptFactoryAccessJwt(state, req, res, bearer, isMcp);
    return true;
  }
  return acceptLegacyKey(state, req, res, plaintext, isMcp, path);
}

async function acceptLegacyKey(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  plaintext: string,
  isMcp: boolean,
  path: string,
): Promise<boolean> {
  const rec = plaintext && state.keys ? state.keys.verify(plaintext) : undefined;
  if (!rec) {
    if (isMcp) {
      const issuer = getOAuthIssuer(state, req);
      res.setHeader('www-authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
    }
    json(res, 401, { error: 'invalid_key', message: 'API key is unknown, revoked or expired' });
    return false;
  }

  // Audience binding (RFC 8707). fk_at_ tokens minted for /mcp stay off the REST API until Phase 3.
  if (rec.audience) {
    if (!isMcp) {
      json(res, 401, { error: 'invalid_token_audience', message: 'Token audience does not permit direct API access' });
      return false;
    }
    const issuer = getOAuthIssuer(state, req);
    const canonicalMcp = `${issuer}/mcp`;
    if (rec.audience !== canonicalMcp && !rec.audience.endsWith('/mcp')) {
      json(res, 401, { error: 'invalid_token_audience', message: 'Token audience does not match this resource' });
      return false;
    }
  }

  requestApiKey.set(req, rec);
  requestKeyInfo.set(req, { keyId: rec.id, keyKind: keyKindOf(rec, BREAK_GLASS_OWNER), ...(rec.oauthClientId ? { oauthClientId: rec.oauthClientId } : {}) });
  requestAuthMethod.set(req, keyAuthMethod(rec));
  if (rec.owner === BREAK_GLASS_OWNER) {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: 'BREAK_GLASS_USED',
      actor: BREAK_GLASS_OWNER,
      subject: `${req.method ?? 'GET'}:${path}`.slice(0, 200).replace(/[^A-Za-z0-9:._@+/-]/g, '_').replace(/^/, 'route:'),
    });
    void state.keys!.markUsed(rec.id).catch(() => undefined);
  }
  return true;
}

/**
 * Accept one factory access JWT (RFC 9068) for this route's audience. The signature is checked
 * against the published JWKS. Issuers include the Phase 3 alias. A `jti` or `sid` in the revocation
 * set is dead, and a `sid` that names a refresh family is dead when that family is revoked.
 */
async function acceptFactoryAccessJwt(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bearer: string,
  isMcp: boolean,
): Promise<boolean> {
  const issuer = getOAuthIssuer(state, req);
  const fail = (error: 'invalid_token' | 'invalid_token_audience', message: string): false => {
    if (isMcp) {
      res.setHeader('www-authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
    }
    json(res, 401, { error, message });
    return false;
  };
  const configured = allowedIssuerOrigins(state);
  const issuers = configured.length > 0 ? configured : [issuer];
  const kind = isMcp ? 'mcp' : 'api';
  const verdict = await verifyAccessToken(bearer, {
    keys: await ensureAsKeys(state),
    issuers,
    audience: resourceAudiences(issuers, kind),
  });
  if (!verdict.ok) {
    if (verdict.reason === 'audience') {
      return fail(
        'invalid_token_audience',
        isMcp ? 'Token audience does not match this resource' : 'Token audience does not permit direct API access',
      );
    }
    return fail('invalid_token', 'Access token is invalid or expired');
  }
  const token = verdict.token;
  try {
    await state.revocations?.reload();
    await state.mcpOAuthStore?.reload();
    await state.grants?.reload();
  } catch {
    json(res, 503, { error: 'auth_store_unavailable', message: 'Sign-in state could not be read' });
    return false;
  }
  if (state.revocations?.has(token.jti) || state.revocations?.has(token.sid)) {
    return fail('invalid_token', 'Access token is invalid or expired');
  }
  const family = state.mcpOAuthStore?.liveFamily(token.sid);
  const now = Date.now();
  if (family) {
    const anchor = family.keyId && state.keys?.healthy ? state.keys.get(family.keyId) : undefined;
    if (
      family.revoked ||
      family.principalId !== token.sub ||
      family.clientId !== token.clientId ||
      (anchor &&
        (anchor.revokedAt ||
          (anchor.expiresAt !== null && !(Date.parse(anchor.expiresAt) > now)) ||
          anchor.owner !== token.sub ||
          (anchor.oauthClientId !== undefined && anchor.oauthClientId !== token.clientId)))
    ) {
      return fail('invalid_token', 'Access token is invalid or expired');
    }
  } else {
    const anchor = state.keys?.healthy ? state.keys.get(token.sid) : undefined;
    if (
      !anchor ||
      anchor.revokedAt ||
      (anchor.expiresAt !== null && !(Date.parse(anchor.expiresAt) > now)) ||
      anchor.owner !== token.sub ||
      anchor.oauthClientId !== token.clientId
    ) {
      return fail('invalid_token', 'Access token is invalid or expired');
    }
  }
  if (state.principals?.healthy && token.sub.startsWith('user:') && !state.principals.get(token.sub)) {
    return fail('invalid_token', 'Access token is invalid or expired');
  }

  // D-5: hints are not copied. Live grants are loaded here and again by the Bouncer on the handler.
  const owner = await resolveVerifiedPrincipal(state, { actor: token.sub, roles: [], emailVerified: true }, false);
  const grantRes = effectiveGrantsForActor(state, owner.actor);
  if (!grantRes.ok) {
    json(res, 503, { error: grantRes.error });
    return false;
  }
  const tokenScopes = mapOAuthScopeToKeyScopes(token.scope);
  const scopes = intersectTokenScopesWithLiveGrants(owner, tokenScopes, grantRes.grants);
  const grantsVersion = token.hints.grantsVersion;
  if (grantsVersion !== undefined && state.grants && state.grants.version > grantsVersion) {
    res.setHeader('X-Factory-Grants-Stale', '1');
  }
  requestAccessJwt.set(req, {
    sub: token.sub,
    clientId: token.clientId,
    sid: token.sid,
    jti: token.jti,
    ...(token.scope ? { scope: token.scope } : {}),
    ...(scopes ? { scopes } : {}),
  });
  requestAuthMethod.set(req, 'access-jwt');
  requestKeyInfo.set(req, { keyId: token.sid, keyKind: 'oauth', oauthClientId: token.clientId });
  return true;
}

function bearerCredential(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/.exec(authorization);
  return m?.[1];
}
