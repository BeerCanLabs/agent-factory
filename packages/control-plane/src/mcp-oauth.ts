import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ROLES,
  accessKindOfUrl,
  canonicalAccessResource,
  canonicalAudiences,
  hashApiKey,
  isFactoryAccessJwt,
  sameHash,
  signAccessToken,
  verifyAccessToken,
  DEFAULT_OAUTH_SCOPE,
  FACTORY_SCOPES,
  FIRST_PARTY_HEADS,
  type AccessTokenHints,
  type Principal,
  type Role,
} from '@beercanlabs/factory-auth';
import { consentCovers, mapOAuthScopeToKeyScopes, normalizeRequestedScopes, scopeViews } from './oauth-scopes.js';
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';
import { actorIsAdmin, effectiveGrantsForActor, identify, json, readBody, readJson, resolveVerifiedPrincipal, type FactoryState } from './app.js';
import { allowedIssuerOrigins, ensureAsKeys, resolveAsIssuer } from './as-discovery.js';
import { SESSION_COOKIE, cookieValue, sessionEmail, sessionIdp } from './login.js';
import { isSnapshotConflict } from './revocation-set.js';

export type McpOAuthClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: 'none';
  createdAt: string;
  isCimd?: boolean;
  clientUri?: string;
  /** Admin-set. DCR and CIMD cannot turn this on. Skips the consent screen. */
  firstParty?: boolean;
  /** Admin-set. Authorize and token refuse a blocked client, and its refresh families are revoked. */
  blocked?: boolean;
};

export type McpOAuthConsentRecord = {
  principalId: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

export type McpOAuthRefreshTokenRecord = {
  tokenHash: string;
  familyId: string;
  generation: number;
  principalId: string;
  clientId: string;
  clientName: string;
  deviceFamily: string;
  keyId: string;
  scope?: string;
  /** First audience, kept so a record written before Slice 2 still refreshes. */
  audience?: string;
  /** Canonical api/mcp resource URIs authorized for this refresh family. */
  audiences?: string[];
  /** How the person signed in when the grant was issued. A hint copied onto the access token (`amr`). */
  amr?: string[];
  expiresAt: string;
  createdAt: string;
  rotatedAt?: string;
  familyRevoked?: boolean;
  /**
   * D-4 holder. Absent means a person (30-day sliding). `device` is the 90-day sliding lifetime.
   * Device-flow issuance is Phase 2, so authorization-code grants stay `person` until a record says otherwise.
   */
  holder?: 'person' | 'device';
  /** Browser session that approved this family. Sign-out revokes every family carrying its sid. */
  sessionSid?: string;
};

export type RefreshHolder = 'person' | 'device';

/** D-4: people slide 30 days; approved devices slide 90 days. */
export const REFRESH_PERSON_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_DEVICE_MS = 90 * 24 * 60 * 60 * 1000;

export function refreshLifetimeMs(holder: RefreshHolder | undefined): number {
  return holder === 'device' ? REFRESH_DEVICE_MS : REFRESH_PERSON_MS;
}

export function refreshHolderOf(holder: RefreshHolder | undefined): RefreshHolder {
  return holder === 'device' ? 'device' : 'person';
}

/** The presented refresh token was already rotated or its family was already revoked. The caller revokes the family. */
export class RefreshReuseError extends Error {
  readonly code = 'refresh_reuse';
  constructor(readonly familyId: string, readonly principalId: string) {
    super('refresh_reuse');
    this.name = 'RefreshReuseError';
  }
}

export type McpOAuthDoc = {
  clients: McpOAuthClientRecord[];
  consents: McpOAuthConsentRecord[];
  refreshTokens: McpOAuthRefreshTokenRecord[];
};

export type PendingOAuthRequest = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  scope?: string;
  resource?: string;
  expiresAt: number;
  csrfToken?: string;
  principalId?: string;
};

export type PendingAuthCode = {
  code: string;
  clientId: string;
  principalId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  /** Space-separated canonical resource URIs authorized for the code. Absent means mcp only. */
  resource?: string;
  /** IdP that proved the person at authorize time (`amr` on the access token). */
  amr?: string[];
  /** Browser session that approved the consent, copied onto the refresh family. */
  sessionSid?: string;
  expiresAt: number;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ALLOWED_SCHEMES = new Set(['cursor:', 'vscode:', 'claude:', 'antigravity:']);

export function isValidRedirectUri(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
    if (ALLOWED_SCHEMES.has(u.protocol)) return true;
    return false;
  } catch {
    return false;
  }
}

export function matchesRedirectUri(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const regUrl = new URL(registered);
    const reqUrl = new URL(requested);
    // RFC 8252: loopback redirect URIs may use ephemeral ports
    if (
      (regUrl.hostname === '127.0.0.1' || regUrl.hostname === 'localhost') &&
      regUrl.protocol === 'http:' &&
      reqUrl.protocol === 'http:' &&
      regUrl.hostname === reqUrl.hostname &&
      regUrl.pathname === reqUrl.pathname
    ) {
      return true;
    }
  } catch {}
  return false;
}

export class McpOAuthStore {
  private docVersion = 0;
  private unhealthy?: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  private reloadFlight?: Promise<void>;

  private clientsById = new Map<string, McpOAuthClientRecord>();
  private consentsByPrincipal = new Map<string, Map<string, McpOAuthConsentRecord>>();
  private refreshTokensByHash = new Map<string, McpOAuthRefreshTokenRecord>();

  // In-memory short-lived state with lazy eviction
  private pendingRequests = new Map<string, PendingOAuthRequest>();
  private pendingCodes = new Map<string, PendingAuthCode>();
  private dcrRateLimits = new Map<string, number[]>();

  private readonly now: () => Date;

