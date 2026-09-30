// DESIGN_AUTHORITY.md §6.12 A2: identity is verified, not asserted. Verifies the identity-aware proxy's signed
// assertion (Cloudflare Access: the `cf-access-jwt-assertion` header or `CF_Authorization` cookie) and maps it to a
// principal. Node's built-in crypto only: RS256 against the team's published keys, nothing else.
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { AuthResult, Principal, Role } from './index.js';

export type AccessClaims = { email?: string; commonName?: string; sub?: string };

export type AccessVerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: string };

/** Returns the parsed JWKS document at `url`. Injectable for tests; the default uses fetch with a timeout. */
export type JwksFetcher = (url: string) => Promise<unknown>;

export type AccessOptions = {
  /** The Access team domain, e.g. `example.cloudflareaccess.com`. The issuer is `https://<teamDomain>`. */
  teamDomain: string;
  /** The Access application audience tag(s). The assertion's `aud` must contain one of them. */
  audience: string | string[];
  /** Verified user emails that get every operator role. Empty: nobody is an admin through Access. */
  adminEmails?: string[];
  fetchJwks?: JwksFetcher;
  /** Allowed clock skew for exp/nbf/iat. Default 60 s. */
  clockSkewSec?: number;
  /** Cached keys are refreshed after this long. Default 1 h. */
  maxKeyAgeMs?: number;
  /** An unknown `kid` refreshes the key set at most this often. Default 30 s. */
  refreshCooldownMs?: number;
  /** At most this many keys are kept from one key set. Default 16. */
  maxKeys?: number;
  now?: () => number;
};

const ADMIN_ROLES: Role[] = ['admin', 'operator', 'approver', 'viewer', 'ingest'];
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;
const B64URL = /^[A-Za-z0-9_-]*$/;

/** `example.cloudflareaccess.com` or `https://example.cloudflareaccess.com/` → `example.cloudflareaccess.com`. */
export function normalizeTeamDomain(raw: string): string {
  const host = raw.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error(`invalid Access team domain: ${raw}`);
  }
  return host;
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) throw new Error(`JWKS ${res.status} at ${url}`);
  const text = await res.text();
  if (text.length > MAX_JWKS_BYTES) throw new Error('JWKS document too large');
  return JSON.parse(text) as unknown;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * RS256 key set for one issuer: cached, refreshed after `maxKeyAgeMs`, re-fetched on an unknown `kid` at most once per
 * `refreshCooldownMs`, one fetch in flight at a time, bounded to `maxKeys` RSA signing keys of at least 2048 bits.
 */
