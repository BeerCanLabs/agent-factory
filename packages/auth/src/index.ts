import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export {
  accessAssertionOf,
  accessAuthFromEnv,
  accessIdentityPrincipal,
  accessPrincipal,
  cloudflareAccessAuth,
  normalizeTeamDomain,
  type AccessAuth,
  type AccessClaims,
  type AccessOptions,
  type AccessVerifyResult,
  type JwksFetcher,
} from './access.js';

export { API_KEY_PREFIX, apiKeyFromAuthorization, generateApiKey, hashApiKey, sameHash } from './keys.js';

export const ROLES =['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'gatekeeper-ingress', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** S5: scopes a factory API key narrows its owner's live grants to (absent = no narrowing). */
export type KeyScopes = { privileges?: string[]; agents?: string[] };

export type Principal = { actor: string; roles: Role[]; onBehalfOf?: string; keyId?: string; keyScopes?: KeyScopes };

export type OidcIdentityClaims = { email: string; emailVerified: true; sub: string };

export type OidcIdentityResult =
  | { ok: true; principal: Principal; claims: OidcIdentityClaims }
  | { ok: false; reason: string };

export type AuthResult = { ok: true; principal: Principal; claims?: OidcIdentityClaims } | { ok: false; reason: string };

export type AuthProvider = {
  name: string;
  verify(authorization: string | undefined): Promise<AuthResult>;
};

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
  adminEmails?: string[];
  /** R1/R13/D1/D2: require `email_verified: true` and emit identity-only `user:<email>` with zero roles. */
  identityOnly?: boolean;
  /** R13: require `email_verified: true` on verified OIDC tokens. */
  requireEmailVerified?: boolean;
};