  private constructor(
    private readonly backend: VersionedDocBackend<McpOAuthDoc>,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  static async open(
    backend: VersionedDocBackend<McpOAuthDoc> = new MemoryDocBackend<McpOAuthDoc>(),
    opts?: { now?: () => Date },
  ): Promise<McpOAuthStore> {
    const store = new McpOAuthStore(backend, opts);
    try {
      await store.reload();
    } catch {
      // fail closed
    }
    return store;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  async reload(): Promise<void> {
    if (this.reloadFlight) return this.reloadFlight;
    const flight = this.serial(() => this.reloadUnlocked());
    this.reloadFlight = flight;
    try {
      await flight;
    } finally {
      if (this.reloadFlight === flight) this.reloadFlight = undefined;
    }
  }

  private async reloadUnlocked(): Promise<void> {
    try {
      const st = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();

      const nextClients = new Map<string, McpOAuthClientRecord>();
      for (const c of st.snapshot?.data?.clients ?? []) {
        if (c?.clientId) nextClients.set(c.clientId, structuredClone(c));
      }

      const nextConsents = new Map<string, Map<string, McpOAuthConsentRecord>>();
      for (const c of st.snapshot?.data?.consents ?? []) {
        if (c?.principalId && c.clientId) {
          let userMap = nextConsents.get(c.principalId);
          if (!userMap) {
            userMap = new Map();
            nextConsents.set(c.principalId, userMap);
          }
          userMap.set(c.clientId, structuredClone(c));
        }
      }

      const nextRefresh = new Map<string, McpOAuthRefreshTokenRecord>();
      for (const r of st.snapshot?.data?.refreshTokens ?? []) {
        if (r?.tokenHash) nextRefresh.set(r.tokenHash, structuredClone(r));
      }

      this.clientsById = nextClients;
      this.consentsByPrincipal = nextConsents;
      this.refreshTokensByHash = nextRefresh;
      // Follow the current pointer only. A version file whose pointer has not landed yet must not
      // be skipped: writing the older body at a higher version would hide the other task's update.
      this.docVersion = st.snapshot?.version ?? 0;
      this.unhealthy = undefined;
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Reload, apply, commit. A version clash with another task reloads and applies again so neither write is dropped.
   * `apply` must only touch the in-memory maps; a throw restores the durable snapshot.
   */
  private async change<T>(by: string, apply: () => T): Promise<T> {
    return this.serial(async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.reloadUnlocked();
        let result: T;
        try {
          result = apply();
        } catch (err) {
          await this.reloadUnlocked().catch(() => undefined);
          throw err;
        }
        try {
          await this.commit(by);
          return result;
        } catch (err) {
          last = err;
          if (!isSnapshotConflict(err)) throw err;
        }
      }
      throw last instanceof Error ? last : new Error('oauth_conflict');
    });
  }

  private async commit(by: string): Promise<void> {
    const clients = [...this.clientsById.values()].sort((a, b) => a.clientId.localeCompare(b.clientId));
    const consents: McpOAuthConsentRecord[] = [];
    for (const m of this.consentsByPrincipal.values()) {
      consents.push(...m.values());
    }
    consents.sort((a, b) => (a.principalId + a.clientId).localeCompare(b.principalId + b.clientId));

    const refreshTokens = [...this.refreshTokensByHash.values()].sort((a, b) => a.tokenHash.localeCompare(b.tokenHash));

    const data: McpOAuthDoc = { clients, consents, refreshTokens };
    const version = this.docVersion + 1;
    try {
      await this.backend.write({
        version,
        updatedAt: this.now().toISOString(),
        updatedBy: by,
        sha256: snapshotSha256(data),
        data,
      });
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
    this.docVersion = version;
  }

  getClient(clientId: string): McpOAuthClientRecord | undefined {
    const c = this.clientsById.get(clientId);
    return c ? structuredClone(c) : undefined;
  }

  async registerClient(client: McpOAuthClientRecord, by = 'dcr'): Promise<McpOAuthClientRecord> {
    return this.change(by, () => {
      // Bound total unconsented clients to 1000
      if (this.clientsById.size >= 1000) {
        const consentedClientIds = new Set<string>();
        for (const userMap of this.consentsByPrincipal.values()) {
          for (const c of userMap.keys()) consentedClientIds.add(c);
        }
        for (const [id] of this.clientsById.entries()) {
          if (!consentedClientIds.has(id)) {
            this.clientsById.delete(id);
            if (this.clientsById.size < 950) break;
          }
        }
      }
      const existing = this.clientsById.get(client.clientId);
      const next = structuredClone(client);
      // A public registration cannot promote itself or clear an admin block.
      if (by !== 'admin') {
        next.firstParty = existing?.firstParty === true;
        next.blocked = existing?.blocked === true;
      }
      this.clientsById.set(client.clientId, next);
      return structuredClone(next);
    });
  }

  /**
   * Admin registration. `firstParty` and `blocked` are taken from the caller. Turning `blocked` on
   * revokes every refresh family for the client in the same write, so a lost race retries both.
   */
  async upsertAdminClient(input: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    /** Omitted keeps the stored flag. */
    firstParty?: boolean;
    blocked?: boolean;
  }): Promise<{ record: McpOAuthClientRecord; families: FamilyRevocation[] }> {
    return this.change('admin', () => {
      const existing = this.clientsById.get(input.clientId);
      const firstParty = input.firstParty ?? existing?.firstParty === true;
      const blocked = input.blocked ?? existing?.blocked === true;
      const record: McpOAuthClientRecord = {
        clientId: input.clientId,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        grantTypes: existing?.grantTypes ?? ['authorization_code', 'refresh_token'],
        responseTypes: existing?.responseTypes ?? ['code'],
        tokenEndpointAuthMethod: 'none',
        createdAt: existing?.createdAt ?? this.now().toISOString(),
        ...(existing?.isCimd ? { isCimd: true, clientUri: existing.clientUri } : {}),
        firstParty,
        blocked,
      };
      this.clientsById.set(input.clientId, record);
      const families = blocked && existing?.blocked !== true ? this.markFamilies((r) => r.clientId === input.clientId) : [];
      return { record: structuredClone(record), families };
    });
  }

  /** Flag Console, Garrison, Web Chat, and Connect as first-party for one factory origin. */
  async ensureFirstPartyHeads(origin: string): Promise<void> {
    let root: string;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad scheme');
      root = url.origin;
    } catch {
      throw new Error('invalid_factory_origin');
    }
    await this.change('first-party', () => {
      for (const head of FIRST_PARTY_HEADS) {
        const existing = this.clientsById.get(head.id);
        const redirect = `${root}${head.path}`;
        if (!existing && !isValidRedirectUri(redirect)) continue;
        this.clientsById.set(head.id, {
          clientId: head.id,
          clientName: head.name,
          redirectUris: existing?.redirectUris?.length ? existing.redirectUris : [redirect],
          grantTypes: existing?.grantTypes ?? ['authorization_code', 'refresh_token'],
          responseTypes: existing?.responseTypes ?? ['code'],
          tokenEndpointAuthMethod: 'none',
          createdAt: existing?.createdAt ?? this.now().toISOString(),
          firstParty: true,
          blocked: existing?.blocked === true,
        });
      }
    });
  }

  async fetchCimd(clientUri: string, fetchFn: typeof fetch = fetch): Promise<McpOAuthClientRecord> {
    let u: URL;
    try {
      u = new URL(clientUri);
    } catch {
      throw new Error('invalid_client_uri: must be a valid URL');
    }
    if (u.protocol !== 'https:' || u.pathname.length <= 1) {
      throw new Error('invalid_client_uri: must be https with non-root path');
    }
    if (isPrivateOrInternalHost(u.hostname)) {
      throw new Error('invalid_client_uri: private hostnames forbidden');
    }

    // Check cached
    const existing = [...this.clientsById.values()].find((c) => c.isCimd && c.clientUri === clientUri);
    if (existing) return existing;

    const res = await fetchFn(clientUri, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`cimd_fetch_failed: HTTP ${res.status}`);

    const cl = res.headers?.get ? res.headers.get('content-length') : undefined;
    if (cl && Number(cl) > 32768) {
      throw new Error('cimd_document_too_large: max 32KB');
    }

    let raw = '';
    if (res.body && typeof (res.body as any)[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of res.body as any) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > 32768) {
          throw new Error('cimd_document_too_large: max 32KB');
        }
        chunks.push(buf);
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } else {
      raw = await res.text();
      if (raw.length > 32768) throw new Error('cimd_document_too_large: max 32KB');
    }

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('cimd_invalid_json');
    }

