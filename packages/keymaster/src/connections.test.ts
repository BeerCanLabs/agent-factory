import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { ConnectionKeymaster, grantSecretName, type Grant, type ConnectionProvider } from './connections.js';

const TEST_PROVIDERS: Record<string, ConnectionProvider> = {
  google: {
    kind: 'oauth-user',
    provider: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
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
    tokenUrl: 'https://oauth2.googleapis.com/token',
    keySecret: 'GOOGLE_SERVICE_ACCOUNT',
    defaultScopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  },
};
const testResolver = (name: string) => TEST_PROVIDERS[name];

/** In-memory writable secrets backend. */
function memoryProvider(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: string[] = [];
  const provider: SecretProvider = {
    name: 'mem',
    async get(n) {
      return values.get(n);
    },
    async put(n, v) {
      writes.push(n);
      values.set(n, v);
    },
  };
  return { provider, values, writes };
}

type TokenCall = { url: string; form: URLSearchParams };

function fakeTokenEndpoint(respond: (form: URLSearchParams) => { status: number; body: Record<string, unknown> }) {
  const calls: TokenCall[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url: String(url), form });
    const r = respond(form);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const CLIENT = JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'client-secret-value' });
const grant = (over: Partial<Grant> = {}): Grant => ({
  provider: 'google',
  clientRef: 'GOOGLE_OAUTH_CLIENT',
  refreshToken: 'refresh-token-1',
  scopes: ['https://www.googleapis.com/auth/calendar'],
  obtainedAt: '2026-09-01T00:00:00.000Z',
  grantedBy: 'admin',
  status: 'active',
  ...over,
});

