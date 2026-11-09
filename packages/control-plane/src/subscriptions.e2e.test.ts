// DESIGN_AUTHORITY.md TSK-326 & TSK-332 (§6.9 M5(4) to (6), §6.11 K2, K4, K5.1):
// Factory-scoped (`shared/...`) and personal Owner BYOM (`users/u-<sha256>/...`) subscription routes, Bouncer `subscriptions.own`,
// cross-scope single-connection-per-vendor-account guard, `needs_reconsent` owner/admin routing, and `X-Factory-Act-As` ledgering.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens, type AuthVerifier } from '@beercanlabs/factory-auth';
import { SubscriptionKeymaster, subscriptionPrincipalKey } from '@beercanlabs/factory-keymaster';
import {
  IdentityLinkStore,
  ApprovalStore,
  GrantStore,
  MemoryDocBackend,
  PrincipalStore,
  type GrantsDoc,
  type PrincipalsDoc,
} from '@beercanlabs/factory-bouncer';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createFactoryServer, type FactoryState } from './app.js';
import { getSubscriptionWindows } from './subscription-windows.js';
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
      return j(200, { access_token: 'xai-access-0-aaaaaaaa', refresh_token: 'xai-refresh-0-aaaaaaaa', id_token: jwt({ sub: 'sub-1', email: 'dale@example.com', name: 'Dale R' }), expires_in: 3600 }); // secret-scan:allow
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

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('anonymous and service roles are refused; raw non-admin bearer tokens without user:<id> cannot connect or view factory scope', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/subscriptions'],
      ['POST', '/api/v1/subscriptions/connect', { templateId: 'xai-subscription', subscriberAttested: true }],
      ['GET', '/api/v1/subscriptions/sign-ins/x'],
      ['POST', '/api/v1/subscriptions/c-000000000000/reconnect', { subscriberAttested: true }],
      ['PATCH', '/api/v1/subscriptions/c-000000000000', { name: 'x' }],
      ['POST', '/api/v1/subscriptions/c-000000000000/rename', { name: 'x' }],
      ['DELETE', '/api/v1/subscriptions/c-000000000000'],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await api(path, method, undefined, body)).status, 401, `${method} ${path} anonymous`);
      assert.equal((await api(path, method, T.egress, body)).status, 403, `${method} ${path} egress`);
    }
    for (const t of [T.viewer, T.operator]) {
      const list = await api('/api/v1/subscriptions', 'GET', t);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.connections, []);
      assert.equal((await api('/api/v1/subscriptions?scope=factory', 'GET', t)).status, 403);
      const personalNoUser = await api('/api/v1/subscriptions/connect', 'POST', t, { templateId: 'xai-subscription', subscriberAttested: true });
      assert.equal(personalNoUser.status, 403);
      assert.equal(personalNoUser.body.error, 'user_principal_required');
      const factoryConnect = await api('/api/v1/subscriptions/connect', 'POST', t, { templateId: 'xai-subscription', scope: 'factory', subscriberAttested: true });
      assert.equal(factoryConnect.status, 403);
      assert.equal((await api('/api/v1/subscriptions/sign-ins/x', 'GET', t)).status, 404);
      assert.equal((await api('/api/v1/subscriptions/c-000000000000', 'DELETE', t)).status, 404);
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
    assert.equal(start.body.signIn.scope, 'factory');
    const signInId = start.body.signIn.signInId;
    clock += 6000;
    // A non-admin viewer gets 404 (no leak of pending factory sign-in).
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.viewer)).status, 404);
    const p1 = await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.status, 'pending');
    clock += 6000;
    const p2 = await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin);
    assert.equal(p2.status, 200, p2.text);
    assert.equal(p2.body.status, 'connected');
    id = p2.body.connection.id;
    assert.equal(p2.body.connection.scope, 'factory');
    assert.equal(p2.body.connection.ownerPrincipalId, undefined);
    assert.equal(p2.body.connection.name, "Dale's Grok Subscription");
    assert.equal(p2.body.connection.subscriberEmail, 'dale@example.com');
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${signInId}`, 'GET', T.admin)).status, 404, 'a finished sign-in cannot be replayed');

    const list = await api('/api/v1/subscriptions', 'GET', T.admin);
    assert.equal(list.status, 200);
    assert.equal(list.body.connections.length, 1);
    assert.equal(list.body.connections[0].scope, 'factory');
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
    assert.ok(rows.every((r) => r.scope === 'factory'));
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

// ---- TSK-332: Owner BYOM Keymaster, Bouncer & scoped subscription routes -------------------------

describe('Owner BYOM scoped subscription routes, Bouncer & re-consent (TSK-332)', { concurrency: false }, () => {
  const TOK = {
    admin: 'tok-admin-byom',
    alice: 'tok-alice-byom',
    bob: 'tok-bob-byom',
    teamlead: 'tok-teamlead-byom',
    outgoing: 'tok-outgoing-byom',
    incoming: 'tok-incoming-byom',
    legacy: 'tok-legacy-byom',
    service: 'tok-service-byom',
  } as const;

  const ACTORS: Record<string, string> = {
    [TOK.admin]: 'user:admin',
    [TOK.alice]: 'user:alice',
    [TOK.bob]: 'user:bob',
    [TOK.teamlead]: 'user:teamlead',
    [TOK.outgoing]: 'user:outgoing',
    [TOK.incoming]: 'user:incoming',
    [TOK.legacy]: 'user:legacy',
    [TOK.service]: 'service:ci-bot',
  };

  function identityAuth(): AuthVerifier {
    return {
      async verify(authorization) {
        if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
        const actor = ACTORS[authorization.slice('Bearer '.length).trim()];
        if (!actor) return { ok: false, reason: 'unknown token' };
        return { ok: true, principal: { actor, roles: [] } };
      },
    };
  }

  let cp: http.Server;
  let state: FactoryState;
  let principals: PrincipalStore;
  let grants: GrantStore;
  let clock = Date.parse('2026-11-08T12:00:00Z');
  let seq = 0;
  let nextSub = { sub: 'sub-factory', email: 'ops@example.com', name: 'Ops Team' };
  let refreshHandler: (refreshToken: string) => Response = () =>
    j(200, { access_token: `xai-access-rot-${++seq}-aaaa`, refresh_token: `xai-refresh-rot-${seq}-aaaa`, expires_in: 3600 }); // secret-scan:allow
  const mem = new Map<string, string>();
  const provider: SecretProvider = { name: 'mem', get: async (k) => mem.get(k), put: async (k, v) => void mem.set(k, v) };
  const notices: SubscriptionNotice[] = [];
  let api: (
    path: string,
    method?: string,
    token?: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) => Promise<{ status: number; body: any; text: string }>;

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (url === 'https://auth.x.ai/.well-known/openid-configuration') return j(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' });
    if (url === 'https://auth.x.ai/oauth2/device/code') {
      const n = ++seq;
      return j(200, {
        device_code: `xai-device-code-${n}`,
        user_code: `CODE-${n}`,
        verification_uri: 'https://auth.x.ai/oauth2/device',
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === 'https://auth.x.ai/oauth2/token') {
      if (form.get('grant_type') === 'refresh_token') {
        return refreshHandler(form.get('refresh_token') ?? '');
      }
      const n = ++seq;
      return j(200, {
        access_token: `xai-access-${n}-aaaaaaaa`, // secret-scan:allow
        refresh_token: `xai-refresh-${n}-aaaaaaaa`, // secret-scan:allow
        id_token: jwt(nextSub),
        expires_in: 3600,
      });
    }
    return j(404, {});
  }) as typeof fetch;

  before(async () => {
    principals = await PrincipalStore.open(new MemoryDocBackend<PrincipalsDoc>());
    grants = await GrantStore.open(new MemoryDocBackend<GrantsDoc>(), { principals, now: () => new Date(clock) });

    for (const id of ['admin', 'alice', 'bob', 'teamlead', 'outgoing', 'incoming', 'legacy']) {
      await principals.create({
        id: `user:${id}`,
        displayName: id,
        emails: [`${id}@example.com`],
        by: 'user:admin',
      });
    }

    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: identityAuth(),
      principals,
      grants,
      version: '0.1.0-test',
      providers: [provider],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('sub-byom-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;

    // Register personal & team agents to test ownership qualification
    state.agents.set('alice-agent', {
      id: 'alice-agent',
      name: 'Alice Personal Agent',
      kind: 'personal',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/alice-agent',
    } as never);
    state.agents.set('team-agent', {
      id: 'team-agent',
      name: 'Ops Team Agent',
      kind: 'team',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/team-agent',
    } as never);
    state.agents.set('transfer-agent', {
      id: 'transfer-agent',
      name: 'Transferring Personal Agent',
      kind: 'personal',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/transfer-agent',
    } as never);
    state.agents.set('legacy-personal', {
      id: 'legacy-personal',
      name: 'Legacy Personal Agent',
      kind: 'personal',
      owners: ['user:legacy'],
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/legacy-personal',
    } as never);

    grants.setAgentKindLookup((agentId) => (state.agents.get(agentId) as { kind?: 'personal' | 'team' } | undefined)?.kind ?? 'personal');

    // Grants:
    // - user:admin -> fleet admin
    // - user:alice -> ONLY personal agent `content-owner` (NO fleet viewer!)
    // - user:bob -> fleet `viewer` (holds `content.submit`)
    // - user:teamlead -> ONLY `team` agent `accountable-lead` (NO fleet viewer / NO `content.submit`!)
    // - user:outgoing -> personal agent `content-owner` in D15 `pending-revoked` transfer state (readOnly!)
    // - service:ci-bot -> fleet `operator` (holds `subscriptions.own` as a service role, NOT a canonical `user:<id>`)
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:alice', scope: { kind: 'agent', id: 'alice-agent' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:bob', scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:teamlead', scope: { kind: 'agent', id: 'team-agent' }, role: 'accountable-lead', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:outgoing', scope: { kind: 'agent', id: 'transfer-agent' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await grants.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'transfer-agent' },
      fromSubject: 'user:outgoing',
      toSubject: 'user:incoming',
      by: 'user:outgoing',
    });
    await grants.grant({ subject: 'service:ci-bot', scope: { kind: 'fleet' }, role: 'operator', by: 'user:admin', granterIsAdmin: true });

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

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    const port = (cp.address() as { port: number }).port;
    api = async (path, method = 'GET', token, body, extraHeaders = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, text };
    };
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('Bouncer qualification: personal content-owner, legacy personal agent-owner, and fleet viewer hold subscriptions.own; team-only accountable-lead and D15 pending-revoked owner do NOT', async () => {
    for (const [label, tok, expected] of [
      ['alice (personal content-owner without fleet viewer)', TOK.alice, true],
      ['legacy (legacy personal agent-owner without fleet viewer)', TOK.legacy, true],
      ['bob (fleet viewer / content.submit)', TOK.bob, true],
      ['teamlead (team accountable-lead without content.submit)', TOK.teamlead, false],
      ['outgoing (D15 pending-revoked personal content-owner)', TOK.outgoing, false],
    ] as const) {
      const chk = await api('/api/v1/authz/check?privilege=subscriptions.own', 'GET', tok);
      assert.equal(chk.status, 200, `${label}: ${chk.text}`);
      assert.equal(chk.body.allowed, expected, `${label} authz/check`);

      const who = await api('/api/v1/whoami', 'GET', tok);
      assert.equal(who.status, 200);
      assert.equal(who.body.privileges.fleet.includes('subscriptions.own'), expected, `${label} whoami privileges`);

      const list = await api('/api/v1/subscriptions', 'GET', tok);
      assert.equal(list.status, expected ? 200 : 403, `${label} GET /api/v1/subscriptions`);
    }

    // MCP `authz_check` also honors `ownsPersonalAgent` for `user:alice` (who holds `mcp.use` via `ownsAnyAgent` and `subscriptions.own` via `ownsPersonalAgent`)
    const mcpAlice = await api('/mcp', 'POST', TOK.alice, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'authz_check', arguments: { privilege: 'subscriptions.own' } },
    });
    assert.equal(mcpAlice.status, 200);
    assert.equal(JSON.parse(mcpAlice.body.result.content[0].text).allowed, true);

    // Team-only `accountable-lead` holds `mcp.use` via `ownsAnyAgent` yet MCP `authz_check` for `subscriptions.own` is false!
    const mcpTeamLead = await api('/mcp', 'POST', TOK.teamlead, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'authz_check', arguments: { privilege: 'subscriptions.own' } },
    });
    assert.equal(mcpTeamLead.status, 200);
    assert.equal(JSON.parse(mcpTeamLead.body.result.content[0].text).allowed, false);

    // Service principal holding fleet operator passes Bouncer's `subscriptions.own`, but is refused personal connect because it is not `user:<id>`.
    const svc = await api('/api/v1/subscriptions', 'POST', TOK.service, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(svc.status, 403);
    assert.equal(svc.body.error, 'user_principal_required');
  });

  let factoryConnId = '';
  let aliceConnId = '';
  let bobConnId = '';

  it('admin connects factory subscription; non-admin alice connects, polls, lists, renames (PATCH), and reconnects her own personal subscription at users/u-<sha256>/...', async () => {
    // 1. Admin connects factory subscription (`sub-factory`)
    nextSub = { sub: 'sub-factory', email: 'ops@example.com', name: 'Ops Team' };
    const fStart = await api('/api/v1/subscriptions', 'POST', TOK.admin, { templateId: 'xai-subscription', subscriberAttested: true, name: 'Factory Grok' });
    assert.equal(fStart.status, 201, fStart.text);
    assert.equal(fStart.body.signIn.scope, 'factory');
    clock += 6000;
    const fPoll = await api(`/api/v1/subscriptions/sign-ins/${fStart.body.signIn.signInId}`, 'GET', TOK.admin);
    assert.equal(fPoll.status, 200);
    assert.equal(fPoll.body.status, 'connected');
    factoryConnId = fPoll.body.connection.id;
    assert.equal(fPoll.body.connection.scope, 'factory');
    assert.ok(mem.has(`shared/xai/subscription/${factoryConnId}`));

    // 2. Non-admin alice cannot request `scope: 'factory'` or `?scope=factory`
    assert.equal((await api('/api/v1/subscriptions', 'POST', TOK.alice, { templateId: 'xai-subscription', scope: 'factory', subscriberAttested: true })).status, 403);
    assert.equal((await api('/api/v1/subscriptions?scope=factory', 'GET', TOK.alice)).status, 403);

    // 3. Non-admin alice starts personal connect (scope omitted -> defaults to `'personal'`)
    nextSub = { sub: 'sub-alice', email: 'alice@example.com', name: 'Alice S' };
    const aStart = await api('/api/v1/subscriptions', 'POST', TOK.alice, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(aStart.status, 201, aStart.text);
    assert.equal(aStart.body.signIn.scope, 'personal');
    assert.equal(aStart.body.signIn.ownerPrincipalId, 'user:alice');
    const aSignIn = aStart.body.signIn.signInId;

    // Bob cannot poll Alice's pending sign-in (404, zero leak); admin without Act-As gets 403
    clock += 6000;
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${aSignIn}`, 'GET', TOK.bob)).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/sign-ins/${aSignIn}`, 'GET', TOK.admin)).status, 403);

    // Alice polls her own sign-in -> connected
    const aPoll = await api(`/api/v1/subscriptions/sign-ins/${aSignIn}`, 'GET', TOK.alice);
    assert.equal(aPoll.status, 200, aPoll.text);
    assert.equal(aPoll.body.status, 'connected');
    aliceConnId = aPoll.body.connection.id;
    assert.equal(aPoll.body.connection.scope, 'personal');
    assert.equal(aPoll.body.connection.ownerPrincipalId, 'user:alice');

    // Verify vault path `users/u-<sha256>/xai/subscription/<id>` + stored JSON metadata
    const alicePk = subscriptionPrincipalKey('user:alice');
    assert.match(alicePk, /^u-[a-f0-9]{64}$/);
    const expectedKey = `users/${alicePk}/xai/subscription/${aliceConnId}`;
    assert.ok(mem.has(expectedKey), `expected vault secret at ${expectedKey}`);
    const rawStored = JSON.parse(mem.get(expectedKey)!);
    assert.equal(rawStored.scope, 'personal');
    assert.equal(rawStored.ownerPrincipalId, 'user:alice');

    // Verify tampered vault record under `users/<pk>/...` fails closed
    try {
      state.subscriptions!.invalidate(aliceConnId);
      mem.set(expectedKey, JSON.stringify({ ...rawStored, ownerPrincipalId: 'user:bob' }));
      assert.equal(await state.subscriptions!.get(aliceConnId), undefined, 'tampered ownerPrincipalId must fail closed');
      const badToken = await state.subscriptions!.accessToken(aliceConnId);
      assert.ok(!badToken.ok && badToken.error === 'unknown_connection');
    } finally {
      mem.set(expectedKey, JSON.stringify(rawStored));
    }
    assert.equal((await state.subscriptions!.get(aliceConnId))?.ownerPrincipalId, 'user:alice');

    // 4. Alice renames via PATCH (and factory-wide name_taken is enforced across scopes!)
    const clash = await api(`/api/v1/subscriptions/${aliceConnId}`, 'PATCH', TOK.alice, { name: 'Factory Grok' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'name_taken');

    const patched = await api(`/api/v1/subscriptions/${aliceConnId}`, 'PATCH', TOK.alice, { name: 'Alice Personal Grok' });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.connection.name, 'Alice Personal Grok');

    // 5. Alice reconnects via POST .../reconnect AND via repeat sign-in as same owner
    const re = await api(`/api/v1/subscriptions/${aliceConnId}/reconnect`, 'POST', TOK.alice, { subscriberAttested: true });
    assert.equal(re.status, 201);
    clock += 6000;
    const reDone = await api(`/api/v1/subscriptions/sign-ins/${re.body.signIn.signInId}`, 'GET', TOK.alice);
    assert.equal(reDone.status, 200);
    assert.equal(reDone.body.reconnect, true);
    assert.equal(reDone.body.connection.id, aliceConnId);

    const repeatStart = await api('/api/v1/subscriptions', 'POST', TOK.alice, { templateId: 'xai-subscription', subscriberAttested: true, name: 'Ignored On Reconnect' });
    assert.equal(repeatStart.status, 201);
    clock += 6000;
    const repeatDone = await api(`/api/v1/subscriptions/sign-ins/${repeatStart.body.signIn.signInId}`, 'GET', TOK.alice);
    assert.equal(repeatDone.status, 200);
    assert.equal(repeatDone.body.reconnect, true);
    assert.equal(repeatDone.body.connection.id, aliceConnId);
    assert.equal(repeatDone.body.connection.name, 'Alice Personal Grok');
  });

  it('single-connection-per-vendor-account across scopes (M5(4)): cross-owner sign-in returns 409 account_already_connected, redacts new tokens, and leaves existing grant untouched', async () => {
    const aliceGrantBefore = mem.get(`users/${subscriptionPrincipalKey('user:alice')}/xai/subscription/${aliceConnId}`);
    const secretCountBefore = state.secretValues.size;

    // 1. Bob tries to connect Alice's vendor account (`sub-alice`) -> 409 account_already_connected
    nextSub = { sub: 'sub-alice', email: 'alice@example.com', name: 'Alice S' };
    const bobSteal = await api('/api/v1/subscriptions', 'POST', TOK.bob, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(bobSteal.status, 201);
    clock += 6000;
    const bobPoll = await api(`/api/v1/subscriptions/sign-ins/${bobSteal.body.signIn.signInId}`, 'GET', TOK.bob);
    assert.equal(bobPoll.status, 409, bobPoll.text);
    assert.equal(bobPoll.body.error, 'account_already_connected');
    assert.ok(state.secretValues.size > secretCountBefore, 'newly obtained tokens were registered for redaction before discarding');
    for (const v of state.secretValues) assert.equal(bobPoll.text.includes(v), false, '409 response leaked a token');
    assert.equal(mem.get(`users/${subscriptionPrincipalKey('user:alice')}/xai/subscription/${aliceConnId}`), aliceGrantBefore, 'Alice grant untouched');

    // 2. Admin tries to connect Alice's vendor account (`sub-alice`) at `scope: 'factory'` -> 409 account_already_connected
    const adminSteal = await api('/api/v1/subscriptions', 'POST', TOK.admin, { templateId: 'xai-subscription', scope: 'factory', subscriberAttested: true });
    assert.equal(adminSteal.status, 201);
    clock += 6000;
    const adminPoll = await api(`/api/v1/subscriptions/sign-ins/${adminSteal.body.signIn.signInId}`, 'GET', TOK.admin);
    assert.equal(adminPoll.status, 409, adminPoll.text);
    assert.equal(adminPoll.body.error, 'account_already_connected');
    assert.equal(mem.get(`users/${subscriptionPrincipalKey('user:alice')}/xai/subscription/${aliceConnId}`), aliceGrantBefore);

    // 3. Bob tries to connect the factory's vendor account (`sub-factory`) as `personal` -> 409 account_already_connected
    const factoryGrantBefore = mem.get(`shared/xai/subscription/${factoryConnId}`);
    nextSub = { sub: 'sub-factory', email: 'ops@example.com', name: 'Ops Team' };
    const bobStealFactory = await api('/api/v1/subscriptions', 'POST', TOK.bob, { templateId: 'xai-subscription', subscriberAttested: true });
    assert.equal(bobStealFactory.status, 201);
    clock += 6000;
    const bobFactoryPoll = await api(`/api/v1/subscriptions/sign-ins/${bobStealFactory.body.signIn.signInId}`, 'GET', TOK.bob);
    assert.equal(bobFactoryPoll.status, 409);
    assert.equal(bobFactoryPoll.body.error, 'account_already_connected');
    assert.equal(mem.get(`shared/xai/subscription/${factoryConnId}`), factoryGrantBefore);
  });

  it('admin X-Factory-Act-As: user:bob creates, lists, renames, and manages user:bob personal subscription with onBehalfOf ledgered; strict isolation between alice, bob, and factory', async () => {
    // Admin acting as `user:bob` creates Bob's personal connection
    nextSub = { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob B' };
    const start = await api(
      '/api/v1/subscriptions',
      'POST',
      TOK.admin,
      { templateId: 'xai-subscription', subscriberAttested: true },
      { 'x-factory-act-as': 'user:bob' },
    );
    assert.equal(start.status, 201, start.text);
    assert.equal(start.body.signIn.scope, 'personal');
    assert.equal(start.body.signIn.ownerPrincipalId, 'user:bob');
    clock += 6000;
    const poll = await api(
      `/api/v1/subscriptions/sign-ins/${start.body.signIn.signInId}`,
      'GET',
      TOK.admin,
      undefined,
      { 'x-factory-act-as': 'user:bob' },
    );
    assert.equal(poll.status, 200, poll.text);
    assert.equal(poll.body.status, 'connected');
    bobConnId = poll.body.connection.id;
    assert.equal(poll.body.connection.scope, 'personal');
    assert.equal(poll.body.connection.ownerPrincipalId, 'user:bob');

    // Admin acting as `user:bob` renames Bob's connection
    const ren = await api(
      `/api/v1/subscriptions/${bobConnId}`,
      'PATCH',
      TOK.admin,
      { name: 'Bob Personal Grok' },
      { 'x-factory-act-as': 'user:bob' },
    );
    assert.equal(ren.status, 200);
    assert.equal(ren.body.connection.name, 'Bob Personal Grok');

    // Scoped listing isolation:
    // - Alice sees ONLY `[aliceConnId]`
    const aliceList = await api('/api/v1/subscriptions', 'GET', TOK.alice);
    assert.deepEqual(aliceList.body.connections.map((c: any) => c.id), [aliceConnId]);
    // - Bob sees ONLY `[bobConnId]`
    const bobList = await api('/api/v1/subscriptions', 'GET', TOK.bob);
    assert.deepEqual(bobList.body.connections.map((c: any) => c.id), [bobConnId]);
    // - Admin with X-Factory-Act-As: user:bob sees ONLY `[bobConnId]`
    const actAsList = await api('/api/v1/subscriptions', 'GET', TOK.admin, undefined, { 'x-factory-act-as': 'user:bob' });
    assert.deepEqual(actAsList.body.connections.map((c: any) => c.id), [bobConnId]);
    // - Admin without Act-As sees all 3 (`factory` + `alice` + `bob`) and can filter `?scope=`
    const adminAll = await api('/api/v1/subscriptions', 'GET', TOK.admin);
    assert.equal(adminAll.body.connections.length, 3);
    const adminFactory = await api('/api/v1/subscriptions?scope=factory', 'GET', TOK.admin);
    assert.deepEqual(adminFactory.body.connections.map((c: any) => c.id), [factoryConnId]);
    const adminPersonal = await api('/api/v1/subscriptions?scope=personal', 'GET', TOK.admin);
    assert.deepEqual(
      adminPersonal.body.connections.map((c: any) => c.id).sort(),
      [aliceConnId, bobConnId].sort(),
    );

    // Cross-principal mutation isolation (non-admin gets 404, zero details leaked):
    for (const target of [factoryConnId, bobConnId]) {
      assert.equal((await api(`/api/v1/subscriptions/${target}/reconnect`, 'POST', TOK.alice, { subscriberAttested: true })).status, 404);
      assert.equal((await api(`/api/v1/subscriptions/${target}`, 'PATCH', TOK.alice, { name: 'Hacked' })).status, 404);
      assert.equal((await api(`/api/v1/subscriptions/${target}/rename`, 'POST', TOK.alice, { name: 'Hacked' })).status, 404);
      assert.equal((await api(`/api/v1/subscriptions/${target}`, 'DELETE', TOK.alice)).status, 404);
    }

    // Check ledger rows for Bob's Act-As connect & rename carry actor: user:admin, onBehalfOf: user:bob, scope: personal, ownerPrincipalId: user:bob
    const events = (state.ledger as MemoryLedger).events;
    const bobConnected = events.find((e) => e.action === 'SUBSCRIPTION_CONNECTED' && e.connection === bobConnId);
    assert.ok(bobConnected);
    assert.equal(bobConnected.actor, 'user:admin');
    assert.equal(bobConnected.onBehalfOf, 'user:bob');
    assert.equal(bobConnected.scope, 'personal');
    assert.equal(bobConnected.ownerPrincipalId, 'user:bob');

    const bobRenamed = events.find((e) => e.action === 'SUBSCRIPTION_RENAMED' && e.connection === bobConnId);
    assert.ok(bobRenamed);
    assert.equal(bobRenamed.actor, 'user:admin');
    assert.equal(bobRenamed.onBehalfOf, 'user:bob');
    assert.equal(bobRenamed.scope, 'personal');
    assert.equal(bobRenamed.ownerPrincipalId, 'user:bob');
  });

  it('needs_reconsent (M5(6)): notifies [user:alice] on her active personal connection, and falls back to factory admins only when owner is disabled/revoked', async () => {
    notices.length = 0;
    clock += 3 * 60 * 60 * 1000;
    refreshHandler = () => j(400, { error: 'invalid_grant' });

    // 1. Active `user:alice` -> notified directly (`['user:alice']`), NOT factory admins
    const out1 = await state.subscriptions!.accessToken(aliceConnId);
    assert.ok(!out1.ok && out1.error === 'needs_reconsent');
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].recipients, ['user:alice']);

    const events = (state.ledger as MemoryLedger).events;
    const reconsentRow = events.find((e) => e.action === 'SUBSCRIPTION_NEEDS_RECONSENT' && e.connection === aliceConnId);
    assert.ok(reconsentRow);
    assert.equal(reconsentRow.scope, 'personal');
    assert.equal(reconsentRow.ownerPrincipalId, 'user:alice');

    const notifiedRows1 = events.filter((e) => e.action === 'SUBSCRIPTION_RECONSENT_NOTIFIED' && e.connection === aliceConnId);
    assert.equal(notifiedRows1.length, 1);
    assert.equal(notifiedRows1[0].subject, 'user:alice');
    assert.equal(notifiedRows1[0].scope, 'personal');
    assert.equal(notifiedRows1[0].ownerPrincipalId, 'user:alice');

    // 2. Revoke all access for `user:bob` (`POST /api/v1/principals/user:bob/revoke-access`) -> Bob has no active grants, so his personal connection falls back to `['user:admin']`!
    const rev = await api('/api/v1/principals/user:bob/revoke-access', 'POST', TOK.admin, { confirm: 'user:bob' });
    assert.equal(rev.status, 200, rev.text);

    notices.length = 0;
    const out2 = await state.subscriptions!.accessToken(bobConnId);
    assert.ok(!out2.ok && out2.error === 'needs_reconsent');
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].recipients, ['user:admin']);

    const notifiedRows2 = (state.ledger as MemoryLedger).events.filter(
      (e) => e.action === 'SUBSCRIPTION_RECONSENT_NOTIFIED' && e.connection === bobConnId,
    );
    assert.equal(notifiedRows2.length, 1);
    assert.equal(notifiedRows2[0].subject, 'user:admin');
    assert.equal(notifiedRows2[0].scope, 'personal');
    assert.equal(notifiedRows2[0].ownerPrincipalId, 'user:bob');

    // 3. Absent principal (`user:deleted` not in `PrincipalStore`) also falls back to factory admins
    assert.deepEqual(
      reconsentRecipients(state, { scope: 'personal', ownerPrincipalId: 'user:deleted', connectedBy: 'user:deleted' }),
      ['user:admin'],
    );
  });

  it('alice disconnects her own personal connection; admin disconnects another personal connection for incident response and via X-Factory-Act-As', async () => {
    // Alice disconnects her own personal connection
    const delAlice = await api(`/api/v1/subscriptions/${aliceConnId}`, 'DELETE', TOK.alice);
    assert.equal(delAlice.status, 200, delAlice.text);
    assert.equal(delAlice.body.connection.id, aliceConnId);
    assert.deepEqual((await api('/api/v1/subscriptions', 'GET', TOK.alice)).body.connections, []);

    const aliceDisc = (state.ledger as MemoryLedger).events.find(
      (e) => e.action === 'SUBSCRIPTION_DISCONNECTED' && e.connection === aliceConnId,
    );
    assert.ok(aliceDisc);
    assert.equal(aliceDisc.actor, 'user:alice');
    assert.equal(aliceDisc.scope, 'personal');
    assert.equal(aliceDisc.ownerPrincipalId, 'user:alice');

    // Admin disconnects Bob's personal connection (incident response without Act-As)
    const delBob = await api(`/api/v1/subscriptions/${bobConnId}`, 'DELETE', TOK.admin);
    assert.equal(delBob.status, 200, delBob.text);
    const bobDisc = (state.ledger as MemoryLedger).events.find(
      (e) => e.action === 'SUBSCRIPTION_DISCONNECTED' && e.connection === bobConnId,
    );
    assert.ok(bobDisc);
    assert.equal(bobDisc.actor, 'user:admin');
    assert.equal(bobDisc.onBehalfOf, undefined);
    assert.equal(bobDisc.scope, 'personal');
    assert.equal(bobDisc.ownerPrincipalId, 'user:bob');

    // Admin disconnects a personal connection via `X-Factory-Act-As: user:legacy` -> `onBehalfOf: 'user:legacy'` ledgered
    nextSub = { sub: 'sub-legacy', email: 'legacy@example.com', name: 'Legacy L' };
    const legStart = await api(
      '/api/v1/subscriptions',
      'POST',
      TOK.admin,
      { templateId: 'xai-subscription', subscriberAttested: true },
      { 'x-factory-act-as': 'user:legacy' },
    );
    assert.equal(legStart.status, 201);
    clock += 6000;
    const legPoll = await api(
      `/api/v1/subscriptions/sign-ins/${legStart.body.signIn.signInId}`,
      'GET',
      TOK.admin,
      undefined,
      { 'x-factory-act-as': 'user:legacy' },
    );
    assert.equal(legPoll.status, 200);
    const legConnId = legPoll.body.connection.id;
    const delLeg = await api(`/api/v1/subscriptions/${legConnId}`, 'DELETE', TOK.admin, undefined, {
      'x-factory-act-as': 'user:legacy',
    });
    assert.equal(delLeg.status, 200);
    const legDisc = (state.ledger as MemoryLedger).events.find(
      (e) => e.action === 'SUBSCRIPTION_DISCONNECTED' && e.connection === legConnId,
    );
    assert.ok(legDisc);
    assert.equal(legDisc.actor, 'user:admin');
    assert.equal(legDisc.onBehalfOf, 'user:legacy');
    assert.equal(legDisc.scope, 'personal');
    assert.equal(legDisc.ownerPrincipalId, 'user:legacy');

    // Zero secrets leaked anywhere in the ledger
    const ledgerText = JSON.stringify((state.ledger as MemoryLedger).events);
    for (const v of state.secretValues) assert.equal(ledgerText.includes(v), false, 'ledger leaked a token');
  });

  it('GET /api/v1/subscriptions enriches open limitWindow and lists Anthropic and Google as notOffered with M5(2) reason', async () => {
    const resetAt = new Date(Date.now() + 3600_000).toISOString();
    getSubscriptionWindows(state).open(factoryConnId, {
      kind: 'plan-limit',
      code: 'usage_limit_reached',
      resetAt,
    });
    const adminView = await api('/api/v1/subscriptions', 'GET', TOK.admin);
    assert.equal(adminView.status, 200);
    const factoryConn = adminView.body.connections.find((c: any) => c.id === factoryConnId);
    assert.ok(factoryConn);
    assert.equal(factoryConn.limitWindow?.kind, 'plan-limit');
    assert.equal(factoryConn.limitWindow?.code, 'usage_limit_reached');
    assert.equal(factoryConn.limitWindow?.resetAt, resetAt);

    const notOffered = adminView.body.notOffered as Array<{ vendor: string; reason: string; checkedDate: string; statementUrls: string[] }>;
    assert.deepEqual(notOffered.map((v) => v.vendor), ['anthropic', 'google']);
    for (const v of notOffered) {
      assert.equal(v.checkedDate, '2026-11-07');
      assert.ok(v.reason.length > 20);
      assert.ok(v.statementUrls.length >= 1);
    }
    getSubscriptionWindows(state).close(factoryConnId, 'reset');
  });
});