    if (data.client_id !== clientUri) {
      throw new Error('cimd_client_id_mismatch');
    }
    if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0 || data.redirect_uris.some((r: any) => typeof r !== 'string' || !isValidRedirectUri(r))) {
      throw new Error('cimd_invalid_redirect_uris');
    }

    const shortId = 'mcp:cimd_' + createHash('sha256').update(clientUri).digest('hex').slice(0, 16);
    const clientRecord: McpOAuthClientRecord = {
      clientId: clientUri,
      clientName: typeof data.client_name === 'string' && data.client_name.trim() ? data.client_name.trim().slice(0, 120) : shortId,
      redirectUris: data.redirect_uris,
      tokenEndpointAuthMethod: 'none',
      isCimd: true,
      clientUri,
      createdAt: this.now().toISOString(),
    };

    return this.registerClient(clientRecord, 'cimd');
  }

  checkDcrRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - 60000;
    if (this.dcrRateLimits.size > 1000) {
      for (const [key, times] of this.dcrRateLimits.entries()) {
        const active = times.filter((t) => t > windowStart);
        if (active.length === 0) {
          this.dcrRateLimits.delete(key);
        } else {
          this.dcrRateLimits.set(key, active);
        }
      }
    }
    let timestamps = this.dcrRateLimits.get(ip) ?? [];
    timestamps = timestamps.filter((t) => t > windowStart);
    if (timestamps.length === 0) {
      this.dcrRateLimits.delete(ip);
    }
    if (timestamps.length >= 20) {
      this.dcrRateLimits.set(ip, timestamps);
      return false;
    }
    timestamps.push(now);
    this.dcrRateLimits.set(ip, timestamps);
    return true;
  }

  getConsent(principalId: string, clientId: string): McpOAuthConsentRecord | undefined {
    const rec = this.consentsByPrincipal.get(principalId)?.get(clientId);
    return rec ? structuredClone(rec) : undefined;
  }

  hasConsent(principalId: string, clientId: string, requestedScope?: string): boolean {
    const c = this.getConsent(principalId, clientId);
    if (!c) return false;
    if (!requestedScope) return true;
    return consentCovers(c.scope, requestedScope.split(/\s+/).filter(Boolean));
  }

  listConsents(principalId: string): McpOAuthConsentRecord[] {
    const userMap = this.consentsByPrincipal.get(principalId);
    if (!userMap) return [];
    return [...userMap.values()].map((c) => structuredClone(c));
  }

  async saveConsent(consent: Omit<McpOAuthConsentRecord, 'createdAt' | 'updatedAt'>): Promise<McpOAuthConsentRecord> {
    return this.change(consent.principalId, () => {
      let userMap = this.consentsByPrincipal.get(consent.principalId);
      if (!userMap) {
        userMap = new Map();
        this.consentsByPrincipal.set(consent.principalId, userMap);
      }
      const existing = userMap.get(consent.clientId);
      const nowIso = this.now().toISOString();
      const rec: McpOAuthConsentRecord = {
        ...consent,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      userMap.set(consent.clientId, rec);
      return structuredClone(rec);
    });
  }

  async revokeConsent(principalId: string, clientId: string): Promise<boolean> {
    return this.change(principalId, () => {
      const userMap = this.consentsByPrincipal.get(principalId);
      if (!userMap) return false;
      const existed = userMap.delete(clientId);
      if (existed) {
        for (const r of this.refreshTokensByHash.values()) {
          if (r.principalId === principalId && r.clientId === clientId) r.familyRevoked = true;
        }
      }
      return existed;
    });
  }

  storePendingRequest(req: Omit<PendingOAuthRequest, 'expiresAt'>): string {
    const now = Date.now();
    for (const [k, p] of this.pendingRequests.entries()) {
      if (p.expiresAt <= now) this.pendingRequests.delete(k);
    }
    const nonce = b64url(randomBytes(24));
    this.pendingRequests.set(nonce, { ...req, expiresAt: now + 10 * 60 * 1000 });
    return nonce;
  }

  takePendingRequest(nonce: string): PendingOAuthRequest | undefined {
    const p = this.pendingRequests.get(nonce);
    if (!p) return undefined;
    this.pendingRequests.delete(nonce);
    if (p.expiresAt <= Date.now()) return undefined;
    return p;
  }

  storeAuthCode(codeData: Omit<PendingAuthCode, 'code' | 'expiresAt'>): string {
    const now = Date.now();
    for (const [k, c] of this.pendingCodes.entries()) {
      if (c.expiresAt <= now) this.pendingCodes.delete(k);
    }
    const code = 'mcpa_' + b64url(randomBytes(24));
    this.pendingCodes.set(code, { ...codeData, code, expiresAt: now + 60 * 1000 });
    return code;
  }

  takeAuthCode(code: string): PendingAuthCode | undefined {
    const c = this.pendingCodes.get(code);
    if (!c) return undefined;
    this.pendingCodes.delete(code);
    if (c.expiresAt <= Date.now()) return undefined;
    return c;
  }

  getRefreshTokenByHash(hash: string): McpOAuthRefreshTokenRecord | undefined {
    const r = this.refreshTokensByHash.get(hash);
    return r ? structuredClone(r) : undefined;
  }

  async saveRefreshToken(tokenRec: McpOAuthRefreshTokenRecord): Promise<void> {
    await this.change(tokenRec.principalId, () => {
      this.refreshTokensByHash.set(tokenRec.tokenHash, structuredClone(tokenRec));
    });
  }

  async rotateRefreshTokenFamily(
    oldTokenHash: string,
    newTokenHash: string,
    newExpiresAt: string,
    keyId: string,
    patch?: { audience?: string; audiences?: string[]; amr?: string[]; holder?: RefreshHolder },
  ): Promise<McpOAuthRefreshTokenRecord> {
    return this.change('refresh', () => {
      const cur = this.refreshTokensByHash.get(oldTokenHash);
      if (!cur) throw new Error('refresh_token_not_found');
      // Inside the write lock, after reload. A second presentation of this generation is reuse,
      // including when the conflict retry observes the other task's rotation.
      if (cur.rotatedAt || cur.familyRevoked) throw new RefreshReuseError(cur.familyId, cur.principalId);
      cur.rotatedAt = this.now().toISOString();
      const next: McpOAuthRefreshTokenRecord = {
        ...structuredClone(cur),
        tokenHash: newTokenHash,
        generation: cur.generation + 1,
        keyId,
        expiresAt: newExpiresAt,
        createdAt: this.now().toISOString(),
        ...(patch?.audience ? { audience: patch.audience } : {}),
        ...(patch?.audiences ? { audiences: patch.audiences } : {}),
        ...(patch?.amr ? { amr: patch.amr } : {}),
        ...(patch?.holder ? { holder: patch.holder } : {}),
      };
      delete next.rotatedAt;
      this.refreshTokensByHash.set(newTokenHash, next);
      return structuredClone(next);
    });
  }

  async revokeRefreshTokenFamily(familyId: string, by = 'system'): Promise<string[]> {
    return this.revokeMatching((r) => r.familyId === familyId, by);
  }

  /** End every family approved by this browser session. */
  async revokeFamiliesForSession(sessionSid: string, by = 'sign-out'): Promise<FamilyRevocation[]> {
    return this.revokeGrouped((r) => r.sessionSid === sessionSid, by);
  }

  /** End every refresh family owned by this principal (#436). */
  async revokeFamiliesForPrincipal(principalId: string, by = 'revoke-all'): Promise<FamilyRevocation[]> {
    return this.revokeGrouped((r) => r.principalId === principalId, by);
  }

  /** End families for one connected app. */
  async revokeFamiliesForClient(principalId: string, clientId: string, by = 'consent'): Promise<FamilyRevocation[]> {
    return this.revokeGrouped((r) => r.principalId === principalId && r.clientId === clientId, by);
  }

  /**
   * The current generation of a family, or undefined when no record uses this id.
   * `revoked` is true when the family was revoked (reuse, sign-out, consent, or an explicit revoke).
   */
  liveFamily(familyId: string): { familyId: string; principalId: string; clientId: string; keyId: string; revoked: boolean } | undefined {
    let current: McpOAuthRefreshTokenRecord | undefined;
    let any: McpOAuthRefreshTokenRecord | undefined;
    for (const r of this.refreshTokensByHash.values()) {
      if (r.familyId !== familyId) continue;
      any = r;
      if (!r.rotatedAt) current = r;
    }
    const row = current ?? any;
    if (!row) return undefined;
    return {
      familyId,
      principalId: row.principalId,
      clientId: row.clientId,
      keyId: row.keyId,
      revoked: Boolean(row.familyRevoked),
    };
  }

  /** One row per live family: the generation a client can still present. */
  listFamilies(principalId: string): RefreshFamilyView[] {
    const now = this.now().getTime();
    const rows: RefreshFamilyView[] = [];
    for (const r of this.refreshTokensByHash.values()) {
      if (r.principalId !== principalId || r.rotatedAt || r.familyRevoked) continue;
      if (Date.parse(r.expiresAt) <= now) continue;
      rows.push(familyView(r));
    }
    return rows.sort((a, b) => a.familyId.localeCompare(b.familyId));
  }

  private async revokeMatching(match: (r: McpOAuthRefreshTokenRecord) => boolean, by: string): Promise<string[]> {
    const grouped = await this.revokeGrouped(match, by);
    return [...new Set(grouped.flatMap((g) => g.keyIds))];
  }

  private async revokeGrouped(match: (r: McpOAuthRefreshTokenRecord) => boolean, by: string): Promise<FamilyRevocation[]> {
    return this.change(by, () => this.markFamilies(match));
  }

  /** Caller holds the write lock. Marks matching families revoked and returns their anchor key ids. */
  private markFamilies(match: (r: McpOAuthRefreshTokenRecord) => boolean): FamilyRevocation[] {
    const byFamily = new Map<string, string[]>();
    for (const r of this.refreshTokensByHash.values()) {
      if (!match(r)) continue;
      r.familyRevoked = true;
      const keys = byFamily.get(r.familyId) ?? [];
      if (r.keyId && !keys.includes(r.keyId)) keys.push(r.keyId);
      byFamily.set(r.familyId, keys);
    }
    return [...byFamily.entries()].map(([familyId, keyIds]) => ({ familyId, keyIds }));
  }
}

