// DESIGN_AUTHORITY.md §6.12 A2: the control plane grants a role only from a credential it verifies itself.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, cloudflareAccessAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { BUILTIN_SYSTEM_AGENTS } from './catalog.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore, RunTokens } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { ScheduleStore } from './schedules.js';

const TEAM = 'team.example.cloudflareaccess.com';
const AUD = 'aud-tag-e2e';
const ADMIN_EMAIL = 'owner@example.com';
const ADMIN_TOKEN = 'admin-token-access-e2e'; // secret-scan:allow (test fixture)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(claims: Record<string, unknown>, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 300, ...claims })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

async function call(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function makeState(access?: FactoryState['access']): FactoryState {
  const state = {
    agents: new Map(BUILTIN_SYSTEM_AGENTS.map((b) => [b.id, structuredClone(b)])),
    ledger: new MemoryLedger(),
    auth: bearerAuth([{ name: 'admin', token: ADMIN_TOKEN, roles: ['admin'] }]),
    access,
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
  };
  return state as unknown as FactoryState;
}

async function serve(state: FactoryState) {
  const server = createFactoryServer(state);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return { server, port: a.port };
}

const FORGED = { 'cf-access-authenticated-user-email': ADMIN_EMAIL };

describe('A2 identity is verified, not asserted (control plane)', { concurrency: false }, () => {
  let on: { server: http.Server; port: number };
  let off: { server: http.Server; port: number };

  before(async () => {
    const access = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, adminEmails: [ADMIN_EMAIL], fetchJwks: async () => ({ keys: [jwk] }) });
    on = await serve(makeState(access));
    off = await serve(makeState(undefined));
  });
  after(() => {
    on.server.close();
    off.server.close();
  });

  it('a forged cf-access-authenticated-user-email header alone gets 401 everywhere', async () => {
    for (const { port } of [on, off]) {
      assert.equal((await call(port, '/api/v1/agents', FORGED)).status, 401);
      assert.equal((await call(port, '/api/v1/registry/agents', FORGED, 'POST', {})).status, 401);
      assert.equal((await call(port, '/api/v1/schedules', FORGED)).status, 401);
      assert.equal((await call(port, '/api/v1/schedules', FORGED, 'POST', { agentId: 'echo-agent', cron: '* * * * *', prompt: 'x' })).status, 401);
      assert.equal((await call(port, '/api/v1/whoami', FORGED)).status, 401);
    }
  });

  it('an unsigned, forged or foreign assertion gets 401', async () => {
    const unsigned = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], exp: 9e9, email: ADMIN_EMAIL })}.`;
    const bad = [unsigned, assertion({ email: ADMIN_EMAIL }, forger), assertion({ email: ADMIN_EMAIL, aud: ['another-app'] }), assertion({ email: ADMIN_EMAIL, iss: 'https://other.cloudflareaccess.com' })];
    for (const a of bad) {
      assert.equal((await call(on.port, '/api/v1/agents', { 'cf-access-jwt-assertion': a, ...FORGED })).status, 401);
      assert.equal((await call(on.port, '/api/v1/agents', { cookie: `CF_Authorization=${a}` })).status, 401);
    }
  });

  it('with Access identity disabled, even a valid assertion grants nothing', async () => {
    assert.equal((await call(off.port, '/api/v1/agents', { 'cf-access-jwt-assertion': assertion({ email: ADMIN_EMAIL }) })).status, 401);
  });

  it('a verified admin assertion (header or cookie) maps to the admin roles', async () => {
    const a = assertion({ email: ADMIN_EMAIL });
    const who = await call(on.port, '/api/v1/whoami', { 'cf-access-jwt-assertion': a });
    assert.deepEqual(who.body, { actor: `cloudflare:${ADMIN_EMAIL}`, roles: ['admin', 'operator', 'approver', 'viewer', 'ingest'] });
    assert.equal((await call(on.port, '/api/v1/agents', { cookie: `x=1; CF_Authorization=${a}` })).status, 200);
    // Admin route: past authentication and authorization (whatever registration then decides).
    const admin = await call(on.port, '/api/v1/registry/agents', { 'cf-access-jwt-assertion': a }, 'POST', {});
    assert.ok(![401, 403].includes(admin.status), `admin route refused: ${admin.status}`);
    assert.equal((await call(on.port, '/api/v1/schedules', { 'cf-access-jwt-assertion': a })).status, 200);
  });

  it('another verified user is a viewer; a service token has no roles', async () => {
    const viewer = assertion({ email: 'someone@example.com' });
    assert.equal((await call(on.port, '/api/v1/agents', { 'cf-access-jwt-assertion': viewer })).status, 200);
    assert.equal((await call(on.port, '/api/v1/registry/agents', { 'cf-access-jwt-assertion': viewer }, 'POST', {})).status, 403);
    const service = assertion({ common_name: 'deploy-check.access', sub: '' });
    assert.deepEqual((await call(on.port, '/api/v1/whoami', { 'cf-access-jwt-assertion': service })).body, { actor: 'cloudflare-service:deploy-check.access', roles: [] });
    assert.equal((await call(on.port, '/api/v1/agents', { 'cf-access-jwt-assertion': service })).status, 403);
    assert.equal((await call(on.port, '/api/v1/schedules', { 'cf-access-jwt-assertion': service })).status, 403);
  });

  it('bearer tokens keep working, alongside a service-token assertion', async () => {
    const service = assertion({ common_name: 'deploy-check.access', sub: '' });
    const r = await call(on.port, '/api/v1/whoami', { authorization: `Bearer ${ADMIN_TOKEN}`, 'cf-access-jwt-assertion': service });
    assert.deepEqual(r.body, { actor: 'token:admin', roles: ['admin'] });
    assert.equal((await call(off.port, '/api/v1/agents', { authorization: `Bearer ${ADMIN_TOKEN}` })).status, 200);
  });
});
