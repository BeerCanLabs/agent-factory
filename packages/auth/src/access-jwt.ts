// Front-door Phase 1 Slice 2 (docs/design/front-door-auth.md §4.2, §10 item 5, issue #563).
// RFC 9068 JWT access tokens, signed with the Slice 1 ES256 key set. This module only signs and checks the token.
// Signature checks use the public JWKS (the same document as GET /jwks), never the private key.
// It does not decide privileges: `roles`, `agents`, and `grants_v` are hints (D-5). The resource server
// (Slice 5, #566) re-reads live grants, intersects them with `scope`, and hands the request to the Bouncer.
// `sid` is the refresh-family id (Slice 3). Tokens issued before that still carry the key-store id.
// Slice 4 (#565) puts real factory scopes on `scope`.
import { randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { AS_SIGNING_ALG, publicJwksOf, stripTrailingSlash, type AsKeySet } from './as-keys.js';

/** D-3: access tokens live 10 minutes. */
export const ACCESS_TOKEN_TTL_SECONDS = 600;

/** RFC 9068 §2.1: the typ header of an access token. */
export const ACCESS_JWT_TYP = 'at+jwt';

const ACCEPTED_TYP = new Set([ACCESS_JWT_TYP, 'application/at+jwt']);

export type AccessAudienceKind = 'api' | 'mcp';

export type AccessTokenHints = {
  /** Fleet roles at issue time. Display only; never an authorization decision. */
  roles?: string[];
  /** Grant-store version at issue time. Slice 5 may send X-Factory-Grants-Stale from this. */
  grantsVersion?: number;
  /** Agent-scoped grant roles at issue time, truncated. Display only. */
  agents?: Record<string, string[]>;
};

export type AccessTokenInput = {
  issuer: string;
  subject: string;
  /** Canonical resource URIs (`{issuer}/api` and/or `{issuer}/mcp`). */
  audiences: string[];
  clientId: string;
  scope?: string;
  /** Revocation anchor. Slice 3 stores the refresh-family id. Older tokens still carry the key-store id. */
  sid: string;
  amr?: string[];
  /** RFC 8693 actor hint (`client:<client_id>`). Not consulted on requests. */
  actSub?: string;
  hints?: AccessTokenHints;
  jti?: string;
  now?: Date;
  ttlSeconds?: number;
};

export type VerifiedAccessToken = {
  iss: string;
  sub: string;
  clientId: string;
  scope?: string;
  sid: string;
  jti: string;
  /** Seconds since epoch. The revocation set keeps a revoked `jti` until then. */
  exp: number;
  audiences: string[];
  amr?: string[];
  hints: AccessTokenHints;
};

export type AccessTokenVerifyResult =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; reason: 'audience' | 'expired' | 'invalid' };

export function canonicalAccessResource(issuer: string, kind: AccessAudienceKind): string {
  return `${stripTrailingSlash(issuer)}/${kind}`;
}

/** Which factory resource a requested URI names, or undefined when it is neither api nor mcp. */
export function accessResourceKind(issuer: string, resource: string): AccessAudienceKind | undefined {
  const clean = stripResource(resource);
  const base = stripTrailingSlash(issuer);
  if (clean === `${base}/api` || clean.startsWith(`${base}/api/`)) return 'api';
  if (clean === `${base}/mcp` || clean.startsWith(`${base}/mcp/`)) return 'mcp';
  return undefined;
}

/** Recover api vs mcp from a resource URI this server stored, even if the issuer host has since changed. */
export function accessKindOfUrl(resource: string): AccessAudienceKind | undefined {
  const clean = stripResource(resource);
  if (clean.endsWith('/mcp')) return 'mcp';
  if (clean.endsWith('/api')) return 'api';
  return undefined;
}

export function canonicalAudiences(
  issuer: string,
  resources: readonly string[],
): { ok: true; audiences: string[] } | { ok: false } {
  if (resources.length === 0) return { ok: true, audiences: [canonicalAccessResource(issuer, 'mcp')] };
  const audiences: string[] = [];
  for (const raw of resources) {
    const kind = accessResourceKind(issuer, raw);
    if (!kind) return { ok: false };
    const canon = canonicalAccessResource(issuer, kind);
    if (!audiences.includes(canon)) audiences.push(canon);
  }
  return { ok: true, audiences };
}

/** True when the bearer value is shaped as a factory access token (RFC 9068 typ), before signature checks. */
export function isFactoryAccessJwt(token: string): boolean {
  const typ = unprotectedTyp(token);
  return typ !== undefined && ACCEPTED_TYP.has(typ);
}