export type FamilyRevocation = { familyId: string; keyIds: string[] };

export type RefreshFamilyView = {
  familyId: string;
  clientId: string;
  clientName: string;
  holder: RefreshHolder;
  createdAt: string;
  expiresAt: string;
  generation: number;
  sessionSid?: string;
};

function familyView(r: McpOAuthRefreshTokenRecord): RefreshFamilyView {
  return {
    familyId: r.familyId,
    clientId: r.clientId,
    clientName: r.clientName,
    holder: refreshHolderOf(r.holder),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    generation: r.generation,
    ...(r.sessionSid ? { sessionSid: r.sessionSid } : {}),
  };
}

/** Record family and legacy anchor ids in the revocation set, and revoke the anchor keys. */
export async function applyFamilyRevocation(state: FactoryState, families: readonly FamilyRevocation[], reason: string): Promise<void> {
  const until = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const batch = families.flatMap((family) => [
    { id: family.familyId, kind: 'sid' as const, expiresAt: until, reason },
    ...family.keyIds.filter(Boolean).map((id) => ({ id, kind: 'sid' as const, expiresAt: until, reason })),
  ]);
  if (batch.length > 0) await state.revocations?.revokeMany(batch);
  if (!state.keys) return;
  const seen = new Set<string>();
  for (const family of families) {
    for (const id of family.keyIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await state.keys.revoke(id, { by: 'service:mcp-oauth' }).catch(() => undefined);
    }
  }
}

export function getOAuthIssuer(state: FactoryState, req?: http.IncomingMessage): string {
  return resolveAsIssuer(state, req);
}

function sameOrigin(state: FactoryState, req: http.IncomingMessage): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(String(req.headers.referer)) : undefined);
  if (!origin) return false;
  const allowed = new Set<string>();
  if (state.publicBaseUrl) allowed.add(safeOrigin(state.publicBaseUrl) ?? '');
  if (state.loginBaseUrl) allowed.add(safeOrigin(state.loginBaseUrl) ?? '');
  if (req.headers.host) for (const p of ['https', 'http']) allowed.add(`${p}://${req.headers.host}`);
  return allowed.has(String(origin));
}

function safeOrigin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

export async function handleMcpOAuthRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const store = state.mcpOAuthStore;
  if (!store) return false;

  // 1. Discovery metadata
  if (
    (path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp' ||
      path.startsWith('/.well-known/oauth-protected-resource/mcp/')) &&
    req.method === 'GET'
  ) {
    const issuer = getOAuthIssuer(state, req);
    res.setHeader('cache-control', 'public, max-age=3600');
    return json(res, 200, {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [...FACTORY_SCOPES],
    }), true;
  }

  // Authorization-server metadata is served by handleAsDiscoveryRoutes (Phase 1 Slice 1)
  // so it stays aligned with /jwks and /.well-known/openid-configuration.

  // 2. Client Registration (DCR)
  if ((path === '/api/v1/auth/register' || path === '/register') && req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1')
      .split(',')[0]
      .trim();
    if (!store.checkDcrRateLimit(ip)) {
      return json(res, 429, { error: 'rate_limit_exceeded', message: 'Too many registration requests from this IP' }), true;
    }
    const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.some((u) => typeof u !== 'string' || !isValidRedirectUri(u))) {
      return json(res, 400, {
        error: 'invalid_redirect_uri',
        message: 'redirect_uris must be non-empty array of valid https, loopback http, or desktop URIs',
      }), true;
    }
    const clientName = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : 'MCP Client';
    const clientId = 'mcpc_' + randomBytes(16).toString('hex');
    const clientRecord: McpOAuthClientRecord = {
      clientId,
      clientName,
      redirectUris: uris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date().toISOString(),
    };
    await store.registerClient(clientRecord, ip);
    return json(res, 201, {
      client_id: clientRecord.clientId,
      client_name: clientRecord.clientName,
      redirect_uris: clientRecord.redirectUris,
      grant_types: clientRecord.grantTypes,
      response_types: clientRecord.responseTypes,
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }), true;
  }

  // 3. Authorization & Consent
  if (path === '/authorize' || path === '/api/v1/auth/oauth/authorize') {
    if (req.method === 'GET') return handleAuthorizeGet(state, req, res);
    if (req.method === 'POST') return handleAuthorizePost(state, req, res);
  }

  // 4. Token endpoint
  if ((path === '/token' || path === '/api/v1/auth/oauth/token') && req.method === 'POST') {
    return handleTokenPost(state, req, res);
  }

  // 5. Revocation endpoint
  if ((path === '/revoke' || path === '/api/v1/auth/oauth/revoke') && req.method === 'POST') {
    return handleRevokePost(state, req, res);
  }

  // 6. Connected MCP Apps Consents management
  if (path === '/api/v1/oauth/consents' && req.method === 'GET') {
    return handleConsentsList(state, req, res);
  }
  const consentMatch = path.match(/^\/api\/v1\/oauth\/consents\/([^/]+)$/);
  if (consentMatch && req.method === 'DELETE') {
    return handleConsentDelete(state, req, res, decodeURIComponent(consentMatch[1]));
  }

  if (path === '/api/v1/oauth/clients' && req.method === 'PUT') {
    return handleClientAdminPut(state, req, res);
  }

  return false;
}

function redirectOAuthError(
  res: http.ServerResponse,
  redirectUri: string,
  issuer: string,
  clientState: string | undefined,
  error: string,
  description: string,
): boolean {
  const errUrl = new URL(redirectUri);
  errUrl.searchParams.set('error', error);
  errUrl.searchParams.set('error_description', description);
  if (clientState) errUrl.searchParams.set('state', clientState);
  errUrl.searchParams.set('iss', issuer);
  res.writeHead(302, { location: errUrl.toString(), 'cache-control': 'no-store' });
  res.end();
  return true;
}

function clientOriginOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}

