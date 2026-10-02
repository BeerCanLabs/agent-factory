/**
 * Keymaster connections (DESIGN_AUTHORITY.md §6.11 K1–K4): credentials that act for a person or an app.
 *
 * - User grants (OAuth refresh tokens) are stored one secret per agent × provider (`connections/<agent>/<provider>`)
 *   in the configured secrets backend. Only the Keymaster reads or writes them (K1).
 * - App credentials (OAuth client, service-account key) are Keymaster-held secrets too.
 * - The Keymaster refreshes access tokens, caches them in memory until shortly before expiry, and persists any
 *   rotated refresh token immediately (K3). A revoked or expired grant is marked `needs_reconsent` (K4).
 *
 * No provider SDKs: token calls are plain HTTPS form posts, and JWT-bearer assertions are signed with node:crypto.
 */
import { createSign, randomUUID } from 'node:crypto';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { writableProvider, type SecretProvider } from '@beercanlabs/factory-secrets-bind';

export type GrantStatus = 'active' | 'needs_reconsent';

export type Grant = {
  provider: string;
  /** Name of the Keymaster-held secret with the OAuth client (`{client_id, client_secret}`). */
  clientRef: string;
  refreshToken: string;
  scopes: string[];
  accessToken?: string;
  expiresAt?: string;
  obtainedAt: string;
  grantedBy: string;
  status: GrantStatus;
};

/** What callers may see about a grant. Never tokens. */
export type GrantView = {
  provider: string;
  scopes: string[];
  status: GrantStatus;
  obtainedAt: string;
  grantedBy: string;
  /** When the grant ends, for providers that issue no refresh token (K4): the person reconnects before then. */
  endsAt?: string;
};

export type OAuthClient = { client_id: string; client_secret: string };

export type UserOAuthProvider = {
  kind: 'oauth-user';
  /** Provider family used in grant names and connect links (e.g. `google`). */
  provider: string;
  authUrl: string;
  tokenUrl: string;
  /** Default Keymaster secret holding the OAuth client. */
  clientSecret: string;
  /** Extra authorization-request parameters (e.g. offline access). */
  authParams: Record<string, string>;
  /**
   * `false`: the provider issues no refresh token (LinkedIn standard apps). The grant is the access token itself and
   * ends when it expires; the Keymaster marks it needs re-consent then (K4).
   */
  refresh?: false;
};

export type JwtBearerProvider = {
  kind: 'jwt-bearer';
  provider: string;
  tokenUrl: string;
  /** Keymaster secret holding the service-account key file JSON. */
  keySecret: string;
  defaultScopes: string[];
};

