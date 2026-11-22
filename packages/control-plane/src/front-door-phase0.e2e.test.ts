// Front-door auth Phase 0 (docs/design/front-door-auth.md §7, PR #547): whoami reports the sign-in method the factory
// actually verified, including for MCP tool calls dispatched in-process, and every external request is logged with its
// method and no secret material.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, cloudflareAccessAuth } from '@beercanlabs/factory-auth';
import { BUILTIN_SYSTEM_AGENTS } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime, RunTokens } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApiKeyStore, ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { bearerAuthMethod, buildAuthRequestLogEntry, keyAuthMethod, keyKindOf, logPath, requestAuthMethod, type AuthRequestLogEntry } from './auth-method.js';

const TEAM = 'phase0.example.cloudflareaccess.com';
const AUD = 'phase0-aud';
const STATIC_TOKEN = 'phase0-static-admin-token'; // secret-scan:allow (test fixture)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'p0', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(email: string) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'p0' })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 300, email, email_verified: true })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

async function call(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as Record<string, any> };
}

describe('front-door Phase 0: truthful signedInWith and per-request sign-in method log', { concurrency: false }, () => {
  let server: http.Server;
  let port = 0;
  let state: FactoryState;
  const log: AuthRequestLogEntry[] = [];
  let serviceKey = '';
  let serviceKeyId = '';
  let oauthToken = '';

  before(async () => {
    const keys = await ApiKeyStore.open();
    const svc = await keys.create({ owner: 'service:phase0-probe', roles: ['admin'], expiresAt: null, by: 'test' });
    serviceKey = svc.plaintext;
    serviceKeyId = svc.record.id;
    const at = await keys.create({
      owner: 'service:phase0-mcp-app',
      roles: ['admin'],
      expiresAt: null,
      by: 'test',
      secretPrefix: 'fk_at_',
      audience: 'https://factory.example/mcp',
      oauthClientId: 'mcpc_phase0',
    });
    oauthToken = at.plaintext;
    state = {
      agents: new Map(BUILTIN_SYSTEM_AGENTS.map((b) => [b.id, structuredClone(b)])),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: STATIC_TOKEN, roles: ['admin'] }]),
      access: cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, adminEmails: ['owner@example.com'], fetchJwks: async () => ({ keys: [jwk] }) }),
      keys,
      version: 'test',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(undefined),
      callbacks: { signingKey: 'k', allowInsecure: true, attempts: 1, backoffMs: 1 },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      schedules: new ScheduleStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
      authRequestLog: (e: AuthRequestLogEntry) => log.push(e),
    } as unknown as FactoryState;
    server = createFactoryServer(state);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('no port');
    port = a.port;
  });
  after(() => server.close());

  const waitForLog = async (n: number) => {
    for (let i = 0; i < 50 && log.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('REST whoami: an fk_ key reports api-key, the static token static-token, an Access assertion cloudflare-access', async () => {
    const key = await call(port, '/api/v1/whoami', { authorization: `Bearer ${serviceKey}` });
    assert.equal(key.status, 200);
    assert.equal(key.body.signedInWith, 'api-key');
    const stat = await call(port, '/api/v1/whoami', { authorization: `Bearer ${STATIC_TOKEN}` });
    assert.equal(stat.body.signedInWith, 'static-token');
    const access = await call(port, '/api/v1/whoami', { 'cf-access-jwt-assertion': assertion('owner@example.com') });
    assert.equal(access.body.signedInWith, 'cloudflare-access');
  });

  it('MCP whoami through an fk_ key reports api-key, not cloudflare-access (the Higgins mislabel)', async () => {
    const r = await call(port, '/mcp', { authorization: `Bearer ${serviceKey}` }, 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.error, undefined, JSON.stringify(r.body));
    const who = JSON.parse(r.body.result.content[0].text);
    assert.equal(who.signedInWith, 'api-key');
  });

  it('MCP whoami through an OAuth access token (fk_at_) reports oauth', async () => {
    const r = await call(port, '/mcp', { authorization: `Bearer ${oauthToken}` }, 'POST', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const who = JSON.parse(r.body.result.content[0].text);
    assert.equal(who.signedInWith, 'oauth');
  });

  it('logs one line per external request with method, path without query, status and key ids, never secrets', async () => {
    log.length = 0;
    await call(port, '/api/v1/whoami?code=very-secret-oauth-code&state=abc', { authorization: `Bearer ${serviceKey}` });
    await call(port, '/api/v1/whoami');
    await call(port, '/mcp', { authorization: `Bearer ${oauthToken}` }, 'POST', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    await waitForLog(3);
    assert.equal(log.length, 3, 'in-process MCP sub-requests are not logged separately');
    const [keyed, anon, mcp] = log;
    assert.equal(keyed.event, 'auth.request');
    assert.equal(keyed.path, '/api/v1/whoami', 'query string dropped');
    assert.equal(keyed.status, 200);
    assert.equal(keyed.authMethod, 'api-key');
    assert.equal(keyed.keyId, serviceKeyId);
    assert.equal(keyed.keyKind, 'service');
    assert.equal(keyed.actor, 'service:phase0-probe');
    assert.equal(anon.authMethod, 'none');
    assert.equal(anon.status, 401);
    assert.equal(anon.actor, undefined);
    assert.equal(mcp.path, '/mcp');
    assert.equal(mcp.authMethod, 'oauth');
    assert.equal(mcp.keyKind, 'oauth');
    assert.equal(mcp.oauthClientId, 'mcpc_phase0');
    const text = JSON.stringify(log);
    for (const secret of [serviceKey, oauthToken, STATIC_TOKEN, 'very-secret-oauth-code']) {
      assert.ok(!text.includes(secret), 'log carries no secret material');
    }
    assert.ok(typeof keyed.durationMs === 'number' && keyed.durationMs >= 0);
  });

  it('a rejected key is logged as none with 401', async () => {
    log.length = 0;
    await call(port, '/api/v1/agents', { authorization: 'Bearer fk_notarealkey000000000000000000000000' });
    await waitForLog(1);
    assert.equal(log[0].status, 401);
    assert.equal(log[0].authMethod, 'none');
    assert.ok(!JSON.stringify(log).includes('fk_notarealkey'));
  });
});

describe('auth-method helpers', () => {
  it('maps keys and bearer actors to methods', () => {
    assert.equal(keyAuthMethod({ secretPrefix: 'fk_at_' }), 'oauth');
    assert.equal(keyAuthMethod({ secretPrefix: 'fk_' }), 'api-key');
    assert.equal(keyAuthMethod({}), 'api-key');
    assert.equal(keyKindOf({ owner: 'user:stephanie' }, 'service:break-glass'), 'person');
    assert.equal(keyKindOf({ owner: 'service:ingest' }, 'service:break-glass'), 'service');
    assert.equal(keyKindOf({ owner: 'service:break-glass' }, 'service:break-glass'), 'break-glass');
    assert.equal(keyKindOf({ owner: 'user:x', secretPrefix: 'fk_at_' }, 'service:break-glass'), 'oauth');
    assert.equal(bearerAuthMethod('token:admin'), 'static-token');
    assert.equal(bearerAuthMethod('oidc:someone@example.com'), 'oidc-bearer');
    assert.equal(bearerAuthMethod('anonymous'), 'insecure-no-auth');
  });

  it('logPath drops query and fragment and caps length', () => {
    assert.equal(logPath('/api/v1/auth/google/callback?code=x&state=y'), '/api/v1/auth/google/callback');
    assert.equal(logPath('/a#frag'), '/a');
    assert.equal(logPath(undefined), '/');
    assert.equal(logPath('/' + 'x'.repeat(400)).length, 256);
  });

  it('buildAuthRequestLogEntry defaults to none and names only non-secret fields', () => {
    const req = { method: 'POST', url: '/token?code=abc', headers: { authorization: 'Bearer secret' } } as unknown as http.IncomingMessage;
    let t = 1000;
    const e = buildAuthRequestLogEntry(req, 400, 990, undefined, () => t);
    assert.deepEqual(e, { event: 'auth.request', ts: new Date(1000).toISOString(), method: 'POST', path: '/token', status: 400, authMethod: 'none', durationMs: 10 });
    requestAuthMethod.set(req, 'google');
    t = 1005;
    assert.equal(buildAuthRequestLogEntry(req, 200, 1000, 'user:dale', () => t).authMethod, 'google');
  });
});
