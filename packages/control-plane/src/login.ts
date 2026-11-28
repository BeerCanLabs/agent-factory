// plans/factory-auth.md S12 (R13, R14, R18, D18, D19, D22), #362
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import type { AuthResult } from '@beercanlabs/factory-auth';
import { MemoryDocBackend, publicKeyView, snapshotSha256, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';
import { json, readJson, resolveVerifiedPrincipal, type FactoryState } from './app.js';
import type { IdpKind, IdpProvider } from './idp-config.js';
import { isSnapshotConflict } from './revocation-set.js';

export const SESSION_COOKIE = 'factory_session';
/** Binds an OAuth state to the browser that started it, so nobody can sign a victim in as themselves (login CSRF). */
const STATE_COOKIE = 'factory_oauth_state';
/** D-4: a session ends after this long with no use. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** D-4: a session ends this long after it was created, even if it is still in use. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An idle slide is written at least this often. A crash can only make the recorded idle shorter, so the session
 * ends early by at most this much. It never extends the 12 h idle window.
 */
const SESSION_TOUCH_COALESCE_MS = 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const LABELS: Record<IdpKind, string> = { google: 'Google', meta: 'Meta', cloudflare: 'Cloudflare', oidc: 'Single sign-on' };

/** What a caller may see. The cookie secret and its hash never leave the store. */
export type Session = {
  sid: string;
  email: string;
  idp: IdpKind;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
};
type StoredSession = Session & { idHash: string };
export type SessionsDoc = { sessions: StoredSession[] };
type Pending = { idp: IdpKind | 'cli'; verifier: string; expiresAt: number; cli?: CliLogin; owner?: string; oauthReq?: string };
/** S13: a CLI sign-in in flight: the loopback port, the CLI's own state, and its PKCE challenge for the key exchange. */
export type CliLogin = { port: number; state: string; challenge: string };
const CLI_CODE_TTL_MS = 2 * 60 * 1000;
type Endpoints = { authorize: string; token: string; userinfo: string; scope: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');
const earliest = (a?: number, b?: number): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/**
 * Server-backed sessions (D-4, #564). The cookie holds a random id; the store holds only its SHA-256 plus a public
 * `sid` for listing and revocation, so a leaked store names no live cookie. Idle is 12 h, absolute life is 7 days.
 * With a document backend the record survives a restart and is visible to other tasks after `reload`. Each request
 * re-resolves the email to the principal, so grants stay live (D2).
 */
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly pending = new Map<string, Pending>();
  private readonly dirty = new Set<string>();
  private docVersion = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly backend?: VersionedDocBackend<SessionsDoc>,
  ) {}

  static async open(
    backend: VersionedDocBackend<SessionsDoc> = new MemoryDocBackend<SessionsDoc>(),
    opts?: { now?: () => number },
  ): Promise<SessionStore> {
    const store = new SessionStore(opts?.now ?? Date.now, backend);
    await store.reload();
    return store;
  }

  create(email: string, idp: IdpKind): string {
    const id = b64url(randomBytes(32));
    const now = this.now();
    const idHash = b64url(sha256(id));
    this.sessions.set(idHash, {
      sid: `sess_${randomBytes(16).toString('hex')}`,
      idHash,
      email: email.trim().toLowerCase(),
      idp,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
    });
    this.dirty.add(idHash);
    return id;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const key = b64url(sha256(id));
    const s = this.sessions.get(key);
    if (!s) return undefined;
    const now = this.now();
    if (!this.isLive(s, now)) {
      if (!s.revokedAt) {
        s.revokedAt = now;
        this.dirty.add(key);
        this.scheduleFlush();
      }
      return undefined;
    }
    if (now > s.lastSeenAt) {
      s.lastSeenAt = now;
      this.dirty.add(key);
      this.scheduleFlush();
    }
    return this.view(s);
  }

  /** Live sessions for these emails, newest activity first. No cookie secret, no hash. */
  listForEmails(emails: readonly string[]): Session[] {
    const set = new Set(emails.map((e) => e.trim().toLowerCase()));
    const now = this.now();
    return [...this.sessions.values()]
      .filter((s) => set.has(s.email) && this.isLive(s, now))
      .map((s) => this.view(s))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** End one session by its public id. Returns the record when it existed. */
  revokeBySid(sid: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.sid !== sid) continue;
      if (!s.revokedAt) {
        s.revokedAt = this.now();
        this.dirty.add(s.idHash);
      }
      return this.view(s);
    }
    return undefined;
  }

  /** #436: end every live session of these (verified) emails. */
  destroyForEmails(emails: readonly string[]): { ended: number; sids: string[] } {
    const set = new Set(emails.map((e) => e.trim().toLowerCase()));
    const sids: string[] = [];
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (!set.has(s.email) || !this.isLive(s, now)) continue;
      s.revokedAt = now;
      this.dirty.add(s.idHash);
      sids.push(s.sid);
    }
    return { ended: sids.length, sids };
  }

  destroy(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const key = b64url(sha256(id));
    const s = this.sessions.get(key);
    if (!s) return undefined;
    if (!s.revokedAt) {
      s.revokedAt = this.now();
      this.dirty.add(key);
    }
    return this.view(s);
  }

  /** Write dirty records. Create, revoke and sign-out await this so a crash cannot resurrect them. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.backend || this.dirty.size === 0) return;
    await this.serial(() => this.flushUnlocked());
  }

  /** Pull another task's creates and revokes. Dirty local slides and revokes still win. */
  async reload(): Promise<void> {
    if (!this.backend) return;
    await this.serial(() => this.reloadUnlocked());
  }

  private isLive(s: StoredSession, now: number): boolean {
    return !s.revokedAt && now < s.absoluteExpiresAt && now < s.lastSeenAt + SESSION_IDLE_MS;
  }

  private view(s: StoredSession): Session {
    return {
      sid: s.sid,
      email: s.email,
      idp: s.idp,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      absoluteExpiresAt: s.absoluteExpiresAt,
      ...(s.revokedAt ? { revokedAt: s.revokedAt } : {}),
    };
  }

  private scheduleFlush(): void {
    if (!this.backend || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, SESSION_TOUCH_COALESCE_MS);
    this.flushTimer.unref?.();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reloadUnlocked(): Promise<void> {
    if (!this.backend) return;
    const st = this.backend.loadState
      ? await this.backend.loadState()
      : await (async () => {
          const snapshot = await this.backend!.loadLatest();
          return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
        })();
    const disk = new Map<string, StoredSession>();
    for (const row of st.snapshot?.data?.sessions ?? []) {
      if (row?.idHash && row.sid && row.email) disk.set(row.idHash, { ...row });
    }
    for (const [key, local] of this.sessions) {
      if (!this.dirty.has(key)) continue;
      const stored = disk.get(key);
      if (!stored) {
        disk.set(key, { ...local });
        continue;
      }
      const revokedAt = earliest(stored.revokedAt, local.revokedAt);
      disk.set(key, {
        ...stored,
        lastSeenAt: Math.max(stored.lastSeenAt, local.lastSeenAt),
        ...(revokedAt ? { revokedAt } : {}),
      });
    }
    this.sessions.clear();
    for (const [key, row] of disk) this.sessions.set(key, row);
    this.docVersion = st.snapshot?.version ?? 0;
  }

  private async flushUnlocked(): Promise<void> {
    if (!this.backend || this.dirty.size === 0) return;
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.reloadUnlocked();
      const written = new Map<string, { lastSeenAt: number; revokedAt?: number }>();
      for (const key of this.dirty) {
        const row = this.sessions.get(key);
        if (row) written.set(key, { lastSeenAt: row.lastSeenAt, revokedAt: row.revokedAt });
      }
      try {
        await this.commit();
        for (const [key, snap] of written) {
          const cur = this.sessions.get(key);
          if (cur && cur.lastSeenAt === snap.lastSeenAt && cur.revokedAt === snap.revokedAt) this.dirty.delete(key);
        }
        return;
      } catch (err) {
        last = err;
        if (!isSnapshotConflict(err)) throw err;
      }
    }
    throw last instanceof Error ? last : new Error('session_conflict');
  }

  private async commit(): Promise<void> {
    if (!this.backend) return;
    const now = this.now();
    const sessions = [...this.sessions.values()]
      .filter((s) => s.absoluteExpiresAt > now)
      .sort((a, b) => a.idHash.localeCompare(b.idHash));
    const data: SessionsDoc = { sessions };
    const version = this.docVersion + 1;
    await this.backend.write({
      version,
      updatedAt: new Date(now).toISOString(),
      updatedBy: 'session',
      sha256: snapshotSha256(data),
      data,
    });
    this.docVersion = version;
  }

  /** OAuth state: one-time, short-lived, bound to its IdP and PKCE verifier. */
  begin(idp: IdpKind, cli?: CliLogin, oauthReq?: string): { state: string; challenge: string } {
    for (const [k, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    this.pending.set(state, { idp, verifier, expiresAt: this.now() + STATE_TTL_MS, ...(cli ? { cli } : {}), ...(oauthReq ? { oauthReq } : {}) });
    return { state, challenge: b64url(sha256(verifier)) };
  }
  take(state: string, idp: IdpKind | 'cli'): Pending | undefined {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.idp !== idp || p.expiresAt <= this.now()) return undefined;
    return p;
  }
  /** S13: a one-time code the CLI trades, with the verifier for `challenge`, for its key. */
  cliCode(owner: string, challenge: string): string {
    const code = b64url(randomBytes(24));
    this.pending.set(code, { idp: 'cli', verifier: challenge, owner, expiresAt: this.now() + CLI_CODE_TTL_MS });
    return code;
  }
}

