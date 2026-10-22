/**
 * OIDC sign-in for the CLI (§6.17 CL9): authorization code with PKCE (S256), a state and a nonce, and a loopback redirect
 * on 127.0.0.1. The CLI is a public client: it has no client secret. The factory verifies the token it is sent (A2).
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NeedsLoginError, type CredentialStore } from './credentials.js';
import type { Credential, Session } from './session.js';

export type OidcConfig = {
  issuer: string;
  clientId: string;
  scopes: string[];
  tokenUse: 'id_token' | 'access_token';
  redirectPort?: number;
};

/** What the Keychain holds for an OIDC sign-in. Everything needed to refresh is here; nothing is fetched at startup. */
type Stored = { kind: 'oidc'; issuer: string; clientId: string; tokenEndpoint: string; tokenUse: OidcConfig['tokenUse']; token: string; exp: number; refreshToken?: string };

export type OidcDeps = {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  say: (text: string) => void;
  now?: () => number;
  timeoutMs?: number;
};

const SKEW_SECONDS = 60;

export const base64url = (b: Buffer): string => b.toString('base64url');
export const newVerifier = (): string => base64url(randomBytes(32));
export const challengeOf = (verifier: string): string => base64url(createHash('sha256').update(verifier).digest());
const randomToken = (): string => base64url(randomBytes(16));

export function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isLoopback = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
function secureUrl(raw: unknown, what: string): string {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`the provider's ${what} is not a URL`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) throw new Error(`the provider's ${what} is not https`);
  return u.toString();
}

export type ProviderMetadata = { authorizationEndpoint: string; tokenEndpoint: string };

export async function fetchProviderMetadata(issuer: string, doFetch: typeof fetch): Promise<ProviderMetadata> {
  const res = await doFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { redirect: 'error' });
  if (!res.ok) throw new Error(`the provider's configuration could not be read (HTTP ${res.status})`);
  const doc = (await res.json()) as { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown };
  // A provider must say it is the issuer we were told about; otherwise a document served elsewhere could stand in for it.
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new Error("the provider's configuration names a different issuer");
  return { authorizationEndpoint: secureUrl(doc.authorization_endpoint, 'authorization endpoint'), tokenEndpoint: secureUrl(doc.token_endpoint, 'token endpoint') };
}

/** A one-shot listener for the provider's redirect. It binds 127.0.0.1 only and answers nothing but /callback. */
export async function startLoopback(port = 0): Promise<{ redirectUri: string; wait(state: string, timeoutMs: number): Promise<string>; close(): void }> {
  let onResult: ((r: { code?: string; error?: string }) => void) | undefined;
  let expected = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    // Anything that does not carry our state (a stray request, a forged one) is ignored, not trusted.
    if (!expected || url.searchParams.get('state') !== expected) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('This sign-in link is not for this session.');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Factory CLI</title><body style="font:16px system-ui;margin:3rem">${error ? 'Sign-in did not complete.' : 'Signed in. You can close this tab and return to the terminal.'}</body>`);
    onResult?.(error ? { error: error.slice(0, 200).replace(/[^\w .:/-]/g, '') } : { code: code ?? undefined });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${bound}/callback`,
    wait: (state, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        expected = state;
        const timer = setTimeout(() => reject(new Error('the sign-in was not completed in time')), timeoutMs);
        onResult = (r) => {
          clearTimeout(timer);
          if (r.error) reject(new Error(`the provider refused the sign-in (${r.error})`));
          else if (!r.code) reject(new Error('the provider returned no code'));
          else resolve(r.code);
        };
      }),
    close: () => server.close(),
  };
}

export const openBrowser = (url: string): Promise<void> =>
  new Promise((resolve) => {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
    if (!cmd) return resolve();
    execFile(cmd, [url], () => resolve()); // best effort: the link is always printed too
  });

