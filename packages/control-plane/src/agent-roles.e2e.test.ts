// TSK-172 (DESIGN_AUTHORITY.md E12, GAP-129): the factory knows the roles an agent's cartridge declares and the routes
// its skills use, refuses a registration that declares them badly, and says them to those who may assign them.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { IdentityLinkStore } from './identity-links.js';

const ADMIN = 'admin-agent-roles';
const OPERATOR = 'operator-agent-roles';
const VIEWER = 'viewer-agent-roles';
const DALE = 'dale-agent-roles'; // owns donna, holds only the viewer role
const SHA = '3'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const donna = {
  id: 'donna',
  name: 'Donna',
  skills: [
    { id: 'google-calendar', routes: ['google-calendar'] },
    { id: 'gmail', routes: ['google-gmail'] },
    { id: 'print', routes: ['print'] },
  ],
  roles: {
    Owner: { description: 'Agent owner', skills: { '*': { allow: ['*'] } } },
    Family: { description: 'Immediate family', skills: { 'google-calendar': { allow: ['*'] }, print: { allow: ['*'] }, gmail: { deny: ['*'] } } },
  },
};

describe('the roles an agent declares (E12, TSK-172)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  const register = (cartridge: Record<string, unknown>, token = ADMIN) =>
    api('/api/v1/registry/agents', 'POST', token, { repo: 'https://github.com/beercanlabs/SM-x', commit: SHA, cartridge });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-agent-roles-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'dale', token: DALE, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('agent-roles-run-token-key-0123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    cp = createFactoryServer(state);
    const port = await listen(cp);
    api = async (path, method = 'GET', token, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const reg = await register(donna);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await api('/api/v1/agents/donna/owners', 'PUT', ADMIN, { owners: ['token:dale'] })).status, 200);
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the declared roles and each skill’s routes on the agent', async () => {
    const rec = state.agents.get('donna')!;
    assert.deepEqual(rec.roles!.map((r) => r.name), ['Family', 'Owner']);
    assert.deepEqual(JSON.parse(JSON.stringify(rec.roles![0].skills)), { 'google-calendar': { allow: ['*'], deny: [] }, gmail: { allow: [], deny: ['*'] }, print: { allow: ['*'], deny: [] } });
    assert.deepEqual({ ...rec.skillRoutes }, { 'google-calendar': ['google-calendar'], gmail: ['google-gmail'], print: ['print'] });
  });

  it('tells an admin which roles exist, which can be given to a person (never Owner), and what each skill uses', async () => {
    const r = await api('/api/v1/agents/donna/roles', 'GET', ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.agentId, 'donna');
    assert.deepEqual(r.body.roles.map((x: { name: string }) => x.name), ['Family', 'Owner']);
    assert.deepEqual(r.body.assignable, ['Family'], 'Owner comes from ownership and is never assigned');
    assert.deepEqual(r.body.skillRoutes, { 'google-calendar': ['google-calendar'], gmail: ['google-gmail'], print: ['print'] });
    assert.deepEqual(r.body.roles[0].skills.gmail, { allow: [], deny: ['*'] });
  });

  it('lists the skills the cartridge declares, so access can be described over all of them', async () => {
    const r = await api('/api/v1/agents/donna/roles', 'GET', ADMIN);
    assert.deepEqual(r.body.skillIds, ['google-calendar', 'gmail', 'print']);
    assert.equal(r.body.effective, undefined, 'nothing is described until a set of roles is asked about');
  });

  it('says what someone who holds Family may use: the calendar and printing, and not Gmail', async () => {
    const r = await api('/api/v1/agents/donna/roles?held=Family', 'GET', ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const e = r.body.effective;
    assert.deepEqual(e.held, ['Family']);
    assert.deepEqual(e.unknownRoles, []);
    assert.deepEqual(e.skills.map((s: { skill: string; access: { kind: string; why?: string } }) => [s.skill, s.access.kind, s.access.why ?? '']), [
      ['google-calendar', 'all', ''],
      ['gmail', 'none', 'denied'],
      ['print', 'all', ''],
    ]);
    assert.deepEqual(e.routes, { 'google-calendar': 'allowed', 'google-gmail': 'denied', print: 'allowed' });
  });

  it('describes a set of roles the same way the egress will: someone with no role may use nothing, an unknown role gives nothing, and the owner’s role everything', async () => {
    const none = (await api('/api/v1/agents/donna/roles?held=', 'GET', ADMIN)).body.effective;
    assert.deepEqual(none.skills.map((s: { access: { why?: string } }) => s.access.why), ['unlisted', 'unlisted', 'unlisted']);
    const unknown = (await api('/api/v1/agents/donna/roles?held=Cousin,Family', 'GET', ADMIN)).body.effective;
    assert.deepEqual([unknown.held, unknown.unknownRoles], [['Family'], ['Cousin']]);
    const owner = (await api('/api/v1/agents/donna/roles?held=Owner', 'GET', ADMIN)).body.effective;
    assert.deepEqual(Object.values(owner.routes), ['allowed', 'allowed', 'allowed']);
  });

  it('describes an agent registered before skillIds existed from the skills it can still see', async () => {
    const donna = state.agents.get('donna')!;
    const { skillIds: _gone, ...old } = donna as typeof donna & { skillIds?: string[] };
    state.agents.set('donna', old as typeof donna);
    try {
      const r = await api('/api/v1/agents/donna/roles?held=Family', 'GET', ADMIN);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([...r.body.skillIds].sort(), ['gmail', 'google-calendar', 'print'], 'routes and the skills roles name');
      assert.equal(r.body.effective.skills.length, 3);
    } finally {
      state.agents.set('donna', donna);
    }
  });

  it('refuses to describe more than 20 roles instead of silently dropping the rest', async () => {
    const names = Array.from({ length: 21 }, (_, i) => `R${i}`).join(',');
    const r = await api(`/api/v1/agents/donna/roles?held=${names}`, 'GET', ADMIN);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'too_many_roles');
    assert.equal((await api(`/api/v1/agents/donna/roles?held=${names.split(',').slice(0, 20).join(',')}`, 'GET', ADMIN)).status, 200, 'exactly 20 is fine');
  });

  it('the description is for those who may read the roles: an owner yes, a viewer no', async () => {
    assert.equal((await api('/api/v1/agents/donna/roles?held=Family', 'GET', DALE)).status, 200);
    assert.equal((await api('/api/v1/agents/donna/roles?held=Family', 'GET', VIEWER)).status, 403);
  });

  it('tells the agent’s owner, but not a viewer, an operator or an anonymous caller', async () => {
    assert.equal((await api('/api/v1/agents/donna/roles', 'GET', DALE)).status, 200, 'its owner');
    assert.equal((await api('/api/v1/agents/donna/roles', 'GET', VIEWER)).status, 403);
    assert.equal((await api('/api/v1/agents/donna/roles', 'GET', OPERATOR)).status, 403);
    assert.equal((await api('/api/v1/agents/donna/roles', 'GET')).status, 401);
  });

  it('a person who owns one agent cannot read another agent’s roles', async () => {
    assert.equal((await register({ id: 'higgins', name: 'Higgins' })).status, 201);
    assert.equal((await api('/api/v1/agents/higgins/roles', 'GET', DALE)).status, 403);
    const own = await api('/api/v1/agents/higgins/roles', 'GET', ADMIN);
    assert.deepEqual([own.status, own.body.roles, own.body.assignable, own.body.skillRoutes], [200, [], [], {}], 'an agent that declares none has none');
  });

  it('says not found for an agent that does not exist', async () => {
    assert.equal((await api('/api/v1/agents/nobody/roles', 'GET', ADMIN)).status, 404);
  });

  it('refuses a registration whose roles are declared badly, says why, ledgers it, and records nothing', async () => {
    const bad = (extra: Record<string, unknown>) => register({ id: 'badroles', name: 'Bad', skills: [{ id: 'gmail', routes: ['google-gmail'] }], ...extra });
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['a role that names a skill the cartridge does not declare', { roles: { Family: { skills: { 'home-print': { allow: ['*'] } } } } }, /names skill "home-print", which the cartridge does not declare/],
      ['a rule that says nothing', { roles: { Family: { skills: { gmail: {} } } } }, /a rule must list at least one action/],
      ['a role name with a space', { roles: { 'Not A Role': { skills: {} } } }, /Not A Role/],
      ['two roles that differ only in case', { roles: { Family: { skills: {} }, family: { skills: {} } } }, /differ by more than case/],
      ['a skill route that is a host', { skills: [{ id: 'gmail', routes: ['mail.google.com'] }] }, /never a host/],
    ];
    for (const [why, extra, reason] of cases) {
      const r = await bad(extra);
      assert.equal(r.status, 422, `${why}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'invalid_roles', why);
      assert.ok(r.body.reasons.some((x: string) => reason.test(x)), `${why}: ${JSON.stringify(r.body.reasons)}`);
    }
    assert.equal(state.agents.has('badroles'), false, 'nothing was registered');
    assert.equal(ledger.query().filter((e) => e.action === 'AGENT_REGISTRATION_REFUSED:roles' && e.agentId === 'badroles').length, cases.length);
  });

  it('re-registering with other roles replaces them, and with none removes them', async () => {
    const next = { ...donna, roles: { Owner: donna.roles.Owner, Aunt: { skills: { 'google-calendar': { allow: ['create'] } } } } };
    assert.equal((await register(next)).status, 201);
    assert.deepEqual((await api('/api/v1/agents/donna/roles', 'GET', ADMIN)).body.assignable, ['Aunt']);
    const { roles: _gone, ...none } = donna;
    assert.equal((await register(none)).status, 201);
    const r = await api('/api/v1/agents/donna/roles', 'GET', ADMIN);
    assert.deepEqual([r.body.roles, r.body.assignable], [[], []]);
  });
});
