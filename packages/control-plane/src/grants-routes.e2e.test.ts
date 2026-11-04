// Story #353 ([S3] Principals & Grants API, admin act-as, and MCP tools, Epic #349):
// R4, R5, R6, R7, D6, D7, D10-D15, D23, D24, D26, D30, D32, S3.
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

describe('S3: Principals & Grants API, admin act-as, private skill assignment, and 1:1 MCP tools (#353)', { concurrency: false }, () => {
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
    dir = mkdtempSync(join(tmpdir(), 's3-grants-routes-'));
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

  it('AC1: admin creates Stephanie with Hotmail + Gmail aliases, manages email aliases, grants team member on higgins, and either verified email resolves user:stephanie', async () => {
    // Non-admin cannot create or list principals -> 403 with requiredRole: 'admin'
    const deniedCreate = await call('POST', '/api/v1/principals', {
      token: TOKENS.op,
      body: { id: 'user:stephanie', displayName: 'Stephanie', emails: ['stephaniesackrider@hotmail.com'] },
    });
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.requiredRole, 'admin');

    // Admin creates Stephanie with two verified emails (mixed case normalized to lowercase)
    const created = await call('POST', '/api/v1/principals', {
      token: TOKENS.admin,
      body: {
        id: 'user:stephanie',
        displayName: 'Stephanie Sackrider',
        emails: ['StephanieSackrider@Hotmail.com', 'stephanie.sackrider@Gmail.com'],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.principal.emails, [
      'stephaniesackrider@hotmail.com',
      'stephanie.sackrider@gmail.com',
    ]);

    const principalLedger = ledger.query().filter((e) => e.action === 'PRINCIPAL_CREATED' && e.subject === 'user:stephanie');
    assert.equal(principalLedger.length, 1);
    assert.equal(principalLedger[0].actor, 'user:admin');
    assert.equal(principalLedger[0].before, null);
    assert.equal((principalLedger[0].after as any)?.id, 'user:stephanie');

    // Add a temporary 3rd email alias, test duplicate conflict (409), then remove the 3rd alias
    const addAlias = await call('POST', '/api/v1/principals/user:stephanie/emails', {
      token: TOKENS.admin,
      body: { email: 'steph.alias@example.com' },
    });
    assert.equal(addAlias.status, 200);
    assert.equal(addAlias.body.principal.emails.length, 3);
    assert.ok(ledger.query().some((e) => e.action === 'PRINCIPAL_EMAIL_ADDED' && e.subject === 'user:stephanie'));

    const dupEmail = await call('POST', '/api/v1/principals/user:alice/emails', {
      token: TOKENS.admin,
      body: { email: 'stephaniesackrider@hotmail.com' },
    });
    assert.equal(dupEmail.status, 409);
    assert.equal(dupEmail.body.error, 'duplicate_principal_email');

    const rmAlias = await call('DELETE', '/api/v1/principals/user:stephanie/emails/steph.alias%40example.com', {
      token: TOKENS.admin,
    });
    assert.equal(rmAlias.status, 200);
    assert.equal(rmAlias.body.principal.emails.length, 2);
    assert.ok(ledger.query().some((e) => e.action === 'PRINCIPAL_EMAIL_REMOVED' && e.subject === 'user:stephanie'));

    // #434: an admin renames a principal (friendly display name, id unchanged), ledgered; bad names are refused
    const renamed = await call('PATCH', '/api/v1/principals/user:stephanie', { token: TOKENS.admin, body: { displayName: '  Stephanie S.  ' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.principal.id, 'user:stephanie');
    assert.equal(renamed.body.principal.displayName, 'Stephanie S.');
    const renameRow = ledger.query().find((e) => e.action === 'PRINCIPAL_RENAMED' && e.subject === 'user:stephanie');
    assert.equal(renameRow?.actor, 'user:admin');
    assert.equal((renameRow?.after as any)?.displayName, 'Stephanie S.');
    assert.equal((await call('PATCH', '/api/v1/principals/user:stephanie', { token: TOKENS.admin, body: { displayName: '' } })).status, 400);
    assert.equal((await call('PATCH', '/api/v1/principals/user:nobody', { token: TOKENS.admin, body: { displayName: 'X' } })).status, 404);
    assert.equal((await call('PATCH', '/api/v1/principals/user:stephanie', { body: { displayName: 'Mallory' } })).status, 401);
    assert.equal((await call('PATCH', '/api/v1/principals/user:stephanie', { token: TOKENS.bob, body: { displayName: 'Mallory' } })).status, 403, 'only grants.manage may rename');

    // Removing the last remaining email on a single-email principal returns 409 last_principal_email
    const rmLast = await call('DELETE', '/api/v1/principals/user:alice/emails/alice%40beercanlabs.com', {
      token: TOKENS.admin,
    });
    assert.equal(rmLast.status, 409);
    assert.equal(rmLast.body.error, 'last_principal_email');

    // Admin grants team 'member' on 'higgins' to 'user:stephanie'
    const grantRes = await call('POST', '/api/v1/grants', {
      token: TOKENS.admin,
      body: {
        subject: 'user:stephanie',
        scope: { kind: 'agent', id: 'higgins' },
        role: 'member',
      },
    });
    assert.equal(grantRes.status, 201, JSON.stringify(grantRes.body));
    const grantRow = ledger.query().find((e) => e.action === 'GRANT_CREATED' && e.subject === 'user:stephanie');
    assert.ok(grantRow);
    assert.deepEqual(grantRow.scope, { kind: 'agent', id: 'higgins' });
    assert.equal(grantRow.before, null);
    assert.equal((grantRow.after as any)?.role, 'member');

    // Sign in under BOTH Hotmail and Gmail Cloudflare Access assertions
    for (const email of ['stephaniesackrider@hotmail.com', 'stephanie.sackrider@gmail.com']) {
      const who = await call('GET', '/api/v1/whoami', { cfEmail: email });
      assert.equal(who.status, 200);
      assert.equal(who.body.principal, 'user:stephanie');
      assert.equal(who.body.materialized, true);
      assert.deepEqual(who.body.emails, ['stephaniesackrider@hotmail.com', 'stephanie.sackrider@gmail.com']);
      assert.ok(who.body.privileges.agents.higgins.includes('agents.converse'));
      assert.ok(who.body.privileges.agents.higgins.includes('agents.wake'));
      assert.equal(who.body.privileges.agents['other-team'], undefined);

      // Can converse with higgins under either verified email, with caller.actor === 'user:stephanie'
      const conv = await call('POST', '/api/v1/agents/higgins/conversation', {
        cfEmail: email,
        body: { content: `hello from ${email}` },
      });
      assert.equal(conv.status, 202, JSON.stringify(conv.body));
      const run = state.runs.get(conv.body.runId);
      assert.equal(run?.caller?.actor, 'user:stephanie');

      // Refused 403 on other-team where Stephanie holds no grant
      const deniedOther = await call('POST', '/api/v1/agents/other-team/conversation', {
        cfEmail: email,
        body: { content: 'intrude' },
      });
      assert.equal(deniedOther.status, 403);
      assert.equal(typeof deniedOther.body.requiredRole, 'string');
    }
  });

  it('D6, R5, R7: unknown caller performs zero writes on whoami and authz/check; domain:<domain> auto-materializes on whoami while authz/check stays 100% side-effect-free', async () => {
    const principalsBefore = principals.list().length;
    const grantsBefore = grants.list({ includeExpired: true }).length;
    const ledgerBefore = ledger.query().length;

    // 1. Completely unknown external caller -> zero writes on whoami AND authz/check
    const strangerWho = await call('GET', '/api/v1/whoami', { cfEmail: 'stranger@external.org' });
    assert.equal(strangerWho.status, 200);
    assert.equal(strangerWho.body.materialized, false);
    assert.deepEqual(strangerWho.body.grants, []);
    assert.deepEqual(strangerWho.body.privileges, { fleet: [], agents: {}, skills: {} });

    const strangerCheck = await call('GET', '/api/v1/authz/check?privilege=agents.read', {
      cfEmail: 'stranger@external.org',
    });
    assert.equal(strangerCheck.status, 200);
    assert.equal(strangerCheck.body.allowed, false);
    assert.equal(strangerCheck.body.requiredRole, 'viewer');

    assert.equal(principals.list().length, principalsBefore, 'unknown caller must not write to PrincipalStore');
    assert.equal(grants.list({ includeExpired: true }).length, grantsBefore, 'unknown caller must not write to GrantStore');
    assert.equal(ledger.query().length, ledgerBefore, 'whoami and authz/check must not append ledger noise');

    // S11 AC1: with no principal or domain grant, every endpoint but whoami (and the side-effect-free check) refuses (and writes no principal or grant).
    for (const p of ['/api/v1/agents', '/api/v1/grants', '/api/v1/principals', '/api/v1/runs', '/api/v1/skills']) {
      assert.equal((await call('GET', p, { cfEmail: 'stranger@external.org' })).status, 403, p);
    }
    assert.equal(principals.list().length, principalsBefore);

    // 2. Admin grants fleet 'viewer' to domain:beercanlabs.com
    const domGrant = await call('POST', '/api/v1/grants', {
      token: TOKENS.admin,
      body: {
        subject: 'domain:beercanlabs.com',
        scope: { kind: 'fleet' },
        role: 'viewer',
      },
    });
    assert.equal(domGrant.status, 201);

    const principalsBeforeDomainLogin = principals.list().length;
    const ledgerBeforePreflight = ledger.query().length;

    // 3. Preflight authz/check for unseen newdev@beercanlabs.com evaluates domain grant WITHOUT materializing or ledgering!
    const preflightAllowed = await call('GET', '/api/v1/authz/check?privilege=agents.read', {
      cfEmail: 'newdev@beercanlabs.com',
    });
    assert.equal(preflightAllowed.status, 200);
    assert.deepEqual(preflightAllowed.body, { allowed: true, requiredRole: null });

    const preflightDenied = await call('GET', '/api/v1/authz/check?privilege=grants.manage', {
      cfEmail: 'newdev@beercanlabs.com',
    });
    assert.equal(preflightDenied.status, 200);
    assert.equal(preflightDenied.body.allowed, false);
    assert.equal(preflightDenied.body.requiredRole, 'admin');

    assert.equal(principals.findByEmail('newdev@beercanlabs.com'), undefined, 'authz/check must never materialize principals');
    assert.equal(principals.list().length, principalsBeforeDomainLogin);
    assert.equal(ledger.query().length, ledgerBeforePreflight, 'authz/check must never emit AUTHZ_DENIED');

    // 4. First verified GET /api/v1/whoami materializes newdev@beercanlabs.com and ledgers PRINCIPAL_CREATED
    const devWho = await call('GET', '/api/v1/whoami', { cfEmail: 'newdev@beercanlabs.com' });
    assert.equal(devWho.status, 200);
    assert.equal(devWho.body.materialized, true);
    assert.ok(devWho.body.principal.startsWith('user:'));
    assert.ok(devWho.body.privileges.fleet.includes('agents.read'));
    assert.ok(principals.findByEmail('newdev@beercanlabs.com'));
    assert.ok(
      ledger.query().some(
        (e) => e.action === 'PRINCIPAL_CREATED' && e.actor === 'domain:beercanlabs.com' && e.subject === devWho.body.principal,
      ),
    );
  });

  it('AC2 & delegation ceiling (D7, D10-D15, D24, D32): accountable-lead and content-owner delegate within scope to known subjects only, and last_admin is guarded with 409', async () => {
    // 1. Team accountable-lead (user:lead on 'higgins') lists grants on 'higgins'
    const listOwnTeam = await call('GET', '/api/v1/grants?scopeKind=agent&scopeId=higgins', { token: TOKENS.lead });
    assert.equal(listOwnTeam.status, 200);
    assert.ok(listOwnTeam.body.grants.some((g: any) => g.role === 'accountable-lead' && g.subject === 'user:lead'));

    // accountable-lead cannot list fleet grants or another team's grants
    const listFleetDenied = await call('GET', '/api/v1/grants', { token: TOKENS.lead });
    assert.equal(listFleetDenied.status, 403);
    assert.equal(listFleetDenied.body.requiredRole, 'admin');

    const listOtherTeamDenied = await call('GET', '/api/v1/grants?scopeKind=agent&scopeId=other-team', { token: TOKENS.lead });
    assert.equal(listOtherTeamDenied.status, 403);
    assert.equal(listOtherTeamDenied.body.requiredRole, 'accountable-lead');

    // 2. accountable-lead adds 'member' for known principal user:alice AND known group group:ops-team -> 201
    const addMemberUser = await call('POST', '/api/v1/grants', {
      token: TOKENS.lead,
      body: { subject: 'user:alice', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
    });
    assert.equal(addMemberUser.status, 201, JSON.stringify(addMemberUser.body));

    const addMemberGroup = await call('POST', '/api/v1/grants', {
      token: TOKENS.lead,
      body: { subject: 'group:ops-team', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
    });
    assert.equal(addMemberGroup.status, 201, JSON.stringify(addMemberGroup.body));

    // accountable-lead revokes alice's member grant -> 200 + GRANT_REVOKED ledgered
    const revokeAlice = await call('DELETE', `/api/v1/grants/${addMemberUser.body.grant.id}`, { token: TOKENS.lead });
    assert.equal(revokeAlice.status, 200);
    assert.ok(
      ledger.query().some((e) => e.action === 'GRANT_REVOKED' && e.actor === 'user:lead' && e.subject === 'user:alice'),
    );

    // 3. accountable-lead refused 403 (zero writes, zero GRANT_*/PRINCIPAL_* ledger rows) on unknown email/principal/group, replacing accountable-lead, or fleet/domain grants
    const principalsSnap = principals.list().length;
    const grantsSnap = grants.list({ includeExpired: true }).length;
    const mutLedgerSnap = ledger.query().filter((e) => e.action?.startsWith('GRANT_') || e.action?.startsWith('PRINCIPAL_')).length;

    for (const badBody of [
      { subject: 'unseen@outsider.io', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
      { subject: 'user:nobody', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
      { subject: 'group:ghost', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
      { subject: 'user:alice', scope: { kind: 'agent', id: 'higgins' }, role: 'accountable-lead' },
      { subject: 'user:alice', scope: { kind: 'agent', id: 'higgins' }, role: 'content-owner' },
      { subject: 'user:alice', scope: { kind: 'fleet' }, role: 'viewer' },
      { subject: 'domain:outsider.io', scope: { kind: 'agent', id: 'higgins' }, role: 'member' },
    ]) {
      const res = await call('POST', '/api/v1/grants', { token: TOKENS.lead, body: badBody });
      assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(badBody)}, got ${res.status}`);
      assert.equal(res.body.requiredRole, 'admin');
    }

    // accountable-lead cannot revoke their own accountable-lead grant
    const leadGrant = grants.list({ scopeKind: 'agent', scopeId: 'higgins' }).find((g) => g.role === 'accountable-lead')!;
    const revokeLeadDenied = await call('DELETE', `/api/v1/grants/${leadGrant.id}`, { token: TOKENS.lead });
    assert.equal(revokeLeadDenied.status, 403);
    assert.equal(revokeLeadDenied.body.requiredRole, 'admin');

    assert.equal(principals.list().length, principalsSnap, 'refused non-admin grants must perform zero PrincipalStore writes');
    assert.equal(grants.list({ includeExpired: true }).length, grantsSnap, 'refused non-admin grants must perform zero GrantStore writes');
    assert.equal(
      ledger.query().filter((e) => e.action?.startsWith('GRANT_') || e.action?.startsWith('PRINCIPAL_')).length,
      mutLedgerSnap,
      'refused non-admin grants must append zero GRANT_*/PRINCIPAL_* ledger rows',
    );

    // 4. Admin CAN pre-grant an unseen valid email -> auto-provisions PrincipalStore + ledgers PRINCIPAL_CREATED & GRANT_CREATED
    const preGrant = await call('POST', '/api/v1/grants', {
      token: TOKENS.admin,
      body: {
        subject: 'prehire@example.com',
        subjectDisplayName: 'Pre Hire',
        scope: { kind: 'agent', id: 'higgins' },
        role: 'member',
      },
    });
    assert.equal(preGrant.status, 201, JSON.stringify(preGrant.body));
    const prePrincipal = principals.findByEmail('prehire@example.com');
    assert.ok(prePrincipal);
    assert.equal(preGrant.body.grant.subject, prePrincipal.id);
    assert.ok(ledger.query().some((e) => e.action === 'PRINCIPAL_CREATED' && e.subject === prePrincipal.id));
    assert.ok(ledger.query().some((e) => e.action === 'GRANT_CREATED' && e.subject === prePrincipal.id));

    // 5. Personal agent content-owner (user:alice on 'alice-bot') grants subrole / agent-member to known user, refused on content-owner or when pending-revoked
    const aliceGrant = await call('POST', '/api/v1/grants', {
      token: TOKENS.alice,
      body: { subject: 'user:bob', scope: { kind: 'agent', id: 'alice-bot' }, role: 'agent-member' },
    });
    assert.equal(aliceGrant.status, 201);

    const aliceOwnerTransferBypass = await call('POST', '/api/v1/grants', {
      token: TOKENS.alice,
      body: { subject: 'user:bob', scope: { kind: 'agent', id: 'alice-bot' }, role: 'content-owner' },
    });
    assert.equal(aliceOwnerTransferBypass.status, 403);

    // Downgrade alice's content-owner grant to pending-revoked (simulating in-flight S3b transfer) -> alice becomes read-only
    const tx = await grants.startOwnershipTransfer({
      scope: { kind: 'agent', id: 'alice-bot' },
      fromSubject: 'user:alice',
      toSubject: 'user:bob',
      by: 'user:alice',
    });
    const aliceWhilePending = await call('POST', '/api/v1/grants', {
      token: TOKENS.alice,
      body: { subject: 'user:lead', scope: { kind: 'agent', id: 'alice-bot' }, role: 'agent-member' },
    });
    assert.equal(aliceWhilePending.status, 403);
    assert.equal(aliceWhilePending.body.requiredRole, 'content-owner');
    await grants.resolveOwnershipTransfer({
      transferId: tx.transferId,
      action: 'cancel',
      by: 'user:alice',
    });

    // 6. Last active human admin guard -> 409 last_admin
    const adminFleetGrant = grants.list({ subject: 'user:admin', scopeKind: 'fleet' }).find((g) => g.role === 'admin')!;
    const rmLastAdmin = await call('DELETE', `/api/v1/grants/${adminFleetGrant.id}`, { token: TOKENS.admin });
    assert.equal(rmLastAdmin.status, 409);
    assert.equal(rmLastAdmin.body.error, 'last_admin');
  });

  it('AC3 (R5, D10, D12, D30): X-Factory-Act-As rejects non-admin (403 + AUTHZ_DENIED), validates target, evaluates target permissions, attributes owned content & caller, and ledgers actor + onBehalfOf', async () => {
    // 1. Non-admin supplying X-Factory-Act-As -> 403 + AUTHZ_DENIED
    const deniedActAs = await call('GET', '/api/v1/whoami', {
      token: TOKENS.alice,
      actAs: 'user:stephanie',
    });
    assert.equal(deniedActAs.status, 403);
    assert.equal(deniedActAs.body.requiredRole, 'admin');
    assert.ok(
      ledger.query().some((e) => e.action === 'AUTHZ_DENIED:act_as_requires_admin' && e.actor === 'user:alice'),
    );

    // 2. Admin supplying non-user or unknown principal -> 400 / 404
    const badTarget = await call('GET', '/api/v1/whoami', { token: TOKENS.admin, actAs: 'group:ops-team' });
    assert.equal(badTarget.status, 400);
    const missingTarget = await call('GET', '/api/v1/whoami', { token: TOKENS.admin, actAs: 'user:ghost' });
    assert.equal(missingTarget.status, 404);

    // 3. Admin whoami & authz/check with X-Factory-Act-As: stephaniesackrider@hotmail.com resolves user:stephanie
    const whoActAs = await call('GET', '/api/v1/whoami', {
      token: TOKENS.admin,
      actAs: 'stephaniesackrider@hotmail.com',
    });
    assert.equal(whoActAs.status, 200);
    assert.equal(whoActAs.body.actor, 'user:admin');
    assert.equal(whoActAs.body.principal, 'user:stephanie');
    assert.equal(whoActAs.body.onBehalfOf, 'user:stephanie');
    assert.equal(whoActAs.body.privileges.fleet.includes('grants.manage'), false);
    assert.equal(whoActAs.body.privileges.agents.higgins.includes('agents.converse'), true);

    const checkActAsAdminPriv = await call('GET', '/api/v1/authz/check?privilege=grants.manage', {
      token: TOKENS.admin,
      actAs: 'user:stephanie',
    });
    assert.equal(checkActAsAdminPriv.status, 200);
    assert.equal(checkActAsAdminPriv.body.allowed, false);
    assert.equal(checkActAsAdminPriv.body.requiredRole, 'admin');

    // 4. Admin creates a personal agent with X-Factory-Act-As: user:stephanie -> content-owner is user:stephanie, ledger carries actor + onBehalfOf
    const createForSteph = await call('POST', '/api/v1/agents', {
      token: TOKENS.admin,
      actAs: 'user:stephanie',
      body: {
        id: 'steph-assistant',
        name: 'Stephanie Assistant',
        role: 'Personal Helper',
        kind: 'personal',
        soul: 'Personal helper for Stephanie.',
        memory: { archetype: 'personal-assistant' },
      },
    });
    assert.equal(createForSteph.status, 201, JSON.stringify(createForSteph.body));
    assert.deepEqual(ownersOf(state, 'steph-assistant'), ['user:stephanie']);
    assert.equal(grants.activeContentOwnerOf({ kind: 'agent', id: 'steph-assistant' }), 'user:stephanie');
    const createRow = ledger
      .query({ agent: 'steph-assistant' })
      .find((e) => e.action === 'AGENT_CREATED_FROM_CONFIGURATION');
    assert.ok(createRow);
    assert.equal(createRow.actor, 'user:admin');
    assert.equal(createRow.onBehalfOf, 'user:stephanie');

    // 5. Admin registers a skill with X-Factory-Act-As: user:stephanie -> owner & content-owner grant belong to user:stephanie, ledger carries actor + onBehalfOf
    const regSkill = await call('POST', '/api/v1/registry/skills', {
      token: TOKENS.admin,
      actAs: 'user:stephanie',
      body: {
        repo: 'https://github.com/BeerCanLabs/skill-steph',
        path: '.',
        commit: SHA,
        manifest: skillManifest('steph-skill', '1.0.0'),
      },
    });
    assert.equal(regSkill.status, 201, JSON.stringify(regSkill.body));
    assert.equal(regSkill.body.owner, 'user:stephanie');
    assert.equal(grants.activeContentOwnerOf({ kind: 'skill', id: 'steph-skill' }), 'user:stephanie');
    const skillRow = ledger
      .query()
      .find((e) => e.action === 'SKILL_REGISTERED' && e.agentId === 'skill:steph-skill@1.0.0');
    assert.ok(skillRow);
    assert.equal(skillRow.actor, 'user:admin');
    assert.equal(skillRow.onBehalfOf, 'user:stephanie');

    // 6. Admin converses on behalf of user:stephanie -> caller.actor is user:stephanie and CONVERSATION_HANDOFF records actor + onBehalfOf
    const convActAs = await call('POST', '/api/v1/agents/higgins/conversation', {
      token: TOKENS.admin,
      actAs: 'user:stephanie',
      body: { content: 'acting on behalf of stephanie' },
    });
    assert.equal(convActAs.status, 202);
    const run = state.runs.get(convActAs.body.runId);
    assert.equal(run?.caller?.actor, 'user:stephanie');
    const handoffRows = ledger
      .query({ agent: 'higgins' })
      .filter((e) => e.action === 'CONVERSATION_HANDOFF' && e.onBehalfOf === 'user:stephanie');
    assert.ok(handoffRows.length >= 1);
    assert.equal(handoffRows.at(-1)?.actor, 'user:admin');
  });

  it('D26: private skill is adoptable onto owners personal agent AND team agent where owner holds accountable-lead, and refused 403 on other agents', async () => {
    // Register & pass checks on a private (unpublished) skill owned by user:lead
    const regPriv = await call('POST', '/api/v1/registry/skills', {
      token: TOKENS.admin,
      actAs: 'user:lead',
      body: {
        repo: 'https://github.com/BeerCanLabs/lead-priv-skill',
        path: '.',
        commit: SHA,
        manifest: skillManifest('lead-priv-skill', '1.0.0'),
      },
    });
    assert.equal(regPriv.status, 201, JSON.stringify(regPriv.body));
    recordSkillChecks(state, 'lead-priv-skill', '1.0.0', { passed: true });
    assert.equal(accountableLeadOf(state, 'higgins'), 'user:lead');

    // Register, pass checks, and publish a public skill owned by user:bob
    const regPub = await call('POST', '/api/v1/registry/skills', {
      token: TOKENS.admin,
      actAs: 'user:bob',
      body: {
        repo: 'https://github.com/BeerCanLabs/pub-skill',
        path: '.',
        commit: SHA,
        manifest: skillManifest('pub-skill', '1.0.0'),
      },
    });
    assert.equal(regPub.status, 201, JSON.stringify(regPub.body));
    recordSkillChecks(state, 'pub-skill', '1.0.0', { passed: true });
    skillRegistry(state).decidePublish('pub-skill', 'approve', 'user:admin');

    // 1. user:lead adopts lead-priv-skill onto personal agent 'lead-personal' -> allowed (auto-adopted)
    const adoptOwnPersonal = await call('POST', '/api/v1/agents/lead-personal/skills', {
      token: TOKENS.lead,
      body: { skillId: 'lead-priv-skill', version: '1.0.0' },
    });
    assert.ok(adoptOwnPersonal.status === 200 || adoptOwnPersonal.status === 201, JSON.stringify(adoptOwnPersonal.body));

    // 2. user:lead adopts lead-priv-skill onto team agent 'higgins' (where user:lead holds accountable-lead) -> allowed!
    const adoptLedTeam = await call('POST', '/api/v1/agents/higgins/skills', {
      token: TOKENS.lead,
      body: { skillId: 'lead-priv-skill', version: '1.0.0' },
    });
    assert.ok(adoptLedTeam.status === 200 || adoptLedTeam.status === 201, JSON.stringify(adoptLedTeam.body));

    // 3. Adopting lead-priv-skill onto 'alice-bot' (personal agent owned by user:alice) -> refused 403 even as admin!
    const adoptAliceDenied = await call('POST', '/api/v1/agents/alice-bot/skills', {
      token: TOKENS.admin,
      body: { skillId: 'lead-priv-skill', version: '1.0.0' },
    });
    assert.equal(adoptAliceDenied.status, 403, JSON.stringify(adoptAliceDenied.body));
    assert.equal(adoptAliceDenied.body.error, 'skill_private');
    assert.equal(adoptAliceDenied.body.requiredRole, 'content-owner');

    // 4. Adopting lead-priv-skill onto 'other-team' (team agent led by user:bob) -> refused 403 with requiredRole: 'accountable-lead'
    const adoptOtherTeamDenied = await call('POST', '/api/v1/agents/other-team/skills', {
      token: TOKENS.admin,
      body: { skillId: 'lead-priv-skill', version: '1.0.0' },
    });
    assert.equal(adoptOtherTeamDenied.status, 403, JSON.stringify(adoptOtherTeamDenied.body));
    assert.equal(adoptOtherTeamDenied.body.error, 'skill_private');
    assert.equal(adoptOtherTeamDenied.body.requiredRole, 'accountable-lead');

    // 5. Public/published skill 'pub-skill' IS adoptable onto 'alice-bot'
    const adoptPublic = await call('POST', '/api/v1/agents/alice-bot/skills', {
      token: TOKENS.alice,
      body: { skillId: 'pub-skill', version: '1.0.0' },
    });
    assert.ok(adoptPublic.status === 200 || adoptPublic.status === 201, JSON.stringify(adoptPublic.body));
  });

  it('D23 / S3: 1:1 /mcp parity — tools/list filters by live privileges and tools/call enforces identical delegation ceiling and actAs ledgering', async () => {
    // 1. Scoped human team member (Stephanie via CF JWT, zero fleet roles!) can use /mcp and sees scoped + self tools only
    const stephList = await mcp('tools/list', {}, { cfEmail: 'stephaniesackrider@hotmail.com' });
    assert.equal(stephList.status, 200);
    const stephTools = stephList.rpc.result.tools.map((t: any) => t.name);
    assert.ok(stephTools.includes('whoami'));
    assert.ok(stephTools.includes('authz_check'));
    assert.ok(stephTools.includes('wake_agent'));
    assert.ok(!stephTools.includes('create_principal'));
    assert.ok(!stephTools.includes('list_principals'));

    // Note: Stephanie now owns 'steph-assistant', so she CAN see scoped grant tools (`list_grants`, `grant_role`, `revoke_grant`)!
    assert.ok(stephTools.includes('grant_role'));

    // Pure team member with zero owned agents/skills sees NO grant tools at all
    await principals.create({ id: 'user:memberonly', displayName: 'Member Only', emails: ['memberonly@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:memberonly', scope: { kind: 'agent', id: 'higgins' }, role: 'member', by: 'user:admin', granterIsAdmin: true });
    const memberOnlyList = await mcp('tools/list', {}, { cfEmail: 'memberonly@example.com' });
    assert.equal(memberOnlyList.status, 200);
    const memberOnlyTools = memberOnlyList.rpc.result.tools.map((t: any) => t.name);
    assert.ok(memberOnlyTools.includes('whoami'));
    assert.ok(memberOnlyTools.includes('authz_check'));
    assert.ok(memberOnlyTools.includes('wake_agent'));
    assert.ok(!memberOnlyTools.includes('grant_role'));
    assert.ok(!memberOnlyTools.includes('list_grants'));
    assert.ok(!memberOnlyTools.includes('revoke_grant'));

    // 2. Team accountable-lead (user:lead, zero fleet roles!) sees scoped grant tools, NOT principal-directory admin tools
    const leadList = await mcp('tools/list', {}, { token: TOKENS.lead });
    assert.equal(leadList.status, 200);
    const leadTools = leadList.rpc.result.tools.map((t: any) => t.name);
    assert.ok(leadTools.includes('list_grants'));
    assert.ok(leadTools.includes('grant_role'));
    assert.ok(leadTools.includes('revoke_grant'));
    assert.ok(!leadTools.includes('create_principal'));
    assert.ok(!leadTools.includes('list_principals'));

    // 3. Admin exercises all 9 S3 MCP tools
    const mcpCreatePrincipal = await mcp(
      'tools/call',
      {
        name: 'create_principal',
        arguments: {
          id: 'user:mcpuser',
          displayName: 'MCP User',
          emails: ['mcp1@example.com'],
        },
      },
      { token: TOKENS.admin },
    );
    assert.equal(mcpCreatePrincipal.rpc.error, undefined, JSON.stringify(mcpCreatePrincipal.rpc));
    const createdPrincipalPayload = JSON.parse(mcpCreatePrincipal.rpc.result.content[0].text);
    assert.equal(createdPrincipalPayload.principal.id, 'user:mcpuser');

    const mcpAddEmail = await mcp(
      'tools/call',
      {
        name: 'add_principal_email',
        arguments: { id: 'user:mcpuser', email: 'mcp2@example.com' },
      },
      { token: TOKENS.admin },
    );
    assert.equal(mcpAddEmail.rpc.error, undefined);
    assert.equal(JSON.parse(mcpAddEmail.rpc.result.content[0].text).principal.emails.length, 2);

    const mcpRemoveEmail = await mcp(
      'tools/call',
      {
        name: 'remove_principal_email',
        arguments: { id: 'user:mcpuser', email: 'mcp2@example.com' },
      },
      { token: TOKENS.admin },
    );
    assert.equal(mcpRemoveEmail.rpc.error, undefined);
    assert.equal(JSON.parse(mcpRemoveEmail.rpc.result.content[0].text).principal.emails.length, 1);

    const mcpListPrincipals = await mcp(
      'tools/call',
      { name: 'list_principals', arguments: { id: 'user:mcpuser' } },
      { token: TOKENS.admin },
    );
    assert.equal(mcpListPrincipals.rpc.error, undefined);
    assert.equal(JSON.parse(mcpListPrincipals.rpc.result.content[0].text).principal.id, 'user:mcpuser');

    // accountable-lead grants 'member' to known user:mcpuser via MCP grant_role, then lists & revokes via MCP
    const leadMcpGrant = await mcp(
      'tools/call',
      {
        name: 'grant_role',
        arguments: {
          subject: 'user:mcpuser',
          scope: { kind: 'agent', id: 'higgins' },
          role: 'member',
        },
      },
      { token: TOKENS.lead },
    );
    assert.equal(leadMcpGrant.rpc.error, undefined, JSON.stringify(leadMcpGrant.rpc));
    const mcpGrantId = JSON.parse(leadMcpGrant.rpc.result.content[0].text).grant.id;

    // accountable-lead refused via MCP when granting to unknown email (identical ceiling rule, zero duplicated code)
    const leadMcpDenied = await mcp(
      'tools/call',
      {
        name: 'grant_role',
        arguments: {
          subject: 'unknown-mcp@outsider.io',
          scope: { kind: 'agent', id: 'higgins' },
          role: 'member',
        },
      },
      { token: TOKENS.lead },
    );
    assert.equal(leadMcpDenied.rpc.error.code, -32001);
    assert.equal(leadMcpDenied.rpc.error.data.requiredRole, 'admin');

    const leadMcpListGrants = await mcp(
      'tools/call',
      { name: 'list_grants', arguments: { scopeKind: 'agent', scopeId: 'higgins' } },
      { token: TOKENS.lead },
    );
    assert.equal(leadMcpListGrants.rpc.error, undefined);
    assert.ok(JSON.parse(leadMcpListGrants.rpc.result.content[0].text).grants.some((g: any) => g.id === mcpGrantId));

    const leadMcpRevoke = await mcp(
      'tools/call',
      { name: 'revoke_grant', arguments: { id: mcpGrantId } },
      { token: TOKENS.lead },
    );
    assert.equal(leadMcpRevoke.rpc.error, undefined);

    // MCP whoami & authz_check + MCP tool-level actAs enforcement & ledgering
    const nonAdminMcpActAs = await mcp(
      'tools/call',
      { name: 'whoami', arguments: { actAs: 'user:stephanie' } },
      { token: TOKENS.lead },
    );
    assert.equal(nonAdminMcpActAs.rpc.error.code, -32001);
    assert.equal(nonAdminMcpActAs.rpc.error.data.requiredRole, 'admin');

    const adminMcpWhoamiActAs = await mcp(
      'tools/call',
      { name: 'whoami', arguments: { actAs: 'user:stephanie' } },
      { token: TOKENS.admin },
    );
    assert.equal(adminMcpWhoamiActAs.rpc.error, undefined);
    const mcpWhoPayload = JSON.parse(adminMcpWhoamiActAs.rpc.result.content[0].text);
    assert.equal(mcpWhoPayload.principal, 'user:stephanie');
    assert.equal(mcpWhoPayload.onBehalfOf, 'user:stephanie');

    const adminMcpAuthzCheck = await mcp(
      'tools/call',
      {
        name: 'authz_check',
        arguments: { privilege: 'agents.converse', agentId: 'higgins', actAs: 'user:stephanie' },
      },
      { token: TOKENS.admin },
    );
    assert.equal(adminMcpAuthzCheck.rpc.error, undefined);
    assert.deepEqual(JSON.parse(adminMcpAuthzCheck.rpc.result.content[0].text), {
      allowed: true,
      requiredRole: null,
    });

    // Admin wake_agent via MCP with actAs: 'user:stephanie' sets caller.actor to user:stephanie and ledgers onBehalfOf
    const adminMcpWakeActAs = await mcp(
      'tools/call',
      { name: 'wake_agent', arguments: { id: 'higgins', actAs: 'user:stephanie' } },
      { token: TOKENS.admin },
    );
    assert.equal(adminMcpWakeActAs.rpc.error, undefined, JSON.stringify(adminMcpWakeActAs.rpc));
    const wokePayload = JSON.parse(adminMcpWakeActAs.rpc.result.content[0].text);
    const mcpRun = state.runs.get(wokePayload.runId);
    assert.equal(mcpRun?.caller?.actor, 'user:stephanie');
    assert.ok(
      ledger.query({ agent: 'higgins' }).some(
        (e) => e.runId === wokePayload.runId && e.actor === 'user:admin' && e.onBehalfOf === 'user:stephanie',
      ),
    );
  });

  it('skill content-owner delegates skill-scoped grants within ceiling, D26 applies on agent creation & authz/check, and unhealthy stores fail closed (503)', async () => {
    // 1. Stephanie (content-owner of steph-skill) delegates 'member' on skill:steph-skill to known user:alice
    const stephSkillGrant = await call('POST', '/api/v1/grants', {
      cfEmail: 'stephaniesackrider@hotmail.com',
      body: { subject: 'user:alice', scope: { kind: 'skill', id: 'steph-skill' }, role: 'member' },
    });
    assert.equal(stephSkillGrant.status, 201, JSON.stringify(stephSkillGrant.body));

    const stephSkillList = await call('GET', '/api/v1/grants?scopeKind=skill&scopeId=steph-skill', {
      cfEmail: 'stephaniesackrider@hotmail.com',
    });
    assert.equal(stephSkillList.status, 200);
    assert.equal(stephSkillList.body.grants.length, 2);

    // Refused 403 on unseen email or content-owner role
    const stephUnseen = await call('POST', '/api/v1/grants', {
      cfEmail: 'stephaniesackrider@hotmail.com',
      body: { subject: 'stranger-skill@outsider.io', scope: { kind: 'skill', id: 'steph-skill' }, role: 'member' },
    });
    assert.equal(stephUnseen.status, 403);
    assert.equal(stephUnseen.body.requiredRole, 'admin');

    const stephRevoke = await call('DELETE', `/api/v1/grants/${stephSkillGrant.body.grant.id}`, {
      cfEmail: 'stephaniesackrider@hotmail.com',
    });
    assert.equal(stephRevoke.status, 200);

    // 2. D26 on POST /api/v1/agents creation & GET /api/v1/authz/check
    const checkAdoptLeadTeam = await call(
      'GET',
      '/api/v1/authz/check?privilege=skills.adopt.request&agentId=higgins&skillId=lead-priv-skill',
      { token: TOKENS.lead },
    );
    assert.deepEqual(checkAdoptLeadTeam.body, { allowed: true, requiredRole: null });

    const checkAdoptOtherTeam = await call(
      'GET',
      '/api/v1/authz/check?privilege=skills.adopt.request&agentId=other-team&skillId=lead-priv-skill',
      { token: TOKENS.admin },
    );
    assert.equal(checkAdoptOtherTeam.body.allowed, false);
    assert.equal(checkAdoptOtherTeam.body.requiredRole, 'accountable-lead');

    const createAliceWithLeadSkill = await call('POST', '/api/v1/agents', {
      token: TOKENS.admin,
      actAs: 'user:alice',
      body: {
        id: 'alice-priv-attempt',
        name: 'Alice Priv Attempt',
        role: 'Agent',
        kind: 'personal',
        soul: 'Helper.',
        memory: { archetype: 'personal-assistant' },
        skills: [{ id: 'lead-priv-skill', version: '1.0.0' }],
      },
    });
    assert.equal(createAliceWithLeadSkill.status, 403);
    assert.equal(createAliceWithLeadSkill.body.requiredRole, 'content-owner');

    // 3. Fail-closed 503 when GrantStore is unhealthy (R8, D32)
    const savedGrants = state.grants!;
    state.grants = new Proxy(savedGrants, {
      get(target, prop, receiver) {
        if (prop === 'healthy') return false;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      assert.equal((await call('GET', '/api/v1/whoami', { token: TOKENS.admin })).status, 503);
      assert.equal((await call('GET', '/api/v1/authz/check?privilege=agents.read', { token: TOKENS.admin })).status, 503);
      assert.equal((await call('GET', '/api/v1/grants', { token: TOKENS.admin })).status, 503);
      const unhealthyMcp = await mcp('tools/list', {}, { token: TOKENS.admin });
      assert.equal(unhealthyMcp.status, 503);
    } finally {
      state.grants = savedGrants;
    }
  });
});