/** Third-party consent screen. Names the client's origin and lists each scope in plain language. */
export function consentPageHtml(input: {
  clientName: string;
  origin: string;
  principalId: string;
  scopes: { id: string; label: string }[];
  consentNonce: string;
  csrfToken: string;
}): string {
  const host = (() => {
    try {
      return new URL(input.origin).host;
    } catch {
      return input.origin;
    }
  })();
  const items = input.scopes
    .map((scope) => `<li data-scope="${esc(scope.id)}"><span class="scope-id">${esc(scope.id)}</span> ${esc(scope.label)}</li>`)
    .join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect MCP Application</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #111; line-height: 1.5; }
    .box { border: 1px solid #ccc; border-radius: 8px; padding: 1.5rem; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-top: 0; }
    .origin-host { font-size: 1.05rem; }
    .client-origin { font-family: monospace; font-size: 0.85rem; }
    ul.scope-list { padding-left: 1.2rem; }
    ul.scope-list li { margin: 0.35rem 0; }
    .scope-id { font-family: monospace; font-size: 0.8rem; color: #555; margin-right: 0.35rem; }
    .note { font-size: 0.85rem; color: #444; }
    .btn-row { display: flex; gap: 1rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.6rem 1rem; font-size: 1rem; border-radius: 6px; cursor: pointer; border: 1px solid #888; }
    button.primary { background: #0066cc; color: #fff; border-color: #0055aa; font-weight: 600; }
    button.secondary { background: #fff; color: #333; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Authorize MCP Client</h1>
    <p class="origin-host"><strong>${esc(host)}</strong> wants to act as you.</p>
    <p>Origin: <code class="client-origin">${esc(input.origin)}</code></p>
    <p class="note">This is a third-party application. Factory Console, Garrison, Web Chat, and Connect are first-party apps and are not shown this screen.</p>
    <div class="meta">
      <div><strong>Application:</strong> ${esc(input.clientName)}</div>
      <div><strong>User:</strong> ${esc(input.principalId)}</div>
      <div><strong>Permissions:</strong></div>
      <ul class="scope-list">${items}</ul>
    </div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="consent_nonce" value="${esc(input.consentNonce)}">
      <input type="hidden" name="csrf_token" value="${esc(input.csrfToken)}">
      <div class="btn-row">
        <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function issueAuthorizationCode(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: McpOAuthStore,
  input: {
    clientId: string;
    principalId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    resource?: string;
    sessionSid?: string;
    clientState?: string;
    issuer: string;
  },
): boolean {
  const code = store.storeAuthCode({
    clientId: input.clientId,
    principalId: input.principalId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    amr: amrOf(state, req),
    sessionSid: input.sessionSid,
  });
  const targetUrl = new URL(input.redirectUri);
  targetUrl.searchParams.set('code', code);
  if (input.clientState) targetUrl.searchParams.set('state', input.clientState);
  targetUrl.searchParams.set('iss', input.issuer);
  res.writeHead(302, { location: targetUrl.toString(), 'cache-control': 'no-store' });
  res.end();
  return true;
}

async function handleAuthorizeGet(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const store = state.mcpOAuthStore!;
  const issuer = getOAuthIssuer(state, req);
  const q = new URL(req.url ?? '/', 'http://x').searchParams;

  let clientId = q.get('client_id');
  let redirectUri = q.get('redirect_uri');
  let responseType = q.get('response_type');
  let codeChallenge = q.get('code_challenge');
  let codeChallengeMethod = q.get('code_challenge_method');
  let clientState = q.get('state') ?? undefined;
  let scope: string | undefined = q.get('scope') ?? undefined;
  let resourceList = resourceParams(q.getAll('resource'));

  const oauthReq = q.get('oauth_req');
  if (oauthReq) {
    const pending = store.takePendingRequest(oauthReq);
    if (pending) {
      clientId = pending.clientId;
      redirectUri = pending.redirectUri;
      responseType = pending.responseType;
      codeChallenge = pending.codeChallenge;
      codeChallengeMethod = pending.codeChallengeMethod;
      clientState = pending.state;
      scope = pending.scope;
      resourceList = pending.resource ? pending.resource.split(/\s+/).filter(Boolean) : [];
    }
  }

  if (!clientId) return json(res, 400, { error: 'invalid_request', message: 'client_id is required' }), true;
  if (!redirectUri) return json(res, 400, { error: 'invalid_request', message: 'redirect_uri is required' }), true;

  // Resolve client (DCR or CIMD)
  let client = store.getClient(clientId);
  if (!client && clientId.startsWith('https://')) {
    try {
      client = await store.fetchCimd(clientId, state.oauthFetch ?? fetch);
    } catch (err: any) {
      return json(res, 400, { error: 'invalid_client', message: err.message || 'CIMD metadata fetch failed' }), true;
    }
  }
  if (!client) {
    return json(res, 400, { error: 'invalid_client', message: 'Unknown client_id' }), true;
  }

  // Validate redirect_uri against client's registered redirect_uris
  const uriMatch = client.redirectUris.some((reg) => matchesRedirectUri(reg, redirectUri!));
  if (!uriMatch) {
    return json(res, 400, { error: 'invalid_request', message: 'redirect_uri does not match registered URIs' }), true;
  }

  // Validate response_type
  if (responseType !== 'code') {
    const errUrl = new URL(redirectUri);
    errUrl.searchParams.set('error', 'unsupported_response_type');
    if (clientState) errUrl.searchParams.set('state', clientState);
    errUrl.searchParams.set('iss', issuer);
    res.writeHead(302, { location: errUrl.toString(), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Validate PKCE (S256 mandatory)
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    const errUrl = new URL(redirectUri);
    errUrl.searchParams.set('error', 'invalid_request');
    errUrl.searchParams.set('error_description', 'PKCE code_challenge with code_challenge_method=S256 is required');
    if (clientState) errUrl.searchParams.set('state', clientState);
    errUrl.searchParams.set('iss', issuer);
    res.writeHead(302, { location: errUrl.toString(), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // RFC 8707 resource. Omitted means mcp only, which is what existing MCP connectors request.
  // An explicit resource must be this factory's api audience, mcp audience, or both.
  let resource: string | undefined;
  if (resourceList.length > 0) {
    const canon = canonicalAudiences(issuer, resourceList);
    if (!canon.ok) {
      const errUrl = new URL(redirectUri);
      errUrl.searchParams.set('error', 'invalid_target');
      errUrl.searchParams.set('error_description', 'Resource must be the factory api or mcp resource');
      if (clientState) errUrl.searchParams.set('state', clientState);
      errUrl.searchParams.set('iss', issuer);
      res.writeHead(302, { location: errUrl.toString(), 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    resource = canon.audiences.join(' ');
  }

  try {
    await store.reload();
  } catch {
    return json(res, 503, { error: 'server_error', message: 'Sign-in state could not be read' }), true;
  }
  client = store.getClient(client.clientId) ?? client;
  if (client.blocked) {
    return redirectOAuthError(res, redirectUri, issuer, clientState, 'access_denied', 'This application has been blocked by an administrator');
  }
  const normalized = normalizeRequestedScopes(scope, client.firstParty === true);
  if (!normalized.ok) {
    return redirectOAuthError(res, redirectUri, issuer, clientState, 'invalid_scope', 'Requested scope is unknown or not available to this application');
  }
  scope = normalized.scope;

  // Check live session
  const email = sessionEmail(state, req);
  if (!email) {
    const nonce = store.storePendingRequest({
      clientId,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
      state: clientState,
      scope,
      resource,
    });
    res.writeHead(302, { location: `/login?oauth_req=${encodeURIComponent(nonce)}`, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // User is signed in; resolve verified principal
  const who = await resolveVerifiedPrincipal(state, { actor: `oidc:${email}`, roles: [], emailVerified: true }, false);
  if (!who.actor.startsWith('user:')) {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    res.end('<!doctype html><html><body><h1>Access Denied</h1><p>You are signed in, but this factory has not granted you access yet.</p></body></html>');
    return true;
  }
  const principalId = who.actor;

  // Enforce connected apps limit: max 15 per principal
  const existingConsents = store.listConsents(principalId);
  if (existingConsents.length >= 15 && !existingConsents.some((c) => c.clientId === client!.clientId)) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    res.end('<!doctype html><html><body><h1>Limit Reached</h1><p>Maximum connected MCP applications limit reached (15). Revoke an existing app before connecting a new one.</p></body></html>');
    return true;
  }

  const sessionSid = state.sessions?.get(cookieValue(req, SESSION_COOKIE))?.sid;
  // First-party heads skip the consent screen. A third-party client never does, even when the person is already signed in.
  if (client.firstParty === true) {
    await store.saveConsent({
      principalId,
      clientId: client.clientId,
      clientName: client.clientName,
      scope,
    });
    return issueAuthorizationCode(state, req, res, store, {
      clientId: client.clientId,
      principalId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource,
      sessionSid,
      clientState,
      issuer,
    });
  }

  if (store.hasConsent(principalId, client.clientId, scope)) {
    return issueAuthorizationCode(state, req, res, store, {
      clientId: client.clientId,
      principalId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource,
      sessionSid,
      clientState,
      issuer,
    });
  }

  // Mandatory per-client consent screen (never auto-approve an unconsented third-party client).
  let redirectOrigin = redirectUri;
  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {}

  const csrfToken = b64url(randomBytes(24));
  // Save consent session in pending requests
  const consentNonce = store.storePendingRequest({
    clientId,
    redirectUri,
    responseType,
    codeChallenge,
    codeChallengeMethod,
    state: clientState,
    scope,
    resource,
    csrfToken,
    principalId,
  });

  const html = consentPageHtml({
    clientName: client.clientName,
    origin: redirectOrigin,
    principalId,
    scopes: scopeViews(scope.split(/\s+/)),
    consentNonce,
    csrfToken,
  });

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self';",
  });
  res.end(html);
  return true;
}

async function handleAuthorizePost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const store = state.mcpOAuthStore!;
  const issuer = getOAuthIssuer(state, req);

  // Cross-origin check
  if (!sameOrigin(state, req)) {
    return json(res, 403, { error: 'cross_origin', message: 'Cross-origin authorization POST refused' }), true;
  }

  const email = sessionEmail(state, req);
  if (!email) {
    return json(res, 401, { error: 'unauthorized', message: 'Sign-in required' }), true;
  }

  const who = await resolveVerifiedPrincipal(state, { actor: `oidc:${email}`, roles: [], emailVerified: true }, false);
  if (!who.actor.startsWith('user:')) {
    return json(res, 403, { error: 'forbidden', message: 'No factory grants' }), true;
  }
  const principalId = who.actor;

  const rawBody = await readBody(req);
  const form = new URLSearchParams(rawBody);
  const decision = form.get('decision');
  const consentNonce = form.get('consent_nonce') ?? '';

  const pending = store.takePendingRequest(consentNonce);
  if (!pending) {
    return json(res, 400, { error: 'invalid_request', message: 'Consent request expired or invalid' }), true;
  }

  // F1: Verify authenticated session principal matches consent request
  if (pending.principalId && pending.principalId !== principalId) {
    return json(res, 403, { error: 'principal_mismatch', message: 'Authenticated user does not match consent request' }), true;
  }

  // F1: Verify CSRF token using timingSafeEqual
  const formCsrf = form.get('csrf_token') ?? '';
  if (!pending.csrfToken || !formCsrf) {
    return json(res, 403, { error: 'invalid_csrf_token', message: 'Missing CSRF token' }), true;
  }
  const bufExpected = Buffer.from(pending.csrfToken, 'utf8');
  const bufActual = Buffer.from(formCsrf, 'utf8');
  if (bufExpected.length !== bufActual.length || !timingSafeEqual(bufExpected, bufActual)) {
    return json(res, 403, { error: 'invalid_csrf_token', message: 'Invalid CSRF token' }), true;
  }

  const redirectUrl = new URL(pending.redirectUri);
  if (decision === 'deny') {
    redirectUrl.searchParams.set('error', 'access_denied');
    redirectUrl.searchParams.set('error_description', 'User denied authorization');
    if (pending.state) redirectUrl.searchParams.set('state', pending.state);
    redirectUrl.searchParams.set('iss', issuer);
    res.writeHead(302, { location: redirectUrl.toString(), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Approved
  try {
    await store.reload();
  } catch {
    return json(res, 503, { error: 'server_error', message: 'Sign-in state could not be read' }), true;
  }
  const client = store.getClient(pending.clientId);
  if (client?.blocked) {
    return redirectOAuthError(res, pending.redirectUri, issuer, pending.state, 'access_denied', 'This application has been blocked by an administrator');
  }
  const clientName = client?.clientName ?? pending.clientId;
  const scope = pending.scope ?? DEFAULT_OAUTH_SCOPE;

  await store.saveConsent({
    principalId,
    clientId: pending.clientId,
    clientName,
    scope,
  });

  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action: 'MCP_OAUTH_CONSENT_GRANTED',
    actor: principalId,
    subject: pending.clientId,
    via: `mcp:${pending.clientId}`,
  });

  const code = store.storeAuthCode({
    clientId: pending.clientId,
    principalId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    scope,
    resource: pending.resource,
    amr: amrOf(state, req),
    sessionSid: state.sessions?.get(cookieValue(req, SESSION_COOKIE))?.sid,
  });

  redirectUrl.searchParams.set('code', code);
  if (pending.state) redirectUrl.searchParams.set('state', pending.state);
  redirectUrl.searchParams.set('iss', issuer);

  res.writeHead(302, { location: redirectUrl.toString(), 'cache-control': 'no-store' });
  res.end();
  return true;
}

function anchorLive(k: { revokedAt?: string; expiresAt: string | null }, now: number): boolean {
  return !k.revokedAt && (k.expiresAt === null || Date.parse(k.expiresAt) > now);
}

const HINT_AGENT_CAP = 16;

function resourceParams(values: readonly string[]): string[] {
  return values.flatMap((v) => v.split(/\s+/)).map((s) => s.trim()).filter(Boolean);
}

function amrOf(state: FactoryState, req: http.IncomingMessage): string[] | undefined {
  const idp = sessionIdp(state, req);
  return idp ? [idp] : undefined;
}

/** Rebuild canonical audiences for the issuer this request is speaking as. */
function audiencesFromStored(issuer: string, field: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (field ?? '').split(/\s+/)) {
    const kind = part ? accessKindOfUrl(part) : undefined;
    if (!kind) continue;
    const canon = canonicalAccessResource(issuer, kind);
    if (!out.includes(canon)) out.push(canon);
  }
  return out.length > 0 ? out : [canonicalAccessResource(issuer, 'mcp')];
}

/**
 * Audiences for this token. The authorization (or the refresh family) fixes the allowed set.
 * Omitting `resource` keeps that set. A request may only narrow it (RFC 8707).
 */
function selectAudiences(
  issuer: string,
  authorizedField: string | undefined,
  requested: readonly string[],
): { ok: true; audiences: string[] } | { ok: false } {
  const authorized = audiencesFromStored(issuer, authorizedField);
  if (requested.length === 0) return { ok: true, audiences: authorized };
  const asked = canonicalAudiences(issuer, requested);
  if (!asked.ok) return { ok: false };
  if (asked.audiences.some((aud) => !authorized.includes(aud))) return { ok: false };
  return { ok: true, audiences: asked.audiences };
}

async function readOAuthBody(req: http.IncomingMessage): Promise<{ fields: Record<string, string>; resources: string[] }> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await readBody(req));
    const fields: Record<string, string> = {};
    for (const [k, v] of params.entries()) if (k !== 'resource') fields[k] = v;
    return { fields, resources: resourceParams(params.getAll('resource')) };
  }
  const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'resource') continue;
    if (typeof v === 'string') fields[k] = v;
  }
  const raw = body.resource;
  const resources = Array.isArray(raw)
    ? resourceParams(raw.filter((v): v is string => typeof v === 'string'))
    : typeof raw === 'string'
      ? resourceParams([raw])
      : [];
  return { fields, resources };
}

/** Role and grant hints for UIs (D-5). The resource server does not authorize from these claims. */
function grantHints(state: FactoryState, actor: string): AccessTokenHints {
  const hints: AccessTokenHints = {};
  if (state.grants && Number.isFinite(state.grants.version)) hints.grantsVersion = state.grants.version;
  const res = effectiveGrantsForActor(state, actor);
  if (!res.ok || !res.grants) return hints;
  const roles = new Set<string>();
  const agents = new Map<string, Set<string>>();
  for (const eg of res.grants) {
    if (eg.readOnly) continue;
    if (eg.grant.scope.kind === 'fleet' && (ROLES as readonly string[]).includes(eg.grant.role)) roles.add(eg.grant.role);
    if (eg.grant.scope.kind === 'agent') {
      const set = agents.get(eg.grant.scope.id) ?? new Set<string>();
      set.add(eg.grant.role);
      agents.set(eg.grant.scope.id, set);
    }
  }
  const roleList = [...roles].filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  if (actorIsAdmin(state, actor, roleList) && !roles.has('admin')) roles.add('admin');
  if (roles.size > 0) hints.roles = [...roles];
  if (agents.size > 0) {
    const out: Record<string, string[]> = {};
    let n = 0;
    for (const [id, set] of agents) {
      if (n >= HINT_AGENT_CAP) break;
      out[id] = [...set].slice(0, 8);
      n += 1;
    }
    hints.agents = out;
  }
  return hints;
}

/**
 * Sign a 10-minute access token and keep a key-store anchor so consent revocation and refresh-reuse
 * still kill it. The anchor's plaintext is never returned. Slice 3 replaces the anchor with the revocation set.
 */
async function mintAccessToken(
  state: FactoryState,
  input: {
    issuer: string;
    principalId: string;
    clientId: string;
    clientName: string;
    scope?: string;
    audiences: string[];
    amr?: string[];
    anchorId?: string;
    /** Refresh-family id. Slice 3 puts this in `sid` so the revocation set can kill the token. */
    sid: string;
    refreshTtlMs: number;
  },
): Promise<{ accessToken: string; expiresIn: number; keyId: string; deviceFamily: string }> {
  const keys = state.keys;
  if (!keys) throw Object.assign(new Error('Key store unavailable'), { status: 503 });
  const deviceFamily = `mcp:${input.clientId.slice(0, 60)}`;
  const scopes = mapOAuthScopeToKeyScopes(input.scope);
  const anchorExpiry = new Date(Date.now() + input.refreshTtlMs).toISOString();
  const rotateInput = {
    by: input.principalId,
    expiresAt: anchorExpiry,
    secretPrefix: 'fk_at_' as const,
    audience: input.audiences[0],
    oauthClientId: input.clientId,
    oauthClientName: input.clientName,
    scopes,
  };
  let recordId: string | undefined;
  if (input.anchorId) {
    try {
      recordId = (await keys.rotate(input.anchorId, rotateInput)).record.id;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'key_not_found') throw err;
    }
  }
  if (!recordId) {
    const now = Date.now();
    // list() still returns expired rows. Rotating one throws key_not_found; mint a new anchor instead.
    const existing = keys.list({ owner: input.principalId }).find((k) => k.deviceFamily === deviceFamily && anchorLive(k, now));
    if (existing) {
      try {
        recordId = (await keys.rotate(existing.id, rotateInput)).record.id;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'key_not_found') throw err;
      }
    }
  }
  if (!recordId) {
    recordId = (
      await keys.create({
        owner: input.principalId,
        deviceFamily,
        by: input.principalId,
        expiresAt: anchorExpiry,
        secretPrefix: 'fk_at_',
        audience: input.audiences[0],
        oauthClientId: input.clientId,
        oauthClientName: input.clientName,
        scopes,
      })
    ).record.id;
  }
  const signed = await signAccessToken(await ensureAsKeys(state), {
    issuer: input.issuer,
    subject: input.principalId,
    audiences: input.audiences,
    clientId: input.clientId,
    scope: input.scope,
    sid: input.sid,
    amr: input.amr,
    actSub: `client:${input.clientId}`,
    hints: grantHints(state, input.principalId),
  });
  return { accessToken: signed.token, expiresIn: signed.expiresIn, keyId: recordId, deviceFamily };
}

async function handleTokenPost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const store = state.mcpOAuthStore!;
  const issuer = getOAuthIssuer(state, req);
  res.setHeader('cache-control', 'no-store');

  const { fields: body, resources } = await readOAuthBody(req);
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const code = body.code;
    const clientId = body.client_id;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return json(res, 400, { error: 'invalid_request', error_description: 'code, client_id, redirect_uri, and code_verifier required' }), true;
    }

    const auth = store.takeAuthCode(code);
    if (!auth) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }), true;
    }

    if (auth.clientId !== clientId) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' }), true;
    }
    if (!matchesRedirectUri(auth.redirectUri, redirectUri)) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }), true;
    }

    // Verify PKCE
    const verifierHash = b64url(sha256(codeVerifier));
    if (verifierHash !== auth.codeChallenge) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }), true;
    }

    const selected = selectAudiences(issuer, auth.resource, resources);
    if (!selected.ok) {
      return json(res, 400, { error: 'invalid_target', error_description: 'resource is not an authorized api or mcp audience' }), true;
    }

    try {
      await store.reload();
    } catch {
      return json(res, 503, { error: 'server_error', error_description: 'Sign-in state could not be read' }), true;
    }
    const client = store.getClient(clientId);
    if (client?.blocked) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'This application has been blocked by an administrator' }), true;
    }
    const clientName = client?.clientName ?? clientId;
    if (auth.sessionSid) {
      try {
        await state.revocations?.reload();
      } catch {
        return json(res, 503, { error: 'server_error', error_description: 'Sign-in state could not be read' }), true;
      }
      if (state.revocations?.has(auth.sessionSid)) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }), true;
      }
    }
    if (!state.keys) {
      return json(res, 503, { error: 'server_error', error_description: 'Key store unavailable' }), true;
    }

    const familyId = 'fam_' + randomBytes(16).toString('hex');
    const refreshTtl = refreshLifetimeMs('person');
    const minted = await mintAccessToken(state, {
      issuer,
      principalId: auth.principalId,
      clientId,
      clientName,
      scope: auth.scope,
      audiences: selected.audiences,
      amr: auth.amr,
      sid: familyId,
      refreshTtlMs: refreshTtl,
    });

    const refreshTokenPlaintext = 'fk_rt_' + b64url(randomBytes(32));
    const tokenHash = hashApiKey(refreshTokenPlaintext);
    const refreshExpiresAt = new Date(Date.now() + refreshTtl).toISOString();

    await store.saveRefreshToken({
      tokenHash,
      familyId,
      generation: 1,
      principalId: auth.principalId,
      clientId,
      clientName,
      deviceFamily: minted.deviceFamily,
      keyId: minted.keyId,
      scope: auth.scope,
      audience: selected.audiences[0],
      audiences: selected.audiences,
      amr: auth.amr,
      holder: 'person',
      ...(auth.sessionSid ? { sessionSid: auth.sessionSid } : {}),
      expiresAt: refreshExpiresAt,
      createdAt: new Date().toISOString(),
    });

    return json(res, 200, {
      access_token: minted.accessToken,
      token_type: 'Bearer',
      expires_in: minted.expiresIn,
      refresh_token: refreshTokenPlaintext,
      scope: auth.scope,
    }), true;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = body.refresh_token;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return json(res, 400, { error: 'invalid_request', error_description: 'refresh_token is required' }), true;
    }

    const tokenHash = hashApiKey(refreshToken);
    await store.reload();
    const rec = store.getRefreshTokenByHash(tokenHash);

    // Reuse detection. reload() above is what makes this true on a task that did not rotate the token.
    if (rec && (rec.rotatedAt !== undefined || rec.familyRevoked)) {
      const keyIds = await store.revokeRefreshTokenFamily(rec.familyId, rec.principalId);
      await applyFamilyRevocation(state, [{ familyId: rec.familyId, keyIds }], 'refresh-reuse');
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: 'control-plane',
        type: 'action',
        action: 'OAUTH_REFRESH_REUSE_DETECTED',
        actor: rec.principalId,
        subject: rec.clientId,
        via: `mcp:${rec.clientId}`,
      });
      return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token reuse detected; family revoked' }), true;
    }

    if (!rec || rec.familyRevoked || Date.parse(rec.expiresAt) <= Date.now()) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }), true;
    }
    if (store.getClient(rec.clientId)?.blocked) {
      const families = await store.revokeFamiliesForClient(rec.principalId, rec.clientId, 'blocked');
      await applyFamilyRevocation(state, families, 'client-blocked');
      return json(res, 400, { error: 'invalid_grant', error_description: 'This application has been blocked by an administrator' }), true;
    }

    if (!state.keys) {
      return json(res, 503, { error: 'server_error', error_description: 'Key store unavailable' }), true;
    }

    const held = audiencesFromStored(issuer, rec.audiences?.length ? rec.audiences.join(' ') : rec.audience);
    const selected = selectAudiences(issuer, held.join(' '), resources);
    if (!selected.ok) {
      return json(res, 400, { error: 'invalid_target', error_description: 'resource is not an authorized api or mcp audience' }), true;
    }

    const refreshTtl = refreshLifetimeMs(rec.holder);
    const minted = await mintAccessToken(state, {
      issuer,
      principalId: rec.principalId,
      clientId: rec.clientId,
      clientName: rec.clientName,
      scope: rec.scope,
      audiences: selected.audiences,
      amr: rec.amr,
      anchorId: rec.keyId,
      sid: rec.familyId,
      refreshTtlMs: refreshTtl,
    });

    const newRefreshToken = 'fk_rt_' + b64url(randomBytes(32));
    const newTokenHash = hashApiKey(newRefreshToken);
    const newRefreshExpiresAt = new Date(Date.now() + refreshTtl).toISOString();

    try {
      await store.rotateRefreshTokenFamily(tokenHash, newTokenHash, newRefreshExpiresAt, minted.keyId, {
        audience: selected.audiences[0],
        audiences: selected.audiences,
        holder: refreshHolderOf(rec.holder),
        ...(rec.amr ? { amr: rec.amr } : {}),
      });
    } catch (err) {
      await state.keys?.revoke(minted.keyId, { by: 'service:mcp-oauth' }).catch(() => undefined);
      if (err instanceof RefreshReuseError) {
        const keyIds = await store.revokeRefreshTokenFamily(err.familyId, err.principalId);
        const anchors = keyIds.includes(minted.keyId) ? keyIds : [...keyIds, minted.keyId];
        await applyFamilyRevocation(state, [{ familyId: err.familyId, keyIds: anchors }], 'refresh-reuse');
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: 'control-plane',
          type: 'action',
          action: 'OAUTH_REFRESH_REUSE_DETECTED',
          actor: err.principalId,
          subject: rec.clientId,
          via: `mcp:${rec.clientId}`,
        });
        return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token reuse detected; family revoked' }), true;
      }
      if (err instanceof Error && err.message === 'refresh_token_not_found') {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }), true;
      }
      throw err;
    }

    return json(res, 200, {
      access_token: minted.accessToken,
      token_type: 'Bearer',
      expires_in: minted.expiresIn,
      refresh_token: newRefreshToken,
      scope: rec.scope ?? DEFAULT_OAUTH_SCOPE,
    }), true;
  }

  return json(res, 400, { error: 'unsupported_grant_type', error_description: 'Grant type not supported' }), true;
}