export type ConnectionProvider = UserOAuthProvider | JwtBearerProvider;

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Connections the Keymaster knows how to serve. A connection name is what cartridges and gatekeeper-egress routes declare. */
export const CONNECTION_PROVIDERS: Record<string, ConnectionProvider> = {
  google: {
    kind: 'oauth-user',
    provider: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: GOOGLE_TOKEN_URL,
    clientSecret: 'GOOGLE_OAUTH_CLIENT',
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  linkedin: {
    kind: 'oauth-user',
    provider: 'linkedin',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    clientSecret: 'LINKEDIN_OAUTH_CLIENT',
    authParams: {},
    refresh: false,
  },
  'google-service-account': {
    kind: 'jwt-bearer',
    provider: 'google-service-account',
    tokenUrl: GOOGLE_TOKEN_URL,
    keySecret: 'GOOGLE_SERVICE_ACCOUNT',
    defaultScopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  },
};

export function connectionProvider(name: string): ConnectionProvider | undefined {
  return Object.hasOwn(CONNECTION_PROVIDERS, name) ? CONNECTION_PROVIDERS[name] : undefined;
}

export const grantSecretName = (agentId: string, provider: string) => `connections/${agentId}/${provider}`;

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export type TokenOutcome =
  | { ok: true; accessToken: string; expiresAt: string }
  | { ok: false; error: 'needs_reconsent'; provider: string; reason: string }
  | { ok: false; error: 'unknown_connection' | 'connection_unconfigured' | 'connection_unavailable'; message: string };

export type ConnectionKeymasterOptions = {
  providers: SecretProvider[];
  ledger?: LedgerStore;
  /** Every token value the Keymaster sees is added here so the factory can redact it (S1 backstop). */
  secretValues?: Set<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before expiry. Default 60s. */
  skewMs?: number;
};

/** `scopes`: what the underlying grant covers (user grants), so a cache hit can still enforce scope coverage. */
type CachedToken = { accessToken: string; expiresAtMs: number; scopes?: string[] };

export class ConnectionKeymaster {
  private readonly providers: SecretProvider[];
  private readonly ledger?: LedgerStore;
  private readonly secretValues: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<TokenOutcome>>();

  constructor(opts: ConnectionKeymasterOptions) {
    this.providers = opts.providers;
    this.ledger = opts.ledger;
    this.secretValues = opts.secretValues ?? new Set();
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 60_000;
  }

  // ---- secret storage ------------------------------------------------------------------------

  async readSecret(name: string): Promise<string | undefined> {
    for (const p of this.providers) {
      const v = await p.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  async writeSecret(name: string, value: string): Promise<void> {
    const w = writableProvider(this.providers);
    if (!w) throw new Error('no writable secrets backend is configured for the Keymaster');
    await w.put(name, value);
  }

  private remember(...values: Array<string | undefined>) {
    for (const v of values) if (v && v.length >= 8) this.secretValues.add(v);
  }

  async getGrant(agentId: string, provider: string): Promise<Grant | undefined> {
    if (!SLUG.test(agentId) || !SLUG.test(provider)) return undefined;
    const raw = await this.readSecret(grantSecretName(agentId, provider));
    if (!raw) return undefined;
    try {
      const g = JSON.parse(raw) as Grant;
      if (!g || typeof g.refreshToken !== 'string') return undefined;
      this.remember(g.refreshToken, g.accessToken);
      return { ...g, scopes: Array.isArray(g.scopes) ? g.scopes : [] };
    } catch {
      return undefined;
    }
  }

  async saveGrant(agentId: string, grant: Grant): Promise<void> {
    if (!SLUG.test(agentId) || !SLUG.test(grant.provider)) throw new Error('invalid agent or provider id');
    this.remember(grant.refreshToken, grant.accessToken);
    await this.writeSecret(grantSecretName(agentId, grant.provider), JSON.stringify(grant));
    // A new grant replaces whatever was cached for this agent × provider.
    for (const k of this.cache.keys()) if (k.startsWith(`${agentId}\u0000${grant.provider}\u0000`)) this.cache.delete(k);
    if (grant.accessToken && grant.expiresAt) {
      this.cache.set(cacheKey(agentId, grant.provider, []), { accessToken: grant.accessToken, expiresAtMs: Date.parse(grant.expiresAt), scopes: grant.scopes });
    }
  }

  static view(g: Grant): GrantView {
    const def = connectionProvider(g.provider);
    const ends = def?.kind === 'oauth-user' && def.refresh === false && g.status === 'active' ? g.expiresAt : undefined;
    return { provider: g.provider, scopes: g.scopes, status: g.status, obtainedAt: g.obtainedAt, grantedBy: g.grantedBy, ...(ends ? { endsAt: ends } : {}) };
  }

  async listGrants(agentId: string, providers: string[] = Object.keys(CONNECTION_PROVIDERS)): Promise<GrantView[]> {
    const out: GrantView[] = [];
    for (const p of providers) {
      const g = await this.getGrant(agentId, p);
      if (g) out.push(ConnectionKeymaster.view(g));
    }
    return out;
  }

  async oauthClient(ref: string): Promise<OAuthClient | undefined> {
    const raw = await this.readSecret(ref);
    if (!raw) return undefined;
    try {
      const j = JSON.parse(raw) as Partial<OAuthClient> & { web?: Partial<OAuthClient>; installed?: Partial<OAuthClient> };
      // Accept the flat form and Google's downloaded client file ({"web": {...}} / {"installed": {...}}).
      const c = j.client_id ? j : (j.web ?? j.installed);
      if (!c?.client_id || !c.client_secret) return undefined;
      this.remember(c.client_secret);
      return { client_id: c.client_id, client_secret: c.client_secret };
    } catch {
      return undefined;
    }
  }

  // ---- access tokens (K3) --------------------------------------------------------------------

  /** A current access token for an agent's connection, refreshing (and persisting rotations) as needed. */
  async accessToken(agentId: string, connection: string, scopes: string[] = []): Promise<TokenOutcome> {
    const def = connectionProvider(connection);
    if (!def) return { ok: false, error: 'unknown_connection', message: `unknown connection "${connection}"` };
    const wanted = [...new Set(scopes.length ? scopes : def.kind === 'jwt-bearer' ? def.defaultScopes : [])].sort();
    // Service-account tokens are app-level: one cache entry per scope set, shared by agents allowed to use it.
    const key = def.kind === 'jwt-bearer' ? cacheKey('*', connection, wanted) : cacheKey(agentId, def.provider, []);
    const hit = this.cache.get(key);
    const covered = !hit?.scopes || wanted.every((s) => hit.scopes!.includes(s));
    if (hit && covered && hit.expiresAtMs - this.skewMs > this.now()) {
      return { ok: true, accessToken: hit.accessToken, expiresAt: new Date(hit.expiresAtMs).toISOString() };
    }
    // One refresh at a time per grant: concurrent callers share it (and a rotated refresh token is written once).
    const flight = `${key}\u0000${wanted.join(' ')}`;
    const running = this.inflight.get(flight);
    if (running) return running;
    const p = (def.kind === 'jwt-bearer' ? this.mintJwtBearer(def, wanted, key) : this.refreshUser(agentId, def, wanted, key)).finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, p);
    return p;
  }

  /** Drop a cached token (e.g. the upstream rejected it). */
  invalidate(agentId: string, connection: string): void {
    const def = connectionProvider(connection);
    if (!def) return;
    for (const k of this.cache.keys()) {
      if (def.kind === 'jwt-bearer' ? k.startsWith(`*\u0000${connection}\u0000`) : k.startsWith(`${agentId}\u0000${def.provider}\u0000`)) this.cache.delete(k);
    }
  }

  private async refreshUser(agentId: string, def: UserOAuthProvider, wanted: string[], key: string): Promise<TokenOutcome> {
    const grant = await this.getGrant(agentId, def.provider);
    if (!grant) return { ok: false, error: 'needs_reconsent', provider: def.provider, reason: 'no_grant' };
    if (grant.status === 'needs_reconsent') return { ok: false, error: 'needs_reconsent', provider: def.provider, reason: 'grant_marked' };
    const missing = wanted.filter((s) => !grant.scopes.includes(s));
    if (missing.length) return { ok: false, error: 'needs_reconsent', provider: def.provider, reason: 'scopes_not_granted' };

    // A stored access token (from consent or import) is still usable after a restart.
    if (grant.accessToken && grant.expiresAt && Date.parse(grant.expiresAt) - this.skewMs > this.now()) {
      this.cache.set(key, { accessToken: grant.accessToken, expiresAtMs: Date.parse(grant.expiresAt), scopes: grant.scopes });
      return { ok: true, accessToken: grant.accessToken, expiresAt: grant.expiresAt };
    }

    // No refresh token (K4): the grant ended with its access token. The person reconnects; nothing is worked around.
    if (def.refresh === false || !grant.refreshToken) {
      await this.markNeedsReconsent(agentId, grant);
      return { ok: false, error: 'needs_reconsent', provider: def.provider, reason: 'grant_ended' };
    }

    const client = await this.oauthClient(grant.clientRef || def.clientSecret);
    if (!client) return { ok: false, error: 'connection_unconfigured', message: `OAuth client secret ${grant.clientRef || def.clientSecret} is not set` };

    let res: Response;
    let body: Record<string, unknown>;
    try {
      res = await this.fetchFn(def.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: client.client_id, client_secret: client.client_secret }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: 'connection_unavailable', message: `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      // invalid_grant: the refresh token was revoked, expired, or issued to another client (K4).
      if (code === 'invalid_grant') {
        await this.markNeedsReconsent(agentId, grant);
        return { ok: false, error: 'needs_reconsent', provider: def.provider, reason: code };
      }
      return { ok: false, error: 'connection_unavailable', message: `token refresh failed: ${code}` };
    }
    const accessToken = body.access_token;
    const expiresAtMs = this.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
    this.remember(accessToken);
    this.cache.set(key, { accessToken, expiresAtMs, scopes: grant.scopes });
    // K3: a rotated refresh token must be persisted at once, or the grant is lost on the next restart.
    if (typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== grant.refreshToken) {
      this.remember(body.refresh_token);
      const rotated: Grant = { ...grant, refreshToken: body.refresh_token, accessToken, expiresAt: new Date(expiresAtMs).toISOString() };
      await this.writeSecret(grantSecretName(agentId, def.provider), JSON.stringify(rotated));
      this.ledger?.append({
        timestamp: new Date(this.now()).toISOString(),
        agentId,
        type: 'action',
        action: 'CONNECTION_REFRESH_TOKEN_ROTATED',
        actor: 'factory:keymaster',
        provider: def.provider,
      });
    }
    return { ok: true, accessToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private async markNeedsReconsent(agentId: string, grant: Grant) {
    this.invalidate(agentId, grant.provider);
    const marked: Grant = { ...grant, status: 'needs_reconsent', accessToken: undefined, expiresAt: undefined };
    try {
      await this.writeSecret(grantSecretName(agentId, grant.provider), JSON.stringify(marked));
    } catch (err) {
      console.error(`[keymaster] could not mark ${agentId}/${grant.provider} needs_reconsent: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.ledger?.append({
      timestamp: new Date(this.now()).toISOString(),
      agentId,
      type: 'action',
      action: 'CONNECTION_MARKED_NEEDS_RECONSENT',
      actor: 'factory:keymaster',
      provider: grant.provider,
    });
  }

  private async mintJwtBearer(def: JwtBearerProvider, scopes: string[], key: string): Promise<TokenOutcome> {
    const raw = await this.readSecret(def.keySecret);
    let sa: { client_email?: string; private_key?: string; private_key_id?: string; token_uri?: string } | undefined;
    try {
      sa = raw ? JSON.parse(raw) : undefined;
    } catch {
      sa = undefined;
    }
    if (!sa?.client_email || !sa.private_key) return { ok: false, error: 'connection_unconfigured', message: `service-account secret ${def.keySecret} is not set` };
    this.remember(sa.private_key);
    const aud = sa.token_uri || def.tokenUrl;
    let assertion: string;
    try {
      assertion = signJwtRs256(
        { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) },
        { iss: sa.client_email, scope: scopes.join(' '), aud, iat: Math.floor(this.now() / 1000), exp: Math.floor(this.now() / 1000) + 3600 },
        sa.private_key,
      );
    } catch (err) {
      return { ok: false, error: 'connection_unconfigured', message: `service-account key cannot sign: ${err instanceof Error ? err.message : String(err)}` };
    }
    let res: Response;
    let body: Record<string, unknown>;
    try {
      res = await this.fetchFn(aud, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: 'connection_unavailable', message: `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok || typeof body.access_token !== 'string') {
      return { ok: false, error: 'connection_unavailable', message: `service-account token failed: ${typeof body.error === 'string' ? body.error : `http_${res.status}`}` };
    }
    const expiresAtMs = this.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
    this.remember(body.access_token);
    this.cache.set(key, { accessToken: body.access_token, expiresAtMs });
    return { ok: true, accessToken: body.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  // ---- consent (K2) --------------------------------------------------------------------------

  /** Exchange an authorization code for a grant (does not store it). */
  async exchangeCode(
    connection: string,
    params: { code: string; redirectUri: string; clientRef?: string },
  ): Promise<{ ok: true; refreshToken: string; accessToken?: string; expiresAt?: string; scopes: string[]; clientRef: string } | { ok: false; error: string }> {
    const def = connectionProvider(connection);
    if (!def || def.kind !== 'oauth-user') return { ok: false, error: 'unknown_connection' };
    const clientRef = params.clientRef ?? def.clientSecret;
    const client = await this.oauthClient(clientRef);
    if (!client) return { ok: false, error: 'oauth_client_unconfigured' };
    let res: Response;
    let body: Record<string, unknown>;
    try {
      res = await this.fetchFn(def.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: client.client_id,
          client_secret: client.client_secret,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'token_endpoint_unreachable' };
    }
    if (!res.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${res.status}` };
    const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    // A provider without refresh tokens grants the access token alone; every other provider must send one.
    if (def.refresh === false ? !accessToken : !refreshToken) return { ok: false, error: def.refresh === false ? 'no_access_token' : 'no_refresh_token' };
    this.remember(refreshToken, accessToken);
    const expiresAt = accessToken ? new Date(this.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000).toISOString() : undefined;
    // Google separates granted scopes with spaces, LinkedIn with commas.
    const scopes = typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : [];
    return { ok: true, refreshToken, accessToken, expiresAt, scopes, clientRef };
  }
}

function cacheKey(agentId: string, provider: string, scopes: string[]): string {
  return `${agentId}\u0000${provider}\u0000${scopes.join(' ')}`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT (RFC 7515/7519) signed with node:crypto. */
export function signJwtRs256(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

export const newNonce = () => randomUUID();
