// §6.11 K1–K4: factory consent flow, grant import, and the gatekeeper-egress token endpoint.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { ConnectionKeymaster, grantSecretName, type Grant } from '@beercanlabs/factory-keymaster';
import { createFactoryServer, type FactoryState } from './app.js';
import { signConsentState, verifyConsentState } from './connections.js';
import { SystemsStore } from './systems.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import type { AgentRecord } from './catalog.js';

const ADMIN = 'admin-conn';
const GATEKEEPER_EGRESS = 'gatekeeper-egress-conn';
const VIEWER = 'viewer-conn';
const SIGNING = 'callback-signing-key-0123456789';
const BASE = 'https://factory.example.test';
const CLIENT = { client_id: 'cid.apps.googleusercontent.com', client_secret: 'client-secret-xyz' };
const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('Keymaster connections API (§6.11)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const values = new Map<string, string>();
  const ledger = new MemoryLedger();
  const tokenCalls: URLSearchParams[] = [];
  let tokenReply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

  const provider: SecretProvider = {
    name: 'mem',
    async get(n) {
      return values.get(n);
    },
    async put(n, v) {
      values.set(n, v);
    },
  };
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    tokenCalls.push(new URLSearchParams(String(init?.body ?? '')));
    return new Response(JSON.stringify(tokenReply.body), { status: tokenReply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const req = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location'), json: () => JSON.parse(text) };
  };
  const stateKey = () => createHmac('sha256', SIGNING).update('factory:keymaster:connection-state:v1').digest();
  const rows = () => ledger.query({});
  let systemsDir = '';

  before(async () => {
    const secretValues = new Set<string>();
    systemsDir = mkdtempSync(join(tmpdir(), 'systems-conn-test-'));
    state = {
      agents: new Map<string, AgentRecord>(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gatekeeper-egress', token: GATEKEEPER_EGRESS, roles: ['gatekeeper-egress'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: 'test',
      providers: [provider],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('conn-run-token-key-0123456789abcdef'),
      callbacks: { signingKey: SIGNING, allowInsecure: true, attempts: 1, backoffMs: 0 },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues,
      publicBaseUrl: BASE,
      systems: await SystemsStore.open(systemsDir, ledger),
    };
    state.connections = new ConnectionKeymaster({
      providers: [provider],
      ledger,
      secretValues,
      fetch: fakeFetch,
      getProvider: (name) => state.systems?.getConnectionProvider(name),
    });
    state.agents.set('donna', {
      id: 'donna',
      name: 'Donna',
      role: 'Assistant',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/tmp/donna',
      connections: [{ provider: 'google', scopes: [CAL, GMAIL] }],
    });
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    if (systemsDir) rmSync(systemsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    values.clear();
    values.set('GOOGLE_OAUTH_CLIENT', JSON.stringify(CLIENT));
    tokenCalls.length = 0;
    state.connections = new ConnectionKeymaster({
      providers: [provider],
      ledger,
      secretValues: state.secretValues,
      fetch: fakeFetch,
      getProvider: (name) => state.systems?.getConnectionProvider(name),
    });
  });

  it('start redirects to Google consent with offline access, the declared scopes, and a signed state', async () => {
    assert.equal((await req('/api/v1/connections/donna/google/start')).status, 401);
    assert.equal((await req('/api/v1/connections/donna/google/start', { token: VIEWER })).status, 403);
    const res = await req('/api/v1/connections/donna/google/start', { token: ADMIN });
    assert.equal(res.status, 302, res.text);
    const u = new URL(res.location!);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(u.searchParams);
    assert.equal(p.client_id, CLIENT.client_id);
    assert.equal(p.redirect_uri, `${BASE}/api/v1/connections/google/callback`);
    assert.equal(p.response_type, 'code');
    assert.equal(p.access_type, 'offline');
    assert.equal(p.prompt, 'consent');
    assert.equal(p.include_granted_scopes, 'true');
    assert.equal(p.scope, `${CAL} ${GMAIL}`);
    assert.equal(res.location!.includes(CLIENT.client_secret), false);
    const st = verifyConsentState(stateKey(), p.state)!;
    assert.ok(st, 'state verifies with the factory key');
    assert.deepEqual({ agentId: st.agentId, provider: st.provider, scopes: st.scopes, actor: st.actor }, { agentId: 'donna', provider: 'google', scopes: [CAL, GMAIL], actor: 'token:admin' });
    assert.ok(st.exp > Date.now() && st.nonce);

    const custom = await req(`/api/v1/connections/donna/google/start?scopes=${encodeURIComponent(CAL)}`, { token: ADMIN });
    assert.equal(new URL(custom.location!).searchParams.get('scope'), CAL);
    assert.equal((await req('/api/v1/connections/nobody/google/start', { token: ADMIN })).status, 404);
  });

  it('callback rejects forged, tampered, and expired state without calling the provider', async () => {
    const good = signConsentState(stateKey(), { agentId: 'donna', provider: 'google', scopes: [CAL], actor: 'admin', nonce: 'n1', exp: Date.now() + 60_000 });
    const forged = signConsentState(createHmac('sha256', 'other').update('x').digest(), { agentId: 'donna', provider: 'google', scopes: [CAL], actor: 'admin', nonce: 'n2', exp: Date.now() + 60_000 });
    const [body, sig] = good.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), agentId: 'evil' })).toString('base64url')}.${sig}`;
    const expired = signConsentState(stateKey(), { agentId: 'donna', provider: 'google', scopes: [CAL], actor: 'admin', nonce: 'n3', exp: Date.now() - 1 });
    for (const s of [forged, tampered, expired, 'garbage']) {
      const res = await req(`/api/v1/connections/google/callback?code=abc&state=${encodeURIComponent(s)}`);
      assert.equal(res.status, 400, s);
    }
    assert.equal(tokenCalls.length, 0);
    assert.equal(values.has(grantSecretName('donna', 'google')), false);
  });

  it('callback exchanges the code, stores the grant, ledgers CONNECTION_GRANTED without tokens, and refuses replay', async () => {
    tokenReply = { status: 200, body: { access_token: 'fake-fresh-access', refresh_token: 'fake-refresh-from-consent', expires_in: 3599, scope: `${CAL} ${GMAIL}`, token_type: 'Bearer' } };
    const st = signConsentState(stateKey(), { agentId: 'donna', provider: 'google', scopes: [CAL, GMAIL], actor: 'cloudflare:owner@example.com', nonce: 'nonce-ok', exp: Date.now() + 60_000 });
    const res = await req(`/api/v1/connections/google/callback?code=auth-code-1&state=${encodeURIComponent(st)}`);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /Connected Google for Donna/);
    assert.equal(tokenCalls[0].get('grant_type'), 'authorization_code');
    assert.equal(tokenCalls[0].get('code'), 'auth-code-1');
    assert.equal(tokenCalls[0].get('redirect_uri'), `${BASE}/api/v1/connections/google/callback`);
    const grant = JSON.parse(values.get(grantSecretName('donna', 'google'))!) as Grant;
    assert.equal(grant.refreshToken, 'fake-refresh-from-consent');
    assert.equal(grant.status, 'active');
    assert.equal(grant.grantedBy, 'cloudflare:owner@example.com');
    assert.deepEqual(grant.scopes, [CAL, GMAIL]);
    const row = rows().filter((e) => e.action === 'CONNECTION_GRANTED').at(-1)!;
    assert.deepEqual({ agentId: row.agentId, provider: row.provider, scopes: row.scopes, actor: row.actor }, { agentId: 'donna', provider: 'google', scopes: [CAL, GMAIL], actor: 'cloudflare:owner@example.com' });
    const all = JSON.stringify(rows());
    assert.equal(all.includes('refresh-from-consent') || all.includes('fresh-access') || all.includes(CLIENT.client_secret), false, 'no tokens in the ledger');

    const replay = await req(`/api/v1/connections/google/callback?code=auth-code-1&state=${encodeURIComponent(st)}`);
    assert.equal(replay.status, 400);

    const list = await req('/api/v1/connections/donna', { token: VIEWER });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json().connections.map((c: any) => [c.provider, c.status]), [['google', 'active']]);
    assert.equal(list.text.includes('refresh') || list.text.includes('ya29'), false, 'listing never shows tokens');
  });

  it('imports an existing authorized-user credential (admin only) and keeps its OAuth client', async () => {
    values.delete('GOOGLE_OAUTH_CLIENT');
    values.set('GMAIL_CREDENTIALS', JSON.stringify({ ...CLIENT, refresh_token: '1//legacy-refresh', scopes: [CAL, GMAIL], token_uri: 'https://oauth2.googleapis.com/token', token: 'ya29.old' }));
    assert.equal((await req('/api/v1/connections/donna/google/import', { method: 'POST', token: VIEWER, body: { secretRef: 'GMAIL_CREDENTIALS' } })).status, 403);
    const res = await req('/api/v1/connections/donna/google/import', { method: 'POST', token: ADMIN, body: { secretRef: 'GMAIL_CREDENTIALS' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.text.includes('legacy-refresh'), false);
    assert.deepEqual(JSON.parse(values.get('GOOGLE_OAUTH_CLIENT')!), CLIENT, 'client stored as the Keymaster app credential');
    const grant = JSON.parse(values.get(grantSecretName('donna', 'google'))!) as Grant;
    assert.equal(grant.refreshToken, '1//legacy-refresh');
    assert.equal(grant.clientRef, 'GOOGLE_OAUTH_CLIENT');
    assert.deepEqual(grant.scopes, [CAL, GMAIL]);
    const row = rows().filter((e) => e.action === 'CONNECTION_IMPORTED').at(-1)!;
    assert.equal(row.agentId, 'donna');
    assert.equal(JSON.stringify(row).includes('legacy-refresh'), false);

    // A different existing client: the imported client is kept separately, bound to this grant.
    values.set('GOOGLE_OAUTH_CLIENT', JSON.stringify({ client_id: 'other-client', client_secret: 'other-secret' }));
    const again = await req('/api/v1/connections/donna/google/import', { method: 'POST', token: ADMIN, body: { secretRef: 'GMAIL_CREDENTIALS' } });
    assert.equal(again.json().clientRef, 'connections/donna/google-client');
    assert.deepEqual(JSON.parse(values.get('connections/donna/google-client')!), CLIENT);
  });

  it('token endpoint: gatekeeper-egress role only, live run of the same agent only; 428 with connect link when there is no grant', async () => {
    const live = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'test', trigger: 'test' });
    const done = state.runs.create({ agentId: 'donna', state: 'DONE', actor: 'test', trigger: 'test' });
    const body = { runId: live.runId, agentId: 'donna', connection: 'google' };
    const path = '/api/v1/gatekeeper-egress/connections/token';

    assert.equal((await req(path, { method: 'POST', token: ADMIN, body })).status, 403, 'admin is not the gatekeeper-egress');
    assert.equal((await req(path, { method: 'POST', token: VIEWER, body })).status, 403);

    const missing = await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body });
    assert.equal(missing.status, 428);
    assert.deepEqual(missing.json(), { error: 'needs_reconsent', provider: 'google', connectUrl: `${BASE}/api/v1/connections/donna/google/start` });

    values.set(grantSecretName('donna', 'google'), JSON.stringify({ provider: 'google', clientRef: 'GOOGLE_OAUTH_CLIENT', refreshToken: '1//r', scopes: [CAL], obtainedAt: 'x', grantedBy: 'admin', status: 'active' }));
    tokenReply = { status: 200, body: { access_token: 'ya29.for-egress', expires_in: 3600 } };
    const ok = await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json().accessToken, 'ya29.for-egress');
    assert.ok(Date.parse(ok.json().expiresAt) > Date.now());
    assert.ok(state.secretValues.has('ya29.for-egress'), 'issued tokens are redacted from results');

    assert.equal((await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body: { ...body, runId: done.runId } })).status, 403, 'terminal run');
    assert.equal((await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body: { ...body, agentId: 'someone-else' } })).status, 403, 'run of another agent');
    assert.equal((await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body: { ...body, runId: 'nope' } })).status, 403);
    assert.equal((await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body: { ...body, connection: 'nope' } })).status, 400);

    tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    state.connections!.invalidate('donna', 'google');
    const revoked = await req(path, { method: 'POST', token: GATEKEEPER_EGRESS, body });
    assert.equal(revoked.status, 428);
    assert.equal(revoked.json().connectUrl, `${BASE}/api/v1/connections/donna/google/start`);
    const list = await req('/api/v1/connections/donna', { token: VIEWER });
    assert.equal(list.json().connections[0].status, 'needs_reconsent');
  });
});