type TokenResponse = { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

export class OidcSession implements Session {
  readonly kind = 'oidc' as const;

  constructor(
    private readonly instance: string,
    private readonly store: CredentialStore,
    private readonly deps: OidcDeps,
    /** From discovery. Without it the session can use and refresh a stored sign-in but not start a new one. */
    private readonly config?: OidcConfig,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  describe(): string {
    const issuer = this.config?.issuer;
    return issuer ? `OIDC (${new URL(issuer).hostname})` : 'OIDC';
  }

  private async read(): Promise<Stored | undefined> {
    const raw = await this.store.get(this.instance);
    if (!raw?.startsWith('{')) return undefined;
    try {
      const v = JSON.parse(raw) as Stored;
      return v.kind === 'oidc' && typeof v.token === 'string' && typeof v.exp === 'number' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async credential(refresh = false): Promise<Credential> {
    let s = await this.read();
    if (!s) throw new NeedsLoginError(this.instance);
    if (refresh || s.exp - SKEW_SECONDS <= this.now() / 1000) s = await this.refresh(s);
    return { name: 'authorization', value: `Bearer ${s.token}` };
  }

  private async refresh(s: Stored): Promise<Stored> {
    if (!s.refreshToken) {
      // Nothing to renew with: the sign-in is over once the token is.
      if (s.exp - SKEW_SECONDS > this.now() / 1000) return s;
      await this.store.delete(this.instance);
      throw new NeedsLoginError(this.instance);
    }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId });
    const t = await this.tokenRequest(s.tokenEndpoint, body).catch(() => undefined);
    const next = t ? this.fromResponse(t, s.tokenEndpoint, s.issuer, s.clientId, s.tokenUse, undefined, s.refreshToken) : undefined;
    if (!next) {
      await this.store.delete(this.instance);
      throw new NeedsLoginError(this.instance);
    }
    await this.save(next);
    return next;
  }

  private async save(s: Stored): Promise<void> {
    await this.store.set(this.instance, JSON.stringify(s));
  }

  private async tokenRequest(endpoint: string, body: URLSearchParams): Promise<TokenResponse> {
    const res = await this.deps.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
    });
    const t = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || t.error) throw new Error(`the provider refused the request${t.error ? ` (${String(t.error).slice(0, 80).replace(/[^\w .-]/g, '')})` : ` (HTTP ${res.status})`}`);
    return t;
  }

  /** Reads a token response into what is stored. `nonce` is checked on the first sign-in only. */
  private fromResponse(t: TokenResponse, tokenEndpoint: string, issuer: string, clientId: string, tokenUse: OidcConfig['tokenUse'], nonce: string | undefined, priorRefresh?: string): Stored | undefined {
    if (nonce !== undefined) {
      const claims = t.id_token ? jwtPayload(t.id_token) : undefined;
      if (!claims || claims.nonce !== nonce) throw new Error('the provider did not return the nonce this sign-in sent');
    }
    const token = tokenUse === 'id_token' ? t.id_token : t.access_token;
    if (!token) {
      if (nonce !== undefined) throw new Error(`the provider returned no ${tokenUse}; check FACTORY_OIDC_CLI_TOKEN_USE and the scopes`);
      return undefined;
    }
    const exp = typeof jwtPayload(token)?.exp === 'number' ? (jwtPayload(token)!.exp as number) : Math.floor(this.now() / 1000) + (typeof t.expires_in === 'number' ? t.expires_in : 300);
    return { kind: 'oidc', issuer, clientId, tokenEndpoint, tokenUse, token, exp, ...((t.refresh_token ?? priorRefresh) ? { refreshToken: t.refresh_token ?? priorRefresh } : {}) };
  }

  async login(opts: { differentUser?: boolean } = {}): Promise<void> {
    const cfg = this.config;
    if (!cfg) throw new Error('this factory has not told the CLI how to sign in; use /login again');
    const meta = await fetchProviderMetadata(cfg.issuer, this.deps.fetch);
    const verifier = newVerifier();
    const state = randomToken();
    const nonce = randomToken();
    const loop = await startLoopback(cfg.redirectPort);
    try {
      const url = new URL(meta.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: loop.redirectUri,
        scope: cfg.scopes.join(' '),
        state,
        nonce,
        code_challenge: challengeOf(verifier),
        code_challenge_method: 'S256',
        ...(opts.differentUser ? { prompt: 'login' } : {}),
      }).toString();
      this.deps.say(`Opening your browser to sign in at ${new URL(cfg.issuer).hostname}. If it does not open, visit:\n${url.toString()}`);
      const waiting = loop.wait(state, this.deps.timeoutMs ?? 5 * 60_000);
      waiting.catch(() => {}); // an early refusal must not be unhandled while the browser is being opened; it is awaited below
      await this.deps.openBrowser(url.toString());
      const code = await waiting;
      const t = await this.tokenRequest(
        meta.tokenEndpoint,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: loop.redirectUri, client_id: cfg.clientId, code_verifier: verifier }),
      );
      const stored = this.fromResponse(t, meta.tokenEndpoint, cfg.issuer, cfg.clientId, cfg.tokenUse, nonce);
      if (!stored) throw new Error('the provider returned no token');
      await this.save(stored);
    } finally {
      loop.close();
    }
  }

  async logout(): Promise<void> {
    await this.store.delete(this.instance);
  }
}