async function discoverJwks(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`OIDC discovery ${res.status} at ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
  return doc.jwks_uri;
}

const MAX_OIDC_RESOLVERS = 64;
const oidcResolverCache = new Map<string, () => Promise<JWTVerifyGetKey>>();

function createOidcKeyResolver(opts: OidcOptions): () => Promise<JWTVerifyGetKey> {
  let keys: JWTVerifyGetKey | undefined = opts.keys;
  let pending: Promise<JWTVerifyGetKey> | undefined;
  return async (): Promise<JWTVerifyGetKey> => {
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
}

function getOidcKeyResolver(opts: OidcOptions): () => Promise<JWTVerifyGetKey> {
  if (opts.keys) return createOidcKeyResolver(opts);
  const cacheKey = `${opts.issuer}\0${opts.jwksUrl ?? ''}`;
  const cached = oidcResolverCache.get(cacheKey);
  if (cached) return cached;
  if (oidcResolverCache.size >= MAX_OIDC_RESOLVERS) {
    const oldest = oidcResolverCache.keys().next().value;
    if (oldest !== undefined) oidcResolverCache.delete(oldest);
  }
  const resolver = createOidcKeyResolver(opts);
  oidcResolverCache.set(cacheKey, resolver);
  return resolver;
}

async function verifyOidcPayload(
  jwt: string | undefined,
  opts: OidcOptions,
  resolveKeys: () => Promise<JWTVerifyGetKey>,
): Promise<{ ok: true; payload: JWTPayload & { sub: string } } | { ok: false; reason: string }> {
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
  return { ok: true, payload: payload as JWTPayload & { sub: string } };
}

function toIdentityResult(payload: JWTPayload & { sub: string }): OidcIdentityResult {
  if (payload.email_verified !== true) return { ok: false, reason: 'email not verified' };
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, reason: 'jwt has no email' };
  return {
    ok: true,
    principal: { actor: `user:${email}`, roles: [] },
    claims: { email, emailVerified: true, sub: payload.sub },
  };
}

/** Verifies an OIDC token (raw JWT or `Bearer <jwt>`) as an identity-only assertion requiring `email_verified: true` (R1, R13, D1, D2). */
export async function verifyOidcIdentity(tokenOrAuth: string | undefined, opts: OidcOptions): Promise<OidcIdentityResult> {
  const trimmed = tokenOrAuth?.trim();
  const jwt = bearerOf(tokenOrAuth) ?? (trimmed && !/\s/.test(trimmed) ? trimmed : undefined);
  const verified = await verifyOidcPayload(jwt, opts, getOidcKeyResolver(opts));
  if (!verified.ok) return verified;
  return toIdentityResult(verified.payload);
}

/** OIDC/JWT (Entra, Cloudflare Access, Google, Cognito): signature via JWKS, iss, aud, exp/nbf. */
export function oidcAuth(opts: OidcOptions): AuthProvider {
  const resolveKeys = getOidcKeyResolver(opts);
  const claim = opts.rolesClaim ?? 'roles';
  const identityMode = Boolean(opts.identityOnly);

  return {
    name: 'oidc',
    async verify(authorization) {
      const verified = await verifyOidcPayload(bearerOf(authorization), opts, resolveKeys);
      if (!verified.ok) return verified;
      const { payload } = verified;
      if (identityMode) return toIdentityResult(payload);
      if (opts.requireEmailVerified && payload.email_verified !== true) {
        return { ok: false, reason: 'email not verified' };
      }
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const roles = asRoles(payload[claim], opts.roleMap);
      // No built-in admins: only the deployment names them (FACTORY_ADMIN_EMAILS).
      const adminList = opts.adminEmails ?? [];
      if (email && adminList.some((e) => e.toLowerCase() === email.toLowerCase())) {
        if (!roles.includes('admin')) roles.push('admin');
      }
      return {
        ok: true,
        principal: { actor: `oidc:${email ?? payload.sub}`, roles },
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
    const adminEmails = (env.FACTORY_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    providers.push(
      oidcAuth({
        issuer: env.FACTORY_OIDC_ISSUER,
        audience: env.FACTORY_OIDC_AUDIENCE,
        jwksUrl: env.FACTORY_OIDC_JWKS_URL || undefined,
        rolesClaim: env.FACTORY_OIDC_ROLES_CLAIM || undefined,
        roleMap: env.FACTORY_OIDC_ROLE_MAP ? (JSON.parse(env.FACTORY_OIDC_ROLE_MAP) as Record<string, Role>) : undefined,
        adminEmails,
      }),
    );
  }
  if (!providers.length) {
    throw new Error('no auth configured: set FACTORY_TOKEN/FACTORY_TOKENS or FACTORY_OIDC_ISSUER+AUDIENCE');
  }
  return providers.length === 1 ? providers[0] : anyAuth(providers);
}

/**
 * Short-lived credential an agent run presents to the factory and its gatekeeper-egress.
 * HS256 over FACTORY_RUN_TOKEN_KEY, shared by the control plane (mint) and gatekeeper-egress (verify).
 * Signature and expiry only; the holder must also confirm the run is still live.
 */
export class RunTokens {
  private readonly key: Uint8Array;
  readonly ephemeral: boolean;

  constructor(secret: string | undefined, private readonly ttlSec = 6 * 3600) {
    if (secret && secret.length < 32) throw new Error('FACTORY_RUN_TOKEN_KEY must be at least 32 characters');
    this.ephemeral = !secret;
    this.key = secret ? new TextEncoder().encode(secret) : randomBytes(32);
  }

  mint(run: { runId: string; agentId: string }): Promise<string> {
    return new SignJWT({ run: run.runId })
      .setProtectedHeader({ alg: 'HS256', typ: 'factory-run+jwt' })
      .setSubject(run.agentId)
      .setIssuer('agent-factory')
      .setAudience('agent-factory:run')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSec}s`)
      .sign(this.key);
  }

  async verify(token: string | undefined): Promise<{ runId: string; agentId: string } | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: 'agent-factory',
        audience: 'agent-factory:run',
        algorithms: ['HS256'],
        typ: 'factory-run+jwt',
      });
      if (typeof payload.run !== 'string' || typeof payload.sub !== 'string') return null;
      return { runId: payload.run, agentId: payload.sub };
    } catch {
      return null;
    }
  }
}