/** RFC 7009 for a factory access JWT: one verified `jti` joins the revocation set until that token's own exp. */
async function revokeAccessJwt(state: FactoryState, req: http.IncomingMessage, token: string): Promise<void> {
  const issuer = getOAuthIssuer(state, req);
  const configured = allowedIssuerOrigins(state);
  const keys = await ensureAsKeys(state);
  for (const kind of ['api', 'mcp'] as const) {
    const verdict = await verifyAccessToken(token, {
      keys,
      issuers: configured.length > 0 ? configured : [issuer],
      audience: canonicalAccessResource(issuer, kind),
    });
    if (!verdict.ok) {
      if (verdict.reason === 'audience') continue;
      return;
    }
    await state.revocations?.revoke({
      id: verdict.token.jti,
      kind: 'jti',
      expiresAt: verdict.token.exp * 1000,
      reason: 'revoke',
    });
    return;
  }
}

async function handleRevokePost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const store = state.mcpOAuthStore!;
  res.setHeader('cache-control', 'no-store');

  let body: Record<string, string> = {};
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    for (const [k, v] of params.entries()) body[k] = v;
  } else {
    body = (await readJson(req).catch(() => ({}))) as Record<string, string>;
  }

  const token = body.token;
  if (!token) return json(res, 200, { ok: true }), true;

  if (isFactoryAccessJwt(token)) {
    await revokeAccessJwt(state, req, token);
  } else if (token.startsWith('fk_rt_')) {
    const hash = hashApiKey(token);
    await store.reload();
    const rec = store.getRefreshTokenByHash(hash);
    if (rec) {
      const keyIds = await store.revokeRefreshTokenFamily(rec.familyId, rec.principalId);
      await applyFamilyRevocation(state, [{ familyId: rec.familyId, keyIds }], 'revoke');
      await store.revokeConsent(rec.principalId, rec.clientId);
    }
  } else if (token.startsWith('fk_at_') || token.startsWith('fk_')) {
    if (state.keys) {
      const rec = state.keys.verify(token);
      if (rec) {
        await state.keys.revoke(rec.id, { by: 'service:mcp-oauth' });
        if (rec.oauthClientId) {
          await store.revokeConsent(rec.owner, rec.oauthClientId);
        }
      }
    }
  }

  return json(res, 200, { ok: true }), true;
}

