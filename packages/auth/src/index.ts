import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const ROLES = ['viewer', 'operator', 'approver', 'ingest', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Principal = { actor: string; roles: Role[] };

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: string };

export type AuthProvider = {
  name: string;
  verify(authorization: string | undefined): Promise<AuthResult>;
};

/** admin implies everything; operator and approver each imply viewer; ingest implies nothing else. */
export function hasRole(principal: Principal, role: Role): boolean {
  const r = principal.roles;
  if (r.includes('admin') || r.includes(role)) return true;
  return role === 'viewer' && (r.includes('operator') || r.includes('approver'));
}

function asRoles(values: unknown, roleMap?: Record<string, Role>): Role[] {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? values.split(/[\s,]+/) : [];
  const out = new Set<Role>();
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const mapped = roleMap ? roleMap[v] : (v as Role);
    if (mapped && (ROLES as readonly string[]).includes(mapped)) out.add(mapped);
  }
  return [...out];
}

function bearerOf(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const t = authorization.slice('Bearer '.length).trim();
  return t || undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type NamedToken = { name: string; token: string; roles: Role[] };

/** Static bearer tokens for services and first bring-up. Each token carries its own name and roles. */
export function bearerAuth(tokens: NamedToken[] | string): AuthProvider {
  const list: NamedToken[] =
    typeof tokens === 'string' ? (tokens ? [{ name: 'admin', token: tokens, roles: ['admin'] }] : []) : tokens;
  const usable = list.filter((t) => t.token.length > 0);
  return {
    name: 'bearer',
    async verify(authorization) {
      const presented = bearerOf(authorization);
      if (!presented) return { ok: false, reason: 'missing bearer token' };
      for (const t of usable) {
        if (safeEqual(presented, t.token)) return { ok: true, principal: { actor: `token:${t.name}`, roles: t.roles } };
      }
      return { ok: false, reason: 'unknown token' };
    },
  };
}

export type OidcOptions = {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  /** Test/advanced hook: supply the key resolver directly instead of fetching JWKS. */
  keys?: JWTVerifyGetKey;
  rolesClaim?: string;
  roleMap?: Record<string, Role>;
  clockToleranceSec?: number;
};

async function discoverJwks(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery ${res.status} at ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
  return doc.jwks_uri;
}

/** OIDC/JWT (Entra, Cloudflare Access, Google, Cognito): signature via JWKS, iss, aud, exp/nbf. */
export function oidcAuth(opts: OidcOptions): AuthProvider {
  let keys: JWTVerifyGetKey | undefined = opts.keys;
  let pending: Promise<JWTVerifyGetKey> | undefined;
  const resolveKeys = async (): Promise<JWTVerifyGetKey> => {
    if (keys) return keys;
    pending ??= (async () => {
      const jwks = opts.jwksUrl ?? (await discoverJwks(opts.issuer));
      keys = createRemoteJWKSet(new URL(jwks));
      return keys;
    })();
    try {
      return await pending;
    } catch (err) {
      pending = undefined;
      throw err;
    }
  };
  const claim = opts.rolesClaim ?? 'roles';

  return {
    name: 'oidc',
    async verify(authorization) {
      const jwt = bearerOf(authorization);
      if (!jwt || jwt.split('.').length !== 3) return { ok: false, reason: 'missing bearer jwt' };
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(jwt, await resolveKeys(), {
          issuer: opts.issuer,
          audience: opts.audience,
          clockTolerance: opts.clockToleranceSec ?? 30,
          algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        }));
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'jwt rejected' };
      }
      if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'jwt has no sub' };
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      return {
        ok: true,
        principal: { actor: `oidc:${email ?? payload.sub}`, roles: asRoles(payload[claim], opts.roleMap) },
      };
    },
  };
}

/** Try each provider in order; first success wins. */
export function anyAuth(providers: AuthProvider[]): AuthProvider {
  return {
    name: providers.map((p) => p.name).join('+'),
    async verify(authorization) {
      const reasons: string[] = [];
      for (const p of providers) {
        const r = await p.verify(authorization);
        if (r.ok) return r;
        reasons.push(`${p.name}: ${r.reason}`);
      }
      return { ok: false, reason: reasons.join('; ') || 'no auth provider' };
    },
  };
}

/** Explicit dev-only escape hatch. Never the default. */
export function insecureNoAuth(): AuthProvider {
  return {
    name: 'none',
    async verify() {
      return { ok: true, principal: { actor: 'anonymous', roles: ['admin'] } };
    },
  };
}

function parseTokens(raw: string | undefined): NamedToken[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Array<{ name?: string; token?: string; roles?: unknown }>;
  if (!Array.isArray(parsed)) throw new Error('FACTORY_TOKENS must be a JSON array');
  return parsed.map((t, i) => {
    if (!t.name || !t.token) throw new Error(`FACTORY_TOKENS[${i}] needs name and token`);
    const roles = asRoles(t.roles);
    if (!roles.length) throw new Error(`FACTORY_TOKENS[${i}] has no valid roles`);
    return { name: t.name, token: t.token, roles };
  });
}

/**
 * Fails closed: with nothing configured this throws. Configure any of
 *  - FACTORY_TOKEN (admin bearer) and/or FACTORY_TOKENS (JSON [{name, token, roles}])
 *  - FACTORY_OIDC_ISSUER + FACTORY_OIDC_AUDIENCE (+ FACTORY_OIDC_JWKS_URL, _ROLES_CLAIM, _ROLE_MAP)
 * FACTORY_AUTH=none is honored only together with FACTORY_INSECURE_NO_AUTH=1.
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  if ((env.FACTORY_AUTH ?? '').toLowerCase() === 'none') {
    if (env.FACTORY_INSECURE_NO_AUTH !== '1') {
      throw new Error('FACTORY_AUTH=none requires FACTORY_INSECURE_NO_AUTH=1 (dev only)');
    }
    return insecureNoAuth();
  }
  const providers: AuthProvider[] = [];
  const tokens = parseTokens(env.FACTORY_TOKENS);
  if (env.FACTORY_TOKEN) tokens.push({ name: 'admin', token: env.FACTORY_TOKEN, roles: ['admin'] });
  if (tokens.length) providers.push(bearerAuth(tokens));
  if (env.FACTORY_OIDC_ISSUER || env.FACTORY_OIDC_AUDIENCE) {
    if (!env.FACTORY_OIDC_ISSUER || !env.FACTORY_OIDC_AUDIENCE) {
      throw new Error('OIDC needs both FACTORY_OIDC_ISSUER and FACTORY_OIDC_AUDIENCE');
    }
    providers.push(
      oidcAuth({
        issuer: env.FACTORY_OIDC_ISSUER,
        audience: env.FACTORY_OIDC_AUDIENCE,
        jwksUrl: env.FACTORY_OIDC_JWKS_URL || undefined,
        rolesClaim: env.FACTORY_OIDC_ROLES_CLAIM || undefined,
        roleMap: env.FACTORY_OIDC_ROLE_MAP ? (JSON.parse(env.FACTORY_OIDC_ROLE_MAP) as Record<string, Role>) : undefined,
      }),
    );
  }
  if (!providers.length) {
    throw new Error('no auth configured: set FACTORY_TOKEN/FACTORY_TOKENS or FACTORY_OIDC_ISSUER+AUDIENCE');
  }
  return providers.length === 1 ? providers[0] : anyAuth(providers);
}
