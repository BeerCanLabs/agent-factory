// Story #365 ([S19] Budget-owner role, Epic #349): D7, D25, D27, D28, S19.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, FileDocBackend, GrantStore, PrincipalStore, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { GroupStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';

const TOKENS = { admin: 'tok-s19-admin', budget: 'tok-s19-budget', viewer: 'tok-s19-viewer', other: 'tok-s19-other' } as const; // secret-scan:allow (test fixture)
const ACTORS: Record<string, string> = {
  [TOKENS.admin]: 'user:admin',
  [TOKENS.budget]: 'user:bea',
  [TOKENS.viewer]: 'user:vic',
  [TOKENS.other]: 'user:otto',
};

function identityOnlyBearer(): AuthProvider {
  return {
    name: 's19-identity-only',
    async verify(authorization) {
      const tok = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const actor = ACTORS[tok];
      return actor ? { ok: true, principal: { actor, roles: [] } } : { ok: false, reason: 'unknown token' };
    },
  };
}

describe('S19: budget-owner allocates agent budget outside submission (#365)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let grants: GrantStore;
  let port = 0;

  const call = async (method: string, path: string, token: string | undefined, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's19-budget-owner-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });
    for (const [id, email] of [
      ['user:admin', 'admin@example.com'],
      ['user:bea', 'bea@example.com'],
      ['user:vic', 'vic@example.com'],
      ['user:otto', 'otto@example.com'],
    ] as const) {
      await principals.create({ id, displayName: id, emails: [email], by: 'user:admin' });
    }
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:vic', scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: identityOnlyBearer(),
      principals,
      grants,
      groups,
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('s19-budget-owner-run-token-key-0123456789abcdef'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => 'a'.repeat(40),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.agents.set('ada', { id: 'ada', name: 'Ada', state: 'PENDING_BUDGET' } as never);
    state.policies.set('ada', { routes: ['anthropic'] } as never);

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('only an admin grants budget-owner (D10), and a second active budget-owner is 409 (AC2)', async () => {
    const byViewer = await call('POST', '/api/v1/grants', TOKENS.viewer, { subject: 'user:bea', scope: { kind: 'fleet' }, role: 'budget-owner' });
    assert.equal(byViewer.status, 403);
    const first = await call('POST', '/api/v1/grants', TOKENS.admin, { subject: 'user:bea', scope: { kind: 'fleet' }, role: 'budget-owner' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await call('POST', '/api/v1/grants', TOKENS.admin, { subject: 'user:otto', scope: { kind: 'fleet' }, role: 'budget-owner' });
    assert.equal(second.status, 409, JSON.stringify(second.body));
  });

  it('the budget-owner allocates budgetUsd, routes stay untouched, BUDGET_ALLOCATED is ledgered (AC1)', async () => {
    const r = await call('PUT', '/api/v1/budget/agents/ada', TOKENS.budget, { budgetUsd: { perDay: 5, perMonth: 50 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.budgetUsd, { perDay: 5, perMonth: 50 });
    const pol = state.policies.get('ada') as { routes?: string[]; budgetUsd?: unknown };
    assert.deepEqual(pol.routes, ['anthropic']);
    assert.deepEqual(pol.budgetUsd, { perDay: 5, perMonth: 50 });
    assert.equal(state.agents.get('ada')?.state, 'PENDING_DEPLOY');
    const rows = ledger.query({ agent: 'ada' }).filter((e) => e.action === 'BUDGET_ALLOCATED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'user:bea');
  });

  it('the allocation endpoint refuses anything but budgetUsd, so routes cannot ride along', async () => {
    for (const body of [{ budgetUsd: { perDay: 1 }, routes: ['openai'] }, { routes: ['openai'] }, { budgetUsd: { perDay: -1 } }, { budgetUsd: { perWeek: 1 } }, {}]) {
      assert.equal((await call('PUT', '/api/v1/budget/agents/ada', TOKENS.budget, body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((state.policies.get('ada') as { routes?: string[] }).routes, ['anthropic']);
  });

  it('the budget-owner is refused content admission, route edits and other admin routes (AC1)', async () => {
    const denied: Array<[string, string, unknown]> = [
      ['PUT', '/api/v1/agents/ada/policy', { routes: ['openai'] }],
      ['PUT', '/api/v1/registry/agents/ada/budget', { spendLimitUsd: 9 }],
      ['POST', '/api/v1/registry/skills/x/versions/1/approve', {}],
      ['POST', '/api/v1/grants', { subject: 'user:otto', scope: { kind: 'fleet' }, role: 'viewer' }],
      ['PUT', '/api/v1/policies/budget', {}],
    ];
    for (const [m, p, b] of denied) {
      const r = await call(m, p, TOKENS.budget, b);
      assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await call('GET', '/api/v1/agents', TOKENS.budget)).status, 200);
  });

  it('a viewer cannot allocate; an admin can as backup (D25)', async () => {
    assert.equal((await call('PUT', '/api/v1/budget/agents/ada', TOKENS.viewer, { budgetUsd: { perDay: 7 } })).status, 403);
    const r = await call('PUT', '/api/v1/budget/agents/ada', TOKENS.admin, { budgetUsd: { perDay: 7 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.budgetUsd, { perDay: 7, perMonth: 50 });
  });

  it('an unknown agent is 404 and nothing is ledgered', async () => {
    const before = ledger.query({}).length;
    assert.equal((await call('PUT', '/api/v1/budget/agents/nope', TOKENS.budget, { budgetUsd: { perDay: 1 } })).status, 404);
    assert.equal((await call('PUT', '/api/v1/budget/agents/%E0%A4%A', TOKENS.budget, { budgetUsd: { perDay: 1 } })).status, 404, 'a malformed escape is not a 500');
    assert.equal(ledger.query({}).length, before);
  });
});
