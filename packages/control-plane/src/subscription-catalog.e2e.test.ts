// DESIGN_AUTHORITY.md TSK-328 (§6.9 M5(1), (2), (4), (4a), (6), (7), (8)):
// Catalog entries, Owner BYOM $0 management & visibility, discovery triggers/storage/retirements,
// D24/D15/S24 enforcement + D15 auto-detach, $0 BYOM standing, per-agent daily token caps,
// priced-fallback notifications, and scoped Accountant subscription spend views.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SubscriptionKeymaster } from '@beercanlabs/factory-keymaster';
import {
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  IdentityLinkStore,
  PrincipalStore,
} from '@beercanlabs/factory-bouncer';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { FileConfigBackend, GroupStore, SkillModelBindingStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import {
  createGatekeeperEgress,
  type ControlClient,
  type LimitWindowView,
  type SubscriptionCapView,
} from '@beercanlabs/factory-gatekeeper';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createFactoryServer, effectiveAgentBudgetUsd, type FactoryState } from './app.js';
import { ModelStore } from './models.js';
import {
  notifyNeedsReconsent,
  setSubscriptionNotifier,
  startSubscriptionDiscoveryTimer,
  withdrawSubscriptionVendor,
  type SubscriptionNotice,
} from './subscriptions.js';
import { SubscriptionCaps, setSubscriptionCaps } from './subscription-caps.js';
import { SubscriptionWindows } from './subscription-windows.js';
import { loadSkills, skillRegistry } from './skills.js';
import { setSkillModelStore } from './skill-models.js';

const SHA = '7'.repeat(40);
const RUN_KEY = 'tsk328-subscription-catalog-run-token-0123456789'; // secret-scan:allow (test fixture)

const TOKENS = {
  admin: 'tok-tsk328-admin', // secret-scan:allow (test fixture)
  dale: 'tok-tsk328-dale', // secret-scan:allow (test fixture)
  bob: 'tok-tsk328-bob', // secret-scan:allow (test fixture)
  carol: 'tok-tsk328-carol', // secret-scan:allow (test fixture)
  egress: 'tok-tsk328-egress', // secret-scan:allow (test fixture)
} as const;

const ACTORS: Record<string, { actor: string; roles: string[] }> = {
  [TOKENS.admin]: { actor: 'user:admin', roles: [] },
  [TOKENS.dale]: { actor: 'user:dale', roles: [] },
  [TOKENS.bob]: { actor: 'user:bob', roles: [] },
  [TOKENS.carol]: { actor: 'user:carol', roles: [] },
  [TOKENS.egress]: { actor: 'service:gatekeeper-egress', roles: ['operator', 'gatekeeper-egress'] },
};