class KeySet {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private attemptedAt = -Infinity;
  private inflight?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly fetchJwks: JwksFetcher,
    private readonly now: () => number,
    private readonly maxAgeMs: number,
    private readonly cooldownMs: number,
    private readonly maxKeys: number,
  ) {}

  async get(kid: string): Promise<KeyObject | undefined> {
    const known = this.keys.get(kid);
    const stale = this.now() - this.fetchedAt > this.maxAgeMs;
    if (known && !stale) return known;
    if (this.inflight) await this.inflight;
    else if (this.now() - this.attemptedAt >= this.cooldownMs) await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      this.attemptedAt = this.now();
      try {
        const doc = (await this.fetchJwks(this.url)) as { keys?: unknown };
        const next = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(doc?.keys) ? doc.keys : []) {
          if (next.size >= this.maxKeys) break;
          const k = jwk as Record<string, unknown>;
          if (typeof k.kid !== 'string' || k.kty !== 'RSA') continue;
          if (k.use !== undefined && k.use !== 'sig') continue;
          if (k.alg !== undefined && k.alg !== 'RS256') continue;
          try {
            const key = createPublicKey({ key: { kty: 'RSA', n: k.n as string, e: k.e as string }, format: 'jwk' });
            if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
            next.set(k.kid, key);
          } catch {
            // malformed key: skip it
          }
        }
        if (next.size) {
          this.keys = next;
          this.fetchedAt = this.now();
        }
      } catch (err) {
        // Keep the keys we have; the next attempt waits for the cooldown.
        console.warn(`[auth] Access key set refresh failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

export type AccessAuth = {
  name: 'cloudflare-access';
  /** Verifies the assertion only: signature, alg, issuer, audience, exp/nbf. */
  verifyAssertion(token: string | undefined): Promise<AccessVerifyResult>;
  /** Verifies the assertion and maps it to a principal. */
  verify(token: string | undefined): Promise<AuthResult>;
};

/** Principal for a verified assertion. Users: admins get every operator role, others view. Service tokens: no roles. */
export function accessPrincipal(claims: AccessClaims, adminEmails: string[]): Principal {
  if (claims.email) {
    const admin = adminEmails.includes(claims.email);
    return { actor: `cloudflare:${claims.email}`, roles: admin ? [...ADMIN_ROLES] : ['viewer'] };
  }
  return { actor: `cloudflare-service:${claims.commonName}`, roles: [] };
}

export function cloudflareAccessAuth(opts: AccessOptions): AccessAuth {
  const team = normalizeTeamDomain(opts.teamDomain);
  const issuer = `https://${team}`;
  const audiences = (Array.isArray(opts.audience) ? opts.audience : opts.audience.split(','))
    .map((a) => a.trim())
    .filter(Boolean);
  if (!audiences.length) throw new Error('Access audience is required');
  const admins = (opts.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const now = opts.now ?? Date.now;
  const skew = opts.clockSkewSec ?? 60;
  const keys = new KeySet(
    `${issuer}/cdn-cgi/access/certs`,
    opts.fetchJwks ?? defaultFetchJwks,
    now,
    opts.maxKeyAgeMs ?? 3600_000,
    opts.refreshCooldownMs ?? 30_000,
    opts.maxKeys ?? 16,
  );

  async function verifyAssertion(token: string | undefined): Promise<AccessVerifyResult> {
    if (!token) return { ok: false, reason: 'no Access assertion' };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'assertion too large' };
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p)) || !parts[2]) return { ok: false, reason: 'malformed assertion' };
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!header || !payload) return { ok: false, reason: 'malformed assertion' };
    if (header.alg !== 'RS256') return { ok: false, reason: `alg ${String(header.alg)} not accepted` };
    if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'assertion has no kid' };
    if (header.crit !== undefined) return { ok: false, reason: 'crit header not supported' };

    const key = await keys.get(header.kid);
    if (!key) return { ok: false, reason: 'unknown kid' };
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    if (!verifySignature('sha256', signed, key, Buffer.from(parts[2], 'base64url'))) {
      return { ok: false, reason: 'bad signature' };
    }

    if (payload.iss !== issuer) return { ok: false, reason: 'wrong issuer' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => typeof a === 'string' && audiences.includes(a))) return { ok: false, reason: 'wrong audience' };
    const t = now() / 1000;
    if (typeof payload.exp !== 'number') return { ok: false, reason: 'assertion has no exp' };
    if (t > payload.exp + skew) return { ok: false, reason: 'assertion expired' };
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || t < payload.nbf - skew)) return { ok: false, reason: 'assertion not yet valid' };
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || t < payload.iat - skew)) return { ok: false, reason: 'assertion issued in the future' };

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const commonName = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (email) return { ok: true, claims: { email, sub } };
    if (commonName) return { ok: true, claims: { commonName, sub } };
    return { ok: false, reason: 'assertion names no user or service' };
  }

  return {
    name: 'cloudflare-access',
    verifyAssertion,
    async verify(token) {
      const r = await verifyAssertion(token);
      return r.ok ? { ok: true, principal: accessPrincipal(r.claims, admins) } : r;
    },
  };
}

/**
 * FACTORY_ACCESS_TEAM_DOMAIN + FACTORY_ACCESS_AUD (comma-separated for several applications) enable Access identity;
 * FACTORY_ADMIN_EMAILS names the admins. Both unset or empty: Access identity is disabled (undefined) and only
 * factory credentials work. Exactly one set is a configuration error.
 */
export function accessAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AccessAuth | undefined {
  const team = (env.FACTORY_ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = (env.FACTORY_ACCESS_AUD ?? '').trim();
  if (!team && !aud) return undefined;
  if (!team || !aud) throw new Error('Access identity needs both FACTORY_ACCESS_TEAM_DOMAIN and FACTORY_ACCESS_AUD');
  return cloudflareAccessAuth({
    teamDomain: team,
    audience: aud,
    adminEmails: (env.FACTORY_ADMIN_EMAILS ?? '').split(','),
  });
}

/** The proxy's assertion on a request: the `cf-access-jwt-assertion` header, else the `CF_Authorization` cookie. */
export function accessAssertionOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const h = headers['cf-access-jwt-assertion'];
  const header = (Array.isArray(h) ? h[0] : h)?.trim();
  if (header) return header;
  const c = headers.cookie;
  for (const part of (Array.isArray(c) ? c.join(';') : c ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'CF_Authorization') return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}