export async function signAccessToken(keys: AsKeySet, input: AccessTokenInput): Promise<{ token: string; expiresIn: number; jti: string }> {
  const audiences = [...new Set(input.audiences.map((a) => a.trim()).filter(Boolean))];
  if (audiences.length === 0) throw new Error('access token needs an api or mcp audience');
  const subject = input.subject.trim();
  const clientId = input.clientId.trim();
  const sid = input.sid.trim();
  const issuer = stripTrailingSlash(input.issuer);
  if (!subject || !clientId || !sid || !issuer) throw new Error('access token is missing iss, sub, client_id, or sid');
  const ttl = input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(`access token lifetime must be between 1 and ${ACCESS_TOKEN_TTL_SECONDS} seconds`);
  }
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const jti = input.jti?.trim() || randomBytes(16).toString('hex');
  const hints = input.hints;
  const payload: JWTPayload = {
    client_id: clientId,
    sid,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.amr && input.amr.length > 0 ? { amr: input.amr } : {}),
    ...(input.actSub ? { act: { sub: input.actSub } } : {}),
    ...(hints?.roles && hints.roles.length > 0 ? { roles: hints.roles } : {}),
    ...(hints?.grantsVersion !== undefined ? { grants_v: hints.grantsVersion } : {}),
    ...(hints?.agents && Object.keys(hints.agents).length > 0 ? { agents: hints.agents } : {}),
  };
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: AS_SIGNING_ALG, kid: keys.current.kid, typ: ACCESS_JWT_TYP })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audiences)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .setJti(jti)
    .sign(keys.current.privateKey);
  return { token, expiresIn: ttl, jti };
}

export async function verifyAccessToken(
  token: string,
  opts: {
    keys: AsKeySet;
    issuers: readonly string[];
    /** One audience, or any of these (the primary issuer and the Phase 3 alias, for this route's api or mcp resource). */
    audience: string | readonly string[];
    now?: Date;
    clockToleranceSec?: number;
  },
): Promise<AccessTokenVerifyResult> {
  const typ = unprotectedTyp(token);
  if (!typ || !ACCEPTED_TYP.has(typ)) return { ok: false, reason: 'invalid' };
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (header.alg !== AS_SIGNING_ALG || typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'invalid' };
  const jwks = publicJwksOf(opts.keys);
  if (!jwks.keys.some((key) => key.kid === header.kid)) return { ok: false, reason: 'invalid' };
  const issuers = [...new Set(opts.issuers.map((i) => stripTrailingSlash(i)).filter(Boolean))];
  const audiences = [...new Set((Array.isArray(opts.audience) ? opts.audience : [opts.audience]).map((a) => a.trim()).filter(Boolean))];
  if (issuers.length === 0 || audiences.length === 0) return { ok: false, reason: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: jwks.keys }), {
      issuer: issuers,
      audience: audiences,
      algorithms: [AS_SIGNING_ALG],
      typ: header.typ,
      clockTolerance: opts.clockToleranceSec ?? 5,
      currentDate: opts.now,
      requiredClaims: ['exp', 'iat', 'iss', 'sub', 'aud', 'jti', 'client_id'],
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
    const sid = typeof payload.sid === 'string' ? payload.sid : '';
    const jti = typeof payload.jti === 'string' ? payload.jti : '';
    if (!sub || !clientId || !sid || !jti) return { ok: false, reason: 'invalid' };
    const aud = payload.aud;
    const tokenAudiences = (Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : []).filter((a) => typeof a === 'string');
    return {
      ok: true,
      token: {
        iss: String(payload.iss),
        sub,
        clientId,
        sid,
        jti,
        exp: typeof payload.exp === 'number' ? payload.exp : 0,
        audiences: tokenAudiences,
        ...(typeof payload.scope === 'string' && payload.scope ? { scope: payload.scope } : {}),
        ...(Array.isArray(payload.amr) ? { amr: payload.amr.filter((v): v is string => typeof v === 'string') } : {}),
        hints: hintsOf(payload),
      },
    };
  } catch (err) {
    const claim = (err as { claim?: string }).claim;
    const code = (err as { code?: string }).code;
    if (claim === 'aud') return { ok: false, reason: 'audience' };
    if (code === 'ERR_JWT_EXPIRED' || claim === 'exp') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

function hintsOf(payload: JWTPayload): AccessTokenHints {
  const roles = Array.isArray(payload.roles) ? payload.roles.filter((v): v is string => typeof v === 'string') : undefined;
  const grantsVersion = typeof payload.grants_v === 'number' && Number.isFinite(payload.grants_v) ? payload.grants_v : undefined;
  const agents = agentsOf(payload.agents);
  return {
    ...(roles && roles.length > 0 ? { roles } : {}),
    ...(grantsVersion !== undefined ? { grantsVersion } : {}),
    ...(agents ? { agents } : {}),
  };
}

function agentsOf(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [id, roles] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(roles)) continue;
    const names = roles.filter((r): r is string => typeof r === 'string');
    if (names.length > 0) out[id] = names;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function unprotectedTyp(token: string): string | undefined {
  try {
    const typ = decodeProtectedHeader(token).typ;
    return typeof typ === 'string' ? typ.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function stripResource(resource: string): string {
  return resource.split('?')[0]!.split('#')[0]!.replace(/\/+$/, '');
}
