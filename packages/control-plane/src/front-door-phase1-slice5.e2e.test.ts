// Front-door auth Phase 1 Slice 5 (#566, D-5): one verifier for /api/v1 and /mcp.
// A factory JWT is checked (JWKS, issuer alias, audience, expiry, kid, revocation), its scopes are
// intersected with live grants, and the Bouncer decides. Revoking a grant takes effect on the next
// request. Legacy fk_ and fk_at_ credentials still authenticate.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
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
import { RevocationSet } from './revocation-set.js';
import { LegacyCredentialUse } from './legacy-credential-use.js';
import type { AuthRequestLogEntry } from './auth-method.js';
import type { AccessAuth } from '@beercanlabs/factory-auth';

const ISS = 'https://auth.example.test';
const ALIAS = 'https://factory-dashboard.example.test';
const API = canonicalAccessResource(ISS, 'api');
const MCP = canonicalAccessResource(ISS, 'mcp');
const ALIAS_API = canonicalAccessResource(ALIAS, 'api');
const REDIRECT = 'http://127.0.0.1:9/callback';

describe('front-door Phase 1 Slice 5: unified resource verifier', { concurrency: false }, () => {
  let server: http.Server;
  let port = 0;
  let state: FactoryState;
  let keys: AsKeySet;
  let noraGrantId = '';
  const logs: AuthRequestLogEntry[] = [];

  before(async () => {
    keys = { current: await generateEphemeralAsKey('slice5'), ephemeral: false };
    const principals = await PrincipalStore.open();
    const grants = await GrantStore.open(undefined, { principals });
    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:nora', displayName: 'Nora', emails: ['nora@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    const nora = await grants.grant({ subject: 'user:nora', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    noraGrantId = nora.id;
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: {
        name: 'slice5',
        verify: async (authorization: string) => {
          const token = authorization.replace(/^Bearer\s+/i, '');
          if (token === 'factory-static-token') return { ok: true, principal: { actor: 'token:probe', roles: ['admin'] } };
          if (token === 'oidc-bearer-token') return { ok: true, principal: { actor: 'oidc:ada@example.com', roles: [], emailVerified: true } };
          return { ok: false, reason: 'no bearer' };
        },
      },
      access: {
        name: 'cloudflare-access',
        verifyAssertion: async () => ({ ok: false, reason: 'unused' }),
        verify: async () => ({ ok: true, principal: { actor: 'cloudflare:owner@example.com', roles: ['viewer'] } }),
      } as AccessAuth,
      principals,
      grants,
      version: 'test',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('slice5-run-token-secret-0123456789'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      asIssuer: ISS,
      asIssuerAliases: [ALIAS],
      asKeys: keys,
      keys: await ApiKeyStore.open(),
      mcpOAuthStore: await McpOAuthStore.open(),
      sessions: new SessionStore(),
      revocations: await RevocationSet.open(),
      legacyCredentialUse: new LegacyCredentialUse(),
      authRequestLog: (entry) => logs.push(entry),
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

  async function issue(principalId: string, scope: string, resource: string) {
    const verifier = `verifier_${randomBytes(8).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const clientId = `mcpc_${randomBytes(4).toString('hex')}`;
    const code = state.mcpOAuthStore!.storeAuthCode({
      clientId,
      principalId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope,
      resource,
      amr: ['oidc'],
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
        resource,
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  }

  function mcp(token: string, name: string) {
    return call('/mcp', { authorization: `Bearer ${token}` }, 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    });
  }

  it('verifies a JWT on REST and MCP, including the Phase 3 issuer alias, and rejects a bad kid', async () => {
    const both = await issue('user:nora', 'admin', `${API} ${MCP}`);
    const claims = decodeJwt(both.access_token);
    assert.equal(claims.iss, ISS);
    assert.deepEqual(claims.roles, ['admin']);
    const rest = await call('/api/v1/agents', { authorization: `Bearer ${both.access_token}` });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.equal(rest.headers.get('x-factory-grants-stale'), null);
    const tool = await mcp(both.access_token, 'list_agents');
    assert.equal(tool.status, 200, JSON.stringify(tool.body));
    assert.notEqual(tool.body.result?.isError, true);

    const anchor = await state.keys!.create({
      owner: 'user:nora',
      deviceFamily: 'mcp:alias-client',
      by: 'user:nora',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      secretPrefix: 'fk_at_',
      audience: ALIAS_API,
      oauthClientId: 'alias-client',
    });
    const aliasToken = await signAccessToken(keys, {
      issuer: ALIAS,
      subject: 'user:nora',
      audiences: [ALIAS_API],
      clientId: 'alias-client',
      sid: anchor.record.id,
      scope: 'admin',
    });
    const alias = await call('/api/v1/agents', { authorization: `Bearer ${aliasToken.token}` });
    assert.equal(alias.status, 200, JSON.stringify(alias.body));

    const foreign = await signAccessToken({ current: await generateEphemeralAsKey('not-in-jwks'), ephemeral: false }, {
      issuer: ISS,
      subject: 'user:nora',
      audiences: [API],
      clientId: 'alias-client',
      sid: anchor.record.id,
    });
    const rejected = await call('/api/v1/agents', { authorization: `Bearer ${foreign.token}` });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error, 'invalid_token');
  });

  it('keeps accepting legacy fk_ and fk_at_ credentials on REST and MCP', async () => {
    const legacyKey = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'cli',
      by: 'user:stephanie',
      expiresAt: null,
    });
    const keyed = await call('/api/v1/whoami', { authorization: `Bearer ${legacyKey.plaintext}` });
    assert.equal(keyed.status, 200, JSON.stringify(keyed.body));
    assert.equal(keyed.body.signedInWith, 'api-key');
    const keyedMcp = await mcp(legacyKey.plaintext, 'whoami');
    assert.equal(keyedMcp.status, 200, JSON.stringify(keyedMcp.body));

    const legacyAt = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'mcp:legacy-at',
      by: 'user:stephanie',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      secretPrefix: 'fk_at_',
      audience: MCP,
      oauthClientId: 'legacy-at',
    });
    const at = await mcp(legacyAt.plaintext, 'whoami');
    assert.equal(at.status, 200, JSON.stringify(at.body));
    const atWho = JSON.parse(at.body.result.content[0].text);
    assert.equal(atWho.signedInWith, 'oauth');
    const atApi = await call('/api/v1/agents', { authorization: `Bearer ${legacyAt.plaintext}` });
    assert.equal(atApi.status, 401);
    assert.equal(atApi.body.error, 'invalid_token_audience');
  });

  it('records fk_, factory-token, oidc-bearer, and cloudflare-access for the console view', async () => {
    await call('/api/v1/whoami', { authorization: 'Bearer factory-static-token' });
    await call('/api/v1/whoami', { authorization: 'Bearer oidc-bearer-token' });
    await call('/api/v1/whoami', { 'cf-access-jwt-assertion': 'access-assertion' });
    const admin = await issue('user:stephanie', 'admin', API);
    const view = await call('/api/v1/auth/legacy-credentials', { authorization: `Bearer ${admin.access_token}` });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const count = (id: string) => view.body.kinds.find((kind: { id: string }) => kind.id === id)?.count ?? 0;
    assert.ok(count('fk_') >= 1, JSON.stringify(view.body.kinds));
    assert.ok(count('fk_at_') >= 1, JSON.stringify(view.body.kinds));
    assert.ok(count('factory-token') >= 1, JSON.stringify(view.body.kinds));
    assert.ok(count('oidc-bearer') >= 1, JSON.stringify(view.body.kinds));
    assert.ok(count('cloudflare-access') >= 1, JSON.stringify(view.body.kinds));
    assert.equal(logs.some((entry) => entry.event === 'auth.request' && entry.authMethod === 'api-key'), true);
    assert.equal(
      state.ledger.query().some((row) => row.action === 'AUTH_LEGACY_CREDENTIAL' && row.subject === 'credential:fk_'),
      true,
    );
    const anon = await call('/api/v1/auth/legacy-credentials');
    assert.equal(anon.status, 401);
  });

  it('a revoked grant takes effect immediately on REST and MCP, and the sidebar whoami is the no-access state', async () => {
    const tokens = await issue('user:nora', 'admin', `${API} ${MCP}`);
    const before = await call('/api/v1/agents', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const beforeMcp = await mcp(tokens.access_token, 'list_agents');
    assert.notEqual(beforeMcp.body.result?.isError, true, JSON.stringify(beforeMcp.body));
    const whoBefore = await call('/api/v1/whoami', { authorization: `Bearer ${tokens.access_token}` });
    assert.ok((whoBefore.body.roles as string[]).includes('admin'));

    await state.grants!.revoke(noraGrantId, { by: 'user:stephanie' });

    const after = await call('/api/v1/agents', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(after.status, 403, JSON.stringify(after.body));
    assert.equal(after.body.error, 'forbidden');
    assert.equal(after.headers.get('x-factory-grants-stale'), '1');
    const afterMcp = await mcp(tokens.access_token, 'list_agents');
    const mcpDenied = afterMcp.status === 403 || afterMcp.body.result?.isError === true;
    assert.equal(mcpDenied, true, JSON.stringify(afterMcp.body));
    const who = await call('/api/v1/whoami', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(who.status, 200, JSON.stringify(who.body));
    assert.deepEqual(who.body.roles, []);
    assert.deepEqual(who.body.grants, []);
    assert.deepEqual(who.body.privileges.fleet, []);
    assert.equal(who.headers.get('x-factory-grants-stale'), '1');
    const still = decodeJwt(tokens.access_token);
    assert.ok((still.exp ?? 0) * 1000 > Date.now(), 'the token itself has not expired');
    assert.deepEqual(still.roles, ['admin']);
  });

  it('a revoked jti is refused on the next request', async () => {
    await state.grants!.grant({ subject: 'user:nora', scope: { kind: 'fleet' }, role: 'admin', by: 'user:stephanie', granterIsAdmin: true });
    const tokens = await issue('user:nora', 'admin', API);
    assert.equal((await call('/api/v1/agents', { authorization: `Bearer ${tokens.access_token}` })).status, 200);
    const jti = String(decodeJwt(tokens.access_token).jti);
    await state.revocations!.revoke({ id: jti, kind: 'jti', expiresAt: Date.now() + 600_000, reason: 'test' });
    const dead = await call('/api/v1/agents', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error, 'invalid_token');
  });

  it('a narrowed scope cannot use a live grant the token did not ask for', async () => {
    const tokens = await issue('user:stephanie', 'agents:read', API);
    const read = await call('/api/v1/agents', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const idp = await call('/api/v1/setup/idp', { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(idp.status, 403, JSON.stringify(idp.body));
  });
});
