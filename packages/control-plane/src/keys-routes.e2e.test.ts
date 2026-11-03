// Story #357 ([S5] Factory API keys, Epic #349): R6, D3, D10, D14, D23. Harness shared with the S3 grants e2e.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, cloudflareAccessAuth, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import {
  ApiKeyStore,
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  PrincipalStore,
  type GrantsDoc,
  type PrincipalsDoc,
} from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdpConfigStore } from './idp-config.js';
import { IdentityLinkStore } from './identity-links.js';
import { accountableLeadOf, ownersOf } from './config-store.js';
import { loadSkills, recordSkillChecks, skillRegistry } from './skills.js';

const TEAM = 's3-grants.example.cloudflareaccess.com';
const AUD = 's3-grants-aud';
const SHA = '9'.repeat(40);
const RUNTIME_SHA = 'c'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:s3';
const RUN_KEY = 's3-grants-routes-run-token-key-0123456789abcdef'; // secret-scan:allow (test fixture)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 's3-k1', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function cfAssertion(email: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 's3-k1' })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 300,
    email,
    email_verified: true,
    ...extra,
  })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const TOKENS = {
  admin: 'tok-s3-admin', // secret-scan:allow (test fixture)
  admin2: 'tok-s3-admin2', // secret-scan:allow (test fixture)
  lead: 'tok-s3-lead', // secret-scan:allow (test fixture)
  alice: 'tok-s3-alice', // secret-scan:allow (test fixture)
  bob: 'tok-s3-bob', // secret-scan:allow (test fixture)
  op: 'tok-s3-op', // secret-scan:allow (test fixture)
} as const;

const ACTORS: Record<string, { actor: string }> = {
  [TOKENS.admin]: { actor: 'user:admin' },
  [TOKENS.admin2]: { actor: 'user:admin2' },
  [TOKENS.lead]: { actor: 'user:lead' },
  [TOKENS.alice]: { actor: 'user:alice' },
  [TOKENS.bob]: { actor: 'user:bob' },
  [TOKENS.op]: { actor: 'user:op' },
};

function identityOnlyBearer(): AuthProvider {
  return {
    name: 's3-identity-only',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) {
        return { ok: false, reason: 'missing bearer' };
      }
      const tok = authorization.slice('Bearer '.length).trim();
      const entry = ACTORS[tok];
      if (!entry) return { ok: false, reason: 'unknown token' };
      return { ok: true, principal: { actor: entry.actor, roles: [] } };
    },
  };
}

const skillManifest = (id: string, version: string, extra: Record<string, unknown> = {}) => ({
  id,
  version,
  name: id,
  description: `Skill ${id}`,
  language: 'python',
  entry: id.replace(/-/g, '_'),
  requires: { routes: [] },
  ...extra,
});