async function handleConsentsList(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const who = await identify(req, state);
  if (!who.ok) return json(res, 401, { error: 'unauthorized' }), true;
  if (who.principal.keyId) {
    return json(res, 403, { error: 'forbidden', message: 'API keys cannot manage OAuth consents; sign in' }), true;
  }

  const isAdmin = actorIsAdmin(state, who.principal.actor, who.principal.roles);
  const ownerQ = new URL(req.url ?? '/', 'http://x').searchParams.get('owner')?.toLowerCase();
  const owner = isAdmin && ownerQ ? ownerQ : who.principal.actor;

  const store = state.mcpOAuthStore!;
  const consents = store.listConsents(owner);
  return json(res, 200, {
    consents: consents.map((c) => {
      const client = store.getClient(c.clientId);
      const origin = client ? clientOriginOf(client.redirectUris[0] ?? '') : undefined;
      const scopes = scopeViews(c.scope.split(/\s+/));
      return {
        clientId: c.clientId,
        clientName: c.clientName,
        scope: c.scope,
        scopes,
        ...(origin ? { origin } : {}),
        firstParty: client?.firstParty === true,
        blocked: client?.blocked === true,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }),
  }), true;
}

async function handleClientAdminPut(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const who = await identify(req, state);
  if (!who.ok) return json(res, 401, { error: 'unauthorized' }), true;
  if (who.principal.keyId) {
    return json(res, 403, { error: 'forbidden', message: 'API keys cannot manage OAuth clients; sign in' }), true;
  }
  if (!actorIsAdmin(state, who.principal.actor, who.principal.roles)) {
    return json(res, 403, { error: 'forbidden', message: 'Only an admin can register or block a client' }), true;
  }
  const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const clientName = typeof body.clientName === 'string' && body.clientName.trim() ? body.clientName.trim().slice(0, 120) : clientId;
  const uris = body.redirectUris;
  if (!clientId || clientId.length > 300) {
    return json(res, 400, { error: 'invalid_client', message: 'clientId is required' }), true;
  }
  if (!Array.isArray(uris) || uris.length === 0 || uris.some((u) => typeof u !== 'string' || !isValidRedirectUri(u))) {
    return json(res, 400, { error: 'invalid_redirect_uri', message: 'redirectUris must be valid https, loopback http, or desktop URIs' }), true;
  }
  const firstParty = typeof body.firstParty === 'boolean' ? body.firstParty : undefined;
  const blocked = typeof body.blocked === 'boolean' ? body.blocked : undefined;
  const { record, families } = await state.mcpOAuthStore!.upsertAdminClient({
    clientId,
    clientName,
    redirectUris: uris.filter((u): u is string => typeof u === 'string'),
    firstParty,
    blocked,
  });
  if (families.length > 0) await applyFamilyRevocation(state, families, 'client-blocked');
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action: blocked ? `OAUTH_CLIENT_BLOCKED:${clientId}` : `OAUTH_CLIENT_UPDATED:${clientId}`,
    actor: who.principal.actor,
    subject: clientId,
  });
  return json(res, 200, {
    client: {
      clientId: record.clientId,
      clientName: record.clientName,
      redirectUris: record.redirectUris,
      firstParty: record.firstParty === true,
      blocked: record.blocked === true,
    },
  }), true;
}

