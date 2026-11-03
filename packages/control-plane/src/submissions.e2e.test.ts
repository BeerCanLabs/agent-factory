// Story #366 ([S20] Content submission and admission gates, Epic #349): D25, D27, D28, S20.
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
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { loadSkills, skillRegistry } from './skills.js';

const PEOPLE = ['admin', 'vic', 'approver', 'bea', 'otto', 'steph'] as const;
const tok = (p: string) => `tok-s20-${p}`; // secret-scan:allow (test fixture)

function identityOnlyBearer(): AuthProvider {
  return {
    name: 's20-identity-only',
    async verify(authorization) {
      const t = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const who = PEOPLE.find((p) => tok(p) === t);
      return who ? { ok: true, principal: { actor: `user:${who}`, roles: [] } } : { ok: false, reason: 'unknown token' };
    },
  };
}

describe('S20: content submission and admission gates (#366)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;

  const call = async (method: string, path: string, who: string | undefined, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tok(who)}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const actions = (id: string) => ledger.query({}).filter((e) => e.requestId === id).map((e) => [e.action, e.route ?? '']);
  const draft = (id: string, extra: Record<string, unknown> = {}) => ({
    kind: 'agent',
    content: { id, name: id, kind: 'personal', soul: 'Helps with email.', memory: { archetype: 'personal-assistant' }, ...extra },
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's20-submissions-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });
    for (const p of PEOPLE) await principals.create({ id: `user:${p}`, displayName: p, emails: [`${p}@example.com`], by: 'user:admin' });
    const g = (subject: string, role: string) => grants.grant({ subject, scope: { kind: 'fleet' }, role, by: 'user:admin', granterIsAdmin: true } as never);
    await g('user:admin', 'admin');
    await g('user:vic', 'viewer');
    await g('user:approver', 'approver');
    await g('user:bea', 'budget-owner');
    // Stephanie has factory access only through an agent sub-role (no fleet role).
    await grants.grant({ subject: 'user:steph', scope: { kind: 'agent', id: 'donna' }, role: 'Family', by: 'user:admin', granterIsAdmin: true } as never);

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
      runTokens: new RunTokens('s20-submissions-run-token-key-0123456789abcdef'), // secret-scan:allow (test fixture)
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => '9'.repeat(40),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: { 'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: 'c'.repeat(40), image: 'registry.example/runtime:s20' },
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
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC1: a viewer submits an agent draft with no budget; the budget gate stays pending and admission is refused until the budget-owner allocates', async () => {
    const sub = await call('POST', '/api/v1/submissions', 'vic', draft('mailbot', { budgetUsd: { perDay: 999 }, policy: { routes: ['x'] } }));
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const id = sub.body.id as string;
    assert.equal(sub.body.submitter, 'user:vic');
    assert.deepEqual(sub.body.strippedFields, ['budgetUsd', 'policy'], 'the submitter cannot set budget');
    assert.equal(sub.body.content.budgetUsd, undefined);
    assert.equal(sub.body.gates.security.state, 'passed');
    assert.equal(sub.body.gates.compliance.state, 'passed');
    assert.equal(sub.body.gates.budget.state, 'pending');

    const refused = await call('POST', `/api/v1/submissions/${id}/admit`, 'approver', {});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'gates_not_passed');
    assert.equal(state.agents.has('mailbot'), false);

    assert.equal((await call('PUT', `/api/v1/budget/submissions/${id}`, 'vic', { budgetUsd: { perDay: 3 } })).status, 403, 'the submitter has no say over budget');
    assert.equal((await call('PUT', `/api/v1/budget/submissions/${id}`, 'approver', { budgetUsd: { perDay: 3 } })).status, 403, 'nor does the approver');
    const alloc = await call('PUT', `/api/v1/budget/submissions/${id}`, 'bea', { budgetUsd: { perDay: 3 } });
    assert.equal(alloc.status, 200, JSON.stringify(alloc.body));
    assert.equal(alloc.body.gates.budget.state, 'passed');

    // AC2: everything passes; the approver admits and CONTENT_ADMITTED is ledgered.
    assert.equal((await call('POST', `/api/v1/submissions/${id}/admit`, 'vic', {})).status, 403, 'a viewer cannot admit');
    const ok = await call('POST', `/api/v1/submissions/${id}/admit`, 'approver', {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.submission.status, 'admitted');
    assert.ok(state.agents.has('mailbot'));
    const owner = (state.grants as GrantStore).list().filter((x: any) => x.scope?.kind === 'agent' && x.scope.id === 'mailbot' && x.role === 'content-owner');
    assert.deepEqual(owner.map((x: any) => x.subject), ['user:vic'], 'the agent is the submitter\'s, not the approver\'s');
    assert.deepEqual((state.policies.get('mailbot') as { budgetUsd?: unknown }).budgetUsd, { perDay: 3 });
    const rows = actions(id);
    assert.deepEqual(rows[0], ['CONTENT_SUBMITTED', '']);
    for (const r of [['GATE_PASSED', 'security'], ['GATE_PASSED', 'compliance'], ['BUDGET_ALLOCATED', ''], ['GATE_PASSED', 'budget'], ['CONTENT_ADMITTED', '']]) {
      assert.ok(rows.some((x) => x[0] === r[0] && x[1] === r[1]), JSON.stringify(r));
    }
    assert.equal((await call('POST', `/api/v1/submissions/${id}/admit`, 'approver', {})).status, 409, 'admitted once');
  });

  it('a draft carrying a credential fails the security scan and is never admitted, even with budget', async () => {
    const sub = await call('POST', '/api/v1/submissions', 'vic', draft('leaky', { soul: 'Use key AKIAABCDEFGHIJKLMNOP.' })); // secret-scan:allow (test fixture: a fake AWS key shape the scan must refuse)
    assert.equal(sub.body.gates.security.state, 'failed');
    await call('PUT', `/api/v1/budget/submissions/${sub.body.id}`, 'bea', { budgetUsd: { perDay: 1 } });
    assert.equal((await call('POST', `/api/v1/submissions/${sub.body.id}/admit`, 'approver', {})).status, 409);
    assert.ok(actions(sub.body.id).some((x) => x[0] === 'GATE_FAILED' && x[1] === 'security'));
  });

  it('a non-compliant draft (team agent with no lead, no soul) fails the compliance check', async () => {
    const sub = await call('POST', '/api/v1/submissions', 'vic', { kind: 'agent', content: { id: 'teamless', kind: 'team' } });
    assert.equal(sub.body.gates.compliance.state, 'failed');
    assert.equal(sub.body.gates.compliance.reasons.length, 2);
  });

  it('a skill draft needs no budget (D28); it is admitted once its checks pass', async () => {
    const rec = {
      id: 'sum', version: '1.0.0', repo: 'https://github.com/example/sum', path: '.', commit: 'a'.repeat(40),
      manifest: { id: 'sum', version: '1.0.0', name: 'sum', description: 'Sum', language: 'python', entry: 'sum', requires: { routes: [] } },
      status: 'pending', tests: 'pending-build', registeredBy: 'user:vic', registeredAt: new Date().toISOString(), owner: 'user:vic',
    };
    skillRegistry(state).save(rec as never);
    const sub = await call('POST', '/api/v1/submissions', 'vic', { kind: 'skill', content: { skillId: 'sum', version: '1.0.0', budgetUsd: { perDay: 5 } } });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    assert.equal(sub.body.gates.budget.state, 'not-applicable');
    assert.equal(sub.body.gates.security.state, 'pending', 'checks not finished');
    assert.equal((await call('PUT', `/api/v1/budget/submissions/${sub.body.id}`, 'bea', { budgetUsd: { perDay: 1 } })).status, 409, 'skills hold no budget');
    assert.equal((await call('POST', `/api/v1/submissions/${sub.body.id}/admit`, 'approver', {})).status, 409);
    skillRegistry(state).save({ ...rec, tests: 'passed' } as never);
    const ok = await call('POST', `/api/v1/submissions/${sub.body.id}/admit`, 'approver', {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(skillRegistry(state).get('sum', '1.0.0')?.status, 'approved');
  });

  it('submitters see their own drafts; approvers see all; strangers get 404 for one they did not submit', async () => {
    const mine = (await call('GET', '/api/v1/submissions', 'vic')).body.submissions.length;
    assert.ok(mine >= 3);
    const sub = await call('POST', '/api/v1/submissions', 'admin', draft('admins-bot'));
    assert.equal((await call('GET', '/api/v1/submissions', 'vic')).body.submissions.length, mine);
    assert.ok((await call('GET', '/api/v1/submissions', 'approver')).body.submissions.length > mine);
    assert.equal((await call('GET', `/api/v1/submissions/${sub.body.id}`, 'vic')).status, 404);
    assert.equal((await call('GET', `/api/v1/submissions/${sub.body.id}`, 'approver')).status, 200);
    assert.equal((await call('GET', '/api/v1/submissions', 'otto')).status, 403, 'no grant at all, no submissions');
    const steph = await call('POST', '/api/v1/submissions', 'steph', draft('steph-bot'));
    assert.equal(steph.status, 201, 'an agent-scoped grant is factory access too (D27)');
    assert.equal(steph.body.submitter, 'user:steph');
    assert.equal((await call('POST', '/api/v1/submissions', undefined, draft('x'))).status, 401);
  });

  it('S21: a finished interview becomes a pending S20 draft that runs the same three gates and needs the same admission', async () => {
    const steps = await call('GET', '/api/v1/submissions/interview', 'steph');
    assert.equal(steps.status, 200);
    assert.ok(steps.body.steps.length >= 4);
    const answers = { name: 'Recipe Bot', kind: 'personal', purpose: 'Plans weekly dinners for the family.' };
    const bad = await call('POST', '/api/v1/submissions/interview', 'steph', { answers: { name: 'Recipe Bot' }, finalize: true });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'interview_incomplete');
    const preview = await call('POST', '/api/v1/submissions/interview', 'steph', { answers });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.id, 'recipe-bot');
    assert.equal((await call('GET', '/api/v1/submissions', 'steph')).body.submissions.filter((x: any) => x.content.id === 'recipe-bot').length, 0, 'a preview stores nothing');
    const done = await call('POST', '/api/v1/submissions/interview', 'steph', { answers, finalize: true });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.status, 'pending');
    assert.equal(done.body.submitter, 'user:steph');
    assert.equal(done.body.gates.security.state, 'passed');
    assert.equal(done.body.gates.compliance.state, 'passed');
    assert.equal(done.body.gates.budget.state, 'pending');
    assert.equal((await call('POST', `/api/v1/submissions/${done.body.id}/admit`, 'approver', {})).status, 409, 'no bypass of the budget gate');
    await call('PUT', `/api/v1/budget/submissions/${done.body.id}`, 'bea', { budgetUsd: { perDay: 2 } });
    assert.equal((await call('POST', `/api/v1/submissions/${done.body.id}/admit`, 'steph', {})).status, 403, 'the interviewee cannot admit');
    assert.equal((await call('POST', `/api/v1/submissions/${done.body.id}/admit`, 'approver', {})).status, 200);
    assert.ok(state.agents.has('recipe-bot'));
  });
});

