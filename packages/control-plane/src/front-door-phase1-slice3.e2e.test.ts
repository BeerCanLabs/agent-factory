// Front-door Phase 1 Slice 3 (#564): session revoke, sign-out, refresh rotation, and family revocation on reuse.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { hashApiKey } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApiKeyStore, ApprovalStore, FileDocBackend, GrantStore, MemoryDocBackend, PrincipalStore, type ApiKeysDoc, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { SessionStore } from './login.js';
import { McpOAuthStore, refreshLifetimeMs, type McpOAuthDoc, type McpOAuthRefreshTokenRecord } from './mcp-oauth.js';
import { RevocationSet, type RevocationDoc } from './revocation-set.js';
import { authLifetimes } from './account-sessions.js';

const BASE = 'https://factory.test';

describe('front-door Phase 1 Slice 3 (#564)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let port = 0;
  let oauthBackend: MemoryDocBackend<McpOAuthDoc>;

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

  async function authorize(cookie: string, redirect = 'http://127.0.0.1:6010/callback'): Promise<{ refresh: string; access: string; clientId: string }> {
    const reg = (await (await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Slice 3 App', redirect_uris: [redirect] }),
    })).json()) as { client_id: string };
    const verifier = `verifier_${randomBytes(16).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authRes = await get(
      `/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${BASE}/api`)}&resource=${encodeURIComponent(`${BASE}/mcp`)}`,
      { cookie },
    );
    const html = await authRes.text();
    const nonce = html.match(/name="consent_nonce"\s+value="([^"]+)"/)?.[1] ?? '';
    const csrf = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? '';
    assert.ok(nonce && csrf, 'consent form rendered');
    const approve = await postForm('/authorize', { consent_nonce: nonce, decision: 'approve', csrf_token: csrf }, { cookie, origin: BASE });
    assert.equal(approve.status, 302, 'consent redirects with a code');
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
    const tok = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    assert.equal(tok.status, 200, await tok.clone().text());
    const body = (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number };
    assert.equal(body.expires_in, 600);
    assert.equal(JSON.parse(Buffer.from(body.access_token.split('.')[0]!, 'base64url').toString()).typ, 'at+jwt');
    return { refresh: body.refresh_token, access: body.access_token, clientId: reg.client_id };
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slice3-'));
    const ledger = new MemoryLedger();
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
    oauthBackend = new MemoryDocBackend<McpOAuthDoc>();
    state = {
      agents: new Map(),
      ledger,
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
      mcpOAuthStore: await McpOAuthStore.open(oauthBackend),
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

  it('lists D-4 lifetimes, revokes a session, and an admin can revoke another person', async () => {
    assert.deepEqual(authLifetimes(), {
      sessionIdleHours: 12,
      sessionAbsoluteDays: 7,
      refreshPeopleDays: 30,
      refreshDeviceDays: 90,
    });
    const cookie = cookieFor('stephanie@example.com');
    const ada = cookieFor('ada@example.com');
    const mine = await get('/api/v1/account/sessions', { cookie });
    assert.equal(mine.status, 200);
    const listed = (await mine.json()) as { lifetimes: { sessionIdleHours: number }; sessions: Array<{ sid: string; current: boolean }> };
    assert.equal(listed.lifetimes.sessionIdleHours, 12);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]!.current, true);
    const gone = await request(`/api/v1/account/sessions/${listed.sessions[0]!.sid}`, { method: 'DELETE', headers: { cookie, origin: BASE } });
    assert.equal(gone.status, 200);
    assert.equal((await get('/api/v1/whoami', { cookie })).status, 401, 'the revoked session cookie is dead');

    const adaList = await get('/api/v1/account/sessions?owner=user:ada', { cookie: cookieFor('stephanie@example.com') });
    assert.equal(adaList.status, 200);
    const adaBody = (await adaList.json()) as { sessions: Array<{ sid: string }> };
    assert.equal(adaBody.sessions.length, 1);
    const adminRevoke = await request(`/api/v1/account/sessions/${adaBody.sessions[0]!.sid}?owner=user:ada`, {
      method: 'DELETE',
      headers: { cookie: cookieFor('stephanie@example.com'), origin: BASE },
    });
    assert.equal(adminRevoke.status, 200);
    assert.equal((await get('/api/v1/whoami', { cookie: ada })).status, 401, 'admin revoke ends the other person');
    const stranger = cookieFor('ada@example.com');
    const hidden = await get('/api/v1/account/sessions?owner=user:stephanie', { cookie: stranger });
    const hiddenBody = (await hidden.json()) as { sessions: Array<{ sid: string }> };
    assert.ok(hiddenBody.sessions.every((s) => s.sid !== listed.sessions[0]!.sid));
  });

  it('sign-out revokes the refresh family, and reuse of a rotated refresh revokes the family', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const first = await authorize(cookie);
    const days = (Date.parse(state.mcpOAuthStore!.getRefreshTokenByHash(hashApiKey(first.refresh))!.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days < 31, `people refresh slides 30 days, was ${days}`);
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${first.access}` })).status, 200);
    const families = await get('/api/v1/account/refresh-families', { cookie });
    const familyBody = (await families.json()) as { refreshFamilies: Array<{ familyId: string; holder: string; clientId: string }> };
    assert.ok(familyBody.refreshFamilies.some((f) => f.clientId === first.clientId && f.holder === 'person'));

    const rotated = await postForm('/token', { grant_type: 'refresh_token', refresh_token: first.refresh });
    assert.equal(rotated.status, 200);
    const second = (await rotated.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(second.refresh_token, first.refresh);
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${second.access_token}` })).status, 200);

    const reuse = await postForm('/token', { grant_type: 'refresh_token', refresh_token: first.refresh });
    assert.equal(reuse.status, 400);
    assert.equal(((await reuse.json()) as { error: string }).error, 'invalid_grant');
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${second.access_token}` })).status, 401, 'reuse revokes the whole family');
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: second.refresh_token })).status, 400);

    const again = await authorize(cookie, 'http://127.0.0.1:6011/callback');
    const out = await request('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: BASE } });
    assert.equal(out.status, 200);
    assert.equal((await get('/api/v1/whoami', { cookie })).status, 401);
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: again.refresh })).status, 400, 'sign-out revokes that session\'s refresh family');
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${again.access}` })).status, 401, 'the access token dies with the family');
  });

  it('a refresh rotated on one task is reuse-detected on another, and a device family slides 90 days', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const issued = await authorize(cookie, 'http://127.0.0.1:6012/callback');
    const other = await McpOAuthStore.open(oauthBackend);
    state.mcpOAuthStore = other;
    const rotated = await postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh });
    assert.equal(rotated.status, 200, 'the other task reloads the family before rotating');
    const next = (await rotated.json()) as { refresh_token: string };
    const original = await McpOAuthStore.open(oauthBackend);
    state.mcpOAuthStore = original;
    const replay = await postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh });
    assert.equal(replay.status, 400, 'reuse on the task that did not rotate');
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: next.refresh_token })).status, 400);

    const plain = `fk_rt_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    const planted: McpOAuthRefreshTokenRecord = {
      tokenHash: hashApiKey(plain),
      familyId: `fam_${randomBytes(8).toString('hex')}`,
      generation: 1,
      principalId: 'user:stephanie',
      clientId: 'device-client',
      clientName: 'Higgins',
      deviceFamily: 'mcp:device-client',
      keyId: 'key_device',
      holder: 'device',
      expiresAt: new Date(now + 60_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    await state.mcpOAuthStore!.saveRefreshToken(planted);
    const slid = await postForm('/token', { grant_type: 'refresh_token', refresh_token: plain });
    assert.equal(slid.status, 200, await slid.clone().text());
    const body = (await slid.json()) as { refresh_token: string };
    const saved = state.mcpOAuthStore!.getRefreshTokenByHash(hashApiKey(body.refresh_token))!;
    const life = Date.parse(saved.expiresAt) - Date.now();
    assert.ok(life > refreshLifetimeMs('device') - 60_000 && life <= refreshLifetimeMs('device'), 'device refresh slides 90 days');
    assert.equal(saved.holder, 'device');
  });

  it('keeps legacy fk_ keys working and revokes a refresh family from the account route', async () => {
    const minted = await state.keys!.create({ owner: 'user:stephanie', deviceFamily: 'laptop', by: 'user:stephanie' });
    assert.match(minted.plaintext, /^fk_/);
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${minted.plaintext}` })).status, 200, 'legacy fk_ still authenticates');

    const cookie = cookieFor('stephanie@example.com');
    const issued = await authorize(cookie, 'http://127.0.0.1:6013/callback');
    const list = (await (await get('/api/v1/account/refresh-families', { cookie })).json()) as { refreshFamilies: Array<{ familyId: string; clientId: string }> };
    const family = list.refreshFamilies.find((f) => f.clientId === issued.clientId)!;
    const del = await request(`/api/v1/account/refresh-families/${family.familyId}`, { method: 'DELETE', headers: { cookie, origin: BASE } });
    assert.equal(del.status, 200);
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh })).status, 400);
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${issued.access}` })).status, 401);
    assert.equal((await get('/api/v1/whoami', { authorization: `Bearer ${minted.plaintext}` })).status, 200, 'revoking a family leaves the fk_ key');
  });

  it('sign-out revokes a family issued when consent was already on file', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const redirect = 'http://127.0.0.1:6014/callback';
    const first = await authorize(cookie, redirect);
    const verifier = `verifier_${randomBytes(16).toString('hex')}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const again = await get(
      `/authorize?client_id=${first.clientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${BASE}/api`)}`,
      { cookie },
    );
    assert.equal(again.status, 302, 'an existing consent skips the screen');
    const code = new URL(again.headers.get('location')!).searchParams.get('code')!;
    const tok = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      client_id: first.clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: `${BASE}/api`,
    });
    assert.equal(tok.status, 200, await tok.clone().text());
    const second = (await tok.json()) as { refresh_token: string };
    const out = await request('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: BASE } });
    assert.equal(out.status, 200);
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: second.refresh_token })).status, 400, 'silent consent is still bound to the browser session');
  });

  it('two overlapping presentations of one refresh token revoke the family', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const issued = await authorize(cookie, 'http://127.0.0.1:6015/callback');
    const [a, b] = await Promise.all([
      postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh }),
      postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh }),
    ]);
    const bodies = await Promise.all([a.json(), b.json()]) as Array<{ refresh_token?: string; error?: string }>;
    for (const body of bodies) {
      if (!body.refresh_token) continue;
      assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: body.refresh_token })).status, 400, 'a successor of a raced refresh does not stay live');
    }
    assert.equal((await postForm('/token', { grant_type: 'refresh_token', refresh_token: issued.refresh })).status, 400);
  });

  it('lists a refresh family that another task wrote', async () => {
    const cookie = cookieFor('stephanie@example.com');
    const other = await McpOAuthStore.open(oauthBackend);
    const plain = `fk_rt_${randomBytes(24).toString('base64url')}`;
    const familyId = `fam_${randomBytes(8).toString('hex')}`;
    await other.saveRefreshToken({
      tokenHash: hashApiKey(plain),
      familyId,
      generation: 1,
      principalId: 'user:stephanie',
      clientId: 'other-task',
      clientName: 'Other task',
      deviceFamily: 'mcp:other-task',
      keyId: 'key_other',
      holder: 'person',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const list = (await (await get('/api/v1/account/refresh-families', { cookie })).json()) as { refreshFamilies: Array<{ familyId: string }> };
    assert.ok(list.refreshFamilies.some((f) => f.familyId === familyId), 'the account list reloads the other task\'s family');
    const del = await request(`/api/v1/account/refresh-families/${familyId}`, { method: 'DELETE', headers: { cookie, origin: BASE } });
    assert.equal(del.status, 200);
  });
});
