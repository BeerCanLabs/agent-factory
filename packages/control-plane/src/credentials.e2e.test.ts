// §6.11 K5: the Keymaster credentials API — outstanding credentials, write-only submission, dashboard consent.
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
import { signConsentState } from './connections.js';
import { SystemsStore } from './systems.js';

/** Providers as a deployment imports them (TSK-067): data, never platform code. */
const TEST_PROVIDERS = [
  { id: 'google', name: 'Google (OAuth)', kind: 'http', upstream: 'https://accounts.google.com', oauth: { kind: 'oauth-user', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', clientSecret: 'GOOGLE_OAUTH_CLIENT', authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } } },
  { id: 'linkedin', name: 'LinkedIn', kind: 'http', upstream: 'https://api.linkedin.com', connection: 'linkedin', oauth: { kind: 'oauth-user', authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', clientSecret: 'LINKEDIN_OAUTH_CLIENT', authParams: {}, refresh: false } },
  { id: 'google-service-account', name: 'Google service account', kind: 'http', upstream: 'https://oauth2.googleapis.com', oauth: { kind: 'jwt-bearer', tokenUrl: 'https://oauth2.googleapis.com/token', keySecret: 'GOOGLE_SERVICE_ACCOUNT', defaultScopes: ['https://www.googleapis.com/auth/devstorage.read_write'] } },
];

async function openSystems(dir: string, ledger: Parameters<typeof SystemsStore.open>[1]) {
  const store = await SystemsStore.open(dir, ledger);
  await store.importRoutes(TEST_PROVIDERS, 'migration:test');
  return store;
}
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
import type { AgentRecord } from '@beercanlabs/factory-registrar';

const ADMIN = 'admin-cred';
const VIEWER = 'viewer-cred';
const SIGNING = 'callback-signing-key-credentials-test';
const BASE = 'https://factory.example.test';
const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
// Obviously fake values (never real token formats).
const FAKE_DISCORD = 'example-fake-discord-bot-token-value';
const FAKE_ROTATED = 'example-fake-rotated-discord-token';
const FAKE_GITHUB = 'example-fake-github-token-value';
const FAKE_CLIENT = JSON.stringify({ client_id: 'example-client.apps.googleusercontent.com', client_secret: 'example-fake-client-secret' });

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const agent = (over: Partial<AgentRecord>): AgentRecord => ({
  id: 'x', name: 'X', role: 'Agent', state: 'SLEEPING', provider: 'cloud', artifact: '',
  requires: [], ungated: [], gated: [], triggers: [], dir: '/tmp/x', ...over,
});

describe('Keymaster credentials API (§6.11 K5)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const values = new Map<string, string>();
  const ledger = new MemoryLedger();
  const responses: string[] = [];
  const logged: string[] = [];
  const reads: string[] = [];
  const described: string[] = [];
  const writes: string[] = [];

  const provider: SecretProvider = {
    name: 'mem',
    async get(n) {
      reads.push(n);
      return values.get(n);
    },
    // Metadata-only presence (like AWS DescribeSecret): never reads the value.
    async has(n) {
      described.push(n);
      return Boolean(values.get(n));
    },
    async put(n, v) {
      writes.push(n);
      values.set(n, v);
    },
  };

  const req = async (path: string, opts: { method?: string; token?: string; body?: unknown; raw?: string; contentType?: string } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'content-type': opts.contentType ?? (opts.raw !== undefined ? 'text/plain' : 'application/json'),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await res.text();
    responses.push(text, JSON.stringify([...res.headers]));
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  const creds = async (id = 'donna') => (await req(`/api/v1/keymaster/agents/${id}/credentials`, { token: ADMIN })).json();
  const item = async (name: string, id = 'donna') => (await creds(id)).credentials.find((c: { name: string }) => c.name === name);

  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  let systemsDir = '';

  before(async () => {
    const capture = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
      orig(...a);
    };
    console.log = capture(origLog);
    console.error = capture(origErr);
    console.warn = capture(origWarn);
    const secretValues = new Set<string>();
    systemsDir = mkdtempSync(join(tmpdir(), 'systems-cred-test-'));
    state = {
      agents: new Map<string, AgentRecord>(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: 'test',
      providers: [provider],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('cred-run-token-key-0123456789abcdef'),
      callbacks: { signingKey: SIGNING, allowInsecure: true, attempts: 1, backoffMs: 0 },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues,
      publicBaseUrl: BASE,
      gatekeeperEgressHeldSecrets: new Set(['NOTION_API_KEY', 'ANTHROPIC_API_KEY']),
      systems: await openSystems(systemsDir, ledger),
    };
    state.connections = new ConnectionKeymaster({
      providers: [provider],
      ledger,
      secretValues: state.secretValues,
      getProvider: (name) => state.systems?.getConnectionProvider(name),
    });
    state.agents.set('donna', agent({
      id: 'donna',
      name: 'Donna',
      requires: ['DISCORD_BOT_TOKEN', 'GITHUB_TOKEN', 'NOTION_API_KEY', 'ANTHROPIC_API_KEY'],
      credentials: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord', description: 'Donna logs in to Discord' }],
      connections: [{ provider: 'google', scopes: [CAL, GMAIL] }, { provider: 'google-service-account', scopes: [] }],
    }));
    state.agents.set('quiet', agent({ id: 'quiet', name: 'Quiet' }));
    state.agents.set('gatekeeper-ingress', agent({ id: 'gatekeeper-ingress', name: 'gatekeeper-ingress', category: 'builtin', isBuiltin: true, requires: ['GATEKEEPER_INGRESS_SECRET'] }));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    await new Promise<void>((r) => cp.close(() => r()));
    if (systemsDir) rmSync(systemsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    values.clear();
    state.connections = new ConnectionKeymaster({
      providers: [provider],
      ledger,
      secretValues: state.secretValues,
      getProvider: (name) => state.systems?.getConnectionProvider(name),
    });
  });

  it('is admin-only', async () => {
    assert.equal((await req('/api/v1/keymaster/agents/donna/credentials')).status, 401);
    assert.equal((await req('/api/v1/keymaster/agents/donna/credentials', { token: VIEWER })).status, 403);
    assert.equal((await req('/api/v1/keymaster/outstanding', { token: VIEWER })).status, 403);
    assert.equal((await req('/api/v1/keymaster/agents/donna/credentials/DISCORD_BOT_TOKEN', { method: 'POST', token: VIEWER, raw: FAKE_DISCORD })).status, 403);
    assert.equal(values.size, 0);
    assert.equal((await req('/api/v1/keymaster/agents/nobody/credentials', { token: ADMIN })).status, 404);
  });

  it('lists every declared credential with status, instructions (pending review), and its action', async () => {
    const body = await creds();
    assert.equal(body.agentId, 'donna');
    const by = Object.fromEntries(body.credentials.map((c: { name: string }) => [c.name, c]));
    assert.deepEqual(Object.keys(by).sort(), ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_OAUTH_CLIENT', 'GOOGLE_SERVICE_ACCOUNT', 'NOTION_API_KEY', 'google']);
    assert.equal(by.DISCORD_BOT_TOKEN.status, 'missing');
    assert.equal(by.DISCORD_BOT_TOKEN.description, 'Donna logs in to Discord');
    assert.equal(by.DISCORD_BOT_TOKEN.instructions.id, 'discord');
    assert.equal(by.DISCORD_BOT_TOKEN.instructions.reviewState, 'pending_review');
    assert.match(by.DISCORD_BOT_TOKEN.instructions.label, /pending human review/i);
    assert.deepEqual(by.DISCORD_BOT_TOKEN.action, { type: 'submit', method: 'POST', path: '/api/v1/keymaster/agents/donna/credentials/DISCORD_BOT_TOKEN' });
    assert.equal(by.GITHUB_TOKEN.source, 'github');
    assert.equal(by.GITHUB_TOKEN.sourceInferred, true);
    assert.equal(by.google.status, 'needs_consent');
    assert.equal(by.google.action.type, 'consent');
    assert.equal(by.google.action.path, '/api/v1/connections/donna/google/start');
    assert.equal(by.google.action.url, `${BASE}/api/v1/connections/donna/google/start`);
    assert.equal(by.google.action.available, false, 'consent waits for the OAuth client');
    assert.equal(by.GOOGLE_OAUTH_CLIENT.managedBy, 'platform');
    // The two gatekeeper-held keys are platform credentials and, unset here, outstanding (K5: the Keymaster owns them).
    assert.deepEqual(body.summary, { total: 7, outstanding: 7, present: 0 });
    assert.equal(body.credentials.every((c: { instructions: unknown }) => c.instructions === null || typeof c.instructions === 'object'), true);
  });

  it('gatekeeper-held keys are platform credentials: checked from metadata only, supplied through the platform channel', async () => {
    reads.length = 0;
    const body = await creds();
    for (const name of ['NOTION_API_KEY', 'ANTHROPIC_API_KEY']) {
      const c = body.credentials.find((x: { name: string }) => x.name === name);
      assert.equal(c.status, 'missing');
      assert.equal(c.outstanding, true);
      assert.equal(c.managedBy, 'platform');
      assert.deepEqual(c.action, { type: 'submit', method: 'POST', path: `/api/v1/keymaster/platform/credentials/${name}` });
      assert.equal(reads.includes(name), false, `${name} is never read, only described`);
    }
    // Not through the agent's endpoint: it points at the platform one and stores nothing.
    const refused = await req('/api/v1/keymaster/agents/donna/credentials/NOTION_API_KEY', { method: 'POST', token: ADMIN, raw: 'example-fake-notion-secret' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().error, 'managed_by_platform');
    assert.equal(refused.json().path, '/api/v1/keymaster/platform/credentials/NOTION_API_KEY');
    assert.equal(values.has('NOTION_API_KEY'), false);

    // The platform view lists every gatekeeper-held key; an admin supplies one write-only.
    const list = await req('/api/v1/keymaster/platform/credentials', { token: ADMIN });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json().credentials.map((c: { name: string; status: string }) => [c.name, c.status]), [['ANTHROPIC_API_KEY', 'missing'], ['NOTION_API_KEY', 'missing']]);
    const before = ledger.query({}).length;
    const set = await req('/api/v1/keymaster/platform/credentials/NOTION_API_KEY', { method: 'POST', token: ADMIN, raw: 'example-fake-notion-secret' });
    assert.equal(set.status, 201);
    assert.equal(set.text.includes('example-fake-notion-secret'), false);
    assert.equal(values.get('NOTION_API_KEY'), 'example-fake-notion-secret');
    const row = ledger.query({}).slice(before).find((e) => e.action === 'CREDENTIAL_SET');
    assert.equal(row?.agentId, 'platform');
    assert.equal(JSON.stringify(ledger.query({})).includes('example-fake-notion-secret'), false);
    assert.equal((await req('/api/v1/keymaster/platform/credentials', { token: ADMIN })).json().credentials.find((c: { name: string }) => c.name === 'NOTION_API_KEY').status, 'present');
    // Only gatekeeper-held names; admin only.
    assert.equal((await req('/api/v1/keymaster/platform/credentials/DISCORD_BOT_TOKEN', { method: 'POST', token: ADMIN, raw: FAKE_DISCORD })).status, 404);
    assert.notEqual((await req('/api/v1/keymaster/platform/credentials')).status, 200);
    values.delete('NOTION_API_KEY');
    writes.length = 0;
  });

  it('refuses names the agent did not declare, and invalid names', async () => {
    for (const [agentId, name] of [['donna', 'OTHER_TOKEN'], ['quiet', 'DISCORD_BOT_TOKEN']]) {
      const res = await req(`/api/v1/keymaster/agents/${agentId}/credentials/${name}`, { method: 'POST', token: ADMIN, raw: FAKE_DISCORD });
      assert.equal(res.status, 404, `${agentId}/${name}`);
      assert.equal(res.json().error, 'undeclared_credential');
    }
    assert.equal((await req('/api/v1/keymaster/agents/donna/credentials/lower_case', { method: 'POST', token: ADMIN, raw: FAKE_DISCORD })).status, 400);
    assert.equal((await req('/api/v1/keymaster/agents/nobody/credentials/DISCORD_BOT_TOKEN', { method: 'POST', token: ADMIN, raw: FAKE_DISCORD })).status, 404);
    assert.equal(values.size, 0);
    assert.equal(writes.length, 0);
  });

  it('writes a submitted value to the secret manager, write-only: never echoed, logged, or ledgered', async () => {
    const before = ledger.query({}).length;
    const set = await req('/api/v1/keymaster/agents/donna/credentials/DISCORD_BOT_TOKEN', { method: 'POST', token: ADMIN, body: { value: `  ${FAKE_DISCORD}\n` } });
    assert.equal(set.status, 201, set.text);
    assert.deepEqual(Object.keys(set.json()).sort(), ['action', 'agentId', 'at', 'name', 'status']);
    assert.equal(set.json().action, 'CREDENTIAL_SET');
    assert.equal(set.headers.get('cache-control'), 'no-store');
    assert.equal(values.get('DISCORD_BOT_TOKEN'), FAKE_DISCORD, 'stored trimmed, at the declared name');
    assert.equal((await item('DISCORD_BOT_TOKEN')).status, 'present');

    const rotated = await req('/api/v1/keymaster/agents/donna/credentials/DISCORD_BOT_TOKEN', { method: 'POST', token: ADMIN, raw: FAKE_ROTATED });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json().action, 'CREDENTIAL_ROTATED');
    assert.equal(values.get('DISCORD_BOT_TOKEN'), FAKE_ROTATED);

    const rows = ledger.query({}).slice(before).filter((e) => e.action?.startsWith('CREDENTIAL_'));
    assert.deepEqual(rows.map((r) => ({ action: r.action, agentId: r.agentId, credential: r.credential, actor: r.actor })), [
      { action: 'CREDENTIAL_SET', agentId: 'donna', credential: 'DISCORD_BOT_TOKEN', actor: 'token:admin' },
      { action: 'CREDENTIAL_ROTATED', agentId: 'donna', credential: 'DISCORD_BOT_TOKEN', actor: 'token:admin' },
    ]);
    assert.ok(state.secretValues.has(FAKE_DISCORD) && state.secretValues.has(FAKE_ROTATED), 'redacted from now on (S1 backstop)');

    await creds();
    await req('/api/v1/keymaster/outstanding', { token: ADMIN });
    const everything = [...responses, ...logged, JSON.stringify(ledger.query({}))].join('\n');
    for (const v of [FAKE_DISCORD, FAKE_ROTATED]) assert.equal(everything.includes(v), false, 'a value never appears in any response, log line, or ledger row');
  });

  it('K5 TSK-067 an OAuth provider client is write-only, admin-only, Keymaster-named, and never echoed, logged or ledgered', async () => {
    // A new provider defined without a client entry name: the Keymaster names it shared/<id>/oauth-client.
    await state.systems!.importRoutes([{ id: 'microsoft', name: 'Microsoft', kind: 'http', upstream: 'https://login.microsoftonline.com',
      oauth: { kind: 'oauth-user', authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' } }], 'migration:test');
    const SECRET = 'example-fake-microsoft-client-value';
    const status = async () => (await req('/api/v1/keymaster/providers/microsoft/client', { token: ADMIN })).json();
    assert.deepEqual(await status(), { system: 'microsoft', kind: 'oauth-user', name: 'shared/microsoft/oauth-client', present: false });

    const notAdmin = await req('/api/v1/keymaster/providers/microsoft/client', { method: 'POST', token: VIEWER, body: { client_id: 'abc', client_secret: SECRET } });
    assert.equal(notAdmin.status, 403);
    assert.equal((await req('/api/v1/keymaster/providers/microsoft/client', { method: 'POST', token: ADMIN, body: { client_id: 'abc' } })).status, 400);
    assert.equal((await req('/api/v1/keymaster/providers/discord/client', { method: 'POST', token: ADMIN, body: { client_id: 'a', client_secret: SECRET } })).status, 404);

    const before = ledger.query({}).length;
    const set = await req('/api/v1/keymaster/providers/microsoft/client', { method: 'POST', token: ADMIN, body: { client_id: '347b5707-0000', client_secret: SECRET } });
    assert.equal(set.status, 201, set.text);
    assert.equal(set.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(values.get('shared/microsoft/oauth-client')!), { client_id: '347b5707-0000', client_secret: SECRET });
    assert.equal((await status()).present, true);
    const rows = ledger.query({}).slice(before);
    assert.deepEqual(rows.map((r) => [r.action, r.provider, r.actor]), [['OAUTH_CLIENT_SET', 'microsoft', 'token:admin']]);
    assert.ok(state.secretValues.has(SECRET), 'redacted from now on (S1 backstop)');
    const everything = [...responses, ...logged, JSON.stringify(ledger.query({}))].join('\n');
    assert.equal(everything.includes(SECRET), false, 'the client secret never appears in a response, log line, or ledger row');
  });

  it('rejects empty, short, and malformed submissions without echoing them', async () => {
    const bad = 'example-not-json-value {';
    for (const [opts, error] of [
      [{ raw: '' }, 'value_required'],
      [{ raw: 'short' }, 'value_invalid'],
      [{ raw: bad, contentType: 'application/json' }, 'value_required'],
      [{ body: { value: 12345678 } }, 'value_required'],
    ] as const) {
      const res = await req('/api/v1/keymaster/agents/donna/credentials/GITHUB_TOKEN', { method: 'POST', token: ADMIN, ...opts });
      assert.equal(res.status, 400);
      assert.equal(res.json().error, error);
      assert.equal(res.text.includes('example-not-json'), false);
    }
    assert.equal(values.has('GITHUB_TOKEN'), false);
  });

  it('503s when no writable secrets backend is configured, and never keeps the value', async () => {
    const saved = state.providers;
    state.providers = [{ name: 'ro', async get() { return undefined; } }];
    try {
      const res = await req('/api/v1/keymaster/agents/donna/credentials/GITHUB_TOKEN', { method: 'POST', token: ADMIN, raw: FAKE_GITHUB });
      assert.equal(res.status, 503);
      assert.equal(res.text.includes(FAKE_GITHUB), false);
    } finally {
      state.providers = saved;
    }
  });

  it('platform app credentials are submittable; consent becomes available once the OAuth client exists', async () => {
    const res = await req('/api/v1/keymaster/agents/donna/credentials/GOOGLE_OAUTH_CLIENT', { method: 'POST', token: ADMIN, raw: FAKE_CLIENT });
    assert.equal(res.status, 201);
    assert.equal(res.text.includes('example-fake-client-secret'), false);
    const google = await item('google');
    assert.equal(google.action.available, true);
    const start = await req(google.action.path, { token: ADMIN });
    assert.equal(start.status, 302, 'the Connect button uses the existing consent start endpoint');
  });

  it('reports OAuth grants: present, missing_scopes, needs_reconsent', async () => {
    values.set('GOOGLE_OAUTH_CLIENT', FAKE_CLIENT);
    const grant = (scopes: string[], status: Grant['status'] = 'active'): Grant => ({
      provider: 'google', clientRef: 'GOOGLE_OAUTH_CLIENT', refreshToken: 'example-fake-refresh', scopes, obtainedAt: '2026-09-28T00:00:00.000Z', grantedBy: 'token:admin', status,
    });
    values.set(grantSecretName('donna', 'google'), JSON.stringify(grant([CAL])));
    let g = await item('google');
    assert.equal(g.status, 'missing_scopes');
    assert.deepEqual(g.scopes.missing, [GMAIL]);
    values.set(grantSecretName('donna', 'google'), JSON.stringify(grant([CAL, GMAIL], 'needs_reconsent')));
    assert.equal((await item('google')).status, 'needs_reconsent');
    values.set(grantSecretName('donna', 'google'), JSON.stringify(grant([CAL, GMAIL])));
    g = await item('google');
    assert.equal(g.status, 'present');
    assert.equal(JSON.stringify(await creds()).includes('example-fake-refresh'), false, 'never tokens');
  });

  it('counts outstanding credentials per agent for the fleet view', async () => {
    values.set('GITHUB_TOKEN', FAKE_GITHUB);
    await creds(); // refreshes the cached summary
    const res = await req('/api/v1/keymaster/outstanding', { token: ADMIN });
    assert.equal(res.status, 200);
    const body = res.json();
    const donna = body.agents.find((a: { agentId: string }) => a.agentId === 'donna');
    const quiet = body.agents.find((a: { agentId: string }) => a.agentId === 'quiet');
    assert.deepEqual({ total: donna.total, outstanding: donna.outstanding }, { total: 7, outstanding: 6 });
    assert.deepEqual({ total: quiet.total, outstanding: quiet.outstanding }, { total: 0, outstanding: 0 });
    assert.equal(body.outstanding, 6);
    assert.equal(body.agents.some((a: { agentId: string }) => a.agentId === 'gatekeeper-ingress'), false, 'built-in system agents are not listed');
  });

  it('built-in system agents are not asked for credentials', async () => {
    const body = await creds('gatekeeper-ingress');
    assert.equal(body.builtin, true);
    assert.deepEqual(body.credentials, []);
    const res = await req('/api/v1/keymaster/agents/gatekeeper-ingress/credentials/GATEKEEPER_INGRESS_SECRET', { method: 'POST', token: ADMIN, raw: FAKE_DISCORD });
    assert.equal(res.status, 409);
    assert.equal(values.has('GATEKEEPER_INGRESS_SECRET'), false);
  });

  it('the consent callback links back to the agent\'s credentials page in the console', async () => {
    values.set('GOOGLE_OAUTH_CLIENT', FAKE_CLIENT);
    state.connections = new ConnectionKeymaster({
      providers: [provider], ledger, secretValues: state.secretValues,
      fetch: (async () => new Response(JSON.stringify({ access_token: 'example-fake-access', refresh_token: 'example-fake-refresh-2', expires_in: 3599, scope: `${CAL} ${GMAIL}` }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    const key = createHmac('sha256', SIGNING).update('factory:keymaster:connection-state:v1').digest();
    const st = signConsentState(key, { agentId: 'donna', provider: 'google', scopes: [CAL, GMAIL], actor: 'token:admin', nonce: 'cred-nonce', exp: Date.now() + 60_000 });
    const res = await req(`/api/v1/connections/google/callback?code=example-code&state=${encodeURIComponent(st)}`);
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes(`href="${BASE}/?view=credentials&amp;agent=donna"`), res.text);
    assert.equal((await item('google')).status, 'present');
  });

  it('registration keeps typed declarations (source, description) on the agent record', async () => {
    const res = await req('/api/v1/registry/agents', {
      method: 'POST',
      token: ADMIN,
      body: { cartridge: { id: 'typed-agent', name: 'Typed', secrets: { requires: [{ name: 'SLACK_BOT_TOKEN', source: 'slack', description: 'Posts updates' }, 'PLAIN_SECRET'] } } },
    });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(state.agents.get('typed-agent')?.credentials, [{ name: 'SLACK_BOT_TOKEN', source: 'slack', description: 'Posts updates' }, { name: 'PLAIN_SECRET' }]);
    const body = await creds('typed-agent');
    assert.deepEqual(body.credentials.map((c: { name: string; source?: string }) => [c.name, c.source]), [['SLACK_BOT_TOKEN', 'slack'], ['PLAIN_SECRET', undefined]]);
  });

  it('K5 repeated dashboard polls do not re-check the secret manager; a change shows at once (GAP-056)', async () => {
    const outstanding = () => req('/api/v1/keymaster/outstanding', { token: ADMIN });
    await req('/api/v1/keymaster/agents/donna/credentials/GITHUB_TOKEN', { method: 'POST', token: ADMIN, body: { value: FAKE_GITHUB } });
    described.length = 0;

    // Concurrent fleet views share one check per secret, and later polls are served from the cache.
    await Promise.all([outstanding(), outstanding(), outstanding()]);
    const firstScan = described.length;
    assert.ok(firstScan > 0, 'the first poll checks the secret manager');
    assert.equal(new Set(described).size, firstScan, 'each secret is checked once, however many views ask');
    await outstanding();
    await outstanding();
    assert.equal(described.length, firstScan, 'polling again does not touch the secret manager');

    // Supplying a credential clears the cache: the next view is current.
    values.delete('GITHUB_TOKEN');
    await req('/api/v1/keymaster/agents/donna/credentials/GITHUB_TOKEN', { method: 'POST', token: ADMIN, body: { value: FAKE_GITHUB } });
    assert.equal((await item('GITHUB_TOKEN')).status, 'present');
    assert.ok(described.length > firstScan, 'a change triggers a fresh check');
  });

  it('K5 a provider that can list is asked once per scan, never per secret (GAP-056)', async () => {
    let listed = 0;
    provider.present = async () => {
      listed += 1;
      return new Set([...values.entries()].filter(([, v]) => v).map(([k]) => k));
    };
    try {
      await req('/api/v1/keymaster/agents/donna/credentials/GITHUB_TOKEN', { method: 'POST', token: ADMIN, body: { value: FAKE_GITHUB } });
      described.length = 0;
      await Promise.all([req('/api/v1/keymaster/outstanding', { token: ADMIN }), req('/api/v1/keymaster/outstanding', { token: ADMIN })]);
      await req('/api/v1/keymaster/outstanding', { token: ADMIN });
      assert.equal(listed, 1, 'one listing serves every agent and every view');
      assert.equal(described.length, 0, 'no per-secret lookups');
      assert.equal((await item('GITHUB_TOKEN')).status, 'present');
    } finally {
      delete provider.present;
    }
  });
});