function testAuth(): AuthProvider {
  return {
    name: 'tsk328-auth',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
      const entry = ACTORS[authorization.slice('Bearer '.length).trim()];
      if (!entry) return { ok: false, reason: 'unknown token' };
      return { ok: true, principal: { actor: entry.actor, roles: entry.roles as never } };
    },
  };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(c)}.sig`;
const j = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const sseOk = (text: string, inputTokens = 10, outputTokens = 6, toolCalls?: unknown[]) =>
  new Response(
    [
      ...(toolCalls ?? []).map((item) => ({ type: 'response.output_item.done', item })),
      {
        type: 'response.completed',
        response: {
          output: toolCalls?.length ? toolCalls : [{ type: 'message', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}

describe('Subscription catalog, Owner BYOM, discovery, D24/D15/S24, $0 standing, caps & spend (TSK-328)', { concurrency: false }, () => {
  let dir: string;
  let cp: http.Server;
  let gk: http.Server;
  let cpPort = 0;
  let gkPort = 0;
  let state: FactoryState;
  const baseUtcDay = new Date().toISOString().slice(0, 10);
  let clock = Date.parse(`${baseUtcDay}T10:00:00.000Z`);
  const mem = new Map<string, string>();
  const provider: SecretProvider = {
    name: 'mem',
    get: async (k) => mem.get(k),
    put: async (k, v) => void mem.set(k, v),
  };
  const notices: SubscriptionNotice[] = [];

  // Scriptable vendor behavior for OAuth sign-in/refresh, model discovery, and Responses calls
  let signInAccount: { sub: string; email: string; name: string; acct?: string; tier?: string } = {
    sub: 'xai-team-1',
    email: 'ops@sackrider.org',
    name: 'Factory Ops',
  };
  let refreshHandler: (vendor: 'xai' | 'openai') => Response = (v) =>
    j(200, {
      access_token: v === 'openai'
        ? jwt({ sub: signInAccount.sub, 'https://api.openai.com/auth': { chatgpt_account_id: signInAccount.acct ?? 'acct-1', chatgpt_plan_type: signInAccount.tier ?? 'plus' } })
        : `${v}-refreshed-token-aaaaaaaa`,
      refresh_token: `${v}-refresh-next-${Math.random().toString(36).slice(2, 8)}`,
      expires_in: 3600,
    });
  let xaiModelsReply: () => Response = () => j(200, { data: [{ id: 'grok-4.6' }, { id: 'grok-3-mini' }] });
  let openaiModelsReply: () => Response = () =>
    j(200, {
      models: [
        { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', priority: 1 },
        { slug: 'gpt-5-mini', display_name: 'GPT-5 mini', priority: 2 },
      ],
    });
  let responsesReply: (url: string, body: any) => Response = () => sseOk('hello from subscription');
  let apiFallbackCalls = 0;

  const vendorFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyStr = String(init?.body ?? '');
    const form = new URLSearchParams(bodyStr);

    // xAI OAuth
    if (url === 'https://auth.x.ai/.well-known/openid-configuration') {
      return j(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' });
    }
    if (url === 'https://auth.x.ai/oauth2/device/code') {
      return j(200, {
        device_code: `xai-dev-${Math.random().toString(36).slice(2, 8)}`,
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.x.ai/oauth2/device',
        expires_in: 600,
        interval: 1,
      });
    }
    if (url === 'https://auth.x.ai/oauth2/token') {
      if (form.get('grant_type') === 'refresh_token') return refreshHandler('xai');
      return j(200, {
        access_token: `xai-access-${signInAccount.sub}-aaaa`, // secret-scan:allow (fake fixture)
        refresh_token: `xai-refresh-${signInAccount.sub}-aaaa`, // secret-scan:allow (fake fixture)
        id_token: jwt({ sub: signInAccount.sub, email: signInAccount.email, name: signInAccount.name }),
        expires_in: 3600,
      });
    }

    // OpenAI OAuth
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return j(200, { device_auth_id: `oa-dev-${Math.random().toString(36).slice(2, 8)}`, user_code: 'WXYZ-9999', interval: '1' });
    }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      return j(200, { authorization_code: 'oa-code-1', code_verifier: 'oa-ver-1' });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      if (form.get('grant_type') === 'refresh_token') return refreshHandler('openai');
      const claims = {
        sub: signInAccount.sub,
        email: signInAccount.email,
        name: signInAccount.name,
        'https://api.openai.com/auth': {
          chatgpt_account_id: signInAccount.acct ?? 'acct-team',
          chatgpt_plan_type: signInAccount.tier ?? 'plus',
        },
      };
      return j(200, {
        access_token: jwt(claims),
        refresh_token: `oa-refresh-${signInAccount.sub}-aaaa`, // secret-scan:allow (fake fixture)
        id_token: jwt(claims),
        expires_in: 3600,
      });
    }

    // Vendor model discovery endpoints
    if (url === 'https://api.x.ai/v1/models') return xaiModelsReply();
    if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) return openaiModelsReply();

    // Vendor Responses endpoints
    if (url === 'https://api.x.ai/v1/responses' || url === 'https://chatgpt.com/backend-api/codex/responses') {
      return responsesReply(url, bodyStr ? JSON.parse(bodyStr) : undefined);
    }

    return j(404, { error: 'not_found', url });
  }) as typeof fetch;

  const api = async (
    path: string,
    method = 'GET',
    token: string = TOKENS.admin,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const res = await fetch(`http://127.0.0.1:${cpPort}${path}`, {
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

  const mcpCall = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await api('/mcp', 'POST', token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const rawText = res.body?.result?.content?.[0]?.text;
    let parsed: any = rawText;
    try {
      if (typeof rawText === 'string') parsed = JSON.parse(rawText);
    } catch {}
    return { status: res.status, rpc: res.body, isError: Boolean(res.body?.error || res.body?.result?.isError), data: parsed };
  };

  const settle = () => new Promise((r) => setTimeout(r, 35));

  const makeAgent = (id: string, name: string, kind: 'personal' | 'team', extra: Record<string, unknown> = {}) =>
    ({
      id,
      name,
      role: name,
      state: 'SLEEPING',
      kind,
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      memoryPrefix: id,
      warmDownSeconds: 300,
      dir: join(dir, id),
      requestedModels: [],
      approvedModels: [],
      ...extra,
    }) as never;

  const chat = async (runToken: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${gkPort}/models/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runToken}`, ...headers },
      body: JSON.stringify({ model: 'ignored', messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };

  const connectSubscription = async (opts: {
    token: string;
    templateId: 'xai-subscription' | 'openai-subscription';
    scope?: 'factory' | 'personal';
    name?: string;
    account: { sub: string; email: string; name: string; acct?: string; tier?: string };
  }) => {
    signInAccount = opts.account;
    const started = await api('/api/v1/subscriptions/connect', 'POST', opts.token, {
      templateId: opts.templateId,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      subscriberAttested: true,
    });
    assert.equal(started.status, 201, started.text);
    clock += 6000;
    const polled = await api(`/api/v1/subscriptions/sign-ins/${started.body.signIn.signInId}`, 'GET', opts.token);
    assert.equal(polled.status, 200, polled.text);
    assert.equal(polled.body.status, 'connected', polled.text);
    return polled.body.connection as { id: string; name: string; scope: string; ownerPrincipalId?: string; discoveredModels?: any[]; discovery?: any };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-tsk328-'));
    const ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend(join(dir, 'principals')));
    const grants = await GrantStore.open(new FileDocBackend(join(dir, 'grants')), { principals });

    for (const [id, email] of [
      ['user:admin', 'admin@sackrider.org'],
      ['user:dale', 'dale@sackrider.org'],
      ['user:bob', 'bob@sackrider.org'],
      ['user:carol', 'carol@sackrider.org'],
    ] as const) {
      await principals.create({ id, displayName: id.slice(5), emails: [email], by: 'user:admin' });
    }
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    for (const u of ['user:dale', 'user:bob', 'user:carol']) {
      await grants.grant({ subject: u, scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    }

    const identityLinks = new IdentityLinkStore();
    identityLinks.link('discord', 'admin-d', 'user:admin', 'setup', { name: 'Admin', roles: ['admin'] });
    identityLinks.link('discord', 'dale-d', 'user:dale', 'setup', { name: 'Dale', roles: ['viewer'] });

    const modelStore = new ModelStore(join(dir, 'models.json'), {
      'api-fallback': { provider: 'mock', id: 'mock-fallback', price: { inputPerMTok: 1, outputPerMTok: 2 } },
      'unpriced-api': { provider: 'mock', id: 'mock-unpriced' },
    });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: testAuth(),
      principals,
      grants,
      groups: await GroupStore.open(join(dir, 'groups')),
      identityLinks,
      version: '0.9.0-test',
      providers: [provider],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(RUN_KEY),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      modelStore,
      defaultModel: 'api-fallback',
      resolveCommit: async () => SHA,
      secretValues: new Set<string>(),
      idleMs: 0,
      idleTimers: new Map(),
      subscriptionNow: () => clock,
      gatekeeperEgressToken: TOKENS.egress,
    } as unknown as FactoryState;

    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    setSkillModelStore(state, new SkillModelBindingStore(join(dir, 'skill-models.json')));

    state.subscriptions = new SubscriptionKeymaster({
      providers: [provider],
      ledger: state.ledger,
      secretValues: state.secretValues,
      fetch: vendorFetch,
      now: () => clock,
      version: state.version,
      onNeedsReconsent: (ev) => notifyNeedsReconsent(state, ev),
    });
    setSubscriptionNotifier(state, (n) => void notices.push(n));
    state.subscriptionWindows = new SubscriptionWindows(state.ledger, () => clock);
    setSubscriptionCaps(state, new SubscriptionCaps(state, () => clock));

    cp = createFactoryServer(state);
    cpPort = await listen(cp);

    const control: ControlClient = {
      async runContext(runId) {
        const r = await api(`/api/v1/gatekeeper-egress/runs/${encodeURIComponent(runId)}`, 'GET', TOKENS.egress);
        return r.status === 200 ? r.body : null;
      },
      async requestApproval() {
        throw new Error('unused');
      },
      async consumeApproval() {
        return false;
      },
      async ledger(ev) {
        // Stamp simulated clock on test ledger events when advancing UTC days
        await api('/api/v1/ledger', 'POST', TOKENS.egress, { timestamp: new Date(clock).toISOString(), ...ev });
      },
      async modelCatalog() {
        const r = await api('/api/v1/models/internal/catalog', 'GET', TOKENS.egress);
        return { catalog: r.body.models ?? {}, default: r.body.default ?? undefined };
      },
      async modelFailover(req) {
        const r = await api(`/api/v1/gatekeeper-egress/runs/${encodeURIComponent(req.runId)}/failover`, 'POST', TOKENS.egress, req);
        return r.body;
      },
      async subscriptionToken(req) {
        const r = await api('/api/v1/gatekeeper-egress/subscriptions/token', 'POST', TOKENS.egress, {
          connection: req.connection,
          id: req.connection,
          ...(req.invalidate ? { invalidate: true } : {}),
        });
        if (r.status === 200) {
          return {
            ok: true,
            accessToken: r.body.accessToken,
            templateId: r.body.templateId,
            ...(r.body.accountId ? { accountId: r.body.accountId } : {}),
          };
        }
        if (r.status === 428) return { ok: false, kind: 'needs_reconsent', reason: r.body?.reason };
        return { ok: false, kind: 'unavailable', message: r.body?.error };
      },
      async subscriptionWindows() {
        const r = await api('/api/v1/gatekeeper-egress/subscription-windows', 'GET', TOKENS.egress);
        return {
          windows: (r.body.windows ?? []) as LimitWindowView[],
          caps: (r.body.caps ?? []) as SubscriptionCapView[],
        };
      },
      async subscriptionWindow(req) {
        const { connection, ...rest } = req;
        const r = await api(`/api/v1/gatekeeper-egress/subscription-windows/${encodeURIComponent(connection)}`, 'PUT', TOKENS.egress, rest);
        return r.body;
      },
      async getRunModels({ runId, runToken }) {
        const res = await fetch(`http://127.0.0.1:${cpPort}/api/v1/runs/${encodeURIComponent(runId)}/models`, {
          headers: { authorization: `Bearer ${runToken}` },
        });
        return res.ok ? ((await res.json()) as never) : undefined;
      },
    };

    gk = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: state.runTokens!,
      control,
      providers: [],
      contextTtlMs: 0,
      routeRefreshIntervalMs: 0,
      eagerCatalogRefresh: true,
      subscriptionProbeIntervalMs: 0,
      subscriptionWindowCacheMs: 0,
      defaultModel: 'api-fallback',
      modelAdapters: {
        mock: {
          async complete() {
            apiFallbackCalls++;
            return { content: 'from api-fallback', finishReason: 'stop', usage: { input: 8, output: 4 } };
          },
        },
      },
      modelFetch: vendorFetch,
      now: () => clock,
      version: state.version,
      serviceToken: TOKENS.egress,
    });
    gkPort = await listen(gk);
    state.gatekeeperEgressUrl = `http://127.0.0.1:${gkPort}`;
  });

  after(async () => {
    await settle();
    gk.closeAllConnections?.();
    cp.closeAllConnections?.();
    await new Promise<void>((r) => gk.close(() => r()));
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  let factoryXaiConnId = '';
  let factoryOpenAiConnId = '';
  let daleConnId = '';
  let bobConnId = '';

  it('1. M5(1), (4), (4a): connect runs discovery without adding models automatically; owner manages personal BYOM at immutable $0; visibility & dynamic connection names update everywhere', async () => {
    // Seed personal agents for Dale and Bob, plus a team agent
    state.agents.set('dale-personal', makeAgent('dale-personal', 'Dale Assistant', 'personal'));
    state.agents.set('dale-personal-2', makeAgent('dale-personal-2', 'Dale Second', 'personal'));
    state.agents.set('bob-personal', makeAgent('bob-personal', 'Bob Assistant', 'personal'));
    state.agents.set('team-ops', makeAgent('team-ops', 'Team Ops', 'team', { accountableLead: 'user:admin' }));

    await state.grants!.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants!.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-personal-2' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants!.grant({ subject: 'user:bob', scope: { kind: 'agent', id: 'bob-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants!.grant({ subject: 'user:admin', scope: { kind: 'agent', id: 'team-ops' }, role: 'accountable-lead', by: 'user:admin', granterIsAdmin: true });

    // Connect factory OpenAI + factory xAI + Dale personal xAI + Bob personal xAI
    const fOpenAi = await connectSubscription({
      token: TOKENS.admin,
      templateId: 'openai-subscription',
      scope: 'factory',
      name: 'Team ChatGPT',
      account: { sub: 'oa-team', email: 'team@sackrider.org', name: 'Team', acct: 'acct-team', tier: 'pro' },
    });
    factoryOpenAiConnId = fOpenAi.id;
    assert.equal(fOpenAi.discovery?.status, 'ok', 'auto-discovery ran on connect');
    assert.deepEqual(fOpenAi.discoveredModels?.map((m: any) => m.id), ['gpt-5-codex', 'gpt-5-mini']);

    const fXai = await connectSubscription({
      token: TOKENS.admin,
      templateId: 'xai-subscription',
      scope: 'factory',
      name: 'Team Grok',
      account: { sub: 'xai-team', email: 'xai-team@sackrider.org', name: 'Team' },
    });
    factoryXaiConnId = fXai.id;

    const dXai = await connectSubscription({
      token: TOKENS.dale,
      templateId: 'xai-subscription',
      scope: 'personal',
      name: "Dale's Grok",
      account: { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' },
    });
    daleConnId = dXai.id;
    assert.equal(dXai.scope, 'personal');
    assert.equal(dXai.ownerPrincipalId, 'user:dale');
    assert.equal(dXai.discovery?.status, 'ok');

    const bXai = await connectSubscription({
      token: TOKENS.bob,
      templateId: 'xai-subscription',
      scope: 'personal',
      name: "Bob's Grok",
      account: { sub: 'xai-bob', email: 'bob@sackrider.org', name: 'Bob' },
    });
    bobConnId = bXai.id;

    // Nothing was added automatically to the model catalog on connect!
    assert.deepEqual(
      state.modelStore!.listOffered().map((m) => m.name).sort(),
      ['api-fallback', 'unpriced-api'],
    );

    // Admin adds factory subscription entries: unset price is refused at egress as unpriced_model until priced; explicit $0 is allowed!
    const unpricedFactoryAdmit = await api(`/api/v1/subscriptions/${factoryOpenAiConnId}/models`, 'POST', TOKENS.admin, {
      name: 'gpt-5-mini-unpriced',
      id: 'gpt-5-mini',
    });
    assert.equal(unpricedFactoryAdmit.status, 201, unpricedFactoryAdmit.text);
    assert.equal(unpricedFactoryAdmit.body.model.price, undefined);

    const unlistedModel = await api(`/api/v1/subscriptions/${factoryOpenAiConnId}/models`, 'POST', TOKENS.admin, {
      name: 'gpt-5-codex-team',
      id: 'gpt-nonexistent',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    assert.equal(unlistedModel.status, 422);
    assert.equal(unlistedModel.body.error, 'model_not_in_subscription_plan');

    const factoryAdmit = await api(`/api/v1/subscriptions/${factoryOpenAiConnId}/models`, 'POST', TOKENS.admin, {
      name: 'gpt-5-codex-team',
      id: 'gpt-5-codex',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    assert.equal(factoryAdmit.status, 201, factoryAdmit.text);
    assert.equal(factoryAdmit.body.model.connection, factoryOpenAiConnId, 'connection id stored, never connection name');
    assert.equal(factoryAdmit.body.model.scope, 'factory');

    // Admin also admits an API-key grok-4.6 so neutral catalog names distinguish API vs personal subscription
    const apiGrok = await api('/api/v1/models/admit', 'POST', TOKENS.admin, {
      name: 'grok-4.6',
      id: 'grok-4.6',
      vendorId: 'xai',
      price: { inputPerMTok: 2, outputPerMTok: 10 },
    });
    assert.equal(apiGrok.status, 201, apiGrok.text);

    // Dale (viewer, no models.manage!) cannot admit on factory connection or Bob's personal connection
    assert.equal(
      (await api(`/api/v1/subscriptions/${factoryOpenAiConnId}/models`, 'POST', TOKENS.dale, { name: 'x', id: 'gpt-5-codex' })).status,
      403,
    );
    assert.equal(
      (await api(`/api/v1/subscriptions/${bobConnId}/models`, 'POST', TOKENS.dale, { name: 'x', id: 'grok-4.6' })).status,
      404,
    );

    // Non-zero price on personal BYOM is refused; duplicate catalog name ('grok-4.6') is refused 409
    const nonZeroPersonal = await api(`/api/v1/subscriptions/${daleConnId}/models`, 'POST', TOKENS.dale, {
      name: 'grok-4.6-dale-sub',
      id: 'grok-4.6',
      price: { inputPerMTok: 1, outputPerMTok: 1 },
    });
    assert.equal(nonZeroPersonal.status, 400);
    assert.equal(nonZeroPersonal.body.error, 'personal_model_price_immutable');

    const clashName = await api(`/api/v1/subscriptions/${daleConnId}/models`, 'POST', TOKENS.dale, {
      name: 'grok-4.6',
      id: 'grok-4.6',
    });
    assert.equal(clashName.status, 409);
    assert.equal(clashName.body.error, 'model_name_taken');

    // Dale admits personal BYOM via /api/v1/subscriptions/:id/models AND /api/v1/models/admit without models.manage
    const daleAdmit1 = await api(`/api/v1/subscriptions/${daleConnId}/models`, 'POST', TOKENS.dale, {
      name: 'grok-4.6-dale-sub',
      id: 'grok-4.6',
    });
    assert.equal(daleAdmit1.status, 201, daleAdmit1.text);
    assert.deepEqual(daleAdmit1.body.model.price, { inputPerMTok: 0, outputPerMTok: 0 });
    assert.equal(daleAdmit1.body.model.credentialMode, 'subscription');
    assert.equal(daleAdmit1.body.model.scope, 'personal');
    assert.equal(daleAdmit1.body.model.ownerPrincipalId, 'user:dale');
    assert.equal(daleAdmit1.body.model.connection, daleConnId);
    assert.equal(daleAdmit1.body.model.displayLabel, "grok-4.6 · Dale's Grok");

    const daleAdmit2 = await api('/api/v1/models/admit', 'POST', TOKENS.dale, {
      connection: daleConnId,
      name: 'grok-3-mini-dale-sub',
      id: 'grok-3-mini',
    });
    assert.equal(daleAdmit2.status, 201, daleAdmit2.text);

    // Bob admits his own personal BYOM entry
    const bobAdmit = await api(`/api/v1/subscriptions/${bobConnId}/models`, 'POST', TOKENS.bob, {
      name: 'grok-4.6-bob-sub',
      id: 'grok-4.6',
    });
    assert.equal(bobAdmit.status, 201, bobAdmit.text);

    // Admin CANNOT change pricing on a personal BYOM entry (immutable $0!)
    const mutatePersonalPrice = await api('/api/v1/models/grok-4.6-dale-sub/pricing', 'PUT', TOKENS.admin, {
      price: { inputPerMTok: 1, outputPerMTok: 2 },
    });
    assert.equal(mutatePersonalPrice.status, 403);
    assert.equal(mutatePersonalPrice.body.error, 'personal_model_price_immutable');

    // Visibility isolation on GET /api/v1/models & MCP list_model_catalog:
    // - Dale sees factory entries + grok-4.6-dale-sub, NEVER grok-4.6-bob-sub
    // - Bob sees factory entries + grok-4.6-bob-sub, NEVER grok-4.6-dale-sub
    // - Carol (viewer with no personal BYOM) sees ONLY factory/API entries
    // - Admin sees ALL entries for fleet audit/ops
    const daleList = await api('/api/v1/models', 'GET', TOKENS.dale);
    const daleNames = daleList.body.models.map((m: any) => m.name);
    assert.equal(daleNames.includes('grok-4.6-dale-sub'), true);
    assert.equal(daleNames.includes('gpt-5-codex-team'), true);
    assert.equal(daleNames.includes('grok-4.6'), true);
    assert.equal(daleNames.includes('grok-4.6-bob-sub'), false);
    assert.equal(
      daleList.body.models.find((m: any) => m.name === 'grok-4.6').displayLabel,
      'grok-4.6 · xAI API',
    );

    const carolList = await api('/api/v1/models', 'GET', TOKENS.carol);
    const carolNames = carolList.body.models.map((m: any) => m.name);
    assert.equal(carolNames.includes('grok-4.6-dale-sub'), false);
    assert.equal(carolNames.includes('grok-4.6-bob-sub'), false);
    assert.equal(carolNames.includes('gpt-5-codex-team'), true);

    const adminList = await api('/api/v1/models', 'GET', TOKENS.admin);
    const adminNames = adminList.body.models.map((m: any) => m.name);
    assert.equal(adminNames.includes('grok-4.6-dale-sub'), true);
    assert.equal(adminNames.includes('grok-4.6-bob-sub'), true);

    const daleMcpCatalog = await mcpCall(TOKENS.dale, 'list_model_catalog');
    assert.equal(daleMcpCatalog.data.offered.some((m: any) => m.name === 'grok-4.6-dale-sub'), true);
    assert.equal(daleMcpCatalog.data.offered.some((m: any) => m.name === 'grok-4.6-bob-sub'), false);

    // Approve grok-4.6-dale-sub + gpt-5-codex-team + api-fallback on dale-personal
    const setPol = await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'grok-3-mini-dale-sub', 'gpt-5-codex-team', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'gpt-5-codex-team',
      secondaryModel: 'api-fallback',
    });
    assert.equal(setPol.status, 200, setPol.text);

    // Rename Dale's connection via PATCH /api/v1/subscriptions/:id -> dynamically updates displayLabel on EVERY model-listing surface!
    const renamed = await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, {
      name: "Dale's SuperGrok",
    });
    assert.equal(renamed.status, 200, renamed.text);

    const afterRenameModels = await api('/api/v1/models', 'GET', TOKENS.dale);
    const daleEntryRest = afterRenameModels.body.models.find((m: any) => m.name === 'grok-4.6-dale-sub');
    assert.equal(daleEntryRest.connectionName, "Dale's SuperGrok");
    assert.equal(daleEntryRest.displayLabel, "grok-4.6 · Dale's SuperGrok");

    const agentModelsRes = await api('/api/v1/agents/dale-personal/models', 'GET', TOKENS.dale);
    assert.equal(agentModelsRes.status, 200);
    assert.equal(
      agentModelsRes.body.models.find((m: any) => m.name === 'grok-4.6-dale-sub').displayLabel,
      "grok-4.6 · Dale's SuperGrok",
    );

    const mcpAgentModels = await mcpCall(TOKENS.dale, 'get_agent_models', { id: 'dale-personal' });
    assert.equal(
      mcpAgentModels.data.models.find((m: any) => m.name === 'grok-4.6-dale-sub').displayLabel,
      "grok-4.6 · Dale's SuperGrok",
    );

    // Run models + run-token MCP + egress GET /models/v1/models + egress factory_get_models tool call
    // M5(1), TSK-330: Agent-facing surfaces expose ONLY presentation fields, never internal catalog/credential fields.
    const assertAgentModelStripped = (m: Record<string, unknown>, surface: string) => {
      assert.equal(m.subscription, true, `${surface}: subscription`);
      assert.equal(m.connectionName, "Dale's SuperGrok", `${surface}: connectionName`);
      assert.equal(m.displayLabel, "grok-4.6 · Dale's SuperGrok", `${surface}: displayLabel`);
      for (const forbidden of [
        'credentialMode',
        'connection',
        'scope',
        'ownerPrincipalId',
        'templateId',
        'dailyTokenCap',
        'price',
        'endpoint',
        'vendorId',
        'provider',
        'admittedBy',
        'admittedAt',
      ]) {
        assert.equal(m[forbidden], undefined, `${surface} must not leak ${forbidden}`);
      }
    };

    const run = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const runToken = await state.runTokens!.mint({ runId: run.runId, agentId: 'dale-personal' });

    const runModelsRes = await fetch(`http://127.0.0.1:${cpPort}/api/v1/runs/${run.runId}/models`, {
      headers: { authorization: `Bearer ${runToken}` },
    });
    const runModelsBody = (await runModelsRes.json()) as any;
    assertAgentModelStripped(
      runModelsBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'GET /api/v1/runs/:id/models',
    );

    const runSwitchRes = await fetch(`http://127.0.0.1:${cpPort}/api/v1/runs/${run.runId}/models`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentModel: 'grok-4.6-dale-sub' }),
    });
    assert.equal(runSwitchRes.status, 200);
    const runSwitchBody = (await runSwitchRes.json()) as any;
    assertAgentModelStripped(
      runSwitchBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'PUT /api/v1/runs/:id/models',
    );

    const runMcpGetRes = await fetch(`http://127.0.0.1:${cpPort}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_agent_models', arguments: {} } }),
    });
    const runMcpGetBody = JSON.parse(((await runMcpGetRes.json()) as any).result.content[0].text);
    assertAgentModelStripped(
      runMcpGetBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'run-token MCP get_agent_models',
    );

    const runMcpSetRes = await fetch(`http://127.0.0.1:${cpPort}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'set_agent_models', arguments: { currentModel: 'grok-4.6-dale-sub' } },
      }),
    });
    const runMcpSetBody = JSON.parse(((await runMcpSetRes.json()) as any).result.content[0].text);
    assertAgentModelStripped(
      runMcpSetBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'run-token MCP set_agent_models',
    );

    const egressModelsRes = await fetch(`http://127.0.0.1:${gkPort}/models/v1/models`, {
      headers: { authorization: `Bearer ${runToken}` },
    });
    const egressModelsBody = (await egressModelsRes.json()) as any;
    assertAgentModelStripped(
      egressModelsBody.data.find((m: any) => m.id === 'grok-4.6-dale-sub'),
      'egress GET /models/v1/models',
    );

    // Trigger factory_get_models inside egress chat loop and verify tool output carries renamed displayLabel without internal fields
    let capturedToolResult: any;
    let roundCount = 0;
    responsesReply = (_url, body) => {
      if (roundCount++ === 0) {
        return sseOk('', 5, 3, [{ type: 'function_call', call_id: 'call_fgm', name: 'factory_get_models', arguments: '{}' }]);
      }
      const toolOutputItem = (body?.input ?? []).find((it: any) => it.type === 'function_call_output' && it.call_id === 'call_fgm');
      capturedToolResult = toolOutputItem ? JSON.parse(toolOutputItem.output) : undefined;
      return sseOk('models checked');
    };
    const fgmChat = await chat(runToken);
    assert.equal(fgmChat.status, 200, fgmChat.text);
    assertAgentModelStripped(
      capturedToolResult?.models?.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'egress factory_get_models',
    );
    responsesReply = () => sseOk('hello from subscription');
    state.runs.update(run.runId, { state: 'DONE' });
  });

  it('2. M5(2), (4), (4a): discovery triggers (explicit, reconnect, timer), no_model_list/vendor_refused/failed retire nothing & allow explicit modelId, and successful drop/disconnect/vendor-withdrawal run M2 retirements', async () => {
    // Authorization on POST /api/v1/subscriptions/:id/discover (non-admin gets 404 on factory or another user's connection)
    assert.equal((await api(`/api/v1/subscriptions/${factoryXaiConnId}/discover`, 'POST', TOKENS.dale)).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.bob)).status, 404);

    // Vendor returns 403 (vendor_refused) -> retires NOTHING on Dale's connection, and allows explicit modelId admit!
    xaiModelsReply = () => j(403, { error: 'forbidden' });
    const refusedDisc = await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.dale);
    assert.equal(refusedDisc.status, 200, refusedDisc.text);
    assert.equal(refusedDisc.body.listAvailable, false);
    assert.equal(refusedDisc.body.reason, 'vendor_refused');
    assert.equal(refusedDisc.body.entriesRetired, 0);
    assert.ok(state.modelStore!.getOffered('grok-4.6-dale-sub'), 'vendor_refused retired nothing');

    const explicitAdmit = await api(`/api/v1/subscriptions/${daleConnId}/models`, 'POST', TOKENS.dale, {
      name: 'grok-custom-dale',
      id: 'grok-4-heavy',
    });
    assert.equal(explicitAdmit.status, 201, explicitAdmit.text);

    // Vendor returns 503 (failed fetch) -> retires NOTHING!
    xaiModelsReply = () => j(503, { error: 'unavailable' });
    const failedDisc = await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.dale);
    assert.equal(failedDisc.status, 502);
    assert.ok(state.modelStore!.getOffered('grok-custom-dale'), 'failed discovery retired nothing');

    // Vendor returns empty list (no_model_list) -> retires NOTHING!
    xaiModelsReply = () => j(200, { data: [] });
    const emptyDisc = await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.dale);
    assert.equal(emptyDisc.status, 200);
    assert.equal(emptyDisc.body.listAvailable, false);
    assert.equal(emptyDisc.body.reason, 'no_model_list');
    assert.ok(state.modelStore!.getOffered('grok-custom-dale'), 'no_model_list retired nothing');

    // Approve grok-custom-dale as currentModel on dale-personal-2, then successful discovery drops grok-4-heavy -> retires grok-custom-dale + runs M2 transition + POLICY_UPDATED!
    await api('/api/v1/agents/dale-personal-2/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-custom-dale', 'grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-custom-dale',
      primaryModel: 'grok-4.6-dale-sub',
      secondaryModel: 'api-fallback',
    });
    const polUpdatesBefore = state.ledger.query().filter((e) => e.action === 'POLICY_UPDATED' && e.agentId === 'dale-personal-2').length;

    xaiModelsReply = () => j(200, { data: [{ id: 'grok-4.6' }, { id: 'grok-3-mini' }] });
    const dropDisc = await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.dale);
    assert.equal(dropDisc.status, 200, dropDisc.text);
    assert.equal(dropDisc.body.entriesRetired, 1);
    assert.equal(state.modelStore!.getOffered('grok-custom-dale'), undefined);
    assert.ok(state.modelStore!.getOffered('grok-4.6-dale-sub'), 'remaining vendor model kept');
    const polAfterDrop = state.policies.get('dale-personal-2')!;
    assert.equal(polAfterDrop.models?.includes('grok-custom-dale'), false);
    assert.equal(polAfterDrop.currentModel, 'grok-4.6-dale-sub', 'M2 Case B promoted primaryModel to currentModel');
    const polUpdatesAfter = state.ledger.query().filter((e) => e.action === 'POLICY_UPDATED' && e.agentId === 'dale-personal-2').length;
    assert.equal(polUpdatesAfter, polUpdatesBefore + 1);

    // Owner retires grok-3-mini-dale-sub via DELETE /api/v1/subscriptions/:id/models/:model (and cannot retire factory entry)
    assert.equal((await api('/api/v1/models/gpt-5-codex-team', 'DELETE', TOKENS.dale)).status, 403);
    const ownerRetire = await api(`/api/v1/subscriptions/${daleConnId}/models/grok-3-mini-dale-sub`, 'DELETE', TOKENS.dale);
    assert.equal(ownerRetire.status, 200, ownerRetire.text);
    assert.equal(state.modelStore!.getOffered('grok-3-mini-dale-sub'), undefined);

    // Reconnect triggers discovery automatically; timer also triggers discovery
    signInAccount = { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' };
    const reconStart = await api(`/api/v1/subscriptions/${daleConnId}/reconnect`, 'POST', TOKENS.dale, { subscriberAttested: true });
    assert.equal(reconStart.status, 201);
    clock += 6000;
    const reconDone = await api(`/api/v1/subscriptions/sign-ins/${reconStart.body.signIn.signInId}`, 'GET', TOKENS.dale);
    assert.equal(reconDone.body.status, 'connected');
    assert.equal(reconDone.body.connection.discovery?.status, 'ok');

    let timerCalls = 0;
    const origXaiReply = xaiModelsReply;
    xaiModelsReply = () => {
      timerCalls++;
      return origXaiReply();
    };
    const discTimer = startSubscriptionDiscoveryTimer(state, 25);
    await new Promise((r) => setTimeout(r, 70));
    if (discTimer) clearInterval(discTimer);
    xaiModelsReply = origXaiReply;
    assert.ok(timerCalls >= 1, 'periodic discovery timer invoked discovery');

    // Disconnect factoryXaiConnId after admitting an entry -> retires its entries + M2 transitions
    await api(`/api/v1/subscriptions/${factoryXaiConnId}/models`, 'POST', TOKENS.admin, {
      name: 'grok-4.6-team-sub',
      id: 'grok-4.6',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    await api('/api/v1/agents/team-ops/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-team-sub', 'gpt-5-codex-team'],
      currentModel: 'grok-4.6-team-sub',
      primaryModel: 'gpt-5-codex-team',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
    const discRes = await api(`/api/v1/subscriptions/${factoryXaiConnId}`, 'DELETE', TOKENS.admin);
    assert.equal(discRes.status, 200, discRes.text);
    assert.equal(discRes.body.entriesRetired, 1);
    assert.equal(state.modelStore!.getOffered('grok-4.6-team-sub'), undefined);
    assert.equal(state.policies.get('team-ops')!.currentModel, 'gpt-5-codex-team');
  });

  it('3. M5(1) D24, D15 & S24: refuses personal BYOM on team agents, non-owner agents (even by Admin!), skills, subagents & training; auto-detaches on D15 ownership changes', async () => {
    // D24: refuse attaching Dale's personal BYOM to team-ops (even by Factory Admin!)
    const teamPol = await api('/api/v1/agents/team-ops/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'gpt-5-codex-team'],
    });
    assert.equal(teamPol.status, 403);
    assert.equal(teamPol.body.error, 'personal_model_team_forbidden');

    // Non-matching owner: refuse attaching Dale's personal BYOM to bob-personal (even by Factory Admin!) across policy, models, wake pin, and MCP
    const mismatchPol = await api('/api/v1/agents/bob-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub'],
    });
    assert.equal(mismatchPol.status, 403);
    assert.equal(mismatchPol.body.error, 'personal_model_owner_mismatch');

    await api('/api/v1/agents/bob-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-bob-sub', 'api-fallback'],
      currentModel: 'grok-4.6-bob-sub',
      primaryModel: 'api-fallback',
    });

    const mismatchWakePin = await api('/api/v1/agents/bob-personal/wake', 'POST', TOKENS.admin, {
      model: 'grok-4.6-dale-sub',
    });
    assert.equal(mismatchWakePin.status, 403);
    assert.equal(mismatchWakePin.body.error, 'personal_model_owner_mismatch');

    const mismatchMcp = await mcpCall(TOKENS.admin, 'set_agent_models', {
      id: 'bob-personal',
      currentModel: 'grok-4.6-dale-sub',
    });
    assert.equal(mismatchMcp.data?.error, 'personal_model_owner_mismatch');

    // S24: refuse binding personal BYOM to a skill (even when Dale owns the skill!)
    skillRegistry(state).save({
      id: 'dale-skill',
      version: '1.0.0',
      repo: 'https://github.com/BeerCanLabs/dale-skill',
      path: '.',
      commit: SHA,
      manifest: { id: 'dale-skill', version: '1.0.0', name: 'dale-skill', description: 'd', language: 'python', entry: 'main', requires: { routes: [] } },
      status: 'approved',
      tests: 'passed',
      registeredBy: 'user:dale',
      registeredAt: new Date(clock).toISOString(),
      owner: 'user:dale',
    } as never);
    await state.grants!.grant({ subject: 'user:dale', scope: { kind: 'skill', id: 'dale-skill' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });

    const s24Denied = await api('/api/v1/skills/dale-skill/model', 'PUT', TOKENS.dale, { model: 'grok-4.6-dale-sub' });
    assert.equal(s24Denied.status, 403);
    assert.equal(s24Denied.body.error, 'personal_model_skill_forbidden');

    // Skill training run: Bob cannot request Dale's personal BYOM on skill training
    skillRegistry(state).save({
      id: 'bob-skill',
      version: '1.0.0',
      repo: 'https://github.com/BeerCanLabs/bob-skill',
      path: '.',
      commit: SHA,
      manifest: { id: 'bob-skill', version: '1.0.0', name: 'bob-skill', description: 'd', language: 'python', entry: 'main', requires: { routes: [] } },
      status: 'approved',
      tests: 'passed',
      registeredBy: 'user:bob',
      registeredAt: new Date(clock).toISOString(),
      owner: 'user:bob',
    } as never);
    await state.grants!.grant({ subject: 'user:bob', scope: { kind: 'skill', id: 'bob-skill' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    const badTraining = await api('/api/v1/skills/bob-skill/training-runs', 'POST', TOKENS.bob, {
      models: ['grok-4.6-dale-sub'],
      capUsd: 5,
    });
    assert.equal(badTraining.status, 403);

    // D15 Auto-detach 1: Transfer ownership of dale-personal-2 from user:dale to user:carol -> auto-detaches grok-4.6-dale-sub with M2 transition + POLICY_UPDATED,
    // while preserving an active pinned run's `run.model` untouched so egress fails closed (403)!
    assert.equal(state.policies.get('dale-personal-2')!.models?.includes('grok-4.6-dale-sub'), true);
    const pinnedTransferRun = state.runs.create({
      agentId: 'dale-personal-2',
      state: 'WORKING',
      model: 'grok-4.6-dale-sub',
      actor: 'user:dale',
      trigger: 'manual',
    } as never);
    const pinnedTransferTok = await state.runTokens!.mint({ runId: pinnedTransferRun.runId, agentId: 'dale-personal-2' });

    const offerRes = await api('/api/v1/agents/dale-personal-2/transfer', 'POST', TOKENS.dale, {
      to: 'user:carol',
    });
    assert.equal(offerRes.status, 202, offerRes.text);
    const acceptRes = await api('/api/v1/agents/dale-personal-2/transfer/accept', 'POST', TOKENS.carol, {});
    assert.equal(acceptRes.status, 200, acceptRes.text);

    const afterTransferPol = state.policies.get('dale-personal-2')!;
    assert.equal(afterTransferPol.models?.includes('grok-4.6-dale-sub'), false, 'outgoing owner personal BYOM auto-detached on transfer');
    assert.equal(afterTransferPol.currentModel, 'api-fallback', 'M2 promoted secondaryModel to currentModel');
    assert.equal(
      state.runs.get(pinnedTransferRun.runId)!.model,
      'grok-4.6-dale-sub',
      'explicitly pinned run.model is never substituted on personal BYOM detachment',
    );
    const pinnedAfterDetach = await chat(pinnedTransferTok);
    assert.equal(pinnedAfterDetach.status, 403, 'pinned run fails closed (403) at egress after personal BYOM detachment');
    state.runs.update(pinnedTransferRun.runId, { state: 'DONE' });

    // D15 Auto-detach 2: Revoking Bob's grant on bob-personal auto-detaches grok-4.6-bob-sub + ledgers POLICY_UPDATED!
    const bobGrant = state.grants!.list({ scopeKind: 'agent', scopeId: 'bob-personal' }).find((g) => g.subject === 'user:bob')!;
    assert.equal(state.policies.get('bob-personal')!.models?.includes('grok-4.6-bob-sub'), true);
    const revokeRes = await api(`/api/v1/grants/${bobGrant.id}`, 'DELETE', TOKENS.admin);
    assert.equal(revokeRes.status, 200, revokeRes.text);
    assert.equal(state.policies.get('bob-personal')!.models?.includes('grok-4.6-bob-sub'), false, 'personal BYOM auto-detached on grant revoke');
    assert.equal(state.policies.get('bob-personal')!.currentModel, 'api-fallback');

    // Restore Bob's ownership & BYOM on bob-personal, then trigger pending-revoked via /api/v1/principals/user:bob/revoke-access -> auto-detaches!
    await state.grants!.grant({ subject: 'user:bob', scope: { kind: 'agent', id: 'bob-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await api('/api/v1/agents/bob-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-bob-sub', 'api-fallback'],
      currentModel: 'grok-4.6-bob-sub',
      primaryModel: 'api-fallback',
    });
    const revokeAccess = await api('/api/v1/principals/user:bob/revoke-access', 'POST', TOKENS.admin, {
      confirm: 'user:bob',
      reason: 'offboard test',
    });
    assert.equal(revokeAccess.status, 200, revokeAccess.text);
    assert.equal(
      state.policies.get('bob-personal')!.models?.includes('grok-4.6-bob-sub'),
      false,
      'personal BYOM auto-detached when owner enters D15 pending-revoked',
    );
  });

  it('4. M5(8), D25: unallocated personal agent evaluates to $0 ceiling ({ perDay: 0, perMonth: 0 }), wakes & converses & calls $0 BYOM, and fails closed 402 on >$0 fallback', async () => {
    // dale-personal has NO budgetUsd on policy and NO budget-owner allocation -> effective ceiling is { perDay: 0, perMonth: 0 }, NEVER undefined!
    const daleAgent = state.agents.get('dale-personal')!;
    assert.deepEqual(effectiveAgentBudgetUsd(state, daleAgent, true), { perDay: 0, perMonth: 0 });

    // Wake succeeds because currentModel ('grok-4.6-dale-sub') is $0-priced!
    const wakeOk = await api('/api/v1/agents/dale-personal/wake', 'POST', TOKENS.dale, { message: 'hello' });
    assert.equal(wakeOk.status, 202, wakeOk.text);
    const runId = wakeOk.body.runId as string;
    state.runs.update(runId, { state: 'WORKING' });
    const runToken = await state.runTokens!.mint({ runId, agentId: 'dale-personal' });

    // Conversation handoff into live run also succeeds at $0 ceiling!
    const convOk = await api('/api/v1/agents/dale-personal/conversation', 'POST', TOKENS.dale, {
      message: 'follow up',
    });
    assert.equal(convOk.status < 300, true, convOk.text);

    // Egress chat call succeeds on $0 BYOM entry!
    responsesReply = () => sseOk('zero-dollar BYOM reply', 10, 5);
    const chatOk = await chat(runToken);
    assert.equal(chatOk.status, 200, chatOk.text);
    assert.equal(chatOk.body.choices[0].message.content, 'zero-dollar BYOM reply');
    await settle();

    // Now set dale-personal's active model to >$0 'api-fallback' while keeping $0 ceiling -> wake, conversation, and egress ALL fail closed with 402!
    state.runs.update(runId, { state: 'DONE' });
    const switchedToPaid = await api('/api/v1/agents/dale-personal/models', 'PUT', TOKENS.dale, {
      currentModel: 'api-fallback',
      primaryModel: 'api-fallback',
      secondaryModel: null,
    });
    assert.equal(switchedToPaid.status, 200, switchedToPaid.text);

    const rPaid = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokPaid = await state.runTokens!.mint({ runId: rPaid.runId, agentId: 'dale-personal' });
    const egress402 = await chat(tokPaid);
    assert.equal(egress402.status, 402, egress402.text);
    state.runs.update(rPaid.runId, { state: 'DONE' });

    const wake402 = await api('/api/v1/agents/dale-personal/wake', 'POST', TOKENS.dale, { message: 'needs paid model' });
    assert.equal(wake402.status, 402, wake402.text);

    const conv402 = await api('/api/v1/agents/dale-personal/conversation', 'POST', TOKENS.dale, { message: 'needs paid model' });
    assert.equal(conv402.status, 402, conv402.text);

    // Unpriced API model in catalog is refused at egress as unpriced_model
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['unpriced-api'],
      currentModel: 'unpriced-api',
      budgetUsd: { perDay: 5, perMonth: 50 },
    });
    const rUnpriced = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokUnpriced = await state.runTokens!.mint({ runId: rUnpriced.runId, agentId: 'dale-personal' });
    const unpricedChat = await chat(tokUnpriced);
    assert.equal(unpricedChat.status, 403);
    assert.equal(unpricedChat.body.error, 'unpriced_model');
  });

  it('5. M5(6), (7), (8): per-agent daily token caps (durable + midnight UTC reset), deduplicated priced-fallback notices, and scoped vs admin subscription spend views', async () => {
    notices.length = 0;
    apiFallbackCalls = 0;

    // Give Dale ownership of a second personal agent ('dale-second') sharing daleConnId
    state.agents.set('dale-second', makeAgent('dale-second', 'Dale Second', 'personal'));
    await state.grants!.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-second' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });

    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
    await api('/api/v1/agents/dale-second/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
    });

    // Set per-agent dailyTokenCap = 50 on Dale's connection via PATCH /api/v1/subscriptions/:id
    // (dale-personal has used 24 + 15 = 39 tokens earlier today; dale-second has used 0)
    const capPatch = await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, {
      dailyTokenCap: 50,
    });
    assert.equal(capPatch.status, 200, capPatch.text);
    assert.equal(capPatch.body.connection.dailyTokenCap, 50);

    const run1 = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tok1 = await state.runTokens!.mint({ runId: run1.runId, agentId: 'dale-personal' });
    const run2 = state.runs.create({ agentId: 'dale-second', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tok2 = await state.runTokens!.mint({ runId: run2.runId, agentId: 'dale-second' });

    // Call 1 on dale-personal uses 15 + 10 = 25 tokens (total 39 + 25 = 64 >= 50) -> reaches dailyTokenCap and ledgers SUBSCRIPTION_CAP_REACHED naming dale-personal!
    responsesReply = () => sseOk('dale call 1', 15, 10);
    const c1 = await chat(tok1);
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c1.body.choices[0].message.content, 'dale call 1');
    await settle();

    const capReachedRows = state.ledger.query().filter((e) => e.action === 'SUBSCRIPTION_CAP_REACHED' && e.agentId === 'dale-personal');
    assert.equal(capReachedRows.length, 1);
    assert.equal(capReachedRows[0].connection, daleConnId);

    // Simulate control-plane restart by rebuilding SubscriptionCaps & SpendTracker from ledger -> cap persists!
    setSubscriptionCaps(state, new SubscriptionCaps(state, () => clock));
    state.spend = SpendTracker.fromLedger(state.ledger.query(), () => true);

    // Call 2 on dale-personal skips grok-4.6-dale-sub and falls back to >$0 api-fallback:
    // - currentModel stays 'grok-4.6-dale-sub'
    // - SUBSCRIPTION_PRICED_FALLBACK_NOTIFIED ledgered + notifier fired ONCE for this UTC day!
    const c2 = await chat(tok1);
    assert.equal(c2.status, 200, c2.text);
    assert.equal(c2.body.choices[0].message.content, 'from api-fallback');
    await settle();
    assert.equal(state.policies.get('dale-personal')!.currentModel, 'grok-4.6-dale-sub', 'currentModel unchanged on cap skip');

    const capNoticesAfterFirst = notices.filter((n) => n.kind === 'priced_fallback' && n.reason === 'subscription_cap_reached');
    assert.equal(capNoticesAfterFirst.length, 1);
    assert.ok(capNoticesAfterFirst[0].recipients.includes('user:dale'), 'agent owner notified of priced fallback');
    assert.ok(capNoticesAfterFirst[0].recipients.includes('user:admin'), 'factory admin notified when factory budget serves fallback');

    // Call 3 on dale-personal on same UTC day -> NO duplicate priced-fallback notice!
    const c3 = await chat(tok1);
    assert.equal(c3.status, 200);
    await settle();
    assert.equal(
      notices.filter((n) => n.kind === 'priced_fallback' && n.reason === 'subscription_cap_reached').length,
      1,
      'priced-fallback notification deduplicated once per UTC day per agent',
    );

    // Pinned run on dale-personal to grok-4.6-dale-sub -> 429 subscription_cap_reached!
    const pinnedRun = state.runs.create({
      agentId: 'dale-personal',
      state: 'WORKING',
      model: 'grok-4.6-dale-sub',
      actor: 'user:dale',
      trigger: 'manual',
    } as never);
    const pinnedTok = await state.runTokens!.mint({ runId: pinnedRun.runId, agentId: 'dale-personal' });
    const pinnedRes = await chat(pinnedTok);
    assert.equal(pinnedRes.status, 429);
    assert.equal(pinnedRes.body.error, 'subscription_cap_reached');

    // Meanwhile dale-second on the SAME connection is NOT capped and succeeds on $0 grok-4.6-dale-sub!
    responsesReply = () => sseOk('dale-second unaffected', 8, 4);
    const cSecond = await chat(tok2);
    assert.equal(cSecond.status, 200, cSecond.text);
    assert.equal(cSecond.body.choices[0].message.content, 'dale-second unaffected');
    await settle();

    // Priced-fallback notice on connection limit window (once per window, carrying resetAt):
    await api('/api/v1/agents/team-ops/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['gpt-5-codex-team', 'api-fallback'],
      currentModel: 'gpt-5-codex-team',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
    const teamRun = state.runs.create({ agentId: 'team-ops', state: 'WORKING', actor: 'user:admin', trigger: 'manual' } as never);
    const teamTok = await state.runTokens!.mint({ runId: teamRun.runId, agentId: 'team-ops' });
    const resetEpochSec = Math.floor((clock + 3600_000) / 1000);
    responsesReply = () =>
      j(429, { error: { type: 'usage_limit_reached', message: 'limit hit', resets_at: resetEpochSec } });
    const teamFallback1 = await chat(teamTok);
    assert.equal(teamFallback1.status, 200);
    assert.equal(teamFallback1.body.choices[0].message.content, 'from api-fallback');
    await settle();
    const teamFallback2 = await chat(teamTok);
    assert.equal(teamFallback2.status, 200);
    await settle();
    const windowNotices = notices.filter((n) => n.kind === 'priced_fallback' && n.reason === 'subscription_limit_reached');
    assert.equal(windowNotices.length, 1, 'priced-fallback notice sent once per limit window');
    assert.ok(windowNotices[0].resetAt, 'limit-window priced-fallback notice includes resetAt');

    //TPM throttle applies to $0 subscription entries too (M5(8)):
    await api('/api/v1/agents/dale-second/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub'],
      currentModel: 'grok-4.6-dale-sub',
      tokensPerMinute: 10,
    });
    const tpmRun = state.runs.create({ agentId: 'dale-second', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tpmTok = await state.runTokens!.mint({ runId: tpmRun.runId, agentId: 'dale-second' });
    responsesReply = () => sseOk('tpm call 1', 8, 4); // 12 tokens >= 10 TPM
    assert.equal((await chat(tpmTok)).status, 200);
    await settle();
    const tpmDenied = await chat(tpmTok);
    assert.equal(tpmDenied.status, 429);
    assert.equal(tpmDenied.body.error, 'throttled');

    // Priced-fallback notice on needs_reconsent (once per episode per agent):
    const reconFOpenAi = await connectSubscription({
      token: TOKENS.admin,
      templateId: 'openai-subscription',
      scope: 'factory',
      name: 'Team ChatGPT Backup',
      account: { sub: 'oa-team-2', email: 'team2@sackrider.org', name: 'Team2', acct: 'acct-team-2', tier: 'pro' },
    });
    await api(`/api/v1/subscriptions/${reconFOpenAi.id}/models`, 'POST', TOKENS.admin, {
      name: 'gpt-5-codex-backup',
      id: 'gpt-5-codex',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    await api('/api/v1/agents/team-ops/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['gpt-5-codex-backup', 'api-fallback'],
      currentModel: 'gpt-5-codex-backup',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
    const origRefresh = refreshHandler;
    refreshHandler = () => j(400, { error: 'invalid_grant' });
    responsesReply = () => j(401, { error: 'unauthorized' });
    const reconsentFb1 = await chat(teamTok);
    assert.equal(reconsentFb1.status, 200);
    assert.equal(reconsentFb1.body.choices[0].message.content, 'from api-fallback');
    await settle();
    const reconsentFb2 = await chat(teamTok);
    assert.equal(reconsentFb2.status, 200);
    await settle();
    refreshHandler = origRefresh;
    const reconsentNotices = notices.filter((n) => n.kind === 'priced_fallback' && n.reason === 'subscription_needs_reconsent');
    assert.equal(reconsentNotices.length, 1, 'priced-fallback notice sent once per needs_reconsent episode per agent');

    // Accountant spend views: GET /api/v1/spend, GET /api/v1/spend/report, and GET /api/v1/subscriptions/spend
    // Also record a subscription call on bob's connection so we can verify cross-owner isolation!
    await state.grants!.grant({ subject: 'user:carol', scope: { kind: 'agent', id: 'carol-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    state.agents.set('carol-personal', makeAgent('carol-personal', 'Carol', 'personal'));
    await api('/api/v1/ledger', 'POST', TOKENS.egress, {
      timestamp: new Date(clock).toISOString(),
      agentId: 'bob-personal',
      type: 'llm',
      model: 'grok-4.6-bob-sub',
      credentialMode: 'subscription',
      scope: 'personal',
      ownerPrincipalId: 'user:bob',
      connection: bobConnId,
      inputTokens: 300,
      outputTokens: 100,
      costUsd: 0,
    });

    const adminSubSpend = await api('/api/v1/subscriptions/spend', 'GET', TOKENS.admin);
    assert.equal(adminSubSpend.status, 200, adminSubSpend.text);
    assert.ok(adminSubSpend.body.connections[daleConnId], 'admin sees Dale personal connection tokens');
    assert.ok(adminSubSpend.body.connections[bobConnId], 'admin sees Bob personal connection tokens');
    assert.equal(adminSubSpend.body.connections[daleConnId].connectionName, "Dale's SuperGrok");
    assert.equal(adminSubSpend.body.connections[daleConnId].dailyTokenCap, 50);
    assert.equal(adminSubSpend.body.connections[daleConnId].day.totalTokens, 88); // 24 + 15 + 25 + 12 + 12

    const daleSubSpend = await api('/api/v1/subscriptions/spend', 'GET', TOKENS.dale);
    assert.equal(daleSubSpend.status, 200, daleSubSpend.text);
    assert.ok(daleSubSpend.body.connections[daleConnId], 'Dale sees own personal connection tokens');
    assert.equal(daleSubSpend.body.connections[bobConnId], undefined, 'Dale NEVER sees Bob personal connection tokens');
    assert.ok(daleSubSpend.body.agents['dale-personal'], 'Dale sees own agent subscription tokens');
    assert.equal(daleSubSpend.body.agents['bob-personal'], undefined, 'Dale NEVER sees Bob agent tokens');

    // GET /api/v1/spend separates priced USD spend from $0 subscription tokens
    const pricedSpend = await api('/api/v1/spend', 'GET', TOKENS.admin);
    assert.equal(pricedSpend.status, 200);
    assert.equal(pricedSpend.body.agents['dale-second'], undefined, '$0 subscription-only agent excluded from priced USD spend');
    assert.ok(pricedSpend.body.agents['dale-personal'].day.usd > 0, 'priced fallback USD spend tracked separately');
    assert.ok(pricedSpend.body.subscriptions?.connections?.[daleConnId], 'GET /api/v1/spend includes separate subscriptions breakdown');

    // Raise dailyTokenCap above dale-personal's usage (64 < 200) -> immediately emits SUBSCRIPTION_CAP_RESET with closedBy === 'cap_updated'!
    const raiseCapRes = await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, {
      dailyTokenCap: 200,
    });
    assert.equal(raiseCapRes.status, 200, raiseCapRes.text);
    const capUpdatedReset = state.ledger
      .query()
      .find((e) => e.action === 'SUBSCRIPTION_CAP_RESET' && e.agentId === 'dale-personal' && e.closedBy === 'cap_updated');
    assert.ok(capUpdatedReset, 'SUBSCRIPTION_CAP_RESET preserves closedBy: cap_updated in ledger');
    assert.equal(capUpdatedReset.closedBy, 'cap_updated');

    // Restore dailyTokenCap = 50 -> re-evaluates 64 >= 50 so cap is active again before midnight UTC reset test:
    const restoreCapRes = await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, {
      dailyTokenCap: 50,
    });
    assert.equal(restoreCapRes.status, 200, restoreCapRes.text);

    // Advance clock past midnight UTC -> SUBSCRIPTION_CAP_RESET (closedBy: 'reset') is ledgered naming dale-personal, and dale-personal serves grok-4.6-dale-sub again!
    clock = Date.parse(`${baseUtcDay}T00:00:00.000Z`) + 86_400_000 + 5 * 60_000;
    responsesReply = () => sseOk('back after midnight UTC', 6, 3);
    const afterMidnight = await chat(tok1);
    assert.equal(afterMidnight.status, 200, afterMidnight.text);
    assert.equal(afterMidnight.body.choices[0].message.content, 'back after midnight UTC');
    await settle();
    const resetRows = state.ledger.query().filter((e) => e.action === 'SUBSCRIPTION_CAP_RESET' && e.agentId === 'dale-personal');
    assert.equal(resetRows.length, 2);
    assert.equal(resetRows[0].closedBy, 'cap_updated');
    assert.equal(resetRows[1].closedBy, 'reset');

    // Finally, M5(2) vendor-permission-withdrawn helper retires all remaining xai-subscription entries with M2 transitions and disconnects xai grants!
    const withdrawn = await withdrawSubscriptionVendor(state, 'xai');
    assert.equal(withdrawn.vendor, 'xai');
    assert.equal(withdrawn.connectionsDisconnected, 2);
    assert.ok(withdrawn.entriesRetired >= 2);
    assert.equal(state.modelStore!.getOffered('grok-4.6-dale-sub'), undefined);
    assert.equal(state.modelStore!.getOffered('grok-4.6-bob-sub'), undefined);
    assert.equal(state.policies.get('dale-personal')!.currentModel, 'api-fallback');
    const withdrawnLedger = state.ledger.query().filter(
      (e) => e.action === 'SUBSCRIPTION_DISCONNECTED' && e.actor === 'migration:vendor-permission-withdrawn',
    );
    assert.ok(withdrawnLedger.length >= 2);

    // Zero secrets leaked anywhere in ledger!
    const ledgerDump = JSON.stringify(state.ledger.query());
    for (const sec of state.secretValues) {
      assert.equal(ledgerDump.includes(sec), false, 'OAuth token leaked to ledger');
    }
  });
});
