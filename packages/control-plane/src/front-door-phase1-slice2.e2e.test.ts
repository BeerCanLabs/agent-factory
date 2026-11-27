// Front-door auth Phase 1 Slice 2 (issue #563): /token issues RFC 9068 JWTs for the api and mcp audiences,
// the resource server checks them against /jwks, and legacy fk_at_ / fk_ credentials still work.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import {
  canonicalAccessResource,
  generateEphemeralAsKey,
  signAccessToken,
  type AsKeySet,
} from '@beercanlabs/factory-auth';
import { ApiKeyStore, ApprovalStore, GrantStore, PrincipalStore } from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime, RunTokens } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { SessionStore } from './login.js';
import { McpOAuthStore } from './mcp-oauth.js';

const ISS = 'https://auth.example.test';
const API = canonicalAccessResource(ISS, 'api');
const MCP = canonicalAccessResource(ISS, 'mcp');
const REDIRECT = 'http://127.0.0.1:9/callback';

describe('front-door Phase 1 Slice 2: JWT access tokens', { concurrency: false }, () => {
  let server: http.Server;
  let port = 0;
  let state: FactoryState;
  let keys: AsKeySet;

  before(async () => {
    keys = { current: await generateEphemeralAsKey('slice2'), ephemeral: false };
    const principals = await PrincipalStore.open();
    const grants = await GrantStore.open(undefined, { principals });
    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:nora', displayName: 'Nora', emails: ['nora@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'agent', id: 'higgins' }, role: 'member', by: 'user:admin', granterIsAdmin: true });
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: { name: 'none', verify: async () => ({ ok: false, reason: 'no bearer' }) },
      principals,
      grants,
      version: 'test',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('slice2-run-token-secret-0123456789'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      asIssuer: ISS,
      asKeys: keys,
      keys: await ApiKeyStore.open(),
      mcpOAuthStore: await McpOAuthStore.open(),
      sessions: new SessionStore(),
    } as unknown as FactoryState;
    server = createFactoryServer(state);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  after(() => server.close());

  async function call(path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as Record<string, any>, headers: res.headers };
  }

  async function issue(resource?: string) {
    const verifier = `verifier_${randomBytes(8).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const clientId = `mcpc_${randomBytes(4).toString('hex')}`;
    const code = state.mcpOAuthStore!.storeAuthCode({
      clientId,
      principalId: 'user:stephanie',
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'mcp:full',
      ...(resource ? { resource } : {}),
      amr: ['oidc'],
    });
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    if (resource) form.set('resource', resource);
    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  }

  it('issues a 10-minute mcp JWT by default, and refuses it on the API', async () => {
    const tokens = await issue();
    assert.equal(tokens.expires_in, 600);
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(String(tokens.refresh_token).startsWith('fk_rt_'));
    const payload = decodeJwt(tokens.access_token);
    assert.equal(payload.iss, ISS);
    assert.equal(payload.sub, 'user:stephanie');
    assert.equal(typeof payload.client_id, 'string');
    assert.equal(payload.scope, 'mcp:full');
    assert.deepEqual(payload.aud, [MCP]);
    assert.deepEqual(payload.roles, ['admin']);
    assert.deepEqual(payload.agents, { higgins: ['member'] });
    assert.equal(typeof payload.grants_v, 'number');
    assert.equal(typeof payload.sid, 'string');
    assert.ok((payload.exp ?? 0) - (payload.iat ?? 0) === 600);

    const mcp = await call('/mcp', { authorization: `Bearer ${tokens.access_token}` }, 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
    const mcpWho = JSON.parse(mcp.body.result.content[0].text);
    assert.equal(mcpWho.signedInWith, 'access-jwt');
    const api = await call('/api/v1/whoami', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(api.status, 401);
    assert.equal(api.body.error, 'invalid_token_audience');
  });

  it('separates api and mcp audiences, and a token for both works on both', async () => {
    const apiOnly = await issue(API);
    assert.deepEqual(decodeJwt(apiOnly.access_token).aud, [API]);
    const who = await call('/api/v1/whoami', { authorization: `Bearer ${apiOnly.access_token}` });
    assert.equal(who.status, 200, JSON.stringify(who.body));
    assert.equal(who.body.signedInWith, 'access-jwt');
    assert.ok((who.body.roles as string[]).includes('admin'));
    const mcpDenied = await call('/mcp', { authorization: `Bearer ${apiOnly.access_token}` }, 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert.equal(mcpDenied.status, 401);
    assert.equal(mcpDenied.body.error, 'invalid_token_audience');

    const both = await issue(`${API} ${MCP}`);
    const aud = decodeJwt(both.access_token).aud;
    assert.deepEqual(aud, [API, MCP]);
    assert.equal((await call('/api/v1/whoami', { authorization: `Bearer ${both.access_token}` })).status, 200);
    assert.equal(
      (await call('/mcp', { authorization: `Bearer ${both.access_token}` }, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status,
      200,
    );
  });

  it('verifies the token against /jwks and rejects a tampered, foreign, or expired token', async () => {
    const tokens = await issue(API);
    const jwks = await call('/jwks');
    assert.equal(jwks.status, 200);
    assert.equal(jwks.headers.get('cache-control'), 'public, max-age=3600');
    const { payload } = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks.body as { keys: [] }), {
      issuer: ISS,
      audience: API,
    });
    assert.equal(payload.sub, 'user:stephanie');
    assert.equal('d' in ((jwks.body.keys as object[])[0] as object), false);

    const parts = String(tokens.access_token).split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}aa`;
    const bad = await call('/api/v1/whoami', { authorization: `Bearer ${tampered}` });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'invalid_token');

    const other = { current: await generateEphemeralAsKey('foreign'), ephemeral: false };
    const foreign = await signAccessToken(other, {
      issuer: ISS,
      subject: 'user:stephanie',
      audiences: [API],
      clientId: 'foreign',
      sid: 'key_nope',
    });
    assert.equal((await call('/api/v1/whoami', { authorization: `Bearer ${foreign.token}` })).status, 401);

    const anchor = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'mcp:expired-client',
      by: 'user:stephanie',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      secretPrefix: 'fk_at_',
      audience: API,
      oauthClientId: 'expired-client',
    });
    const expired = await signAccessToken(keys, {
      issuer: ISS,
      subject: 'user:stephanie',
      audiences: [API],
      clientId: 'expired-client',
      sid: anchor.record.id,
      now: new Date(Date.now() - 3_600_000),
    });
    const stale = await call('/api/v1/whoami', { authorization: `Bearer ${expired.token}` });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, 'invalid_token');
  });

  it('does not treat role hints as authority', async () => {
    const anchor = await state.keys!.create({
      owner: 'user:nora',
      deviceFamily: 'mcp:hint-client',
      by: 'user:nora',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      secretPrefix: 'fk_at_',
      audience: API,
      oauthClientId: 'hint-client',
    });
    const hinted = await signAccessToken(keys, {
      issuer: ISS,
      subject: 'user:nora',
      audiences: [API],
      clientId: 'hint-client',
      sid: anchor.record.id,
      hints: { roles: ['admin'] },
    });
    assert.deepEqual(decodeJwt(hinted.token).roles, ['admin']);
    const who = await call('/api/v1/whoami', { authorization: `Bearer ${hinted.token}` });
    assert.equal(who.status, 200, JSON.stringify(who.body));
    assert.equal(who.body.signedInWith, 'access-jwt');
    assert.ok(!(who.body.roles as string[]).includes('admin'));
    const registry = await call('/api/v1/registry/agents', { authorization: `Bearer ${hinted.token}` }, 'POST', {});
    assert.equal(registry.status, 403);
  });

  it('keeps accepting legacy fk_at_ and fk_ credentials', async () => {
    const legacyAt = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'mcp:legacy-at',
      by: 'user:stephanie',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      secretPrefix: 'fk_at_',
      audience: `${ISS}/mcp`,
      oauthClientId: 'legacy-at',
    });
    const mcp = await call('/mcp', { authorization: `Bearer ${legacyAt.plaintext}` }, 'POST', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
    const who = JSON.parse(mcp.body.result.content[0].text);
    assert.equal(who.signedInWith, 'oauth');
    const apiDenied = await call('/api/v1/agents', { authorization: `Bearer ${legacyAt.plaintext}` });
    assert.equal(apiDenied.status, 401);
    assert.equal(apiDenied.body.error, 'invalid_token_audience');

    const legacyKey = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'cli',
      by: 'user:stephanie',
      expiresAt: null,
    });
    const keyed = await call('/api/v1/whoami', { authorization: `Bearer ${legacyKey.plaintext}` });
    assert.equal(keyed.status, 200, JSON.stringify(keyed.body));
    assert.equal(keyed.body.signedInWith, 'api-key');
    assert.equal(keyed.body.actor, 'user:stephanie');
  });

  it('mints a new access token when the previous anchor has expired', async () => {
    const clientId = 'stale-client';
    await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: `mcp:${clientId}`,
      by: 'user:stephanie',
      expiresAt: new Date(Date.now() + 40).toISOString(),
      secretPrefix: 'fk_at_',
      audience: MCP,
      oauthClientId: clientId,
    });
    await new Promise((r) => setTimeout(r, 80));
    const verifier = `verifier_${randomBytes(8).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = state.mcpOAuthStore!.storeAuthCode({
      clientId,
      principalId: 'user:stephanie',
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'mcp:full',
    });
    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal((await call('/mcp', { authorization: `Bearer ${body.access_token}` }, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
  });

  it('stops accepting a JWT when its key anchor is revoked', async () => {
    const tokens = await issue(API);
    const sid = String(decodeJwt(tokens.access_token).sid);
    assert.equal((await call('/api/v1/whoami', { authorization: `Bearer ${tokens.access_token}` })).status, 200);
    await state.keys!.revoke(sid, { by: 'user:stephanie' });
    const after = await call('/api/v1/whoami', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'invalid_token');
  });
});