async function handleConsentDelete(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientId: string,
): Promise<boolean> {
  const who = await identify(req, state);
  if (!who.ok) return json(res, 401, { error: 'unauthorized' }), true;
  if (who.principal.keyId) {
    return json(res, 403, { error: 'forbidden', message: 'API keys cannot manage OAuth consents; sign in' }), true;
  }

  const isAdmin = actorIsAdmin(state, who.principal.actor, who.principal.roles);
  const ownerQ = new URL(req.url ?? '/', 'http://x').searchParams.get('owner')?.toLowerCase();
  const owner = isAdmin && ownerQ ? ownerQ : who.principal.actor;

  // Revoke consent (also marks that client's refresh families revoked) and record the ids.
  const existed = await state.mcpOAuthStore!.revokeConsent(owner, clientId);
  const families = await state.mcpOAuthStore!.revokeFamiliesForClient(owner, clientId, who.principal.actor);
  await applyFamilyRevocation(state, families, 'consent');

  // Revoke active KeyStore key for owner with deviceFamily: "mcp:" + clientId
  if (state.keys) {
    const targetFamily = `mcp:${clientId.slice(0, 60)}`;
    const keys = state.keys.list({ owner }).filter((k) => k.deviceFamily === targetFamily && !k.revokedAt);
    for (const k of keys) {
      await state.keys.revoke(k.id, { by: who.principal.actor });
    }
  }

  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action: `MCP_OAUTH_REVOKED:${clientId}`,
    actor: who.principal.actor,
    subject: owner,
  });

  return json(res, 200, { ok: true, revoked: existed }), true;
}

export function isPrivateOrInternalHost(rawHostname: string): boolean {
  let host = rawHostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  // IPv4 checks
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)
  ) {
    return true;
  }
  // IPv6 checks
  if (
    host === '::1' ||
    host === '::' ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(host)
  ) {
    return true;
  }
  return false;
}

export { mapOAuthScopeToKeyScopes } from './oauth-scopes.js';
