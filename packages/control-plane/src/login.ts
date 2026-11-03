// plans/factory-auth.md S12 (R13, R14, R18, D18, D19, D22), #362
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import type { AuthResult } from '@beercanlabs/factory-auth';
import { json, type FactoryState } from './app.js';
import type { IdpKind, IdpProvider } from './idp-config.js';

export const SESSION_COOKIE = 'factory_session';
/** Binds an OAuth state to the browser that started it, so nobody can sign a victim in as themselves (login CSRF). */
const STATE_COOKIE = 'factory_oauth_state';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const LABELS: Record<IdpKind, string> = { google: 'Google', meta: 'Meta', cloudflare: 'Cloudflare', oidc: 'Single sign-on' };

type Session = { email: string; idp: IdpKind; expiresAt: number };
type Pending = { idp: IdpKind; verifier: string; expiresAt: number };
type Endpoints = { authorize: string; token: string; userinfo: string; scope: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Server-backed sessions: the cookie holds a random id, the store holds only its SHA-256, so a leaked store names no
 * live cookie. Each request re-resolves the email to the principal, so grants stay live (D2). A restart signs users out.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly now: () => number = Date.now) {}

  create(email: string, idp: IdpKind): string {
    const id = b64url(randomBytes(32));
    this.sessions.set(b64url(sha256(id)), { email, idp, expiresAt: this.now() + SESSION_TTL_MS });
    return id;
  }
  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const key = b64url(sha256(id));
    const s = this.sessions.get(key);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) return void this.sessions.delete(key);
    return s;
  }
  destroy(id: string | undefined): Session | undefined {
    const s = this.get(id);
    if (id) this.sessions.delete(b64url(sha256(id)));
    return s;
  }
  /** OAuth state: one-time, short-lived, bound to its IdP and PKCE verifier. */
  begin(idp: IdpKind): { state: string; challenge: string } {
    for (const [k, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    this.pending.set(state, { idp, verifier, expiresAt: this.now() + STATE_TTL_MS });
    return { state, challenge: b64url(sha256(verifier)) };
  }
  take(state: string, idp: IdpKind): string | undefined {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.idp !== idp || p.expiresAt <= this.now()) return undefined;
    return p.verifier;
  }
}

/** The one-time state check for the IdP callback: the PKCE verifier bound to it, or undefined when forged/expired/replayed. */
export function verifyOAuthState(state: FactoryState, st: string, idp: IdpKind): string | undefined {
  return st ? sessions(state).take(st, idp) : undefined;
}

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

function sameOrigin(state: FactoryState, req: http.IncomingMessage): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(String(req.headers.referer)) : undefined);
  if (!origin) return false;
  const allowed = new Set<string>();
  if (state.publicBaseUrl) allowed.add(safeOrigin(state.publicBaseUrl) ?? '');
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

/** The session verifier: a live factory session is a verified email with zero claim-derived roles (D2). */
export function verifySession(state: FactoryState, req: http.IncomingMessage): AuthResult {
  const email = sessionEmail(state, req);
  return email ? { ok: true, principal: { actor: `oidc:${email}`, roles: [] } } : { ok: false, reason: 'no session' };
}

function cookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The standalone login page: no SPA assets, no status, one button per configured IdP (D19, D22). */
export function loginPage(state: FactoryState, error?: string): string {
  const providers = state.idpConfig?.get().providers ?? [];
  const buttons = providers.length
    ? providers.map((p) => `<li><a class="b" href="/api/v1/auth/${p.id}/start">Sign in with ${esc(LABELS[p.id])}</a></li>`).join('')
    : '<li>No sign-in provider is configured yet.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Factory: sign in</title><style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}ul{list-style:none;padding:0}.b{display:block;padding:.7rem 1rem;margin:.5rem 0;border:1px solid #888;border-radius:.4rem;text-decoration:none;color:inherit}.e{color:#b00}</style></head><body><main><h1>Agent Factory</h1>${error ? `<p class="e">${esc(error)}</p>` : ''}<ul>${buttons}</ul></main></body></html>`;
}

export function sendLoginPage(state: FactoryState, res: http.ServerResponse, status = 200, error?: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(loginPage(state, error));
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

const callbackUrl = (state: FactoryState, idp: string) => `${state.publicBaseUrl!.replace(/\/$/, '')}/api/v1/auth/${idp}/callback`;

function ledger(state: FactoryState, action: 'SIGN_IN' | 'SIGN_OUT', email: string, idp: string): void {
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action, actor: `oidc:${email}`, subject: `idp:${idp}` });
}

/** GET /login, GET /api/v1/auth/:idp/start, GET /api/v1/auth/:idp/callback, POST /api/v1/auth/logout. */
export async function handleLoginRoutes(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/login' && req.method === 'GET') return sendLoginPage(state, res), true;

  if (path === '/api/v1/auth/logout' && req.method === 'POST') {
    const id = cookieValue(req, SESSION_COOKIE);
    if (id && state.sessions?.get(id) && !sessionEmail(state, req)) return json(res, 403, { error: 'cross_origin' }), true;
    const s = state.sessions?.destroy(id);
    if (s) ledger(state, 'SIGN_OUT', s.email, s.idp);
    res.setHeader('set-cookie', cookie('', 0));
    return json(res, 200, { ok: true }), true;
  }

  const start = path.match(/^\/api\/v1\/auth\/([^/]+)\/start$/);
  if (start && req.method === 'GET') return beginSignIn(state, res, start[1]);
  const cb = path.match(/^\/api\/v1\/auth\/([^/]+)\/callback$/);
  if (cb && req.method === 'GET') return finishSignIn(state, req, res, cb[1]);
  return false;
}

async function resolveIdp(state: FactoryState, res: http.ServerResponse, id: string): Promise<{ p: IdpProvider; ep: Endpoints } | undefined> {
  const p = provider(state, id);
  if (!p) return void json(res, 404, { error: 'unknown_idp' });
  if (!state.publicBaseUrl) return void json(res, 503, { error: 'login_unconfigured', message: 'FACTORY_PUBLIC_BASE_URL is required' });
  const ep = await endpointsFor(state, p).catch(() => undefined);
  if (!ep) return void json(res, 502, { error: 'idp_unreachable' });
  return { p, ep };
}

async function beginSignIn(state: FactoryState, res: http.ServerResponse, id: string): Promise<boolean> {
  const r = await resolveIdp(state, res, id);
  if (!r) return true;
  const { p, ep } = r;
  {
    const { state: st, challenge } = sessions(state).begin(p.id);
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
  const verifier = st && cookieValue(req, STATE_COOKIE) === st ? verifyOAuthState(state, st, p.id) : undefined;
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
  if (!email || !(info.email_verified === true || info.email_verified === 'true')) return sendLoginPage(state, res, 403, 'Your identity provider did not confirm a verified email.'), true;
  const domain = email.slice(email.indexOf('@') + 1);
  if (p.allowedDomains?.length && !p.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) return sendLoginPage(state, res, 403, 'This email domain may not sign in here.'), true;

  const sid = sessions(state).create(email, p.id);
  ledger(state, 'SIGN_IN', email, p.id);
  res.writeHead(302, { location: '/ui', 'set-cookie': cookie(sid, SESSION_TTL_MS / 1000), 'cache-control': 'no-store' });
  res.end();
  return true;
}