/** The one-time state check for the IdP callback: the PKCE verifier bound to it, or undefined when forged/expired/replayed. */
export function verifyOAuthState(state: FactoryState, st: string, idp: IdpKind | 'cli'): Pending | undefined {
  return st ? sessions(state).take(st, idp) : undefined;
}

const B64URL = /^[A-Za-z0-9_-]{16,128}$/;
/** S13: the CLI's loopback request, or undefined when absent or malformed. */
export function cliLoginOf(q: URLSearchParams): CliLogin | undefined {
  const port = Number(q.get('cli_port'));
  const st = q.get('cli_state') ?? '';
  const challenge = q.get('cli_challenge') ?? '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !B64URL.test(st) || !B64URL.test(challenge)) return undefined;
  return { port, state: st, challenge };
}
const authQuery = (c?: CliLogin, oauthReq?: string) => {
  const p = new URLSearchParams();
  if (c) {
    p.set('cli_port', String(c.port));
    p.set('cli_state', c.state);
    p.set('cli_challenge', c.challenge);
  }
  if (oauthReq) p.set('oauth_req', oauthReq);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function sessions(state: FactoryState): SessionStore {
  return (state.sessions ??= new SessionStore());
}

export function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

export function sameOrigin(state: FactoryState, req: http.IncomingMessage): boolean {
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

/**
 * The session's verified email, or undefined. A cookie on a state-changing request counts only from the factory's own
 * origin, so another site cannot ride the cookie (CSRF), on top of SameSite=Lax.
 */
export function sessionEmail(state: FactoryState, req: http.IncomingMessage): string | undefined {
  if (!state.sessions) return undefined;
  const s = state.sessions.get(cookieValue(req, SESSION_COOKIE));
  if (!s) return undefined;
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (!safe && !sameOrigin(state, req)) return undefined;
  return s.email;
}

/** The IdP of the caller's live factory session, if that is how they signed in (#432). */
export function sessionIdp(state: FactoryState, req: http.IncomingMessage): IdpKind | undefined {
  return sessionEmail(state, req) ? state.sessions?.get(cookieValue(req, SESSION_COOKIE))?.idp : undefined;
}

/** The session verifier: a live factory session is a verified email with zero claim-derived roles (D2). */
export function verifySession(state: FactoryState, req: http.IncomingMessage): AuthResult {
  const email = sessionEmail(state, req);
  // A live factory session was issued only after the IdP attested a verified email (R13 / #527).
  return email ? { ok: true, principal: { actor: `oidc:${email}`, roles: [], emailVerified: true } } : { ok: false, reason: 'no session' };
}

function cookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The standalone login page: no SPA assets, no status, one button per configured IdP (D19, D22). */
export function loginPage(state: FactoryState, error?: string, cli?: CliLogin, oauthReq?: string): string {
  const providers = state.idpConfig?.get().providers ?? [];
  const buttons = providers.length
    ? providers.map((p) => `<li><a class="b" href="/api/v1/auth/${p.id}/start${esc(authQuery(cli, oauthReq))}">Sign in with ${esc(LABELS[p.id])}</a></li>`).join('')
    : '<li>No sign-in provider is configured yet.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Factory: sign in</title><style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}ul{list-style:none;padding:0}.b{display:block;padding:.7rem 1rem;margin:.5rem 0;border:1px solid #888;border-radius:.4rem;text-decoration:none;color:inherit}.e{color:#b00}</style></head><body><main><h1>Agent Factory</h1>${error ? `<p class="e">${esc(error)}</p>` : ''}<ul>${buttons}</ul></main></body></html>`;
}

export function sendLoginPage(state: FactoryState, res: http.ServerResponse, status = 200, error?: string, cli?: CliLogin, oauthReq?: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(loginPage(state, error, cli, oauthReq));
}

const fetcher = (state: FactoryState) => state.oauthFetch ?? fetch;

async function endpointsFor(state: FactoryState, p: IdpProvider): Promise<Endpoints | undefined> {
  if (p.id === 'google') {
    return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile' };
  }
  if (p.id === 'meta') {
    // Meta's Graph API names no email_verified claim, so R13 refuses its sign-ins until it does (fail closed).
    return { authorize: 'https://www.facebook.com/v19.0/dialog/oauth', token: 'https://graph.facebook.com/v19.0/oauth/access_token', userinfo: 'https://graph.facebook.com/me?fields=id,email', scope: 'email' };
  }
  if (!p.issuer) return undefined;
  const base = p.id === 'cloudflare' && !p.issuer.includes('/cdn-cgi/') ? `${p.issuer.replace(/\/$/, '')}/cdn-cgi/access/sso/oidc/${encodeURIComponent(p.clientId)}` : p.issuer.replace(/\/$/, '');
  const r = await fetcher(state)(`${base}/.well-known/openid-configuration`);
  if (!r.ok) return undefined;
  const d = (await r.json()) as { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
  const https = (u?: string) => typeof u === 'string' && u.startsWith('https://');
  if (!https(d.authorization_endpoint) || !https(d.token_endpoint) || !https(d.userinfo_endpoint)) return undefined;
  return { authorize: d.authorization_endpoint!, token: d.token_endpoint!, userinfo: d.userinfo_endpoint!, scope: 'openid email profile' };
}

function provider(state: FactoryState, id: string): IdpProvider | undefined {
  return state.idpConfig?.get().providers.find((p) => p.id === id);
}

/** Sign-in callbacks land on the host people browse (the console), so its session cookie is set there (S12). */
const loginBase = (state: FactoryState) => state.loginBaseUrl || state.publicBaseUrl;
/**
 * R13: only a verified email counts. Cloudflare Access issues a SaaS OIDC token only after it has verified the user's
 * email itself (one-time PIN or its upstream IdP), and its id_token/userinfo omit `email_verified` (#420). So for the
 * `cloudflare` provider only, an email without the claim is verified; an explicit false is still refused.
 */
export function emailVerified(idp: string, info: { email_verified?: unknown }): boolean {
  if (info.email_verified === true || info.email_verified === 'true') return true;
  return idp === 'cloudflare' && info.email_verified === undefined;
}

const callbackUrl = (state: FactoryState, idp: string) => `${loginBase(state)!.replace(/\/$/, '')}/api/v1/auth/${idp}/callback`;

function ledger(state: FactoryState, action: 'SIGN_IN' | 'SIGN_OUT', email: string, idp: string): void {
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action, actor: `oidc:${email}`, subject: `idp:${idp}` });
}

/** GET /login, GET /api/v1/auth/:idp/start, GET /api/v1/auth/:idp/callback, POST /api/v1/auth/logout. */
export async function handleLoginRoutes(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/login' && req.method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const oauthReq = q.get('oauth_req') ?? undefined;
    if (oauthReq && sessionEmail(state, req)) {
      res.writeHead(302, { location: `/authorize?oauth_req=${encodeURIComponent(oauthReq)}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    return sendLoginPage(state, res, 200, undefined, cliLoginOf(q), oauthReq), true;
  }
  if (path === '/api/v1/auth/cli/token' && req.method === 'POST') return cliToken(state, req, res);

  if (path === '/api/v1/auth/logout' && req.method === 'POST') {
    const id = cookieValue(req, SESSION_COOKIE);
    if (id && state.sessions?.get(id) && !sessionEmail(state, req)) return json(res, 403, { error: 'cross_origin' }), true;
    const s = state.sessions?.destroy(id);
    try {
      await state.sessions?.flush();
    } catch {
      return json(res, 503, { error: 'session_store_unavailable', message: 'Sign-out could not be saved' }), true;
    }
    if (s) {
      ledger(state, 'SIGN_OUT', s.email, s.idp);
      const { endSessionCredentials } = await import('./account-sessions.js');
      await endSessionCredentials(state, s, 'sign-out');
    }
    // Also expire a Cloudflare Access cookie on this host (#427): the console host used to sit behind Access, and a
    // browser still holding CF_Authorization stayed signed in as cloudflare:<email> after the factory session ended.
    res.setHeader('set-cookie', [cookie('', 0), 'CF_Authorization=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    res.setHeader('clear-site-data', '"cookies"');
    return json(res, 200, { ok: true }), true;
  }

  const start = path.match(/^\/api\/v1\/auth\/([^/]+)\/start$/);
  if (start && req.method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    return beginSignIn(state, res, start[1], cliLoginOf(q), q.get('oauth_req') ?? undefined);
  }
  const cb = path.match(/^\/api\/v1\/auth\/([^/]+)\/callback$/);
  if (cb && req.method === 'GET') return finishSignIn(state, req, res, cb[1]);
  return false;
}

async function resolveIdp(state: FactoryState, res: http.ServerResponse, id: string): Promise<{ p: IdpProvider; ep: Endpoints } | undefined> {
  const p = provider(state, id);
  if (!p) return void json(res, 404, { error: 'unknown_idp' });
  if (!loginBase(state)) return void json(res, 503, { error: 'login_unconfigured', message: 'FACTORY_PUBLIC_BASE_URL is required' });
  const ep = await endpointsFor(state, p).catch(() => undefined);
  if (!ep) return void json(res, 502, { error: 'idp_unreachable' });
  return { p, ep };
}

async function beginSignIn(state: FactoryState, res: http.ServerResponse, id: string, cli?: CliLogin, oauthReq?: string): Promise<boolean> {
  const r = await resolveIdp(state, res, id);
  if (!r) return true;
  const { p, ep } = r;
  {
    const { state: st, challenge } = sessions(state).begin(p.id, cli, oauthReq);
    const u = new URL(ep.authorize);
    u.search = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: callbackUrl(state, p.id), scope: ep.scope, state: st, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store', 'set-cookie': `${STATE_COOKIE}=${st}; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Max-Age=${STATE_TTL_MS / 1000}` });
    res.end();
    return true;
  }
}

async function finishSignIn(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<boolean> {
  const r = await resolveIdp(state, res, id);
  if (!r) return true;
  const { p, ep } = r;
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const st = q.get('state') ?? '';
  const code = q.get('code') ?? '';
  const pending = st && cookieValue(req, STATE_COOKIE) === st ? verifyOAuthState(state, st, p.id) : undefined;
  const verifier = pending?.verifier;
  if (!verifier || !code) return sendLoginPage(state, res, 400, 'Sign-in expired or was not started here. Try again.'), true;

  let secret: string | undefined;
  if (p.clientSecretRef) {
    const b = await bindSecrets([p.clientSecretRef], state.providers);
    secret = b.ok ? b.env[p.clientSecretRef] : undefined;
    if (!secret) return json(res, 503, { error: 'idp_secret_missing' }), true;
  }
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(state, p.id), client_id: p.clientId, code_verifier: verifier });
  if (secret) form.set('client_secret', secret);
  const tok = await fetcher(state)(ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() }).catch(() => undefined);
  const access = tok?.ok ? ((await tok.json()) as { access_token?: string }).access_token : undefined;
  if (!access) return sendLoginPage(state, res, 401, 'The identity provider refused the sign-in.'), true;
  const ui = await fetcher(state)(ep.userinfo, { headers: { authorization: `Bearer ${access}`, accept: 'application/json' } }).catch(() => undefined);
  const info = ui?.ok ? ((await ui.json()) as { email?: unknown; email_verified?: unknown }) : {};
  const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
  // R13: only a verified email counts.
  if (!email || !emailVerified(p.id, info)) return sendLoginPage(state, res, 403, 'Your identity provider did not confirm a verified email.'), true;
  const domain = email.slice(email.indexOf('@') + 1);
  if (p.allowedDomains?.length && !p.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) return sendLoginPage(state, res, 403, 'This email domain may not sign in here.'), true;

  const sid = sessions(state).create(email, p.id);
  try {
    await sessions(state).flush();
  } catch {
    return json(res, 503, { error: 'session_store_unavailable', message: 'The sign-in could not be saved' }), true;
  }
  ledger(state, 'SIGN_IN', email, p.id);
  if (pending?.oauthReq) {
    res.writeHead(302, { location: `/authorize?oauth_req=${encodeURIComponent(pending.oauthReq)}`, 'set-cookie': cookie(sid, SESSION_ABSOLUTE_MS / 1000), 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (pending?.cli) {
    // S13: hand the CLI a one-time code on its loopback; the key itself only travels in the CLI's own POST.
    const who = await resolveVerifiedPrincipal(state, { actor: `oidc:${email}`, roles: [], emailVerified: true }, true);
    if (!state.keys || !/^user:/.test(who.actor)) return sendLoginPage(state, res, 403, 'You are signed in, but this factory has not granted you access yet.'), true;
    const code = sessions(state).cliCode(who.actor, pending.cli.challenge);
    res.writeHead(302, { location: `http://127.0.0.1:${pending.cli.port}/callback?${new URLSearchParams({ code, state: pending.cli.state })}`, 'set-cookie': cookie(sid, SESSION_ABSOLUTE_MS / 1000), 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  res.writeHead(302, { location: '/ui', 'set-cookie': cookie(sid, SESSION_ABSOLUTE_MS / 1000), 'cache-control': 'no-store' });
  res.end();
  return true;
}


/**
 * S13: POST /api/v1/auth/cli/token {code, verifier}. The one-time code from the loopback plus the CLI's PKCE verifier
 * yield the person's `cli` device-family key: the active one is rotated (its old secret stops working), else one is issued.
 */
async function cliToken(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const body = (await readJson(req).catch(() => ({}))) as { code?: unknown; verifier?: unknown };
  const pending = typeof body.code === 'string' ? verifyOAuthState(state, body.code, 'cli') : undefined;
  const ok = pending?.owner && typeof body.verifier === 'string' && b64url(sha256(body.verifier)) === pending.verifier;
  if (!ok || !state.keys) return json(res, 400, { error: 'invalid_grant' }), true;
  const owner = pending.owner!;
  const existing = state.keys.list({ owner }).find((k) => k.deviceFamily === 'cli' && !k.revokedAt);
  const out = existing ? await state.keys.rotate(existing.id, { by: owner }) : await state.keys.create({ owner, deviceFamily: 'cli', by: owner });
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: `${existing ? 'KEY_ROTATED' : 'KEY_ISSUED'}:${out.record.id}`, actor: owner, subject: owner });
  res.setHeader('cache-control', 'no-store');
  return json(res, 200, { key: publicKeyView(out.record), secret: out.plaintext }), true;
}