describe('S5: factory API keys (#357)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let principals: PrincipalStore;
  let grants: GrantStore;
  let groups: GroupStore;
  let port = 0;

  const call = async (
    method: string,
    path: string,
    opts: {
      token?: string;
      cfEmail?: string;
      actAs?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cfEmail) headers['cf-access-jwt-assertion'] = cfAssertion(opts.cfEmail);
    if (opts.actAs !== undefined) headers['x-factory-act-as'] = opts.actAs;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.body === undefined || method === 'GET' ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const mcp = async (
    method: string,
    params: unknown,
    opts: { token?: string; cfEmail?: string; actAsHeader?: string } = {},
  ) => {
    const res = await call('POST', '/mcp', {
      token: opts.token,
      cfEmail: opts.cfEmail,
      actAs: opts.actAsHeader,
      body: { jsonrpc: '2.0', id: 1, method, params },
    });
    return { status: res.status, rpc: res.body as Record<string, any> };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's5-keys-'));
    ledger = new MemoryLedger();
    principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    groups = await GroupStore.open(join(dir, 'groups'));
    grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });

    // Seed baseline principals
    for (const [id, email, name] of [
      ['user:admin', 'admin@beercanlabs.com', 'Dale Admin'],
      ['user:admin2', 'admin2@beercanlabs.com', 'Backup Admin'],
      ['user:lead', 'lead@beercanlabs.com', 'Higgins Lead'],
      ['user:alice', 'alice@beercanlabs.com', 'Alice Owner'],
      ['user:bob', 'bob@beercanlabs.com', 'Bob Owner'],
      ['user:op', 'op@beercanlabs.com', 'Fleet Operator'],
    ] as const) {
      await principals.create({ id, displayName: name, emails: [email], by: 'user:admin' });
    }

    // Seed fleet grants for admin and operator ONLY; lead, alice, and bob hold scoped grants only (zero fleet roles!)
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:op', scope: { kind: 'fleet' }, role: 'operator', by: 'user:admin', granterIsAdmin: true });

    await groups.createGroup({ id: 'ops-team', name: 'Ops Team', roles: [], members: ['user:op'] });

    const access = cloudflareAccessAuth({
      teamDomain: TEAM,
      audience: AUD,
      identityOnly: true,
      fetchJwks: async () => ({ keys: [jwk] }),
    });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: identityOnlyBearer(),
      access,
      principals,
      grants,
      groups,
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      schedules: new ScheduleStore(),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(RUN_KEY),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: {
        'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never,
      },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async (agentId: string, source: { commit: string }) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId: string) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;

    state.keys = await ApiKeyStore.open();
    state.idpConfig = await IdpConfigStore.open();
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;

    // Seed team agents ('higgins' led by user:lead, 'other-team' led by user:bob) and personal agents ('lead-personal', 'alice-bot')
    for (const spec of [
      { id: 'higgins', kind: 'team', accountableLead: 'user:lead', token: TOKENS.admin },
      { id: 'other-team', kind: 'team', accountableLead: 'user:bob', token: TOKENS.admin },
    ]) {
      const created = await call('POST', '/api/v1/agents', {
        token: spec.token,
        body: {
          id: spec.id,
          name: spec.id,
          role: 'Team Agent',
          kind: spec.kind,
          accountableLead: spec.accountableLead,
          soul: 'Helpful team assistant.',
          memory: { archetype: 'team-member' },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      state.policies.set(spec.id, { models: ['gemini-2.0-flash'], budgetUsd: { perDay: 10, perMonth: 100 } } as never);
    }

    for (const [agentId, owner] of [
      ['lead-personal', 'user:lead'],
      ['alice-bot', 'user:alice'],
    ] as const) {
      const created = await call('POST', '/api/v1/agents', {
        token: TOKENS.admin,
        actAs: owner,
        body: {
          id: agentId,
          name: agentId,
          role: 'Personal Agent',
          kind: 'personal',
          soul: 'Helpful personal assistant.',
          memory: { archetype: 'personal-assistant' },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      state.policies.set(agentId, { models: ['gemini-2.0-flash'], budgetUsd: { perDay: 10, perMonth: 100 } } as never);
    }
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

  it('AC1: an admin-minted non-expiring tesla key for Stephanie converses with higgins while granted, 403 after the grant is revoked, 401 once the key is revoked', async () => {
    await principals.create({ id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephanie@example.com'], by: 'user:admin' });
    const g = await grants.grant({ subject: 'user:stephanie', scope: { kind: 'agent', id: 'higgins' }, role: 'member', by: 'user:admin', granterIsAdmin: true });
    const minted = await call('POST', '/api/v1/keys', {
      token: TOKENS.admin,
      actAs: 'user:stephanie',
      body: { deviceFamily: 'tesla', scopes: { agents: ['higgins'], privileges: ['agents.converse', 'mcp.use'] }, expiresAt: null },
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const secret: string = minted.body.secret;
    assert.match(secret, /^fk_/);
    assert.equal(minted.body.key.owner, 'user:stephanie');
    assert.equal(minted.body.key.expiresAt, null);
    assert.equal(minted.body.key.hash, undefined, 'the hash never leaves the store');
    assert.ok(!JSON.stringify(ledger.query()).includes(secret), 'the plaintext is never ledgered');

    const ok = await call('POST', '/api/v1/agents/higgins/conversation', { headers: bearer(secret), body: { content: 'hi' } });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(state.runs.get(ok.body.runId)?.caller?.actor, 'user:stephanie');
    const mcpOk = await call('POST', '/mcp', { headers: bearer(secret), body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    assert.equal(mcpOk.status, 200);

    // Outside the key's scopes: refused even though nothing else changed
    const other = await call('POST', '/api/v1/agents/other-team/conversation', { headers: bearer(secret), body: { content: 'x' } });
    assert.equal(other.status, 403);

    await grants.revoke(g.id, { by: 'user:admin' });
    const denied = await call('POST', '/api/v1/agents/higgins/conversation', { headers: bearer(secret), body: { content: 'hi' } });
    assert.equal(denied.status, 403, 'live intersection: the owner lost the grant');

    const revoked = await call('DELETE', `/api/v1/keys/${minted.body.key.id}`, { token: TOKENS.admin });
    assert.equal(revoked.status, 200);
    for (const p of ['/api/v1/agents', '/mcp']) {
      const r = await call(p === '/mcp' ? 'POST' : 'GET', p, { headers: bearer(secret), body: p === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined });
      assert.equal(r.status, 401, p);
      assert.equal(r.body.error, 'invalid_key');
    }
  });

  it('S16 AC2: a health-probe machine key gets 200 from /healthz and /api/v1/health; a revoked one gets 401', async () => {
    const minted = await call('POST', '/api/v1/keys', { token: TOKENS.alice, body: { deviceFamily: 'health-probe' } });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    for (const p of ['/healthz', '/api/v1/health']) assert.equal((await call('GET', p, { headers: bearer(minted.body.secret) })).status, 200, p);
    assert.equal((await call('DELETE', `/api/v1/keys/${minted.body.key.id}`, { token: TOKENS.alice })).status, 200);
    assert.equal((await call('GET', '/healthz', { headers: bearer(minted.body.secret) })).status, 401);
  });

  it('AC2: a second active tesla key is 409; rotate with graceSeconds issues a new secret on the same record and the old one works only inside the grace window', async () => {
    const first = await call('POST', '/api/v1/keys', { token: TOKENS.alice, body: { deviceFamily: 'tesla' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const dup = await call('POST', '/api/v1/keys', { token: TOKENS.alice, body: { deviceFamily: 'tesla' } });
    assert.equal(dup.status, 409);
    const rot = await call('POST', `/api/v1/keys/${first.body.key.id}/rotate`, { token: TOKENS.alice, body: { graceSeconds: 60 } });
    assert.equal(rot.status, 200);
    assert.equal(rot.body.key.id, first.body.key.id);
    assert.notEqual(rot.body.secret, first.body.secret);
    for (const s of [first.body.secret, rot.body.secret]) {
      assert.equal((await call('GET', '/api/v1/whoami', { headers: bearer(s) })).status, 200);
    }
    const noGrace = await call('POST', `/api/v1/keys/${first.body.key.id}/rotate`, { token: TOKENS.alice, body: {} });
    assert.equal((await call('GET', '/api/v1/whoami', { headers: bearer(rot.body.secret) })).status, 401, 'no grace: the previous secret stops at once');
    assert.equal((await call('GET', '/api/v1/whoami', { headers: bearer(noGrace.body.secret) })).status, 200);
  });

  it('only admins mint for others or mint service keys; keys cannot mint keys; an unknown fk_ is refused before routing', async () => {
    assert.equal((await call('POST', '/api/v1/keys', { token: TOKENS.bob, body: { owner: 'user:alice', deviceFamily: 'cli' } })).status, 403);
    assert.equal((await call('POST', '/api/v1/keys', { token: TOKENS.bob, body: { owner: 'service:ingest', roles: ['ingest'] } })).status, 403);
    const svc = await call('POST', '/api/v1/keys', { token: TOKENS.admin, body: { owner: 'service:ingest', roles: ['ingest'] } });
    assert.equal(svc.status, 201, JSON.stringify(svc.body));
    const mine = await call('POST', '/api/v1/keys', { token: TOKENS.bob, body: { deviceFamily: 'laptop' } });
    assert.equal((await call('POST', '/api/v1/keys', { headers: bearer(mine.body.secret), body: { deviceFamily: 'phone' } })).status, 403);
    const listed = await call('GET', '/api/v1/keys', { token: TOKENS.bob });
    assert.ok(listed.body.keys.every((k: { owner: string }) => k.owner === 'user:bob'));
    const bogus = await call('POST', '/api/v1/agents', { headers: bearer('fk_not-a-real-key'), body: { id: 'x' } });
    assert.equal(bogus.status, 401);
  });

  it('S6 AC2: a break-glass call is ledgered and whoami/status flag breakGlassAlert until the key is rotated; IdP setup is admin-only', async () => {
    const bg = await call('POST', '/api/v1/keys', { token: TOKENS.admin, body: { owner: 'service:break-glass', roles: ['admin'] } });
    assert.equal(bg.status, 201, JSON.stringify(bg.body));
    assert.equal((await call('GET', '/api/v1/setup/status', { token: TOKENS.alice })).body.breakGlassAlert, false);
    const used = await call('GET', '/api/v1/agents', { headers: bearer(bg.body.secret) });
    assert.equal(used.status, 200);
    assert.ok(ledger.query().some((e) => e.action === 'BREAK_GLASS_USED'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call('GET', '/api/v1/whoami', { token: TOKENS.alice })).body.breakGlassAlert, true);
    assert.equal((await call('GET', '/api/v1/setup/status', { token: TOKENS.alice })).body.breakGlassAlert, true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await call('POST', `/api/v1/keys/${bg.body.key.id}/rotate`, { token: TOKENS.admin, body: {} })).status, 200);
    assert.equal((await call('GET', '/api/v1/whoami', { token: TOKENS.alice })).body.breakGlassAlert, false);

    const idp = { providers: [{ id: 'google', clientId: 'cid', clientSecretRef: 'factory/prod/GOOGLE_OAUTH', allowedDomains: ['sackrider.org'] }] };
    assert.equal((await call('PUT', '/api/v1/setup/idp', { token: TOKENS.alice, body: idp })).status, 403);
    assert.equal((await call('PUT', '/api/v1/setup/idp', { token: TOKENS.admin, body: { providers: [{ id: 'google', clientId: 'x', clientSecret: 'nope' }] } })).status, 400);
    assert.equal((await call('PUT', '/api/v1/setup/idp', { token: TOKENS.admin, body: idp })).status, 200);
    const st = await call('GET', '/api/v1/setup/status', { token: TOKENS.alice });
    assert.equal(st.body.setupComplete, true);
    assert.deepEqual(st.body.providers, ['google']);
  });
});
