// Front-door Phase 1 Slice 4 (#565, D-2): real scopes, scope consent, first-party flag, admin block.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { FACTORY_SCOPES, LEGACY_FULL_SCOPE } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApiKeyStore, ApprovalStore, FileDocBackend, GrantStore, MemoryDocBackend, PrincipalStore, type ApiKeysDoc, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { SessionStore } from './login.js';
import { McpOAuthStore, type McpOAuthDoc } from './mcp-oauth.js';
import { RevocationSet, type RevocationDoc } from './revocation-set.js';

const BASE = 'https://factory.test';

describe('front-door Phase 1 Slice 4 (#565)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let port = 0;

  const request = (path: string, opts: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...opts });
  const get = (path: string, headers: Record<string, string> = {}) => request(path, { method: 'GET', headers });
  const postForm = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(params).toString(),
    });

  function cookieFor(email: string): string {
    return `factory_session=${state.sessions!.create(email, 'google')}`;
  }

  async function register(name: string, redirect: string): Promise<string> {
    const res = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], firstParty: true, first_party: true }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  async function authorize(input: {
    cookie: string;
    clientId: string;
    redirect: string;
    scope?: string;
  }): Promise<{ status: number; location: string; html: string }> {
    const verifier = `verifier_${randomBytes(16).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const scope = input.scope ? `&scope=${encodeURIComponent(input.scope)}` : '';
    const authRes = await get(
      `/authorize?client_id=${encodeURIComponent(input.clientId)}&redirect_uri=${encodeURIComponent(input.redirect)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256${scope}`,
      { cookie: input.cookie },
    );
    const html = await authRes.text();
    return { status: authRes.status, location: authRes.headers.get('location') ?? '', html: html + `\n<!--verifier:${verifier}-->` };
  }

  function verifierOf(html: string): string {
    return html.match(/<!--verifier:([^>]+)-->/)?.[1] ?? '';
  }

  async function exchange(clientId: string, redirect: string, location: string, verifier: string) {
    const code = new URL(location).searchParams.get('code');
    assert.ok(code, 'authorization redirect carries a code');
    const tok = await postForm('/token', {
      grant_type: 'authorization_code',
      code: code!,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    const body = (await tok.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
    assert.equal(tok.status, 200, JSON.stringify(body));
    return body;
  }

  async function toolNames(token: string): Promise<string[]> {
    const res = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    return body.result?.tools?.map((tool) => tool.name) ?? [];
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slice4-'));
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), {
      principals,
      knownGroups: (g) => Boolean(groups.getGroup(g)),
    });
    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:ada', displayName: 'Ada', emails: ['ada@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:stephanie', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:ada', scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    state = {
      agents: new Map([['castle', { id: 'castle', name: 'Castle', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/castle' }]]),
      ledger: new MemoryLedger(),
      auth: { name: 'none', verify: async () => ({ ok: false, reason: 'no bearer' }) },
      principals,
      grants,
      groups,
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      publicBaseUrl: BASE,
      keys: await ApiKeyStore.open(new FileDocBackend<ApiKeysDoc>(join(dir, 'keys.json'))),
      mcpOAuthStore: await McpOAuthStore.open(new MemoryDocBackend<McpOAuthDoc>()),
      sessions: new SessionStore(),
      revocations: await RevocationSet.open(new MemoryDocBackend<RevocationDoc>()),
    } as FactoryState;
    cp = createFactoryServer(state);
    port = await new Promise<number>((resolve) => {
      const server = cp.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((resolve) => cp.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises the real scope list and not mcp:full', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      const body = (await (await get(path)).json()) as { scopes_supported: string[] };
      assert.deepEqual(body.scopes_supported, [...FACTORY_SCOPES], path);
      assert.equal(body.scopes_supported.includes(LEGACY_FULL_SCOPE), false);
    }
  });

  it('shows a third-party consent screen in plain language, names the origin, and does not offer admin scopes', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const redirect = 'https://thisismadeup.ai/callback';
    const clientId = await register('Made Up Console', redirect);
    const auth = await authorize({
      cookie,
      clientId,
      redirect,
      scope: 'admin grants:manage keys:manage mcp agents:read',
    });
    assert.equal(auth.status, 200, 'a third-party client still stops for consent');
    assert.match(auth.html, /Authorize MCP Client/);
    assert.match(auth.html, /thisismadeup\.ai/);
    assert.match(auth.html, /https:\/\/thisismadeup\.ai/);
    assert.match(auth.html, /See your agents and their status/);
    assert.match(auth.html, /Use the factory MCP tools your account already allows/);
    assert.match(auth.html, /data-scope="mcp"/);
    assert.match(auth.html, /data-scope="agents:read"/);
    assert.doesNotMatch(auth.html, /data-scope="admin"/);
    assert.doesNotMatch(auth.html, /data-scope="grants:manage"/);
    assert.doesNotMatch(auth.html, /data-scope="keys:manage"/);
    assert.match(auth.html, /third-party application/);
    const nonce = auth.html.match(/name="consent_nonce"\s+value="([^"]+)"/)?.[1] ?? '';
    const csrf = auth.html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? '';
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: csrf }, { cookie, origin: BASE });
    assert.equal(approve.status, 302);
    const tokens = await exchange(clientId, redirect, approve.headers.get('location') ?? '', verifierOf(auth.html));
    assert.equal(tokens.scope, 'mcp agents:read');
    const names = await toolNames(tokens.access_token!);
    assert.ok(names.includes('list_agents'));
    assert.equal(names.includes('grant_role'), false, 'a third-party token is below grants:manage');
    const families = (await (await get('/api/v1/account/refresh-families', { cookie })).json()) as { refreshFamilies: { holder: string; clientId: string }[] };
    assert.equal(families.refreshFamilies.find((row) => row.clientId === clientId)?.holder, 'person');
  });

  it('flags a first-party head, skips the consent screen, and does not describe it as a third-party console', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const redirect = 'https://factory.example/oauth/callback';
    const viewer = await request('/api/v1/oauth/clients', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieFor('ada@example.com'), origin: BASE },
      body: JSON.stringify({ clientId: 'factory-console', clientName: 'Factory Console', redirectUris: [redirect], firstParty: true }),
    });
    assert.equal(viewer.status, 403);
    const put = await request('/api/v1/oauth/clients', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ clientId: 'factory-console', clientName: 'Factory Console', redirectUris: [redirect], firstParty: true }),
    });
    assert.equal(put.status, 200, await put.clone().text());
    const auth = await authorize({ cookie, clientId: 'factory-console', redirect, scope: 'admin mcp api' });
    assert.equal(auth.status, 302, 'a first-party client skips the consent screen');
    assert.doesNotMatch(auth.html, /wants to act as you/);
    assert.doesNotMatch(auth.html, /third-party application/);
    const tokens = await exchange('factory-console', redirect, auth.location, verifierOf(auth.html));
    assert.equal(tokens.scope, 'mcp api admin');
    const names = await toolNames(tokens.access_token!);
    assert.ok(names.includes('grant_role'), 'admin scope on a first-party client keeps the person grants');
    const listed = (await (await get('/api/v1/oauth/consents', { cookie })).json()) as {
      consents: { clientId: string; firstParty: boolean; origin: string; scopes: { id: string; label: string }[] }[];
    };
    const row = listed.consents.find((consent) => consent.clientId === 'factory-console');
    assert.equal(row?.firstParty, true);
    assert.equal(row?.origin, 'https://factory.example');
    assert.ok(row?.scopes.some((scope) => scope.id === 'admin' && scope.label === 'Administer the factory'));
  });

  it('lets an admin block a client, which stops new grants and kills tokens already issued', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const redirect = 'http://127.0.0.1:9144/callback';
    const clientId = await register('Blocked Later', redirect);
    const auth = await authorize({ cookie, clientId, redirect, scope: 'mcp' });
    const nonce = auth.html.match(/name="consent_nonce"\s+value="([^"]+)"/)?.[1] ?? '';
    const csrf = auth.html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? '';
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: csrf }, { cookie, origin: BASE });
    const tokens = await exchange(clientId, redirect, approve.headers.get('location') ?? '', verifierOf(auth.html));
    assert.equal((await toolNames(tokens.access_token!)).includes('list_agents'), true);
    const block = await request('/api/v1/oauth/clients', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ clientId, clientName: 'Blocked Later', redirectUris: [redirect], blocked: true }),
    });
    assert.equal(block.status, 200);
    assert.equal(((await block.json()) as { client: { blocked: boolean; firstParty: boolean } }).client.blocked, true);
    const again = await authorize({ cookie, clientId, redirect, scope: 'mcp' });
    assert.equal(again.status, 302);
    assert.equal(new URL(again.location).searchParams.get('error'), 'access_denied');
    const refresh = await postForm('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token! });
    assert.equal(refresh.status, 400);
    const after = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(after.status, 401);
    const listed = (await (await get('/api/v1/oauth/consents', { cookie })).json()) as { consents: { clientId: string; blocked: boolean; scopes: { label: string }[] }[] };
    const row = listed.consents.find((consent) => consent.clientId === clientId);
    assert.equal(row?.blocked, true);
    assert.ok(row?.scopes.some((scope) => scope.label.includes('MCP tools')));
    const revoke = await request(`/api/v1/oauth/consents/${encodeURIComponent(clientId)}`, { method: 'DELETE', headers: { cookie, origin: BASE } });
    assert.equal(revoke.status, 200);
  });

  it('keeps legacy fk_ and fk_at_ keys working, and every current client is a person holder', async () => {
    const fk = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'legacy-cli',
      by: 'user:stephanie',
      expiresAt: null,
    });
    assert.ok(fk.plaintext.startsWith('fk_'));
    assert.equal(fk.plaintext.startsWith('fk_at_'), false);
    const who = await get('/api/v1/whoami', { authorization: `Bearer ${fk.plaintext}` });
    assert.equal(who.status, 200, await who.clone().text());
    const at = await state.keys!.create({
      owner: 'user:stephanie',
      deviceFamily: 'legacy-at',
      by: 'user:stephanie',
      expiresAt: null,
      secretPrefix: 'fk_at_',
      audience: `${BASE}/mcp`,
    });
    assert.ok(at.plaintext.startsWith('fk_at_'));
    const mcp = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at.plaintext}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcp.status, 200, await mcp.clone().text());
    const families = (await (await get('/api/v1/account/refresh-families', { cookie: cookieFor('stephanie@example.com') })).json()) as { refreshFamilies: { holder: string }[] };
    assert.ok(families.refreshFamilies.every((row) => row.holder === 'person'));
  });
});
