// DESIGN_AUTHORITY.md TSK-330 (§6.9 M5(1)–(8), §6.3.1 E5/E8, §6.11 K1–K5, §6.12 A1/A2, §6.10 LG1, S1, S20, S24, D15, D24, D25):
// Complete M5 + Owner BYOM conformance test suite asserting end-to-end against real
// createApp / createGatekeeperEgress / SubscriptionKeymaster / SUBSCRIPTION_TEMPLATES
// with zero mocks of the modules under test (fake upstream HTTP servers only).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
import { SpendTracker, ZERO_BUDGET_LIMITS, checkStanding, isZeroPrice } from '@beercanlabs/factory-budget';
import {
  FileConfigBackend,
  GroupStore,
  SkillModelBindingStore,
  VersionedConfigStore,
} from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import {
  createGatekeeperEgress,
  type ControlClient,
  type LimitWindowView,
  type SubscriptionCapView,
  type RunContext,
} from '@beercanlabs/factory-gatekeeper';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import {
  SUBSCRIPTION_TEMPLATES,
  subscriptionDefaultHeaders,
  validateSystemProposal,
  systemProposalSchema,
  systemDefinitionSchema,
} from '@beercanlabs/factory-contract';
import { repoRoot, read } from './support.js';

// Dynamically import control-plane composition members from built dist/
const appPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/app.js')).href;
const modelsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/models.js')).href;
const subsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/subscriptions.js')).href;
const capsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/subscription-caps.js')).href;
const windowsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/subscription-windows.js')).href;
const skillsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/skills.js')).href;
const skillModelsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/skill-models.js')).href;
const submissionsPath = pathToFileURL(join(repoRoot, 'packages/control-plane/dist/submissions.js')).href;

const { createFactoryServer, effectiveAgentBudgetUsd } = (await import(appPath)) as {
  createFactoryServer: (state: any) => http.Server;
  effectiveAgentBudgetUsd: (state: any, agent: any, applyDefault?: boolean) => { perDay: number; perMonth: number };
};
const { ModelStore } = (await import(modelsPath)) as { ModelStore: any };
const { notifyNeedsReconsent, setSubscriptionNotifier, startSubscriptionDiscoveryTimer } = (await import(subsPath)) as {
  notifyNeedsReconsent: (state: any, ev: any) => void;
  setSubscriptionNotifier: (state: any, notifier: (n: any) => void) => void;
  startSubscriptionDiscoveryTimer: (state: any, intervalMs: number) => NodeJS.Timeout | undefined;
};
const { SubscriptionCaps, setSubscriptionCaps } = (await import(capsPath)) as {
  SubscriptionCaps: any;
  setSubscriptionCaps: (state: any, caps: any) => void;
};
const { SubscriptionWindows } = (await import(windowsPath)) as { SubscriptionWindows: any };
const { loadSkills, skillRegistry } = (await import(skillsPath)) as {
  loadSkills: (state: any, dir: string) => void;
  skillRegistry: (state: any) => any;
};
const { setSkillModelStore } = (await import(skillModelsPath)) as {
  setSkillModelStore: (state: any, store: any) => void;
};
const { createSubmission } = (await import(submissionsPath)) as {
  createSubmission: (state: any, input: any, actor: string) => Promise<any>;
};

const SHA = 'a'.repeat(40);
const RUN_KEY = 'conformance-m5-run-token-key-01234567890123456789'; // secret-scan:allow (test fixture)

