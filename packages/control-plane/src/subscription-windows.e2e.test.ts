// DESIGN_AUTHORITY.md TSK-327 (§6.9 M5(6), (7), (7a)): the egress's subscription token route and the plan-limit window store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SubscriptionKeymaster } from '@beercanlabs/factory-keymaster';
import { IdentityLinkStore, ApprovalStore } from '@beercanlabs/factory-bouncer';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createFactoryServer, type FactoryState } from './app.js';
import { notifyNeedsReconsent, setSubscriptionNotifier, type SubscriptionNotice } from './subscriptions.js';
import { SubscriptionWindows, PROBE_INTERVAL_MS, getSubscriptionWindows } from './subscription-windows.js';

const T = { admin: 'admin-win-e2e', viewer: 'viewer-win-e2e', operator: 'operator-win-e2e', egress: 'egress-win-e2e' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(c)}.sig`;
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('subscription token route and plan-limit windows (TSK-327)', { concurrency: false }, () => {
  let cp: http.Server;
  let state: FactoryState;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any; text: string }>;
  let clock = Date.parse('2026-11-08T00:00:00Z');
  let pending = 1;
  let refresh: () => Response = () => j(200, { access_token: 'xai-access-r1-aaaaaaaa', refresh_token: 'xai-refresh-r1-aaaaaaaa', expires_in: 3600 }); // secret-scan:allow (fake vendor fixture)
  const mem = new Map<string, string>();
  const provider: SecretProvider = { name: 'mem', get: async (k) => mem.get(k), put: async (k, v) => void mem.set(k, v) };
  const notices: SubscriptionNotice[] = [];

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (url === 'https://auth.x.ai/.well-known/openid-configuration') return j(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' });
    if (url === 'https://auth.x.ai/oauth2/device/code') {
      return j(200, { device_code: 'xai-device-code-0001', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.x.ai/oauth2/device', expires_in: 600, interval: 5 });
    }
    if (url === 'https://auth.x.ai/oauth2/token') {
      if (form.get('grant_type') === 'refresh_token') return refresh();
      if (pending-- > 0) return j(400, { error: 'authorization_pending' });
      return j(200, { access_token: 'xai-access-0-aaaaaaaa', refresh_token: 'xai-refresh-0-aaaaaaaa', id_token: jwt({ sub: 'sub-1', email: 'dale@example.com', name: 'Dale R' }), expires_in: 3600 });
    }
    return j(404, {});
  }) as typeof fetch;

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: T.admin, roles: ['admin'] },
        { name: 'viewer', token: T.viewer, roles: ['viewer'] },
        { name: 'operator', token: T.operator, roles: ['operator'] },
        { name: 'egress', token: T.egress, roles: ['gatekeeper-egress'] },
      ]),
      version: '0.1.0-test',
      providers: [provider],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('win-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
      identityLinks: new IdentityLinkStore(),
    } as unknown as FactoryState;
    state.subscriptions = new SubscriptionKeymaster({
      providers: [provider],
      ledger: state.ledger,
      secretValues: state.secretValues,
      fetch: fakeFetch,
      now: () => clock,
      version: state.version,
      onNeedsReconsent: (ev) => notifyNeedsReconsent(state, ev),
    });
    setSubscriptionNotifier(state, (n) => void notices.push(n));
    state.identityLinks!.link('discord', '1', 'oidc:alice@example.com', 'setup', { name: 'Alice', roles: ['admin'] });
    state.identityLinks!.link('discord', '2', 'oidc:bob@example.com', 'setup', { name: 'Bob', roles: ['admin'] });
    state.identityLinks!.link('discord', '3', 'oidc:carol@example.com', 'setup', { name: 'Carol', roles: ['viewer'] });
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    const port = (cp.address() as { port: number }).port;
    api = async (path, method = 'GET', token, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, text };
    };
  });

  after(() => cp.close());

  const WIN = '/api/v1/gatekeeper-egress/subscription-windows';
  const TOK = '/api/v1/gatekeeper-egress/subscriptions/token';
  const rows = (action: string) => state.ledger.query().filter((r) => r.action === action);
  let id = '';

  it('a connection to work with (signed in through the fake vendor)', async () => {
    const start = await api('/api/v1/subscriptions/connect', 'POST', T.admin, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(start.status, 201, start.text);
    clock += 6000;
    await api(`/api/v1/subscriptions/sign-ins/${start.body.signIn.signInId}`, 'GET', T.admin);
    clock += 6000;
    const done = await api(`/api/v1/subscriptions/sign-ins/${start.body.signIn.signInId}`, 'GET', T.admin);
    assert.equal(done.body.status, 'connected', done.text);
    id = done.body.connection.id;
  });

  describe('POST /gatekeeper-egress/subscriptions/token (M5(6))', () => {
    it('is the gatekeeper-egress\'s alone: no credential, an admin, a viewer and an operator are refused', async () => {
      assert.equal((await api(TOK, 'POST', undefined, { connection: id })).status, 401);
      for (const t of [T.admin, T.viewer, T.operator]) assert.equal((await api(TOK, 'POST', t, { connection: id })).status, 403, t);
    });

    it('hands the egress the access token and the template the Keymaster\'s record names; an unknown connection is 404', async () => {
      const ok = await api(TOK, 'POST', T.egress, { connection: id });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.accessToken, 'xai-access-0-aaaaaaaa');
      assert.equal(ok.body.templateId, 'xai-subscription');
      assert.equal(ok.body.provider, 'xai');
      assert.equal((await api(TOK, 'POST', T.egress, { id })).body.accessToken, 'xai-access-0-aaaaaaaa');
      assert.equal((await api(TOK, 'POST', T.egress, { connection: 'c-nope' })).status, 404);
      assert.equal((await api(TOK, 'POST', T.egress, {})).status, 400);
    });

    it('supports { id, invalidate: true } to force a single refresh when a vendor rejects an unexpired token with 401', async () => {
      let calls = 0;
      refresh = () => (calls++, j(200, { access_token: 'xai-access-r1-aaaaaaaa', refresh_token: 'xai-refresh-r1-aaaaaaaa', expires_in: 3600 })); // secret-scan:allow (fake vendor fixture)
      const fresh = await api(TOK, 'POST', T.egress, { id, invalidate: true });
      assert.equal(fresh.status, 200, fresh.text);
      assert.equal(fresh.body.accessToken, 'xai-access-r1-aaaaaaaa');
      assert.equal(calls, 1, 'forced refresh ran once despite unexpired token');
      const cached = await api(TOK, 'POST', T.egress, { id });
      assert.equal(cached.body.accessToken, 'xai-access-r1-aaaaaaaa');
      assert.equal(calls, 1, 'subsequent call uses the refreshed cached token');
    });

    it('a refused refresh is reported as needs re-consent (428), and is never retried', async () => {
      let calls = 0;
      refresh = () => (calls++, j(400, { error: 'invalid_grant' }));
      const r = await api(TOK, 'POST', T.egress, { id, invalidate: true });
      assert.equal(r.status, 428, r.text);
      assert.equal(r.body.error, 'needs_reconsent');
      assert.equal(r.text.includes('xai-'), false, 'no token in the answer');
      const again = await api(TOK, 'POST', T.egress, { connection: id });
      assert.equal(again.status, 428);
      assert.equal(calls, 1, 'no refresh retry');
      assert.equal(rows('POLICY_UPDATED').length, 0);
    });
  });

  describe('the window routes (M5(7a))', () => {
    it('are the gatekeeper-egress\'s alone', async () => {
      for (const [m, p] of [['GET', WIN], ['PUT', `${WIN}/${id}`]] as const) {
        assert.equal((await api(p, m, undefined, {})).status, 401);
        for (const t of [T.admin, T.viewer, T.operator]) assert.equal((await api(p, m, t, {})).status, 403, `${m} ${t}`);
      }
    });

    it('an unknown connection and a bad action are refused', async () => {
      assert.equal((await api(`${WIN}/c-nope`, 'PUT', T.egress, { action: 'open', kind: 'plan-limit', code: 'x' })).status, 404);
      assert.equal((await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'wat' })).status, 400);
      assert.equal((await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'open', kind: 'plan-limit' })).status, 400);
    });

    it('open is idempotent, ledgered once per window with no policy row, and listed', async () => {
      const resetAt = new Date(Date.now() + 3_600_000).toISOString();
      const a = await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'open', kind: 'plan-limit', code: 'usage_limit_reached', resetAt });
      assert.equal(a.status, 200, a.text);
      assert.equal(a.body.opened, true);
      const b = await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'open', kind: 'plan-limit', code: 'usage_limit_reached', resetAt });
      assert.equal(b.body.opened, false, 'a second instance reporting the same limit opens nothing new');
      assert.equal(rows('SUBSCRIPTION_LIMIT_REACHED').length, 1);
      const row = rows('SUBSCRIPTION_LIMIT_REACHED')[0];
      assert.deepEqual([row.connection, row.limitKind, row.limitCode, row.resetAt], [id, 'plan-limit', 'usage_limit_reached', resetAt]);
      const list = await api(WIN, 'GET', T.egress);
      assert.deepEqual(list.body.windows.map((w: { connection: string }) => w.connection), [id]);
      assert.equal(rows('POLICY_UPDATED').length, 0);
      assert.equal(rows('MODEL_FAILOVER').length, 0);
    });

    it('a connection in needs_reconsent refuses probe slots ({ granted: false }) without writing SUBSCRIPTION_LIMIT_PROBE or consuming the hourly slot', async () => {
      // `id` is currently `needs_reconsent` from the invalid_grant test above, and has an open window.
      const denied = await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'probe' });
      assert.equal(denied.status, 200, denied.text);
      assert.equal(denied.body.granted, false, 'no probe runs while needs_reconsent (M5(6))');
      assert.equal(rows('SUBSCRIPTION_LIMIT_PROBE').length, 0, 'no probe row written');

      // Reconnect `id` back to `active`: the hourly probe slot was NOT consumed, so it is immediately available below.
      pending = 0;
      const re = await api(`/api/v1/subscriptions/${id}/reconnect`, 'POST', T.admin, { subscriberAttested: true });
      assert.equal(re.status, 201, re.text);
      clock += 6000;
      const done = await api(`/api/v1/subscriptions/sign-ins/${re.body.signIn.signInId}`, 'GET', T.admin);
      assert.equal(done.body.status, 'connected', done.text);
    });

    it('the probe slot is granted once per hour, and close ledgers SUBSCRIPTION_LIMIT_RESET once', async () => {
      const p1 = await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'probe' });
      assert.equal(p1.body.granted, true);
      assert.equal(rows('SUBSCRIPTION_LIMIT_PROBE').length, 1);
      assert.equal((await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'probe' })).body.granted, false);
      const c = await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'close', by: 'probe' });
      assert.equal(c.body.closed, true);
      assert.equal((await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'close', by: 'probe' })).body.closed, false);
      assert.equal(rows('SUBSCRIPTION_LIMIT_RESET').length, 1);
      assert.equal(rows('SUBSCRIPTION_LIMIT_RESET')[0].closedBy, 'probe');
      assert.equal((await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'probe' })).body.granted, false, 'no window, no probe');
      assert.deepEqual((await api(WIN, 'GET', T.egress)).body.windows, []);
    });

    it('disconnecting a connection closes its window', async () => {
      await api(`${WIN}/${id}`, 'PUT', T.egress, { action: 'open', kind: 'tier-refused', code: 'subscription_required' });
      assert.equal((await api(WIN, 'GET', T.egress)).body.windows.length, 1);
      assert.equal((await api(`/api/v1/subscriptions/${id}`, 'DELETE', T.admin)).status, 200);
      assert.deepEqual((await api(WIN, 'GET', T.egress)).body.windows, []);
      assert.equal(rows('SUBSCRIPTION_LIMIT_RESET').at(-1)?.closedBy, 'disconnect');
    });
  });

  describe('SubscriptionWindows (the store)', () => {
    const ledger = () => new MemoryLedger();
    const T0 = Date.parse('2026-11-08T12:00:00Z');

    it('closes at the vendor\'s reset time, once, and ledgers it', () => {
      const l = ledger();
      let t = T0;
      const w = new SubscriptionWindows(l, () => t);
      w.open('c-1', { kind: 'plan-limit', code: 'usage_limit_reached', resetAt: new Date(T0 + 60_000).toISOString() });
      assert.equal(w.list().length, 1);
      t = T0 + 59_000;
      assert.equal(w.list().length, 1);
      t = T0 + 61_000;
      assert.deepEqual(w.list(), []);
      assert.deepEqual(w.list(), []);
      const resets = l.query().filter((r) => r.action === 'SUBSCRIPTION_LIMIT_RESET');
      assert.equal(resets.length, 1);
      assert.equal(resets[0].closedBy, 'reset');
    });

    it('is per connection: one connection\'s window does not touch another\'s', () => {
      const w = new SubscriptionWindows(ledger(), () => T0);
      w.open('c-1', { kind: 'plan-limit', code: 'a' });
      assert.equal(w.get('c-2'), undefined);
      w.open('c-2', { kind: 'tier-refused', code: 'b' });
      w.close('c-1', 'probe');
      assert.deepEqual(w.list().map((x) => x.connection), ['c-2']);
    });

    it('ignores a reset time that is past, unreadable or absurdly far: the window then waits for a probe', () => {
      const w = new SubscriptionWindows(ledger(), () => T0);
      for (const [c, resetAt] of [['a', new Date(T0 - 1000).toISOString()], ['b', 'not a date'], ['c', new Date(T0 + 400 * 86_400_000).toISOString()]] as const) {
        assert.equal(w.open(c, { kind: 'plan-limit', code: 'x', resetAt }).window.resetAt, undefined, c);
      }
    });

    it('survives a restart: rebuilt from the ledger rows, including the probe time', () => {
      const l = ledger();
      let t = T0;
      const first = new SubscriptionWindows(l, () => t);
      first.open('c-1', { kind: 'plan-limit', code: 'usage_limit_reached', resetAt: new Date(T0 + 3_600_000).toISOString() });
      first.open('c-2', { kind: 'plan-limit', code: 'usage_limit_reached' });
      first.open('c-3', { kind: 'tier-refused', code: 'usage_not_included' });
      first.close('c-3', 'probe');
      assert.equal(first.claimProbe('c-2'), true);
      t = T0 + 30 * 60_000;
      const second = new SubscriptionWindows(l, () => t);
      assert.deepEqual(second.list().map((w) => w.connection).sort(), ['c-1', 'c-2']);
      assert.equal(second.get('c-1')?.kind, 'plan-limit');
      assert.equal(second.claimProbe('c-2'), false, 'the hourly limit survives the restart');
      t = T0 + PROBE_INTERVAL_MS + 1000;
      assert.equal(second.claimProbe('c-2'), true);
      // A window that had passed its reset while the process was down is closed on first read.
      t = T0 + 2 * 3_600_000;
      assert.deepEqual(new SubscriptionWindows(l, () => t).list().map((w) => w.connection), ['c-2']);
    });

    it('is the one writer: two concurrent opens of the same window write one row', async () => {
      const l = ledger();
      const w = new SubscriptionWindows(l, () => T0);
      const [a, b] = await Promise.all([Promise.resolve().then(() => w.open('c-1', { kind: 'plan-limit', code: 'x' })), Promise.resolve().then(() => w.open('c-1', { kind: 'plan-limit', code: 'x' }))]);
      assert.deepEqual([a.opened, b.opened].sort(), [false, true]);
      assert.equal(l.query().filter((r) => r.action === 'SUBSCRIPTION_LIMIT_REACHED').length, 1);
    });

    it('getSubscriptionWindows keeps one store per factory state', () => {
      assert.equal(getSubscriptionWindows(state), getSubscriptionWindows(state));
    });
  });
});