describe('Keymaster connections (§6.11)', () => {
  it('refreshes once, caches the access token until 60s before expiry, then refreshes again', async () => {
    let now = 1_000_000;
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [grantSecretName('donna', 'google')]: JSON.stringify(grant()) });
    let n = 0;
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: `at-${++n}`, expires_in: 3600 } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, now: () => now, getProvider: testResolver });

    const a = await km.accessToken('donna', 'google');
    assert.deepEqual(a, { ok: true, accessToken: 'at-1', expiresAt: new Date(now + 3600_000).toISOString() });
    assert.equal(tok.calls.length, 1);
    assert.equal(tok.calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(tok.calls[0].form.get('grant_type'), 'refresh_token');
    assert.equal(tok.calls[0].form.get('refresh_token'), 'refresh-token-1');
    assert.equal(tok.calls[0].form.get('client_id'), 'cid.apps.googleusercontent.com');

    now += 3600_000 - 61_000;
    assert.equal((await km.accessToken('donna', 'google')).ok && tok.calls.length, 1, 'still cached 61s before expiry');
    now += 2_000;
    const c = await km.accessToken('donna', 'google');
    assert.ok(c.ok && c.accessToken === 'at-2', 'refreshed inside the 60s window');
    assert.equal(tok.calls.length, 2);
    assert.deepEqual(mem.writes, [], 'no rotation, nothing persisted');
  });

  it('shares one refresh between concurrent callers', async () => {
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [grantSecretName('donna', 'google')]: JSON.stringify(grant()) });
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'at', expires_in: 3600 } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, getProvider: testResolver });
    const out = await Promise.all([km.accessToken('donna', 'google'), km.accessToken('donna', 'google'), km.accessToken('donna', 'google')]);
    assert.ok(out.every((o) => o.ok));
    assert.equal(tok.calls.length, 1);
  });

  it('persists a rotated refresh token immediately (K3) and ledgers the rotation without tokens', async () => {
    const name = grantSecretName('donna', 'google');
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [name]: JSON.stringify(grant()) });
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'at-new', expires_in: 3600, refresh_token: 'refresh-token-2' } }));
    const ledger = new MemoryLedger();
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, ledger, getProvider: testResolver });
    assert.ok((await km.accessToken('donna', 'google')).ok);
    assert.deepEqual(mem.writes, [name]);
    const stored = JSON.parse(mem.values.get(name)!) as Grant;
    assert.equal(stored.refreshToken, 'refresh-token-2');
    assert.equal(stored.status, 'active');
    const rows = ledger.query({});
    assert.equal(rows.at(-1)?.action, 'CONNECTION_REFRESH_TOKEN_ROTATED');
    assert.equal(JSON.stringify(rows).includes('refresh-token'), false);
    assert.equal(JSON.stringify(rows).includes('at-new'), false);
  });

  it('marks the grant needs_reconsent on invalid_grant and stops calling the provider (K4)', async () => {
    const name = grantSecretName('donna', 'google');
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [name]: JSON.stringify(grant()) });
    const tok = fakeTokenEndpoint(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    const ledger = new MemoryLedger();
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, ledger, getProvider: testResolver });
    const r = await km.accessToken('donna', 'google');
    assert.deepEqual(r, { ok: false, error: 'needs_reconsent', provider: 'google', reason: 'invalid_grant' });
    assert.equal((JSON.parse(mem.values.get(name)!) as Grant).status, 'needs_reconsent');
    assert.ok(ledger.query({}).some((e) => e.action === 'CONNECTION_MARKED_NEEDS_RECONSENT'));
    const again = await km.accessToken('donna', 'google');
    assert.equal(again.ok, false);
    assert.equal(tok.calls.length, 1, 'a marked grant is not retried');
  });

  it('reports needs_reconsent when there is no grant or the grant lacks a requested scope', async () => {
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [grantSecretName('donna', 'google')]: JSON.stringify(grant()) });
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'at', expires_in: 3600 } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, getProvider: testResolver });
    assert.deepEqual(await km.accessToken('nobody', 'google'), { ok: false, error: 'needs_reconsent', provider: 'google', reason: 'no_grant' });
    assert.ok((await km.accessToken('donna', 'google')).ok);
    const r = await km.accessToken('donna', 'google', ['https://www.googleapis.com/auth/gmail.modify']);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, 'needs_reconsent');
  });

  it('other token endpoint failures are unavailable, not needs_reconsent', async () => {
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT, [grantSecretName('donna', 'google')]: JSON.stringify(grant()) });
    const tok = fakeTokenEndpoint(() => ({ status: 503, body: { error: 'backend_error' } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, getProvider: testResolver });
    const r = await km.accessToken('donna', 'google');
    assert.equal(!r.ok && r.error, 'connection_unavailable');
    assert.equal((JSON.parse(mem.values.get(grantSecretName('donna', 'google'))!) as Grant).status, 'active');
  });

  it('mints service-account tokens with an RS256 JWT-bearer assertion that verifies with the public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = {
      type: 'service_account',
      client_email: 'factory@proj.iam.gserviceaccount.com',
      private_key_id: 'kid-1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: 'https://oauth2.googleapis.com/token',
    };
    const mem = memoryProvider({ GOOGLE_SERVICE_ACCOUNT: JSON.stringify(sa) });
    const now = 1_700_000_000_000;
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'sa-token', expires_in: 3599, token_type: 'Bearer' } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, now: () => now, getProvider: testResolver });

    const r = await km.accessToken('donna', 'google-service-account');
    assert.ok(r.ok && r.accessToken === 'sa-token');
    assert.equal(tok.calls[0].form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = tok.calls[0].form.get('assertion')!;
    const [h, c, sig] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(sig, 'base64url')), 'signature verifies with the public key');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.deepEqual(claims, {
      iss: 'factory@proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });

    // Cached per scope set; a different scope set mints a new token.
    await km.accessToken('other-agent', 'google-service-account');
    assert.equal(tok.calls.length, 1);
    await km.accessToken('donna', 'google-service-account', ['https://www.googleapis.com/auth/devstorage.read_only']);
    assert.equal(tok.calls.length, 2);
    assert.equal(JSON.parse(Buffer.from(tok.calls[1].form.get('assertion')!.split('.')[1], 'base64url').toString()).scope, 'https://www.googleapis.com/auth/devstorage.read_only');
  });

  it('exchanges an authorization code and records every token value for redaction', async () => {
    const secretValues = new Set<string>();
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT });
    const tok = fakeTokenEndpoint((f) =>
      f.get('code') === 'good-code'
        ? { status: 200, body: { access_token: 'access-from-code', refresh_token: 'refresh-from-code', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/calendar' } }
        : { status: 400, body: { error: 'invalid_grant' } },
    );
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, secretValues, getProvider: testResolver });
    const ok = await km.exchangeCode('google', { code: 'good-code', redirectUri: 'https://f.example/cb' });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.scopes, ['openid', 'https://www.googleapis.com/auth/calendar']);
    assert.equal(tok.calls[0].form.get('redirect_uri'), 'https://f.example/cb');
    assert.ok(secretValues.has('refresh-from-code') && secretValues.has('access-from-code') && secretValues.has('client-secret-value'));
    assert.deepEqual(await km.exchangeCode('google', { code: 'bad', redirectUri: 'x' }), { ok: false, error: 'invalid_grant' });
  });

  it('K4 LinkedIn: a grant without a refresh token is the access token, says when it ends, and ends then', async () => {
    let now = Date.parse('2026-10-01T00:00:00.000Z');
    const LI_CLIENT = JSON.stringify({ client_id: 'linkedin-client-id', client_secret: 'linkedin-client-secret' });
    const mem = memoryProvider({ LINKEDIN_OAUTH_CLIENT: LI_CLIENT });
    const ledger = new MemoryLedger();
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'linkedin-access-1', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, now: () => now, ledger, getProvider: testResolver });

    const out = await km.exchangeCode('linkedin', { code: 'li-code', redirectUri: 'https://f.example/api/v1/connections/linkedin/callback' });
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(tok.calls[0].url, 'https://www.linkedin.com/oauth/v2/accessToken');
    assert.equal(out.refreshToken, '');
    assert.deepEqual(out.scopes, ['openid', 'profile', 'w_member_social'], 'LinkedIn separates granted scopes with commas');
    const ends = new Date(now + 5_184_000_000).toISOString();
    assert.equal(out.expiresAt, ends);
    await km.saveGrant('castle', { provider: 'linkedin', clientRef: out.clientRef, refreshToken: out.refreshToken, accessToken: out.accessToken, expiresAt: out.expiresAt, scopes: out.scopes, obtainedAt: new Date(now).toISOString(), grantedBy: 'dale', status: 'active' });

    const [view] = await km.listGrants('castle', ['linkedin']);
    assert.equal(view.endsAt, ends, 'the grant says when it ends');
    assert.deepEqual(await km.accessToken('castle', 'linkedin'), { ok: true, accessToken: 'linkedin-access-1', expiresAt: ends });

    now += 5_184_000_000;
    const fresh = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, now: () => now, ledger, getProvider: testResolver });
    const ended = await fresh.accessToken('castle', 'linkedin');
    assert.deepEqual(ended, { ok: false, error: 'needs_reconsent', provider: 'linkedin', reason: 'grant_ended' });
    assert.equal(tok.calls.length, 1, 'no refresh is attempted');
    assert.equal(JSON.parse(mem.values.get(grantSecretName('castle', 'linkedin'))!).status, 'needs_reconsent');
    assert.ok(ledger.query({}).some((e) => e.action === 'CONNECTION_MARKED_NEEDS_RECONSENT'));
  });

  it('K4 a provider that must send a refresh token and does not is refused', async () => {
    const mem = memoryProvider({ GOOGLE_OAUTH_CLIENT: CLIENT });
    const tok = fakeTokenEndpoint(() => ({ status: 200, body: { access_token: 'access-only', expires_in: 3600 } }));
    const km = new ConnectionKeymaster({ providers: [mem.provider], fetch: tok.fn, getProvider: testResolver });
    assert.deepEqual(await km.exchangeCode('google', { code: 'c', redirectUri: 'x' }), { ok: false, error: 'no_refresh_token' });
  });
});
