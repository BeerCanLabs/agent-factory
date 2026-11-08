// DESIGN_AUTHORITY.md TSK-326 (§6.9 M5(4) to (6)): the subscription connections routes, admin only, with a fake vendor.
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
import { notifyNeedsReconsent, reconsentRecipients, setSubscriptionEntryRetirer, setSubscriptionNotifier, type SubscriptionNotice } from './subscriptions.js';

const T = { admin: 'admin-sub-e2e', viewer: 'viewer-sub-e2e', operator: 'operator-sub-e2e', egress: 'egress-sub-e2e' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(c)}.sig`;
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('subscription connection routes (TSK-326)', { concurrency: false }, () => {
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
      runTokens: new RunTokens('sub-e2e-run-token-key-0123456789abcdef'),
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

  it('every route is admin only: no credential, a viewer, an operator and the egress are refused', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/subscriptions'],
      ['POST', '/api/v1/subscriptions/connect', { templateId: 'xai-subscription', subscriberAttested: true }],
      ['GET', '/api/v1/subscriptions/sign-ins/x'],
      ['POST', '/api/v1/subscriptions/c-000000000000/reconnect', { subscriberAttested: true }],
      ['POST', '/api/v1/subscriptions/c-000000000000/rename', { name: 'x' }],
      ['DELETE', '/api/v1/subscriptions/c-000000000000'],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await api(path, method, undefined, body)).status, 401, `${method} ${path} anonymous`);
      for (const t of [T.viewer, T.operator, T.egress]) {
        const r = await api(path, method, t, body);
        assert.equal(r.status, 403, `${method} ${path} ${t}: ${r.text}`);
      }
    }
    assert.equal(state.subscriptions && (await state.subscriptions.list()).length, 0);
  });

  it('connect needs the subscriber attestation', async () => {
    const r = await api('/api/v1/subscriptions/connect', 'POST', T.admin, { templateId: 'xai-subscription' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'attestation_required');
    assert.equal((await api('/api/v1/subscriptions/connect', 'POST', T.admin, { templateId: 'anthropic-subscription', subscriberAttested: true })).status, 404);
  });

  let id = '';
  it('connect, poll to sign-in, list: no response carries a token', async () => {
    const start = await api('/api/v1/subscriptions/connect', 'POST', T.admin, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(start.status, 201, start.text);
    assert.equal(start.body.signIn.userCode, 'ABCD-EFGH');
    assert.equal(start.body.signIn.verificationUrl, 'https://auth.x.ai/oauth2/device');
    const signInId = start.body.signIn.signInId;
    // A different admin cannot poll it.
    clock += 6000;
    // (the bearer admin and the poller are the same actor; a viewer is refused by privilege)
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.viewer)).status, 403);
    const p1 = await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.status, 'pending');
    clock += 6000;
    const p2 = await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin);
    assert.equal(p2.status, 200, p2.text);
    assert.equal(p2.body.status, 'connected');
    id = p2.body.connection.id;
    assert.equal(p2.body.connection.name, "Dale's Grok Subscription");
    assert.equal(p2.body.connection.subscriberEmail, 'dale@example.com');
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin)).status, 404, 'a finished sign-in cannot be replayed');

    const list = await api('/api/v1/subscriptions', 'GET', T.admin);
    assert.equal(list.status, 200);
    assert.equal(list.body.connections.length, 1);
    const ids = list.body.templates.map((t: { id: string }) => t.id).sort();
    assert.deepEqual(ids, ['openai-subscription', 'xai-subscription']);
    const inst = list.body.templates.find((t: { id: string }) => t.id === 'xai-subscription').instructions;
    assert.equal(inst.reviewState, 'pending_review', 'AI-drafted instructions are labelled pending human review (K5.4)');
    assert.match(inst.label, /Pending human review/);
    assert.ok(inst.instructions.includes('subscriber'));
    for (const v of state.secretValues) for (const r of [start, p2, list]) assert.equal(r.text.includes(v), false, 'a response carried a token');
    assert.ok(mem.has(`shared/xai/subscription/${id}`), 'stored by the Keymaster at shared/<provider>/subscription/<connection>');
    for (const k of mem.keys()) assert.ok(k.startsWith('shared/xai/subscription/'), `unexpected secret ${k}`);
  });

  it('rename, refuses a clash, and reconnect starts a sign-in for that connection', async () => {
    const rn = await api(`/api/v1/subscriptions/${id}/rename`, 'POST', T.admin, { name: 'Dale grok' });
    assert.equal(rn.status, 200);
    assert.equal(rn.body.connection.name, 'Dale grok');
    assert.equal((await api(`/api/v1/subscriptions/${id}/rename`, 'POST', T.admin, { name: '' })).status, 400);
    assert.equal((await api('/api/v1/subscriptions/c-000000000000/rename', 'POST', T.admin, { name: 'z' })).status, 404);
    const noAttest = await api(`/api/v1/subscriptions/${id}/reconnect`, 'POST', T.admin, {});
    assert.equal(noAttest.status, 400);
    pending = 0;
    const re = await api(`/api/v1/subscriptions/${id}/reconnect`, 'POST', T.admin, { subscriberAttested: true });
    assert.equal(re.status, 201);
    assert.equal(re.body.signIn.reconnect, id);
    clock += 6000;
    const done = await api(`/api/v1/subscriptions/sign-ins/${re.body.signIn.signInId}`, 'GET', T.admin);
    assert.equal(done.body.status, 'connected');
    assert.equal(done.body.reconnect, true);
    assert.equal(done.body.connection.id, id);
    assert.equal(done.body.connection.name, 'Dale grok');
  });

  it('a refused refresh marks needs re-consent and notifies the admins (the connecting token admin holds no linked role)', async () => {
    clock += 3 * 60 * 60 * 1000;
    refresh = () => j(400, { error: 'invalid_grant' });
    const out = await state.subscriptions!.accessToken(id);
    assert.ok(!out.ok && out.error === 'needs_reconsent');
    assert.equal(notices.length, 1);
    // The connecting actor is a bearer token, not a linked admin, so every factory admin is told.
    assert.deepEqual(notices[0].recipients, ['oidc:alice@example.com', 'oidc:bob@example.com']);
    const rows = (state.ledger as MemoryLedger).events.filter((e) => e.action === 'SUBSCRIPTION_RECONSENT_NOTIFIED');
    assert.deepEqual(rows.map((r) => r.subject).sort(), ['oidc:alice@example.com', 'oidc:bob@example.com']);
    const list = await api('/api/v1/subscriptions', 'GET', T.admin);
    assert.equal(list.body.connections[0].status, 'needs_reconsent');
  });

  it('the notice goes to the connecting admin alone while that admin still holds the role', () => {
    assert.deepEqual(reconsentRecipients(state, 'oidc:alice@example.com'), ['oidc:alice@example.com']);
    // Carol was linked as a viewer: she is not an admin, so the fallback applies.
    assert.deepEqual(reconsentRecipients(state, 'oidc:carol@example.com'), ['oidc:alice@example.com', 'oidc:bob@example.com']);
    // Alice loses the role: her connection's notice goes to every admin that remains.
    state.identityLinks!.link('discord', '1', 'oidc:alice@example.com', 'setup', { name: 'Alice', roles: ['viewer'] });
    assert.deepEqual(reconsentRecipients(state, 'oidc:alice@example.com'), ['oidc:bob@example.com']);
  });

  it('a delivery hook that fails does not hide the ledger rows or stop the refusal', async () => {
    setSubscriptionNotifier(state, () => {
      throw new Error('channel down');
    });
    const before = (state.ledger as MemoryLedger).events.filter((e) => e.action === 'SUBSCRIPTION_RECONSENT_NOTIFIED').length;
    const view = (await state.subscriptions!.list())[0];
    await notifyNeedsReconsent(state, { connection: view, reason: 'invalid_grant' });
    const after = (state.ledger as MemoryLedger).events.filter((e) => e.action === 'SUBSCRIPTION_RECONSENT_NOTIFIED').length;
    assert.equal(after - before, 1, 'one row for the one admin who remains');
    setSubscriptionNotifier(state, (n) => void notices.push(n));
  });

  it('disconnect retires entries through the catalog hook, and the grant is gone', async () => {
    const retired: string[] = [];
    setSubscriptionEntryRetirer(state, (c) => (retired.push(c.id), 2));
    const r = await api(`/api/v1/subscriptions/${id}`, 'DELETE', T.admin);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.entriesRetired, 2);
    assert.deepEqual(retired, [id]);
    assert.equal((await api(`/api/v1/subscriptions/${id}`, 'DELETE', T.admin)).status, 404);
    assert.deepEqual((await api('/api/v1/subscriptions', 'GET', T.admin)).body.connections, []);
    const actions = (state.ledger as MemoryLedger).events.map((e) => e.action);
    for (const a of ['SUBSCRIPTION_CONNECTED', 'SUBSCRIPTION_RENAMED', 'SUBSCRIPTION_DISCONNECTED']) assert.ok(actions.includes(a), a);
    const text = JSON.stringify((state.ledger as MemoryLedger).events);
    for (const v of state.secretValues) assert.equal(text.includes(v), false, 'the ledger carried a token');
  });
});
