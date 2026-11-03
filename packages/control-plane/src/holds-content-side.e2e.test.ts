// Story #368 ([S22] Holds to content side, Epic #349): D7, D11, D29, S22.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
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

const PEOPLE = ['admin', 'dale', 'stephanie', 'approver', 'lead', 'mia', 'max', 'outsider'] as const;
const tok = (p: string) => `tok-s22-${p}`; // secret-scan:allow (test fixture)

function identityOnlyBearer(): AuthProvider {
  return {
    name: 's22-identity-only',
    async verify(authorization) {
      const t = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const who = PEOPLE.find((p) => tok(p) === t);
      return who ? { ok: true, principal: { actor: `user:${who}`, roles: [] } } : { ok: false, reason: 'unknown token' };
    },
  };
}

describe('S22: run-time holds go to the content side (#368)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;

  const decide = async (id: string, who: string, extraHeaders: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(who)}`, ...extraHeaders },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const hold = (agentId: string) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'token:operator', trigger: 'manual', requestedBy: { provider: 'discord', id: '201' } });
    const argsSha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
    return state.approvals.hold({
      runId: run.runId,
      agentId,
      route: 'linkedin',
      tool: 'POST /posts',
      argsSha256,
      request: { method: 'POST', path: '/posts', headers: {}, body: '{}', bodyEncoding: 'utf8' },
    }).approval.approvalId;
  };

  const cleared = (id: string) => ledger.query({}).filter((e) => e.action === 'HOLD_CLEARED' && e.approvalId === id);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's22-holds-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });
    for (const p of PEOPLE) await principals.create({ id: `user:${p}`, displayName: p, emails: [`${p}@example.com`], by: 'user:admin' });
    const g = (subject: string, scope: { kind: 'fleet' } | { kind: 'agent'; id: string }, role: string) =>
      grants.grant({ subject, scope, role, by: 'user:admin', granterIsAdmin: true } as never);
    await g('user:admin', { kind: 'fleet' }, 'admin');
    await g('user:approver', { kind: 'fleet' }, 'approver');
    for (const p of ['dale', 'stephanie', 'lead', 'mia', 'max', 'outsider']) await g(`user:${p}`, { kind: 'fleet' }, 'viewer');

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
      runTokens: new RunTokens('s22-holds-run-token-key-0123456789abcdef'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.agents.set('donna', { id: 'donna', name: 'Donna', state: 'SLEEPING', kind: 'personal' } as never);
    state.agents.set('higgins', { id: 'higgins', name: 'Higgins', state: 'SLEEPING', kind: 'team' } as never);
    await g('user:dale', { kind: 'agent', id: 'donna' }, 'content-owner');
    await g('user:stephanie', { kind: 'agent', id: 'donna' }, 'Family');
    await g('user:lead', { kind: 'agent', id: 'higgins' }, 'accountable-lead');
    await g('user:mia', { kind: 'agent', id: 'higgins' }, 'member');
    await g('user:max', { kind: 'agent', id: 'higgins' }, 'member');

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('personal agent: Stephanie (agent-member, and the requester) and a fleet approver get 403; Dale (content-owner) clears it (AC1)', async () => {
    const id = hold('donna');
    for (const who of ['stephanie', 'approver', 'outsider', 'mia']) {
      const r = await decide(id, who);
      assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(state.approvals.get(id)?.state, 'pending');
    assert.equal(cleared(id).length, 0);
    const ok = await decide(id, 'dale');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const rows = cleared(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'user:dale');
  });

  it('team agent: any member clears it and HOLD_CLEARED records that member (AC2); the lead may too; outsiders and the approver may not', async () => {
    for (const who of ['mia', 'max', 'lead']) {
      const id = hold('higgins');
      for (const no of ['approver', 'outsider', 'dale', 'stephanie']) assert.equal((await decide(id, no)).status, 403, no);
      const ok = await decide(id, who);
      assert.equal(ok.status, 200, `${who}: ${JSON.stringify(ok.body)}`);
      const rows = cleared(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].actor, `user:${who}`);
    }
  });

  it('an admin acting as the content-owner clears it, and HOLD_CLEARED carries both', async () => {
    const id = hold('donna');
    const ok = await decide(id, 'admin', { 'x-factory-act-as': 'user:dale' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const rows = cleared(id) as Array<{ actor?: string; onBehalfOf?: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].onBehalfOf, 'user:dale');
    assert.equal(rows[0].actor, 'user:admin');
  });
});