const TOKENS = {
  admin: 'tok-m5-admin', // secret-scan:allow (test fixture)
  dale: 'tok-m5-dale', // secret-scan:allow (test fixture)
  bob: 'tok-m5-bob', // secret-scan:allow (test fixture)
  carol: 'tok-m5-carol', // secret-scan:allow (test fixture)
  egress: 'tok-m5-egress', // secret-scan:allow (test fixture)
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
    name: 'conformance-auth',
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

describe('M5 Conformance: Model Subscriptions & Owner BYOM', { concurrency: false }, () => {
  let dir: string;
  let cp: http.Server;
  let gk: http.Server;
  let cpPort = 0;
  let gkPort = 0;
  let state: any;
  const baseUtcDay = new Date().toISOString().slice(0, 10);
  let clock = Date.parse(`${baseUtcDay}T10:00:00.000Z`);
  const mem = new Map<string, string>();
  const provider: SecretProvider = {
    name: 'mem',
    get: async (k) => mem.get(k),
    put: async (k, v) => void mem.set(k, v),
  };
  const notices: any[] = [];
  const capturedUpstreamRequests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

  // Scriptable vendor behavior
  let signInAccount: { sub: string; email: string; name: string; acct?: string; tier?: string } = {
    sub: 'xai-team-1',
    email: 'ops@sackrider.org',
    name: 'Factory Ops',
  };
  let refreshHandler: (vendor: 'xai' | 'openai') => Response = (v) =>
    j(200, {
      access_token:
        v === 'openai'
          ? jwt({
              sub: signInAccount.sub,
              'https://api.openai.com/auth': {
                chatgpt_account_id: signInAccount.acct ?? 'acct-1',
                chatgpt_plan_type: signInAccount.tier ?? 'plus',
              },
            })
          : `${v}-refreshed-token-987654321`, // secret-scan:allow (test fixture)
      refresh_token: `${v}-refresh-next-${Math.random().toString(36).slice(2, 8)}`, // secret-scan:allow (test fixture)
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
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as Headers).forEach === 'function') {
        (init.headers as Headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v);
      }
    }
    const form = new URLSearchParams(bodyStr);
    let parsedBody: any;
    try {
      parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined;
    } catch {}

    capturedUpstreamRequests.push({ url, headers, body: parsedBody ?? bodyStr });

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
        access_token: `xai-access-${signInAccount.sub}-secret-token-1234`, // secret-scan:allow (test fixture)
        refresh_token: `xai-refresh-${signInAccount.sub}-secret-token-5678`, // secret-scan:allow (test fixture)
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
        refresh_token: `oa-refresh-${signInAccount.sub}-secret-token-9999`, // secret-scan:allow (test fixture)
        id_token: jwt(claims),
        expires_in: 3600,
      });
    }

    // Vendor model discovery
    if (url === 'https://api.x.ai/v1/models') return xaiModelsReply();
    if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) return openaiModelsReply();

    // Vendor Responses
    if (url === 'https://api.x.ai/v1/responses' || url === 'https://chatgpt.com/backend-api/codex/responses') {
      return responsesReply(url, parsedBody);
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

  const settle = () => new Promise((r) => setTimeout(r, 40));

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
    return polled.body.connection as {
      id: string;
      name: string;
      scope: string;
      ownerPrincipalId?: string;
      discoveredModels?: any[];
      discovery?: any;
    };
  };

  let factoryOpenAiConnId = '';
  let factoryXaiConnId = '';
  let daleConnId = '';
  let bobConnId = '';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-m5-conformance-'));
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
    identityLinks.link('discord', 'admin-discord', 'user:admin', 'setup', { name: 'Admin', roles: ['admin'] });
    identityLinks.link('discord', 'dale-discord', 'user:dale', 'setup', { name: 'Dale', roles: ['viewer'] });

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
      version: '1.2.3',
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
    };

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
      onNeedsReconsent: (ev: any) => notifyNeedsReconsent(state, ev),
    });
    setSubscriptionNotifier(state, (n: any) => void notices.push(n));
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
      routes: [
        { id: 'models', kind: 'models' },
        { id: 'anthropic-native', kind: 'llm', provider: 'anthropic', upstream: 'http://127.0.0.1:9' },
      ],
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

  it('M5(1), M5 lead-in, S1: Agent opacity — an agent never sees a subscription token or internal connection/credential fields across any surface', async () => {
    // Seed personal agents for Dale and a team agent
    state.agents.set('dale-personal', makeAgent('dale-personal', 'Dale Assistant', 'personal'));
    state.agents.set('dale-personal-2', makeAgent('dale-personal-2', 'Dale Second', 'personal'));
    state.agents.set('bob-personal', makeAgent('bob-personal', 'Bob Assistant', 'personal'));
    state.agents.set('team-ops', makeAgent('team-ops', 'Team Ops', 'team', { accountableLead: 'user:admin' }));

    await state.grants.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-personal-2' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants.grant({ subject: 'user:bob', scope: { kind: 'agent', id: 'bob-personal' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await state.grants.grant({ subject: 'user:admin', scope: { kind: 'agent', id: 'team-ops' }, role: 'accountable-lead', by: 'user:admin', granterIsAdmin: true });

    // Connect factory and personal subscriptions
    const fOpenAi = await connectSubscription({
      token: TOKENS.admin,
      templateId: 'openai-subscription',
      scope: 'factory',
      name: 'Team ChatGPT',
      account: { sub: 'oa-team', email: 'team@sackrider.org', name: 'Team', acct: 'acct-team', tier: 'pro' },
    });
    factoryOpenAiConnId = fOpenAi.id;

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

    const bXai = await connectSubscription({
      token: TOKENS.bob,
      templateId: 'xai-subscription',
      scope: 'personal',
      name: "Bob's Grok",
      account: { sub: 'xai-bob', email: 'bob@sackrider.org', name: 'Bob' },
    });
    bobConnId = bXai.id;

    // Admin admits factory subscription model and API model
    await api(`/api/v1/subscriptions/${factoryOpenAiConnId}/models`, 'POST', TOKENS.admin, {
      name: 'gpt-5-codex-team',
      id: 'gpt-5-codex',
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    await api('/api/v1/models/admit', 'POST', TOKENS.admin, {
      name: 'grok-4.6',
      id: 'grok-4.6',
      vendorId: 'xai',
      price: { inputPerMTok: 2, outputPerMTok: 10 },
    });

    // Dale admits personal BYOM model
    const daleAdmit = await api(`/api/v1/subscriptions/${daleConnId}/models`, 'POST', TOKENS.dale, {
      name: 'grok-4.6-dale-sub',
      id: 'grok-4.6',
    });
    assert.equal(daleAdmit.status, 201, daleAdmit.text);

    // Dale sets policy on dale-personal
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'gpt-5-codex-team', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'gpt-5-codex-team',
      secondaryModel: 'api-fallback',
    });

    // Rename Dale's connection -> displayLabel updates
    await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, {
      name: "Dale's SuperGrok",
    });

    // Agent opacity assertion: Presentation fields present, internal fields stripped
    const assertAgentModelStripped = (m: Record<string, unknown>, surface: string) => {
      assert.ok(m, `${surface}: model object must exist`);
      assert.equal(m.subscription, true, `${surface}: subscription marker`);
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
    const runToken = await state.runTokens.mint({ runId: run.runId, agentId: 'dale-personal' });

    // 1. GET /api/v1/runs/:id/models
    const runModelsRes = await fetch(`http://127.0.0.1:${cpPort}/api/v1/runs/${run.runId}/models`, {
      headers: { authorization: `Bearer ${runToken}` },
    });
    const runModelsBody = (await runModelsRes.json()) as any;
    assertAgentModelStripped(
      runModelsBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'GET /api/v1/runs/:id/models',
    );

    // 2. PUT /api/v1/runs/:id/models
    const runSwitchRes = await fetch(`http://127.0.0.1:${cpPort}/api/v1/runs/${run.runId}/models`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentModel: 'grok-4.6-dale-sub' }),
    });
    const runSwitchBody = (await runSwitchRes.json()) as any;
    assertAgentModelStripped(
      runSwitchBody.models.find((m: any) => m.name === 'grok-4.6-dale-sub'),
      'PUT /api/v1/runs/:id/models',
    );

    // 3. run-token MCP get_agent_models
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

    // 4. run-token MCP set_agent_models
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

    // 5. egress GET /models/v1/models
    const egressModelsRes = await fetch(`http://127.0.0.1:${gkPort}/models/v1/models`, {
      headers: { authorization: `Bearer ${runToken}` },
    });
    const egressModelsBody = (await egressModelsRes.json()) as any;
    assertAgentModelStripped(
      egressModelsBody.data.find((m: any) => m.id === 'grok-4.6-dale-sub'),
      'egress GET /models/v1/models',
    );

    // 6. egress transparently injected factory_get_models
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

    // 7. Model reply never contains subscription OAuth tokens
    assert.equal(fgmChat.text.includes('secret-token'), false, 'model reply never includes tokens');
    responsesReply = () => sseOk('hello from subscription');
    state.runs.update(run.runId, { state: 'DONE' });
  });

  it('M5(3), M4: Native-route isolation — subscription catalog entries are unreachable on native routes and never request tokens', async () => {
    const run = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const runToken = await state.runTokens.mint({ runId: run.runId, agentId: 'dale-personal' });

    const beforeRequests = capturedUpstreamRequests.length;
    // Attempt to call native route with subscription model name
    const nativeRes = await fetch(`http://127.0.0.1:${gkPort}/anthropic-native/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.6-dale-sub', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(nativeRes.status, 403, 'subscription entry unreachable on native route');
    const afterRequests = capturedUpstreamRequests.length;
    // Verify Keymaster was NEVER asked for a token on the native route
    assert.equal(beforeRequests, afterRequests, 'no upstream token or request was made for native route');
    state.runs.update(run.runId, { state: 'DONE' });
  });

  it('M5(2), M5(5): Prohibited vendors & admin-proposed systems — Anthropic/Google refused with subscription_not_permitted and proposals refused', () => {
    // Shipped templates check: only xai-subscription and openai-subscription exist
    assert.deepEqual(
      Object.keys(SUBSCRIPTION_TEMPLATES).sort(),
      ['openai-subscription', 'xai-subscription'],
    );

    const subscriptionDefinition = (templateId: string, over: Record<string, unknown> = {}) => {
      const t = SUBSCRIPTION_TEMPLATES[templateId]!;
      return {
        id: t.id,
        name: t.name,
        kind: 'ai-provider',
        upstream: t.inference.upstream,
        aiProvider: {
          adapter: t.aiProvider.adapter,
          discoveryPath: t.aiProvider.discoveryPath,
          credentialMode: 'subscription',
          templateId: t.id,
          defaultHeaders: subscriptionDefaultHeaders(t),
        },
        oauth: { kind: 'oauth-user', authUrl: t.signIn.deviceCodeUrl, tokenUrl: t.tokenUrl, refresh: true, defaultScopes: t.scopes },
        version: 1,
        status: 'approved',
        proposedBy: 'system',
        proposedAt: '2026-11-08T00:00:00Z',
        hash: 'h',
        ...over,
      };
    };

    // Backstop check: Anthropic sign-in / inference host refused with subscription_not_permitted
    for (const upstream of ['https://api.anthropic.com', 'https://generativelanguage.googleapis.com']) {
      const r = systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', { upstream }));
      assert.equal(r.success, false);
      if (!r.success) {
        assert.ok(r.error.issues.some((i) => /subscription_not_permitted/.test(i.message)), 'must refuse with subscription_not_permitted');
      }
    }

    // Admin proposal schema refuses credentialMode: 'subscription'
    const propRes = validateSystemProposal({
      id: 'my-custom-sub',
      name: 'Custom Subscription',
      kind: 'ai-provider',
      upstream: 'https://api.example.com',
      aiProvider: {
        credentialMode: 'subscription',
        templateId: 'xai-subscription',
      },
    });
    assert.equal(propRes.ok, false);

    // System definition schema refuses subscription mode without matching shipped template
    const defRes = systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', {
      aiProvider: {
        credentialMode: 'subscription',
        templateId: 'unshipped-template',
        adapter: 'responses',
      },
    }));
    assert.equal(defRes.success, false);
  });

  it('M5(1), M5(4), K2, K4, K5.1: Cross-user BYOM isolation — cross-owner sign-in 409 refused and non-owners cannot see or attach foreign BYOM', async () => {
    // 1. Bob attempts to connect Dale's already-connected account (xai-dale) -> refused with 409 account_already_connected
    const bobCrossOwner = await api('/api/v1/subscriptions/connect', 'POST', TOKENS.bob, {
      templateId: 'xai-subscription',
      scope: 'personal',
      name: "Bob Attempt on Dale's Grok",
      subscriberAttested: true,
    });
    assert.equal(bobCrossOwner.status, 201);
    signInAccount = { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' };
    clock += 6000;
    const bobCrossOwnerPoll = await api(`/api/v1/subscriptions/sign-ins/${bobCrossOwner.body.signIn.signInId}`, 'GET', TOKENS.bob);
    assert.equal(bobCrossOwnerPoll.status, 409);
    assert.equal(bobCrossOwnerPoll.body.error, 'account_already_connected');

    // 2. Admin attempts factory connect with Dale's account -> 409 account_already_connected
    const adminCrossOwner = await api('/api/v1/subscriptions/connect', 'POST', TOKENS.admin, {
      templateId: 'xai-subscription',
      scope: 'factory',
      subscriberAttested: true,
    });
    clock += 6000;
    const adminCrossOwnerPoll = await api(`/api/v1/subscriptions/sign-ins/${adminCrossOwner.body.signIn.signInId}`, 'GET', TOKENS.admin);
    assert.equal(adminCrossOwnerPoll.status, 409);
    assert.equal(adminCrossOwnerPoll.body.error, 'account_already_connected');

    // 3. User Bob cannot list, mutate, or trigger discovery on Dale's connection
    const bobList = await api('/api/v1/subscriptions', 'GET', TOKENS.bob);
    assert.equal(bobList.status, 200);
    assert.equal(bobList.body.connections.some((c: any) => c.id === daleConnId), false);

    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.bob, { name: 'hacked' })).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.bob, { dailyTokenCap: 100 })).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}/reconnect`, 'POST', TOKENS.bob, { subscriberAttested: true })).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}`, 'DELETE', TOKENS.bob)).status, 404);
    assert.equal((await api(`/api/v1/subscriptions/${daleConnId}/discover`, 'POST', TOKENS.bob)).status, 404);

    // 4. Bob cannot see Dale's BYOM entry in catalog or MCP
    const bobCatalog = await api('/api/v1/models', 'GET', TOKENS.bob);
    assert.equal(bobCatalog.body.models.some((m: any) => m.name === 'grok-4.6-dale-sub'), false);

    const bobMcp = await mcpCall(TOKENS.bob, 'list_model_catalog');
    assert.equal(bobMcp.data.offered.some((m: any) => m.name === 'grok-4.6-dale-sub'), false);

    // 5. Bob cannot attach Dale's BYOM entry to bob-personal (refused 403 personal_model_owner_mismatch even when attempted by Admin!)
    const bobAttach = await api('/api/v1/agents/bob-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub'],
    });
    assert.equal(bobAttach.status, 403);
    assert.equal(bobAttach.body.error, 'personal_model_owner_mismatch');
  });

  it('M5(1): D24, S24 & non-owner refusal — personal BYOM refused on team agents, non-matching owners, and skills on REST and egress', async () => {
    // D24: Team agent refusal on control-plane policy PUT (even by Admin!)
    const teamAttach = await api('/api/v1/agents/team-ops/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'gpt-5-codex-team'],
    });
    assert.equal(teamAttach.status, 403);
    assert.equal(teamAttach.body.error, 'personal_model_team_forbidden');

    // Non-owner agent refusal (even by Admin!)
    const nonOwnerAttach = await api('/api/v1/agents/bob-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub'],
    });
    assert.equal(nonOwnerAttach.status, 403);
    assert.equal(nonOwnerAttach.body.error, 'personal_model_owner_mismatch');

    // Wake pin refusal on non-matching owner
    const wakePin = await api('/api/v1/agents/bob-personal/wake', 'POST', TOKENS.admin, {
      model: 'grok-4.6-dale-sub',
    });
    assert.equal(wakePin.status, 403);
    assert.equal(wakePin.body.error, 'personal_model_owner_mismatch');

    // S24: Skill-model binding refusal (PUT /api/v1/skills/:id/model)
    skillRegistry(state).save({
      id: 'conf-skill',
      version: '1.0.0',
      repo: 'https://github.com/BeerCanLabs/conf-skill',
      path: '.',
      commit: SHA,
      manifest: { id: 'conf-skill', version: '1.0.0', name: 'conf-skill', description: 'c', language: 'python', entry: 'main', requires: { routes: [] } },
      status: 'approved',
      tests: 'passed',
      registeredBy: 'user:dale',
      registeredAt: new Date(clock).toISOString(),
      owner: 'user:dale',
    } as never);
    await state.grants.grant({ subject: 'user:dale', scope: { kind: 'skill', id: 'conf-skill' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });

    const s24Res = await api('/api/v1/skills/conf-skill/model', 'PUT', TOKENS.dale, { model: 'grok-4.6-dale-sub' });
    assert.equal(s24Res.status, 403);
    assert.equal(s24Res.body.error, 'personal_model_skill_forbidden');

    // Call-time enforcement in gatekeeper-egress: fails closed (403)
    const runTeam = state.runs.create({ agentId: 'team-ops', state: 'WORKING', actor: 'user:admin', trigger: 'manual' } as never);
    const runTokenTeam = await state.runTokens.mint({ runId: runTeam.runId, agentId: 'team-ops' });
    const egressTeamCall = await chat(runTokenTeam, { model: 'grok-4.6-dale-sub' });
    assert.equal(egressTeamCall.status, 403, 'egress blocks personal BYOM on team agent');
    state.runs.update(runTeam.runId, { state: 'DONE' });
  });

  it('M5(1): D15 transfer & revocation detachment — outgoing owner BYOM unapproved via M2 transitions without touching pinned runs', async () => {
    // Approve grok-4.6-dale-sub on dale-personal-2
    await api('/api/v1/agents/dale-personal-2/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
    });
    assert.equal(state.policies.get('dale-personal-2').models?.includes('grok-4.6-dale-sub'), true);

    // Active pinned run on dale-personal-2
    const pinnedRun = state.runs.create({
      agentId: 'dale-personal-2',
      state: 'WORKING',
      model: 'grok-4.6-dale-sub',
      actor: 'user:dale',
      trigger: 'manual',
    } as never);
    const pinnedTok = await state.runTokens.mint({ runId: pinnedRun.runId, agentId: 'dale-personal-2' });

    // D15 Transfer: Transfer dale-personal-2 to user:carol
    const offerRes = await api('/api/v1/agents/dale-personal-2/transfer', 'POST', TOKENS.dale, { to: 'user:carol' });
    assert.equal(offerRes.status, 202);
    const acceptRes = await api('/api/v1/agents/dale-personal-2/transfer/accept', 'POST', TOKENS.carol, {});
    assert.equal(acceptRes.status, 200);

    // Policy unapproves outgoing owner's BYOM entry
    const postTransferPol = state.policies.get('dale-personal-2');
    assert.equal(postTransferPol.models?.includes('grok-4.6-dale-sub'), false, 'BYOM detached on transfer');
    assert.equal(postTransferPol.currentModel, 'api-fallback', 'M2 promoted fallback to currentModel');

    // Pinned run model is untouched
    assert.equal(state.runs.get(pinnedRun.runId).model, 'grok-4.6-dale-sub', 'pinned run model untouched');

    // Subsequent call on pinned run fails closed (403) at egress
    const pinnedCallAfterTransfer = await chat(pinnedTok);
    assert.equal(pinnedCallAfterTransfer.status, 403, 'egress blocks pinned run after BYOM detachment');
    state.runs.update(pinnedRun.runId, { state: 'DONE' });
  });

  it('M5(8), D25, S20: $0 BYOM standing — unallocated personal agent evaluates to $0 ceiling, passes S20 budgetGate, wakes, and fails closed 402 on paid fallback', async () => {
    // dale-personal has NO budgetUsd set -> evaluates to ZERO_BUDGET_LIMITS { perDay: 0, perMonth: 0 }
    const daleAgent = state.agents.get('dale-personal');
    assert.deepEqual(effectiveAgentBudgetUsd(state, daleAgent, true), ZERO_BUDGET_LIMITS);
    assert.deepEqual(ZERO_BUDGET_LIMITS, { perDay: 0, perMonth: 0 });

    // S20 budgetGate admission: personal agent draft passes without > $0 budget allocation
    const subPersonal = await createSubmission(
      state,
      { actor: 'user:dale', roles: ['viewer'] },
      'agent',
      { id: 'new-personal', kind: 'personal', name: 'New Personal Agent' },
    );
    assert.equal(subPersonal.gates?.budget?.state, 'passed', 'personal agent passes budget gate at $0');

    // Team agent draft without budget allocation remains pending
    const subTeam = await createSubmission(
      state,
      { actor: 'user:admin', roles: ['admin'] },
      'agent',
      { id: 'new-team', kind: 'team', accountableLead: 'user:admin', name: 'New Team Agent' },
    );
    assert.equal(subTeam.gates?.budget?.state, 'pending', 'team agent requires budget allocation');

    // Standing: wakes, converses, and calls $0 BYOM entry
    await api('/api/v1/agents/dale-personal/models', 'PUT', TOKENS.dale, {
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'grok-4.6-dale-sub',
      secondaryModel: null,
    });

    const wakeRes = await api('/api/v1/agents/dale-personal/wake', 'POST', TOKENS.dale, { message: 'hi' });
    assert.equal(wakeRes.status, 202);
    const rId = wakeRes.body.runId;
    state.runs.update(rId, { state: 'WORKING' });
    const rTok = await state.runTokens.mint({ runId: rId, agentId: 'dale-personal' });

    // Conversation handoff into live run succeeds
    const convRes = await api('/api/v1/agents/dale-personal/conversation', 'POST', TOKENS.dale, { message: 'hello' });
    assert.equal(convRes.status < 300, true);

    // Egress call on $0 BYOM succeeds
    responsesReply = () => sseOk('zero dollar success');
    const egressChat = await chat(rTok);
    assert.equal(egressChat.status, 200);
    assert.equal(egressChat.body.choices[0].message.content, 'zero dollar success');
    state.runs.update(rId, { state: 'DONE' });

    // Switch active model to priced (> $0) 'api-fallback' without factory budget -> wake, conversation, and egress fail closed 402!
    await api('/api/v1/agents/dale-personal/models', 'PUT', TOKENS.dale, {
      currentModel: 'api-fallback',
      primaryModel: 'api-fallback',
      secondaryModel: null,
    });

    const wake402 = await api('/api/v1/agents/dale-personal/wake', 'POST', TOKENS.dale, { message: 'should fail' });
    assert.equal(wake402.status, 402, 'wake fails 402 on paid model without budget');

    const conv402 = await api('/api/v1/agents/dale-personal/conversation', 'POST', TOKENS.dale, { message: 'should fail' });
    assert.equal(conv402.status, 402, 'conversation fails 402 on paid model without budget');

    const rPaid = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokPaid = await state.runTokens.mint({ runId: rPaid.runId, agentId: 'dale-personal' });
    const egress402 = await chat(tokPaid);
    assert.equal(egress402.status, 402, 'egress fails 402 on paid model without budget');
    state.runs.update(rPaid.runId, { state: 'DONE' });

    // Switch back to grok-4.6-dale-sub
    await api('/api/v1/agents/dale-personal/models', 'PUT', TOKENS.dale, {
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'grok-4.6-dale-sub',
      secondaryModel: null,
    });
  });

  it('M5(6), M5(7), M5(8), M2: Pinned and requested refusal — pinned or training-requested subscription entry refused during window (429), reconsent (503), cap (429)', async () => {
    // Setup dale-personal with pinned run
    const rPin = state.runs.create({
      agentId: 'dale-personal',
      state: 'WORKING',
      model: 'grok-4.6-dale-sub',
      actor: 'user:dale',
      trigger: 'manual',
    } as never);
    const tokPin = await state.runTokens.mint({ runId: rPin.runId, agentId: 'dale-personal' });

    // 1. Refusal during open limit window: 429 subscription_limit_reached with resetAt, never substituted
    const resetTime = new Date(clock + 3600_000).toISOString();
    const openRes = await api(`/api/v1/gatekeeper-egress/subscription-windows/${daleConnId}`, 'PUT', TOKENS.egress, {
      action: 'open',
      kind: 'plan-limit',
      code: 'usage_limit_reached',
      resetAt: resetTime,
    });
    assert.equal(openRes.status, 200, openRes.text);
    const callWindow = await chat(tokPin);
    assert.equal(callWindow.status, 429);
    assert.equal(callWindow.body.error, 'subscription_limit_reached');
    assert.equal(callWindow.body.resetAt, resetTime);
    await api(`/api/v1/gatekeeper-egress/subscription-windows/${daleConnId}`, 'PUT', TOKENS.egress, {
      action: 'close',
      by: 'test_reset',
    });

    // 2. Refusal during needs_reconsent: 503 subscription_needs_reconsent, never substituted
    const prevHandler = refreshHandler;
    refreshHandler = () => j(400, { error: 'invalid_grant', error_description: 'revoked' });
    await state.subscriptions.accessToken(daleConnId, { invalidate: true }).catch(() => {});
    refreshHandler = prevHandler;
    const callReconsent = await chat(tokPin);
    assert.equal(callReconsent.status, 503);
    assert.equal(callReconsent.body.error, 'subscription_needs_reconsent');

    // Reconnect to clear needs_reconsent
    signInAccount = { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' };
    const recStart = await api(`/api/v1/subscriptions/${daleConnId}/reconnect`, 'POST', TOKENS.dale, { subscriberAttested: true });
    clock += 6000;
    await api(`/api/v1/subscriptions/sign-ins/${recStart.body.signIn.signInId}`, 'GET', TOKENS.dale);

    // 3. Refusal when dailyTokenCap is spent: 429 subscription_cap_reached, never substituted
    await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, { dailyTokenCap: 10 });
    // Simulate cap reached for dale-personal
    await api('/api/v1/ledger', 'POST', TOKENS.egress, {
      timestamp: new Date(clock).toISOString(),
      action: 'SUBSCRIPTION_CAP_REACHED',
      agentId: 'dale-personal',
      connection: daleConnId,
      actor: 'system',
    });
    // Force egress cache reload
    const callCap = await chat(tokPin);
    assert.equal(callCap.status, 429);
    assert.equal(callCap.body.error, 'subscription_cap_reached');

    // Reset cap
    await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, { dailyTokenCap: null });
    state.runs.update(rPin.runId, { state: 'DONE' });
  });

  it('M5(6): Needs-reconsent skip without retry — skipped in failback without retrying refresh or firing limit probes', async () => {
    // Set dale-personal policy with primary fallback to api-fallback
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });

    const prevHandler2 = refreshHandler;
    refreshHandler = () => j(400, { error: 'invalid_grant', error_description: 'revoked' });
    await state.subscriptions.accessToken(daleConnId, { invalidate: true }).catch(() => {});
    refreshHandler = prevHandler2;

    const runFailover = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokFailover = await state.runTokens.mint({ runId: runFailover.runId, agentId: 'dale-personal' });

    const requestsBefore = capturedUpstreamRequests.length;
    const callRes = await chat(tokFailover);
    assert.equal(callRes.status, 200, callRes.text);
    assert.equal(callRes.body.choices[0].message.content, 'from api-fallback');

    // Repeated calls: Keymaster is NOT stormed with refresh retries and no limit probes fired
    await chat(tokFailover);
    await chat(tokFailover);
    const requestsAfter = capturedUpstreamRequests.length;
    assert.equal(requestsBefore, requestsAfter, 'no upstream refresh requests or probe requests fired');

    // Verify selection is preserved (no POLICY_UPDATED written for needs_reconsent skip)
    assert.equal(state.policies.get('dale-personal').currentModel, 'grok-4.6-dale-sub');

    // Reconnect to restore active state
    signInAccount = { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' };
    const recStart = await api(`/api/v1/subscriptions/${daleConnId}/reconnect`, 'POST', TOKENS.dale, { subscriberAttested: true });
    clock += 6000;
    await api(`/api/v1/subscriptions/sign-ins/${recStart.body.signIn.signInId}`, 'GET', TOKENS.dale);
    state.runs.update(runFailover.runId, { state: 'DONE' });
  });

  it('M5(8): Per-agent cap isolation — exhausting dailyTokenCap affects only that agent and resets at UTC midnight', async () => {
    notices.length = 0;
    // Set dailyTokenCap = 30 on Dale's connection
    await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, { dailyTokenCap: 30 });

    state.agents.set('dale-second', makeAgent('dale-second', 'Dale Second', 'personal'));
    await state.grants.grant({ subject: 'user:dale', scope: { kind: 'agent', id: 'dale-second' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await api('/api/v1/agents/dale-second/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });

    const runA = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokA = await state.runTokens.mint({ runId: runA.runId, agentId: 'dale-personal' });
    const runB = state.runs.create({ agentId: 'dale-second', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokB = await state.runTokens.mint({ runId: runB.runId, agentId: 'dale-second' });

    // Agent A uses 25 + 15 = 40 tokens >= 30 cap
    responsesReply = () => sseOk('Agent A tokens spent', 25, 15);
    const cA1 = await chat(tokA);
    assert.equal(cA1.status, 200);
    await settle();

    // Verify Agent A hit cap: ledgers SUBSCRIPTION_CAP_REACHED naming dale-personal
    const capRows = state.ledger.query().filter((e: any) => e.action === 'SUBSCRIPTION_CAP_REACHED' && e.agentId === 'dale-personal');
    assert.equal(capRows.length >= 1, true, 'SUBSCRIPTION_CAP_REACHED ledgered');

    // Agent A subsequent non-pinned call skips grok-4.6-dale-sub and falls back to api-fallback
    const cA2 = await chat(tokA);
    assert.equal(cA2.status, 200);
    assert.equal(cA2.body.choices[0].message.content, 'from api-fallback');

    // Agent B calls the same connection: succeeds unaffected!
    responsesReply = () => sseOk('Agent B call unaffected', 10, 5);
    const cB1 = await chat(tokB);
    assert.equal(cB1.status, 200);
    assert.equal(cB1.body.choices[0].message.content, 'Agent B call unaffected');

    // Advance simulated clock past UTC midnight -> resets cap (SUBSCRIPTION_CAP_RESET)
    clock += 24 * 3600_000 + 10_000;
    // Trigger reset query / check
    const midnightRes = await api('/api/v1/gatekeeper-egress/subscription-windows', 'GET', TOKENS.egress);
    assert.equal(midnightRes.status, 200);
    const capResetRows = state.ledger.query().filter((e: any) => e.action === 'SUBSCRIPTION_CAP_RESET' && e.agentId === 'dale-personal');
    assert.equal(capResetRows.length >= 1, true, 'SUBSCRIPTION_CAP_RESET ledgered after midnight');

    // Agent A can call the subscription model again
    responsesReply = () => sseOk('Agent A works on new day', 10, 5);
    const cA3 = await chat(tokA);
    assert.equal(cA3.status, 200);
    assert.equal(cA3.body.choices[0].message.content, 'Agent A works on new day');

    // Clean up cap
    await api(`/api/v1/subscriptions/${daleConnId}`, 'PATCH', TOKENS.dale, { dailyTokenCap: null });
    state.runs.update(runA.runId, { state: 'DONE' });
    state.runs.update(runB.runId, { state: 'DONE' });
  });

  it('M5(3): Exact template headers & factory identity — requests carry strictly template headers with factory User-Agent and zero borrowed headers', async () => {
    // 1. xAI inference request verification
    capturedUpstreamRequests.length = 0;
    responsesReply = () => sseOk('xai response');
    const runXai = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokXai = await state.runTokens.mint({ runId: runXai.runId, agentId: 'dale-personal' });
    await chat(tokXai);

    const xaiReq = capturedUpstreamRequests.find((r) => r.url === 'https://api.x.ai/v1/responses')!;
    assert.ok(xaiReq, 'xAI inference request captured');
    assert.match(xaiReq.headers['user-agent'] ?? '', /^BeerCanLabs-AgentFactory\//);
    assert.match(xaiReq.headers['authorization'] ?? '', /^Bearer /);
    assert.equal(xaiReq.headers['content-type'], 'application/json');
    // Ensure no borrowed browser or vendor app disguise headers
    for (const forbiddenHeader of ['x-browser', 'sec-ch-ua', 'sec-fetch-dest', 'cookie', 'x-requested-with']) {
      assert.equal(xaiReq.headers[forbiddenHeader], undefined);
    }
    state.runs.update(runXai.runId, { state: 'DONE' });

    // 2. OpenAI inference request verification
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['gpt-5-codex-team'],
      currentModel: 'gpt-5-codex-team',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
    capturedUpstreamRequests.length = 0;
    responsesReply = () => sseOk('openai response');
    const runOa = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokOa = await state.runTokens.mint({ runId: runOa.runId, agentId: 'dale-personal' });
    await chat(tokOa);

    const oaReq = capturedUpstreamRequests.find((r) => r.url === 'https://chatgpt.com/backend-api/codex/responses')!;
    assert.ok(oaReq, 'OpenAI inference request captured');
    assert.match(oaReq.headers['user-agent'] ?? '', /^BeerCanLabs-AgentFactory\//);
    assert.equal(oaReq.headers['originator'], 'beercanlabs-agent-factory');
    assert.equal(oaReq.headers['chatgpt-account-id'], 'acct-team');
    assert.match(oaReq.headers['authorization'] ?? '', /^Bearer /);
    assert.equal(oaReq.headers['content-type'], 'application/json');
    state.runs.update(runOa.runId, { state: 'DONE' });

    // Switch policy back
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });
  });

  it('M5(6), S1, K5.3: Token redaction — tokens are redacted from run results, error messages, and ledger rows', async () => {
    // Simulate upstream returning 500 error body containing the secret token
    const secretTokenStr = 'xai-access-xai-dale-secret-token-1234'; // secret-scan:allow (test fixture)
    responsesReply = () => new Response(`upstream failed: leaked ${secretTokenStr}`, { status: 500 });

    const runRedact = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokRedact = await state.runTokens.mint({ runId: runRedact.runId, agentId: 'dale-personal' });

    const errRes = await chat(tokRedact);
    await settle();

    // Verify token is not in response text
    assert.equal(errRes.text.includes(secretTokenStr), false, 'access token redacted from egress response');

    // Verify token is not in ledger
    const ledgerStr = JSON.stringify(state.ledger.query());
    assert.equal(ledgerStr.includes(secretTokenStr), false, 'access token redacted from ledger rows');

    responsesReply = () => sseOk('hello');
    state.runs.update(runRedact.runId, { state: 'DONE' });
  });

  it('M5(6): Refused refresh failover & re-consent — invalid_grant marks needs_reconsent and fails over cleanly to next candidate', async () => {
    notices.length = 0;
    // Set refresh handler to return invalid_grant
    const prevRefreshHandler = refreshHandler;
    refreshHandler = () => j(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });

    // Force token invalidation on Dale's connection
    await state.subscriptions.accessToken(daleConnId, { invalidate: true }).catch(() => {});

    // Verify grant is marked needs_reconsent
    const grantRecord = await state.subscriptions.get(daleConnId);
    assert.equal(grantRecord?.status, 'needs_reconsent');

    // Verify notice dispatched to ownerPrincipalId (user:dale)
    const needsReconsentRows = state.ledger.query().filter((e: any) => e.action === 'SUBSCRIPTION_NEEDS_RECONSENT' && e.connection === daleConnId);
    assert.equal(needsReconsentRows.length >= 1, true, 'SUBSCRIPTION_NEEDS_RECONSENT ledgered');

    // Clean failover to api-fallback
    const runRefuse = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokRefuse = await state.runTokens.mint({ runId: runRefuse.runId, agentId: 'dale-personal' });
    const cFailover = await chat(tokRefuse);
    assert.equal(cFailover.status, 200);
    assert.equal(cFailover.body.choices[0].message.content, 'from api-fallback');

    refreshHandler = prevRefreshHandler;
    // Reconnect to restore active state
    signInAccount = { sub: 'xai-dale', email: 'dale@sackrider.org', name: 'Dale' };
    const recStart = await api(`/api/v1/subscriptions/${daleConnId}/reconnect`, 'POST', TOKENS.dale, { subscriberAttested: true });
    clock += 6000;
    await api(`/api/v1/subscriptions/sign-ins/${recStart.body.signIn.signInId}`, 'GET', TOKENS.dale);
    state.runs.update(runRefuse.runId, { state: 'DONE' });
  });

  it('M5(7): Limit window fleet-wide skip & reset — plan limit opens shared window skipping entries without changing currentModel and closes at reset', async () => {
    // Ensure dale-personal has grok-4.6-dale-sub as currentModel and api-fallback as primaryModel
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });

    const futureResetAt = new Date(clock + 7200_000).toISOString();
    // Open shared limit window
    const openWin = await api(`/api/v1/gatekeeper-egress/subscription-windows/${daleConnId}`, 'PUT', TOKENS.egress, {
      action: 'open',
      kind: 'plan-limit',
      code: 'usage_limit_reached',
      resetAt: futureResetAt,
    });
    assert.equal(openWin.status, 200, openWin.text);

    const runLimit = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokLimit = await state.runTokens.mint({ runId: runLimit.runId, agentId: 'dale-personal' });

    // Call encounters open window -> skips candidate 0 (window open) and served by api-fallback
    const cLimit = await chat(tokLimit);
    assert.equal(cLimit.status, 200);
    assert.equal(cLimit.body.choices[0].message.content, 'from api-fallback');
    await settle();

    // Verify limit window ledgered: SUBSCRIPTION_LIMIT_REACHED
    const winRows = state.ledger.query().filter((e: any) => e.action === 'SUBSCRIPTION_LIMIT_REACHED' && e.connection === daleConnId);
    assert.equal(winRows.length >= 1, true, 'SUBSCRIPTION_LIMIT_REACHED ledgered');

    // Selection remains unchanged because candidate 0 was skipped (M5(7a))
    assert.equal(state.policies.get('dale-personal').currentModel, 'grok-4.6-dale-sub');

    // Second call also skips grok-4.6-dale-sub without calling vendor Responses endpoint
    capturedUpstreamRequests.length = 0;
    const cLimit2 = await chat(tokLimit);
    assert.equal(cLimit2.status, 200);
    assert.equal(cLimit2.body.choices[0].message.content, 'from api-fallback');
    assert.equal(capturedUpstreamRequests.filter((r) => r.url === 'https://api.x.ai/v1/responses').length, 0);

    // Advance clock past resetAt -> window closes
    clock += 7200_000 + 10_000;
    responsesReply = () => sseOk('welcome back after limit reset');
    const cAfterReset = await chat(tokLimit);
    assert.equal(cAfterReset.status, 200);
    assert.equal(cAfterReset.body.choices[0].message.content, 'welcome back after limit reset');

    const resetRows = state.ledger.query().filter((e: any) => e.action === 'SUBSCRIPTION_LIMIT_RESET' && e.connection === daleConnId);
    assert.equal(resetRows.length >= 1, true, 'SUBSCRIPTION_LIMIT_RESET ledgered');

    state.runs.update(runLimit.runId, { state: 'DONE' });
  });

  it('M5(8), LG1: Ledgering & pricing — calls ledgered with credentialMode, scope, connection, priced $0 on BYOM, and reported in Accountant spend', async () => {
    // Ensure dale-personal is set to grok-4.6-dale-sub
    await api('/api/v1/agents/dale-personal/policy', 'PUT', TOKENS.admin, {
      routes: ['models'],
      models: ['grok-4.6-dale-sub', 'api-fallback'],
      currentModel: 'grok-4.6-dale-sub',
      primaryModel: 'api-fallback',
      budgetUsd: { perDay: 10, perMonth: 100 },
    });

    responsesReply = () => sseOk('pricing check', 20, 10);
    const runPriced = state.runs.create({ agentId: 'dale-personal', state: 'WORKING', actor: 'user:dale', trigger: 'manual' } as never);
    const tokPriced = await state.runTokens.mint({ runId: runPriced.runId, agentId: 'dale-personal' });
    const pChat = await chat(tokPriced);
    assert.equal(pChat.status, 200);
    await settle();

    // Verify llm ledger row fields
    const llmRows = state.ledger.query().filter((e: any) => (e.type === 'llm' || e.action === 'llm') && e.model === 'grok-4.6-dale-sub');
    assert.ok(llmRows.length >= 1, 'llm ledger row created');
    const lastRow = llmRows[llmRows.length - 1];
    assert.equal(lastRow.credentialMode, 'subscription');
    assert.equal(lastRow.scope, 'personal');
    assert.equal(lastRow.connection, daleConnId);
    assert.equal(lastRow.connectionName, "Dale's SuperGrok");
    assert.equal(lastRow.ownerPrincipalId, 'user:dale');
    assert.equal(lastRow.costUsd, 0, 'cost is exactly $0 for personal BYOM');

    // Accountant spend views: User Dale sees his personal connection token totals
    const spendRes = await api('/api/v1/subscriptions/spend', 'GET', TOKENS.dale);
    assert.equal(spendRes.status, 200);
    assert.ok(spendRes.body.connections?.[daleConnId], 'Dale sees own personal connection tokens');
    assert.equal(spendRes.body.connections?.[daleConnId].connectionName, "Dale's SuperGrok");

    // Bob cannot see Dale's connection in spend report
    const bobSpendRes = await api('/api/v1/subscriptions/spend', 'GET', TOKENS.bob);
    assert.equal(bobSpendRes.status, 200);
    assert.equal(bobSpendRes.body.connections?.[daleConnId], undefined, 'Bob cannot see Dale personal connection in spend');

    // Admin sees fleet-wide spend
    const adminSpendRes = await api('/api/v1/subscriptions/spend', 'GET', TOKENS.admin);
    assert.equal(adminSpendRes.status, 200);
    assert.ok(adminSpendRes.body.connections?.[daleConnId], 'Admin sees Dale connection in spend');

    state.runs.update(runPriced.runId, { state: 'DONE' });
  });

  it('M5: AWS IAM keymaster_grant_arns coverage in landing-zones/aws/iam.tf', () => {
    const iam = read('landing-zones/aws/iam.tf');
    // Must protect Keymaster grant arns in both control_plane and gatekeeper_egress
    assert.match(iam, /keymaster_grant_arns/);
    assert.match(iam, /Sid\s*=\s*"KeymasterGrantStore"/);
    assert.match(iam, /Sid\s*=\s*"NeverKeymasterGrants"/);

    // Unconditionally assert connections/*, shared/*/subscription/*, and users/* in keymaster_grant_arns
    assert.match(iam, /keymaster_grant_arns\s*=\s*\[[\s\S]*?connections\/\*[\s\S]*?shared\/\*\/subscription\/\*[\s\S]*?users\/\*/);
  });
});
