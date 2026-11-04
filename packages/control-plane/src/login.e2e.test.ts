// S12 (#362): factory login page, state/PKCE OAuth with verified email, HttpOnly sessions, UI gating, logout.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, FileDocBackend, GrantStore, PrincipalStore, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { ApiKeyStore } from '@beercanlabs/factory-bouncer';
import { IdpConfigStore } from './idp-config.js';
import { SessionStore } from './login.js';

const ISSUER = 'https://idp.test';
const BASE = 'https://factory.test';

describe('S12: login page, OAuth state/PKCE, sessions (#362)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  // The mock IdP: what the next sign-in's userinfo says, and the PKCE challenge it saw.
  let nextUser: Record<string, unknown> = {};
  const challenges = new Map<string, string>();
  let lastTokenForm: URLSearchParams | undefined;

  const idpFetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/.well-known/openid-configuration') {
      return j({ authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo` });
    }
    if (u.pathname === '/token') {
      lastTokenForm = new URLSearchParams(String(init?.body));
      const code = lastTokenForm.get('code')!;
      const want = challenges.get(code);
      const got = createHash('sha256').update(lastTokenForm.get('code_verifier') ?? '').digest('base64url');
      return want && want === got ? j({ access_token: `at-${code}` }) : j({ error: 'invalid_grant' }, 400);
    }
    if (u.pathname === '/userinfo') return j(nextUser);
    return j({ error: 'nope' }, 404);
  }) as typeof fetch;

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' });

  /** Drives start → IdP authorize → callback like a browser, returning the callback response. */
  async function signIn(user: Record<string, unknown>, opts: { tamperState?: boolean; badVerifier?: boolean; otherBrowser?: boolean; cliQuery?: string } = {}) {
    nextUser = user;
    const start = await get(`/api/v1/auth/oidc/start${opts.cliQuery ?? ''}`);
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('location')!);
    assert.equal(auth.origin + auth.pathname, `${ISSUER}/authorize`);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), `${BASE}/api/v1/auth/oidc/callback`);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    challenges.set(code, opts.badVerifier ? 'wrong' : auth.searchParams.get('code_challenge')!);
    const st = opts.tamperState ? 'forged' : auth.searchParams.get('state')!;
    const bound = opts.otherBrowser ? {} : { cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };
    return get(`/api/v1/auth/oidc/callback?code=${code}&state=${encodeURIComponent(st)}`, bound);
  }
  const sessionCookie = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's12-login-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), { principals, knownGroups: (g) => Boolean(groups.getGroup(g)) });
    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: { name: 'none', verify: async () => ({ ok: false, reason: 'no bearer' }) },
      principals,
      grants,
      groups,
      version: '0.1.0',
      providers: [envProvider({ S12_IDP_SECRET: 'idp-client-secret' })], // secret-scan:allow (test fixture)
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('s12-login-run-token-key-0123456789abcdef'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      publicBaseUrl: BASE,
      oauthFetch: idpFetch,
      sessions: new SessionStore(),
    } as unknown as FactoryState;
    state.keys = await ApiKeyStore.open();
    state.idpConfig = await IdpConfigStore.open();
    await state.idpConfig.put({ providers: [{ id: 'oidc', clientId: 'factory-client', issuer: ISSUER, clientSecretRef: 'S12_IDP_SECRET' }] }, 'user:admin');
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC1: an unauthenticated browser at / or /ui gets only the login page, with the configured IdP button', async () => {
    const root = await get('/', { accept: 'text/html' });
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /Sign in with Single sign-on/);
    assert.match(html, /href="\/api\/v1\/auth\/oidc\/start"/);
    assert.ok(!/<script/i.test(html), 'the login page loads no SPA asset');
    const ui = await get('/ui', { accept: 'text/html' });
    assert.equal(ui.status, 302);
    assert.equal(ui.headers.get('location'), '/login');
    assert.equal((await get('/login')).status, 200);
    assert.equal((await get('/api/v1/auth/google/start')).status, 404, 'an unconfigured IdP has no start route');
  });

  it('AC2: a verified email issues an HttpOnly session, ledgers SIGN_IN, and whoami resolves the principal', async () => {
    const cb = await signIn({ email: 'Stephanie@Example.com', email_verified: true });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/ui');
    const setCookie = cb.headers.get('set-cookie') ?? '';
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(flag), `cookie has ${flag}: ${setCookie}`);
    assert.equal(lastTokenForm?.get('client_secret'), 'idp-client-secret', 'the client secret is read from its reference');
    const c = sessionCookie(cb);
    const who = await get('/api/v1/whoami', { cookie: c });
    assert.equal(who.status, 200);
    assert.equal(((await who.json()) as { actor: string }).actor, 'user:stephanie');
    assert.equal((await get('/ui', { cookie: c })).status, 200);
    const rows = ledger.query() as Array<{ action?: string; actor?: string }>;
    assert.ok(rows.some((r) => r.action === 'SIGN_IN' && r.actor === 'oidc:stephanie@example.com'));
    assert.ok(!JSON.stringify(rows).includes(c.split('=')[1]), 'the session id is never ledgered');
  });

  it('refuses an unverified email, a forged state, a replayed state, and a wrong PKCE verifier', async () => {
    const unverified = await signIn({ email: 'stephanie@example.com', email_verified: false });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.headers.get('set-cookie'), null);
    assert.equal((await signIn({ email: 'stephanie@example.com', email_verified: true }, { tamperState: true })).status, 400);
    assert.equal((await signIn({ email: 'stephanie@example.com', email_verified: true }, { badVerifier: true })).status, 401);
    // Replay: reuse one state twice.
    nextUser = { email: 'stephanie@example.com', email_verified: true };
    const start = await get('/api/v1/auth/oidc/start');
    const st = new URL(start.headers.get('location')!).searchParams;
    challenges.set('replay', st.get('code_challenge')!);
    const bound = { cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };
    assert.equal((await get(`/api/v1/auth/oidc/callback?code=replay&state=${st.get('state')}`, bound)).status, 302);
    assert.equal((await get(`/api/v1/auth/oidc/callback?code=replay&state=${st.get('state')}`, bound)).status, 400);
    // Login CSRF: a valid state finished in a browser that did not start it is refused.
    assert.equal((await signIn({ email: 'stephanie@example.com', email_verified: true }, { otherBrowser: true })).status, 400);
  });

  it('S12: with a login base (the console host) the IdP redirect_uri uses it, so the cookie lands where people browse', async () => {
    state.loginBaseUrl = 'https://console.example.test';
    try {
      const start = await get('/api/v1/auth/oidc/start');
      assert.equal(new URL(start.headers.get('location')!).searchParams.get('redirect_uri'), 'https://console.example.test/api/v1/auth/oidc/callback');
    } finally {
      state.loginBaseUrl = undefined;
    }
  });

  it('logout ends the session, clears the cookie and ledgers SIGN_OUT; a cross-origin cookie POST is refused', async () => {
    const c = sessionCookie(await signIn({ email: 'stephanie@example.com', email_verified: true }));
    const cross = await fetch(`http://127.0.0.1:${port}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: c, origin: 'https://evil.test' } });
    assert.equal(cross.status, 403);
    assert.equal((await get('/api/v1/whoami', { cookie: c })).status, 200, 'a refused cross-origin logout leaves the session');
    const out = await fetch(`http://127.0.0.1:${port}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: c, origin: BASE } });
    assert.equal(out.status, 200);
    const cleared = out.headers.getSetCookie();
    assert.ok(cleared.some((h) => /^factory_session=;.*Path=\/;.*Max-Age=0/.test(h)), 'the session cookie is expired with the attributes it was set with');
    assert.ok(cleared.some((h) => /^CF_Authorization=;.*Path=\/;.*Max-Age=0/.test(h)), 'a stale Access cookie on the host is expired too (#427)');
    assert.equal(out.headers.get('clear-site-data'), '"cookies"');
    // Regression (#427): replaying the old cookie after sign-out is refused everywhere, not just on whoami.
    assert.equal((await get('/api/v1/whoami', { cookie: c })).status, 401);
    for (const path of ['/api/v1/principals', '/api/v1/keys', '/api/v1/setup/status']) {
      assert.equal((await get(path, { cookie: c })).status, 401, `${path} with the signed-out cookie`);
    }
    assert.ok((ledger.query() as Array<{ action?: string }>).some((r) => r.action === 'SIGN_OUT'));
  });

  it('a session cookie does not authorize a state-changing request from another origin', async () => {
    const c = sessionCookie(await signIn({ email: 'stephanie@example.com', email_verified: true }));
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/keys`, { method: 'POST', headers: { cookie: c, origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  });

  it('CL9 S13 AC1: the CLI loopback gets a one-time code and trades it with its PKCE verifier for a cli fk_ key; a second login rotates it', async () => {
    const verifier = 'cli-verifier-0123456789abcdefghijklmnop';
    const cliChallenge = createHash('sha256').update(verifier).digest('base64url');
    const q = `?cli_port=53682&cli_state=clistate0123456789ab&cli_challenge=${cliChallenge}`;
    const page = await (await get(`/login${q}`)).text();
    assert.ok(page.includes(`/api/v1/auth/oidc/start${q.replace(/&/g, '&#38;')}`), 'the IdP button carries the CLI request');
    const loginOnce = async () => {
      const cb = await signIn({ email: 'stephanie@example.com', email_verified: true }, { cliQuery: q });
      assert.equal(cb.status, 302);
      const loc = new URL(cb.headers.get('location')!);
      assert.equal(loc.origin, 'http://127.0.0.1:53682');
      assert.equal(loc.searchParams.get('state'), 'clistate0123456789ab');
      assert.equal(loc.searchParams.get('key'), null, 'the key never rides the redirect');
      const code = loc.searchParams.get('code')!;
      const bad = await fetch(`http://127.0.0.1:${port}/api/v1/auth/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier: 'wrong-verifier-0123456789abcdefgh' }) });
      assert.equal(bad.status, 400);
      return { code, cb };
    };
    // A wrong verifier burns the code.
    const first = await loginOnce();
    const burned = await fetch(`http://127.0.0.1:${port}/api/v1/auth/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: first.code, verifier }) });
    assert.equal(burned.status, 400);
    const second = await signIn({ email: 'stephanie@example.com', email_verified: true }, { cliQuery: q });
    const code2 = new URL(second.headers.get('location')!).searchParams.get('code')!;
    const tok = await fetch(`http://127.0.0.1:${port}/api/v1/auth/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, verifier }) });
    assert.equal(tok.status, 200);
    const out = (await tok.json()) as { secret: string; key: { id: string; deviceFamily: string; owner: string; hash?: string } };
    assert.match(out.secret, /^fk_/);
    assert.equal(out.key.deviceFamily, 'cli');
    assert.equal(out.key.owner, 'user:stephanie');
    assert.equal(out.key.hash, undefined);
    const who = await get('/api/v1/whoami', { authorization: `Bearer ${out.secret}` });
    assert.equal(who.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/auth/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, verifier }) })).status, 400, 'the code is one-time');
    const third = await signIn({ email: 'stephanie@example.com', email_verified: true }, { cliQuery: q });
    const code3 = new URL(third.headers.get('location')!).searchParams.get('code')!;
    const again = (await (await fetch(`http://127.0.0.1:${port}/api/v1/auth/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code3, verifier }) })).json()) as { secret: string; key: { id: string } };
    assert.equal(again.key.id, out.key.id, 'the same cli key is rotated, not duplicated');
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${out.secret}` })).status, 401, 'the old cli secret stops working');
  });

  it('S13: a malformed CLI request is ignored, and a stranger gets no key', async () => {
    const cb = await signIn({ email: 'stephanie@example.com', email_verified: true }, { cliQuery: '?cli_port=80&cli_state=x&cli_challenge=y' });
    assert.equal(cb.headers.get('location'), '/ui');
    const verifier = 'cli-verifier-0123456789abcdefghijklmnop';
    const q = `?cli_port=53682&cli_state=clistate0123456789ab&cli_challenge=${createHash('sha256').update(verifier).digest('base64url')}`;
    const stranger = await signIn({ email: 'nobody@elsewhere.test', email_verified: true }, { cliQuery: q });
    assert.equal(stranger.status, 403);
  });
});
