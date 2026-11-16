import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import {
  ApiKeyStore,
  ApprovalStore,
  docBackendFromUri,
  FileDocBackend,
  GrantStore,
  PrincipalStore,
  type ApiKeysDoc,
  type GrantsDoc,
  type PrincipalsDoc,
} from '@beercanlabs/factory-bouncer';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdpConfigStore, type IdpConfigDoc } from './idp-config.js';
import { SessionStore } from './login.js';
import { McpOAuthStore, type McpOAuthDoc } from './mcp-oauth.js';

const ISSUER = 'https://idp.test';
const BASE = 'https://factory.test';

describe('TSK-339: MCP OAuth 2.1 AS, RFC 9728 Discovery, Consent, Multi-Client D14, Tokens & Store', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;

  let nextUser: Record<string, unknown> = {};
  const challenges = new Map<string, string>();
  let lastTokenForm: URLSearchParams | undefined;

  const mockCimdDocs = new Map<string, Record<string, unknown>>();

  const oauthFetch = (async (input: string | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const u = new URL(urlStr);
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (mockCimdDocs.has(urlStr)) {
      return j(mockCimdDocs.get(urlStr)!);
    }

    if (u.pathname === '/.well-known/openid-configuration') {
      return j({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
      });
    }
    if (u.pathname === '/token') {
      lastTokenForm = new URLSearchParams(String(init?.body));
      const code = lastTokenForm.get('code')!;
      const want = challenges.get(code);
      const got = createHash('sha256').update(lastTokenForm.get('code_verifier') ?? '').digest('base64url');
      return want && want === got ? j({ access_token: `at-${code}` }) : j({ error: 'invalid_grant' }, 400);
    }
    if (u.pathname === '/userinfo') return j(nextUser);
    return j({ error: 'not_found' }, 404);
  }) as typeof fetch;

  const request = (path: string, opts: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...opts });

  const get = (path: string, headers: Record<string, string> = {}) =>
    request(path, { method: 'GET', headers });

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const postForm = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(params).toString(),
    });

  const sessionCookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsk-339-mcp-oauth-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), {
      principals,
      knownGroups: (g) => Boolean(groups.getGroup(g)),
    });

    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });

    const keys = await ApiKeyStore.open(docBackendFromUri<ApiKeysDoc>(undefined, join(dir, 'auth', 'keys')));
    const idpConfig = await IdpConfigStore.open(docBackendFromUri<IdpConfigDoc>(undefined, join(dir, 'auth', 'idp-config')));
    await idpConfig.put({
      providers: [
        { id: 'oidc', clientId: 'test-client', issuer: ISSUER, clientSecretRef: 'TEST_IDP_SECRET' },
      ],
    }, 'user:admin');

    const mcpOAuthStore = await McpOAuthStore.open(
      docBackendFromUri<McpOAuthDoc>(undefined, join(dir, 'auth', 'mcp-oauth')),
    );

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: { name: 'none', verify: async () => ({ ok: false, reason: 'no bearer' }) },
      principals,
      grants,
      groups,
      version: '0.1.0',
      providers: [envProvider({ TEST_IDP_SECRET: 'test-secret-value-12345' })], // secret-scan:allow (test fixture)
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('mcp-oauth-run-token-secret-0123456789'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      publicBaseUrl: BASE,
      oauthFetch,
      keys,
      idpConfig,
      mcpOAuthStore,
      sessions: new SessionStore(),
    };

    state.agents.set('castle', {
      id: 'castle',
      name: 'Castle Agent',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/castle',
    } as never);

    cp = createFactoryServer(state);
    port = await new Promise<number>((resolve) => {
      const s = cp.listen(0, '127.0.0.1', () => {
        resolve((s.address() as any).port);
      });
    });
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Helper to get an active user session cookie
  function createUserSession(email = 'stephanie@example.com'): string {
    const sid = state.sessions!.create(email, 'oidc');
    return `factory_session=${sid}`;
  }

  it('1. Unauthenticated POST /mcp returns 401 JSON + WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"', async () => {
    // A) No Authorization header
    const r1 = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r1.status, 401);
    const wwwAuth1 = r1.headers.get('www-authenticate');
    assert.ok(wwwAuth1);
    assert.equal(wwwAuth1, `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const body1 = (await r1.json()) as any;
    assert.equal(body1.error, 'unauthorized');

    // B) Invalid Bearer token
    const r2 = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: 'Bearer fk_unknown_key_0000',
    });
    assert.equal(r2.status, 401);
    const wwwAuth2 = r2.headers.get('www-authenticate');
    assert.ok(wwwAuth2);
    assert.equal(wwwAuth2, `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const body2 = (await r2.json()) as any;
    assert.equal(body2.error, 'invalid_key');
  });

  it('2. /.well-known/oauth-protected-resource/mcp and /.well-known/oauth-authorization-server match issuer byte-for-byte', async () => {
    const rResource = await get('/.well-known/oauth-protected-resource/mcp');
    assert.equal(rResource.status, 200);
    const resourceMeta = (await rResource.json()) as any;
    assert.equal(resourceMeta.resource, `${BASE}/mcp`);
    assert.ok(Array.isArray(resourceMeta.authorization_servers));
    assert.equal(resourceMeta.authorization_servers.length, 1);
    assert.equal(resourceMeta.authorization_servers[0], BASE);

    const rAs = await get('/.well-known/oauth-authorization-server');
    assert.equal(rAs.status, 200);
    const asMeta = (await rAs.json()) as any;
    assert.equal(asMeta.issuer, BASE);
    assert.equal(asMeta.issuer, resourceMeta.authorization_servers[0], 'Issuer and resource authorization_server must match byte-for-byte');
    assert.equal(asMeta.authorization_endpoint, `${BASE}/authorize`);
    assert.equal(asMeta.token_endpoint, `${BASE}/token`);
    assert.equal(asMeta.registration_endpoint, `${BASE}/api/v1/auth/register`);
    assert.equal(asMeta.revocation_endpoint, `${BASE}/revoke`);
    assert.equal(asMeta.client_id_metadata_document_supported, true);
    assert.equal(asMeta.authorization_response_iss_parameter_supported, true);
  });

  it('3. DCR (POST /api/v1/auth/register) + CIMD (https:// client_id metadata fetch) both work, and invalid/http non-loopback redirect URIs are rejected', async () => {
    // A) DCR valid registration
    const dcrRes = await postJson('/api/v1/auth/register', {
      client_name: 'Cursor Editor',
      redirect_uris: ['http://127.0.0.1:4567/callback', 'cursor://bcl/oauth/callback'],
    });
    assert.equal(dcrRes.status, 201);
    const dcrData = (await dcrRes.json()) as any;
    assert.ok(dcrData.client_id.startsWith('mcpc_'));
    assert.equal(dcrData.client_name, 'Cursor Editor');
    assert.deepEqual(dcrData.redirect_uris, ['http://127.0.0.1:4567/callback', 'cursor://bcl/oauth/callback']);
    assert.equal(dcrData.token_endpoint_auth_method, 'none');

    // B) DCR invalid redirect URIs (non-loopback http rejected)
    const badHttp = await postJson('/api/v1/auth/register', {
      client_name: 'Evil App',
      redirect_uris: ['http://evil.com/callback'],
    });
    assert.equal(badHttp.status, 400);

    const emptyUris = await postJson('/api/v1/auth/register', {
      client_name: 'No URIs App',
      redirect_uris: [],
    });
    assert.equal(emptyUris.status, 400);

    // C) CIMD metadata fetch
    const cimdUrl = 'https://cimd-client.example.com/oauth/client-metadata.json';
    mockCimdDocs.set(cimdUrl, {
      client_id: cimdUrl,
      client_name: 'Verified CIMD App',
      redirect_uris: ['https://cimd-client.example.com/oauth/callback'],
    });

    const cookie = createUserSession();
    const cimdAuthRes = await get(
      `/authorize?client_id=${encodeURIComponent(cimdUrl)}&redirect_uri=${encodeURIComponent('https://cimd-client.example.com/oauth/callback')}&response_type=code&code_challenge=challenge_1234&code_challenge_method=S256`,
      { cookie },
    );
    assert.equal(cimdAuthRes.status, 200);
    const html = await cimdAuthRes.text();
    assert.ok(html.includes('Verified CIMD App'), 'CIMD metadata was fetched and displayed');
  });

  it('4. Silent-consent attack test: a user ALREADY holding a live factory_session cookie hits GET /authorize for a newly registered DCR client -> gets 200 HTML consent screen (NEVER an auto-302 code redirect!), and POST /authorize from a cross-origin Origin header is rejected 403', async () => {
    // Register a new DCR client
    const dcr = (await (await postJson('/api/v1/auth/register', {
      client_name: 'New Attack Client',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
    })).json()) as any;
    const clientId = dcr.client_id;
    const redirectUri = 'http://127.0.0.1:9999/callback';

    // User already has an active factory_session
    const cookie = createUserSession('stephanie@example.com');

    // GET /authorize must render 200 HTML consent screen, NEVER an automatic 302!
    const authRes = await get(
      `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=challenge_456&code_challenge_method=S256`,
      { cookie },
    );
    assert.equal(authRes.status, 200, 'Must return 200 consent screen, never auto-approve');
    assert.equal(authRes.headers.get('x-frame-options'), 'DENY');
    const html = await authRes.text();
    assert.ok(html.includes('Authorize MCP Client'));
    assert.ok(html.includes('New Attack Client'));

    // Extract consent_nonce from HTML
    const nonceMatch = html.match(/name="consent_nonce"\s+value="([^"]+)"/);
    assert.ok(nonceMatch, 'Consent form must contain consent_nonce');
    const consentNonce = nonceMatch[1];

    // POST /authorize from a cross-origin Origin (e.g. evil.com) must be refused 403
    const evilPost = await postForm('/authorize', {
      consent_nonce: consentNonce,
      decision: 'approve',
      csrf_token: 'dummy',
    }, {
      cookie,
      origin: 'https://evil.com',
    });
    assert.equal(evilPost.status, 403, 'Cross-origin POST /authorize must be refused 403');
  });

  it('5. Full PKCE S256 flow (/login -> /authorize consent -> 302 with code, state, and RFC 9207 iss -> POST /token -> fk_at_ + fk_rt_)', async () => {
    // Register client
    const reg = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Full Flow Client',
      redirect_uris: ['http://127.0.0.1:8888/callback'],
    })).json()) as any;
    const clientId = reg.client_id;
    const redirectUri = 'http://127.0.0.1:8888/callback';

    // Setup PKCE verifier and challenge
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    // 1) Initial call without cookie -> 302 redirect to /login?oauth_req=<nonce>
    const unauthRes = await get(
      `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=${codeChallenge}&code_challenge_method=S256&state=state_xyz123`,
    );
    assert.equal(unauthRes.status, 302);
    const loginLocation = unauthRes.headers.get('location')!;
    assert.ok(loginLocation.startsWith('/login?oauth_req='));
    const oauthReqNonce = new URL(loginLocation, 'http://x').searchParams.get('oauth_req')!;

    // 2) User logs in -> simulate OIDC sign-in with oauth_req
    const cookie = createUserSession('stephanie@example.com');

    // 3) Following back to /authorize?oauth_req=<nonce> with session cookie gives 200 consent screen
    const consentRes = await get(`/authorize?oauth_req=${encodeURIComponent(oauthReqNonce)}`, { cookie });
    assert.equal(consentRes.status, 200);
    const consentHtml = await consentRes.text();
    const consentNonce = consentHtml.match(/name="consent_nonce"\s+value="([^"]+)"/)![1];

    // 4) User submits approval on consent screen
    const approveRes = await postForm('/authorize', {
      consent_nonce: consentNonce,
      decision: 'approve',
      csrf_token: 'dummy',
    }, {
      cookie,
      origin: BASE,
    });
    assert.equal(approveRes.status, 302);
    const cbLoc = new URL(approveRes.headers.get('location')!);
    assert.equal(cbLoc.origin + cbLoc.pathname, redirectUri);
    assert.equal(cbLoc.searchParams.get('state'), 'state_xyz123');
    assert.equal(cbLoc.searchParams.get('iss'), BASE, 'Must return RFC 9207 iss parameter');
    const authCode = cbLoc.searchParams.get('code')!;
    assert.ok(authCode.startsWith('mcpa_'));

    // 5) Exchange code for tokens on POST /token
    const tokenRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as any;
    assert.ok(tokens.access_token.startsWith('fk_at_'), 'access_token must have fk_at_ prefix');
    assert.ok(tokens.refresh_token.startsWith('fk_rt_'), 'refresh_token must have fk_rt_ prefix');
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
  });

  it('6. Multi-client D14 test: connecting both Cursor (clientA) and Claude Desktop (clientB) for the same user issues two independent mcp:<client> keys that BOTH work simultaneously without clobbering each other', async () => {
    const cookie = createUserSession('stephanie@example.com');

    // Client A: Cursor
    const regA = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Cursor App',
      redirect_uris: ['http://127.0.0.1:4001/callback'],
    })).json()) as any;
    const verifierA = 'verifier_client_a_12345678901234567890';
    const challengeA = createHash('sha256').update(verifierA).digest('base64url');

    const authResA = await get(
      `/authorize?client_id=${regA.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:4001/callback')}&response_type=code&code_challenge=${challengeA}&code_challenge_method=S256`,
      { cookie },
    );
    const nonceA = (await authResA.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approveA = await postForm('/authorize', { consent_nonce: nonceA, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const codeA = new URL(approveA.headers.get('location')!).searchParams.get('code')!;
    const tokResA = await postForm('/token', {
      grant_type: 'authorization_code',
      code: codeA,
      client_id: regA.client_id,
      redirect_uri: 'http://127.0.0.1:4001/callback',
      code_verifier: verifierA,
    });
    assert.equal(tokResA.status, 200);
    const tokA = (await tokResA.json()) as any;

    // Client B: Claude Desktop
    const regB = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Claude Desktop',
      redirect_uris: ['http://127.0.0.1:4002/callback'],
    })).json()) as any;
    const verifierB = 'verifier_client_b_12345678901234567890';
    const challengeB = createHash('sha256').update(verifierB).digest('base64url');

    const authResB = await get(
      `/authorize?client_id=${regB.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:4002/callback')}&response_type=code&code_challenge=${challengeB}&code_challenge_method=S256`,
      { cookie },
    );
    const nonceB = (await authResB.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approveB = await postForm('/authorize', { consent_nonce: nonceB, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const codeB = new URL(approveB.headers.get('location')!).searchParams.get('code')!;
    const tokResB = await postForm('/token', {
      grant_type: 'authorization_code',
      code: codeB,
      client_id: regB.client_id,
      redirect_uri: 'http://127.0.0.1:4002/callback',
      code_verifier: verifierB,
    });
    assert.equal(tokResB.status, 200);
    const tokB = (await tokResB.json()) as any;

    // Verify both keys exist in KeyStore simultaneously with distinct deviceFamily
    const userKeys = state.keys!.list({ owner: 'user:stephanie' });
    const keyRecordA = userKeys.find((k) => k.deviceFamily === `mcp:${regA.client_id}`);
    const keyRecordB = userKeys.find((k) => k.deviceFamily === `mcp:${regB.client_id}`);
    assert.ok(keyRecordA, 'Key for Client A exists');
    assert.ok(keyRecordB, 'Key for Client B exists');
    assert.notEqual(keyRecordA.id, keyRecordB.id, 'Keys must be independent');

    // Both tokens work simultaneously on POST /mcp
    const callA = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${tokA.access_token}`,
    });
    assert.equal(callA.status, 200, 'Client A access token works');

    const callB = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${tokB.access_token}`,
    });
    assert.equal(callB.status, 200, 'Client B access token works');
  });

  it('7. Audience-binding test (RFC 8707): fk_at_ works on POST /mcp (including in-process tool execution!), and is refused with 401 if used directly against GET /api/v1/agents', async () => {
    const cookie = createUserSession('stephanie@example.com');
    const reg = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Audience Bound App',
      redirect_uris: ['http://127.0.0.1:5001/callback'],
    })).json()) as any;

    const verifier = 'verifier_audience_test_123456789012345';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authRes = await get(
      `/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5001/callback')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { cookie },
    );
    const nonce = (await authRes.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;

    const tokRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1:5001/callback',
      code_verifier: verifier,
    });
    assert.equal(tokRes.status, 200);
    const tokens = (await tokRes.json()) as any;
    const fkAt = tokens.access_token;

    // A) Direct call to /api/v1/agents with fk_at_ MUST be refused 401 invalid_token_audience!
    const directApiRes = await get('/api/v1/agents', {
      authorization: `Bearer ${fkAt}`,
    });
    assert.equal(directApiRes.status, 401, 'Direct API call with fk_at_ must be refused 401');
    const directApiBody = (await directApiRes.json()) as any;
    assert.equal(directApiBody.error, 'invalid_token_audience');

    // B) Calling tools/call on POST /mcp (which runs executeInProcessRoute to GET /api/v1/agents in-process) MUST succeed!
    const mcpCallRes = await postJson('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_agents', arguments: {} },
    }, {
      authorization: `Bearer ${fkAt}`,
    });
    assert.equal(mcpCallRes.status, 200);
    const mcpBody = (await mcpCallRes.json()) as any;
    assert.equal(mcpBody.error, undefined);
    assert.equal(mcpBody.result?.isError, undefined);
    assert.ok(mcpBody.result?.content?.[0]?.text?.includes('castle'), 'In-process tool dispatch returned agents list');
  });

  it('8. Refresh rotation & reuse-detection test + restart durability test', async () => {
    const cookie = createUserSession('stephanie@example.com');
    const reg = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Rotating App',
      redirect_uris: ['http://127.0.0.1:6001/callback'],
    })).json()) as any;

    const verifier = 'verifier_refresh_test_12345678901234567';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authRes = await get(
      `/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:6001/callback')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { cookie },
    );
    const nonce = (await authRes.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;

    const tokRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1:6001/callback',
      code_verifier: verifier,
    });
    const gen1 = (await tokRes.json()) as any;
    const fkRt1 = gen1.refresh_token;
    const fkAt1 = gen1.access_token;

    // 1) Rotate fk_rt_1 -> yields fk_rt_2 and fk_at_2
    const rotRes1 = await postForm('/token', {
      grant_type: 'refresh_token',
      refresh_token: fkRt1,
    });
    assert.equal(rotRes1.status, 200);
    const gen2 = (await rotRes1.json()) as any;
    const fkRt2 = gen2.refresh_token;
    const fkAt2 = gen2.access_token;
    assert.notEqual(fkRt1, fkRt2);
    assert.notEqual(fkAt1, fkAt2);

    // fk_at_2 works on /mcp
    const ok2 = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${fkAt2}`,
    });
    assert.equal(ok2.status, 200);

    // 2) Replay fk_rt_1 (Reuse detection!)
    const replayRes = await postForm('/token', {
      grant_type: 'refresh_token',
      refresh_token: fkRt1,
    });
    assert.equal(replayRes.status, 400);
    const replayBody = (await replayRes.json()) as any;
    assert.equal(replayBody.error, 'invalid_grant');
    assert.equal(replayBody.error_description, 'Refresh token reuse detected');

    // Entire family revoked! fk_at_2 is now invalid!
    const callAfterReplay = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${fkAt2}`,
    });
    assert.equal(callAfterReplay.status, 401, 'Access token must be invalidated immediately on reuse detection');

    // Verify ledger logged OAUTH_REFRESH_REUSE_DETECTED
    const ledgerRows = state.ledger.query().filter((e) => e.action === 'OAUTH_REFRESH_REUSE_DETECTED');
    assert.ok(ledgerRows.length >= 1, 'Reuse detection must be ledgered');

    // 3) Restart durability test: create client + tokens, reload store from disk, verify state persists across restarts
    const regDur = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Durable App',
      redirect_uris: ['http://127.0.0.1:7001/callback'],
    })).json()) as any;
    const verifierDur = 'verifier_durability_test_1234567890123';
    const challengeDur = createHash('sha256').update(verifierDur).digest('base64url');
    const authDur = await get(
      `/authorize?client_id=${regDur.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:7001/callback')}&response_type=code&code_challenge=${challengeDur}&code_challenge_method=S256`,
      { cookie },
    );
    const nonceDur = (await authDur.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approveDur = await postForm('/authorize', { consent_nonce: nonceDur, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const codeDur = new URL(approveDur.headers.get('location')!).searchParams.get('code')!;

    const tokDur = (await (await postForm('/token', {
      grant_type: 'authorization_code',
      code: codeDur,
      client_id: regDur.client_id,
      redirect_uri: 'http://127.0.0.1:7001/callback',
      code_verifier: verifierDur,
    })).json()) as any;
    const fkRtDur = tokDur.refresh_token;

    // Simulate process restart: re-open stores from disk
    const reloadedStore = await McpOAuthStore.open(
      docBackendFromUri<McpOAuthDoc>(undefined, join(dir, 'auth', 'mcp-oauth')),
    );
    state.mcpOAuthStore = reloadedStore;
    const reloadedClient = reloadedStore.getClient(regDur.client_id);
    assert.ok(reloadedClient, 'Client was preserved across restart');
    assert.equal(reloadedClient.clientName, 'Durable App');
    assert.equal(reloadedStore.hasConsent('user:stephanie', regDur.client_id), true, 'Consent preserved across restart');

    // The refresh token still works and rotates
    const rotDurRes = await postForm('/token', {
      grant_type: 'refresh_token',
      refresh_token: fkRtDur,
    });
    assert.equal(rotDurRes.status, 200, 'Refresh token works after store reload');
    const nextTok = (await rotDurRes.json()) as any;
    assert.ok(nextTok.access_token.startsWith('fk_at_'));
  });

  it('9. Revoking via DELETE /api/v1/oauth/consents/:clientId immediately invalidates fk_at_ on the very next POST /mcp call', async () => {
    const cookie = createUserSession('stephanie@example.com');
    const reg = (await (await postJson('/api/v1/auth/register', {
      client_name: 'Revocable App',
      redirect_uris: ['http://127.0.0.1:8001/callback'],
    })).json()) as any;

    const verifier = 'verifier_revocation_test_1234567890123';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authRes = await get(
      `/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8001/callback')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { cookie },
    );
    const nonce = (await authRes.text()).match(/name="consent_nonce"\s+value="([^"]+)"/)![1];
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: 'dummy' }, { cookie, origin: BASE });
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;

    const tokRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1:8001/callback',
      code_verifier: verifier,
    });
    const tokens = (await tokRes.json()) as any;
    const fkAt = tokens.access_token;

    // 1) Access token works
    const okRes = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${fkAt}`,
    });
    assert.equal(okRes.status, 200);

    // 2) List consents via GET /api/v1/oauth/consents
    const listRes = await get('/api/v1/oauth/consents', { cookie });
    assert.equal(listRes.status, 200);
    const consents = ((await listRes.json()) as any).consents;
    assert.ok(consents.some((c: any) => c.clientId === reg.client_id));

    // 3) Revoke consent via DELETE /api/v1/oauth/consents/:clientId
    const deleteRes = await request(`/api/v1/oauth/consents/${encodeURIComponent(reg.client_id)}`, {
      method: 'DELETE',
      headers: { cookie, origin: BASE },
    });
    assert.equal(deleteRes.status, 200);
    const deleteBody = (await deleteRes.json()) as any;
    assert.equal(deleteBody.ok, true);

    // 4) Immediate invalidation: the very next call to POST /mcp with fk_at_ must be refused 401!
    const afterRevokeRes = await postJson('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${fkAt}`,
    });
    assert.equal(afterRevokeRes.status, 401, 'Access token must be immediately refused after consent revocation');

    // 5) Ledger records MCP_OAUTH_REVOKED
    const revokeLedger = state.ledger.query().filter((e) => e.action === `MCP_OAUTH_REVOKED:${reg.client_id}`);
    assert.ok(revokeLedger.length >= 1, 'Revocation must be ledgered');
  });
});
