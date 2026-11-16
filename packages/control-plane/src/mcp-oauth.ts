import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashApiKey, sameHash, type Principal, type KeyScopes } from '@beercanlabs/factory-auth';
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';
import { actorIsAdmin, identify, json, readBody, readJson, resolveVerifiedPrincipal, type FactoryState } from './app.js';
import { sessionEmail } from './login.js';

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
  audience?: string;
  expiresAt: string;
  createdAt: string;
  rotatedAt?: string;
  familyRevoked?: boolean;
};

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
  resource?: string;
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
      this.docVersion = Math.max(st.snapshot?.version ?? 0, st.maxSeenVersion);
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
    return this.serial(async () => {
      // Bound total unconsented clients to 1000
      if (this.clientsById.size >= 1000) {
        const consentedClientIds = new Set<string>();
        for (const userMap of this.consentsByPrincipal.values()) {
          for (const c of userMap.keys()) consentedClientIds.add(c);
        }
        for (const [id, c] of this.clientsById.entries()) {
          if (!consentedClientIds.has(id)) {
            this.clientsById.delete(id);
            if (this.clientsById.size < 950) break;
          }
        }
      }
      this.clientsById.set(client.clientId, structuredClone(client));
      await this.commit(by);
      return structuredClone(client);
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
    if (!requestedScope || requestedScope === 'mcp:full') {
      return c.scope === 'mcp:full' || c.scope.includes('mcp:full');
    }
    const granted = new Set(c.scope.split(/\s+/).filter(Boolean));
    const req = requestedScope.split(/\s+/).filter(Boolean);
    return req.every((s) => granted.has(s) || granted.has('mcp:full'));
  }

  listConsents(principalId: string): McpOAuthConsentRecord[] {
    const userMap = this.consentsByPrincipal.get(principalId);
    if (!userMap) return [];
    return [...userMap.values()].map((c) => structuredClone(c));
  }

  async saveConsent(consent: Omit<McpOAuthConsentRecord, 'createdAt' | 'updatedAt'>): Promise<McpOAuthConsentRecord> {
    return this.serial(async () => {
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
      await this.commit(consent.principalId);
      return structuredClone(rec);
    });
  }

  async revokeConsent(principalId: string, clientId: string): Promise<boolean> {
    return this.serial(async () => {
      const userMap = this.consentsByPrincipal.get(principalId);
      if (!userMap) return false;
      const existed = userMap.delete(clientId);
      if (existed) {
        // Also revoke all refresh token families for (principalId, clientId)
        for (const [h, r] of this.refreshTokensByHash.entries()) {
          if (r.principalId === principalId && r.clientId === clientId) {
            r.familyRevoked = true;
          }
        }
        await this.commit(principalId);
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
    return this.serial(async () => {
      this.refreshTokensByHash.set(tokenRec.tokenHash, structuredClone(tokenRec));
      await this.commit(tokenRec.principalId);
    });
  }

  async rotateRefreshTokenFamily(
    oldTokenHash: string,
    newTokenHash: string,
    newExpiresAt: string,
    keyId: string,
  ): Promise<McpOAuthRefreshTokenRecord> {
    return this.serial(async () => {
      const cur = this.refreshTokensByHash.get(oldTokenHash);
      if (!cur) throw new Error('refresh_token_not_found');
      cur.rotatedAt = this.now().toISOString();
      const next: McpOAuthRefreshTokenRecord = {
        ...structuredClone(cur),
        tokenHash: newTokenHash,
        generation: cur.generation + 1,
        keyId,
        expiresAt: newExpiresAt,
        createdAt: this.now().toISOString(),
      };
      delete next.rotatedAt;
      this.refreshTokensByHash.set(newTokenHash, next);
      await this.commit(cur.principalId);
      return structuredClone(next);
    });
  }

  async revokeRefreshTokenFamily(familyId: string, by = 'system'): Promise<string[]> {
    return this.serial(async () => {
      const affectedKeyIds: string[] = [];
      for (const r of this.refreshTokensByHash.values()) {
        if (r.familyId === familyId) {
          r.familyRevoked = true;
          if (!affectedKeyIds.includes(r.keyId)) affectedKeyIds.push(r.keyId);
        }
      }
      await this.commit(by);
      return affectedKeyIds;
    });
  }
}

export function getOAuthIssuer(state: FactoryState, req?: http.IncomingMessage): string {
  if (state.loginBaseUrl) return state.loginBaseUrl.replace(/\/$/, '');
  if (state.publicBaseUrl) return state.publicBaseUrl.replace(/\/$/, '');
  if (req?.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }
  return 'http://localhost';
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
      scopes_supported: ['mcp:full'],
    }), true;
  }

  if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    const issuer = getOAuthIssuer(state, req);
    res.setHeader('cache-control', 'public, max-age=3600');
    return json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/api/v1/auth/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }), true;
  }

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

  return false;
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
  let scope = q.get('scope') ?? 'mcp:full';
  let resource = q.get('resource') ?? undefined;

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
      scope = pending.scope ?? 'mcp:full';
      resource = pending.resource;
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

  // Canonicalize and validate resource if provided
  if (resource) {
    const cleanResource = resource.split('?')[0].replace(/\/$/, '');
    const canonicalMcp = `${issuer}/mcp`;
    if (cleanResource !== canonicalMcp && !cleanResource.startsWith(`${canonicalMcp}/`)) {
      const errUrl = new URL(redirectUri);
      errUrl.searchParams.set('error', 'invalid_target');
      errUrl.searchParams.set('error_description', 'Resource must match factory MCP resource URI');
      if (clientState) errUrl.searchParams.set('state', clientState);
      errUrl.searchParams.set('iss', issuer);
      res.writeHead(302, { location: errUrl.toString(), 'cache-control': 'no-store' });
      res.end();
      return true;
    }
  }

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
  const who = await resolveVerifiedPrincipal(state, { actor: `oidc:${email}`, roles: [] }, false);
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

  // If already explicitly consented for this client and scope, issue code directly
  if (store.hasConsent(principalId, client.clientId, scope)) {
    const code = store.storeAuthCode({
      clientId: client.clientId,
      principalId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource,
    });
    const targetUrl = new URL(redirectUri);
    targetUrl.searchParams.set('code', code);
    if (clientState) targetUrl.searchParams.set('state', clientState);
    targetUrl.searchParams.set('iss', issuer);
    res.writeHead(302, { location: targetUrl.toString(), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Mandatory per-client consent screen (never auto-approve unconsented client!)
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

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect MCP Application</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1.5rem; color: #111; line-height: 1.5; }
    .box { border: 1px solid #ccc; border-radius: 8px; padding: 1.5rem; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-top: 0; }
    .meta { margin: 1rem 0; font-size: 0.95rem; }
    .meta strong { display: inline-block; width: 6rem; color: #555; }
    .scope-box { background: #eee; padding: 0.5rem 0.75rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; margin-top: 0.25rem; word-break: break-all; }
    .btn-row { display: flex; gap: 1rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.6rem 1rem; font-size: 1rem; border-radius: 6px; cursor: pointer; border: 1px solid #888; }
    button.primary { background: #0066cc; color: #fff; border-color: #0055aa; font-weight: 600; }
    button.secondary { background: #fff; color: #333; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Authorize MCP Client</h1>
    <p>The application below wants access to your Agent Factory MCP tools:</p>
    <div class="meta">
      <div><strong>Application:</strong> ${esc(client.clientName)}</div>
      <div><strong>Redirect Host:</strong> <code>${esc(redirectOrigin)}</code></div>
      <div><strong>User:</strong> ${esc(principalId)}</div>
      <div><strong>Permissions:</strong></div>
      <div class="scope-box">${esc(scope)}</div>
    </div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="consent_nonce" value="${esc(consentNonce)}">
      <input type="hidden" name="csrf_token" value="${esc(csrfToken)}">
      <div class="btn-row">
        <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;

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

  const who = await resolveVerifiedPrincipal(state, { actor: `oidc:${email}`, roles: [] }, false);
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
  const client = store.getClient(pending.clientId);
  const clientName = client?.clientName ?? pending.clientId;
  const scope = pending.scope ?? 'mcp:full';

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
  });

  redirectUrl.searchParams.set('code', code);
  if (pending.state) redirectUrl.searchParams.set('state', pending.state);
  redirectUrl.searchParams.set('iss', issuer);

  res.writeHead(302, { location: redirectUrl.toString(), 'cache-control': 'no-store' });
  res.end();
  return true;
}

async function handleTokenPost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const store = state.mcpOAuthStore!;
  const issuer = getOAuthIssuer(state, req);
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

    const client = store.getClient(clientId);
    const clientName = client?.clientName ?? clientId;
    const canonicalMcp = `${issuer}/mcp`;
    const deviceFamily = `mcp:${clientId.slice(0, 60)}`;

    if (!state.keys) {
      return json(res, 503, { error: 'server_error', error_description: 'Key store unavailable' }), true;
    }

    // Create or rotate 1-hour fk_at_ key in KeyStore
    const scopes = mapOAuthScopeToKeyScopes(auth.scope);
    const existingKey = state.keys.list({ owner: auth.principalId }).find((k) => k.deviceFamily === deviceFamily);
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    let keyOut: { record: any; plaintext: string };

    if (existingKey) {
      keyOut = await state.keys.rotate(existingKey.id, {
        by: auth.principalId,
        expiresAt,
        secretPrefix: 'fk_at_',
        audience: canonicalMcp,
        oauthClientId: clientId,
        oauthClientName: clientName,
        scopes,
      });
    } else {
      keyOut = await state.keys.create({
        owner: auth.principalId,
        deviceFamily,
        by: auth.principalId,
        expiresAt,
        secretPrefix: 'fk_at_',
        audience: canonicalMcp,
        oauthClientId: clientId,
        oauthClientName: clientName,
        scopes,
      });
    }

    // Mint durable rotating refresh token (60-day sliding TTL)
    const refreshTokenPlaintext = 'fk_rt_' + b64url(randomBytes(32));
    const tokenHash = hashApiKey(refreshTokenPlaintext);
    const familyId = 'fam_' + randomBytes(16).toString('hex');
    const refreshExpiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

    await store.saveRefreshToken({
      tokenHash,
      familyId,
      generation: 1,
      principalId: auth.principalId,
      clientId,
      clientName,
      deviceFamily,
      keyId: keyOut.record.id,
      scope: auth.scope,
      audience: canonicalMcp,
      expiresAt: refreshExpiresAt,
      createdAt: new Date().toISOString(),
    });

    return json(res, 200, {
      access_token: keyOut.plaintext,
      token_type: 'Bearer',
      expires_in: 3600,
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
    const rec = store.getRefreshTokenByHash(tokenHash);

    // Reuse detection
    if (rec && (rec.rotatedAt !== undefined || rec.familyRevoked)) {
      // Reuse detected! Revoke entire family + revoke KeyStore key + ledger alert
      const keyIds = await store.revokeRefreshTokenFamily(rec.familyId, rec.principalId);
      if (state.keys) {
        for (const kid of keyIds) {
          await state.keys.revoke(kid, { by: 'service:mcp-oauth' }).catch(() => undefined);
        }
      }
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

    if (!state.keys) {
      return json(res, 503, { error: 'server_error', error_description: 'Key store unavailable' }), true;
    }

    // Advance family generation & rotate KeyStore fk_at_ key (+1h TTL)
    const newExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const scopes = mapOAuthScopeToKeyScopes(rec.scope);
    const keyOut = await state.keys.rotate(rec.keyId, {
      by: rec.principalId,
      expiresAt: newExpiresAt,
      secretPrefix: 'fk_at_',
      audience: rec.audience,
      oauthClientId: rec.clientId,
      oauthClientName: rec.clientName,
      scopes,
    });

    const newRefreshToken = 'fk_rt_' + b64url(randomBytes(32));
    const newTokenHash = hashApiKey(newRefreshToken);
    const newRefreshExpiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

    await store.rotateRefreshTokenFamily(tokenHash, newTokenHash, newRefreshExpiresAt, keyOut.record.id);

    return json(res, 200, {
      access_token: keyOut.plaintext,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: newRefreshToken,
      scope: rec.scope ?? 'mcp:full',
    }), true;
  }

  return json(res, 400, { error: 'unsupported_grant_type', error_description: 'Grant type not supported' }), true;
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

  if (token.startsWith('fk_rt_')) {
    const hash = hashApiKey(token);
    const rec = store.getRefreshTokenByHash(hash);
    if (rec) {
      const keyIds = await store.revokeRefreshTokenFamily(rec.familyId, rec.principalId);
      if (state.keys) {
        for (const kid of keyIds) {
          await state.keys.revoke(kid, { by: 'service:mcp-oauth' }).catch(() => undefined);
        }
      }
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

  const consents = state.mcpOAuthStore!.listConsents(owner);
  return json(res, 200, {
    consents: consents.map((c) => ({
      clientId: c.clientId,
      clientName: c.clientName,
      scope: c.scope,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
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

  // Revoke consent
  const existed = await state.mcpOAuthStore!.revokeConsent(owner, clientId);

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

export function mapOAuthScopeToKeyScopes(scopeStr?: string): KeyScopes | undefined {
  if (!scopeStr || scopeStr.trim() === '' || scopeStr.trim() === 'mcp:full') return undefined;
  const parts = scopeStr.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.includes('mcp:full')) return undefined;
  const privs = new Set(parts);
  privs.add('mcp.use');
  return { privileges: Array.from(privs) };
}
