// TSK-265 (DESIGN_AUTHORITY.md CF2, CF4, E12): an owner gives people roles on their own agent; the agent may only ask, and
// only while an owner is the person asking; the owner (or an admin) approves and the factory applies it. Real control plane.
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
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { accessForRun } from './access-enforcement.js';
import { agentInForce } from './agent-settings.js';

const ADMIN = 'admin-settings';
const OWNER = 'owner-settings';
const OTHER = 'other-owner-settings';
const VIEWER = 'viewer-settings';
const CASED = 'cased-settings';
const APPROVER = 'approver-settings';
const SHA = '5'.repeat(40);
const KEY = 'settings-run-token-key-0123456789abc';

describe('owners assign roles; an agent may only ask (CF2, CF4, TSK-265)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);
  const call = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const cartridge = (id: string) => ({
    id,
    name: id,
    memory: { archetype: 'personal-assistant' },
    skills: [{ id: 'google-calendar', routes: ['google-calendar'] }],
    roles: { Owner: { skills: { '*': { allow: ['*'] } } }, Family: { skills: { 'google-calendar': { allow: ['*'] } } } },
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-settings-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'owner-svc', token: OWNER, roles: [] },
        { name: 'other-svc', token: OTHER, roles: [] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'Cased-Svc', token: CASED, roles: [] },
        { name: 'approver', token: APPROVER, roles: ['approver', 'viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
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
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    for (const id of ['mine', 'theirs']) {
      const reg = await call('POST', '/api/v1/registry/agents', { repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, cartridge: cartridge(id) });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
    }
    assert.equal((await call('PUT', '/api/v1/agents/mine/owners', { owners: ['token:owner-svc'] })).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/theirs/owners', { owners: ['token:other-svc'] })).status, 200);
    const links = state.identityLinks!;
    links.link('discord', '100', 'token:owner-svc', 'admin', { name: 'Dale' });
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', roles: ['viewer'], agentRoles: { theirs: ['Family'] } });
    links.link('discord', '300', 'cloudflare:stranger@example.com', 'admin', { name: 'Stranger' });
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const runFor = async (requestedBy?: { provider: string; id: string }) => {
    const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'factory:ingress', trigger: 'api', ...(requestedBy ? { requestedBy } : {}) } as never);
    return { run, token: await tokens.mint({ runId: run.runId, agentId: 'mine' }) };
  };
  const rolesOf = (provider: string, id: string, agent = 'mine') => state.identityLinks!.resolveLink(provider, id)?.agentRoles?.[agent];

  it('the owner gives an existing person a role on their own agent; nobody else can, and only that agent’s roles change', async () => {
    const put = (token: string, body: unknown, id = '201', agent = 'mine') => call('PUT', `/api/v1/agents/${agent}/role-assignments/discord/${id}`, body, token);
    assert.equal((await put(OTHER, { roles: ['Family'] })).status, 403, 'another agent’s owner');
    assert.equal((await put(VIEWER, { roles: ['Family'] })).status, 403);
    assert.equal((await put(APPROVER, { roles: ['Family'] })).status, 403, 'an approver is not an owner');
    assert.equal(rolesOf('discord', '201'), undefined);
    const ok = await put(OWNER, { roles: ['Family'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(rolesOf('discord', '201'), ['Family']);
    const link = state.identityLinks!.resolveLink('discord', '201')!;
    assert.deepEqual(link.roles, ['viewer'], 'the person’s factory roles are untouched');
    assert.deepEqual(link.agentRoles!.theirs, ['Family'], 'their roles on another agent are untouched');
    assert.equal(link.actor, 'cloudflare:stephanie@example.com');
    const rows = ledger.query().filter((e) => (e as { action?: string }).action === 'AGENT_ROLES_ASSIGNED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'token:owner-svc');
    assert.ok(!JSON.stringify(rows).includes('stephanie'), 'the ledger holds a hash, not the person');
    assert.deepEqual((await call('GET', '/api/v1/agents/mine/role-assignments', undefined, OWNER)).body.assignments, [{ provider: 'discord', identity: '201', name: 'Stephanie', roles: ['Family'] }]);
    assert.equal((await call('GET', '/api/v1/agents/mine/role-assignments', undefined, OTHER)).status, 403);
    // The same again changes nothing; an empty list removes.
    assert.equal((await put(OWNER, { roles: ['Family'] })).body.changed, false);
    assert.equal((await put(OWNER, { roles: [] })).status, 200);
    assert.equal(rolesOf('discord', '201'), undefined);
    assert.deepEqual(state.identityLinks!.resolveLink('discord', '201')!.agentRoles!.theirs, ['Family']);
  });

  it('refuses a person the factory does not know, a role the agent does not define, and Owner', async () => {
    const put = (id: string, roles: unknown) => call('PUT', `/api/v1/agents/mine/role-assignments/discord/${id}`, { roles }, OWNER);
    assert.equal((await put('999', ['Family'])).status, 404, 'an owner cannot create a link');
    assert.equal((await put('201', ['Admin'])).body.error, 'unknown_agent_role');
    assert.equal((await put('201', ['Owner'])).status, 400);
    assert.equal((await put('201', 'Family')).status, 400);
    assert.equal((await put('201', ['__proto__'])).status, 400);
    assert.equal(rolesOf('discord', '201'), undefined);
  });

  it('the agent cannot assign: its run token reaches no assignment route', async () => {
    const { token } = await runFor({ provider: 'discord', id: '100' });
    assert.equal((await call('PUT', '/api/v1/agents/mine/role-assignments/discord/201', { roles: ['Family'] }, token)).status, 401);
    assert.equal((await call('GET', '/api/v1/agents/mine/role-assignments', undefined, token)).status, 401);
    assert.equal(rolesOf('discord', '201'), undefined);
  });

  it('the agent may ask only while an owner is the person asking', async () => {
    const ask = (token: string, runId: string) => call('POST', `/api/v1/runs/${runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, token);
    const stranger = await runFor({ provider: 'discord', id: '300' });
    assert.equal((await ask(stranger.token, stranger.run.runId)).status, 403, 'a linked stranger is not the owner');
    const unlinked = await runFor({ provider: 'discord', id: '404' });
    assert.equal((await ask(unlinked.token, unlinked.run.runId)).status, 403);
    const nobody = await runFor();
    assert.equal((await ask(nobody.token, nobody.run.runId)).status, 403, 'no requesting person at all');
    const mine = await runFor({ provider: 'discord', id: '100' });
    assert.equal((await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Admin'] }, mine.token)).status, 400);
    assert.equal(state.approvals.list({ state: 'pending' }).filter((a) => a.kind === 'change').length, 0);
    assert.ok(ledger.query().some((e) => (e as { action?: string }).action === 'ROLE_REQUEST_REFUSED_REQUESTER_NOT_OWNER'));
    assert.equal(rolesOf('discord', '201'), undefined, 'asking changes nothing');
  });

  it('a request waits for the owner; a non-owner approver, another agent’s owner and the agent cannot decide it; the requester-owner can, once', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    assert.equal(ask.status, 202, JSON.stringify(ask.body));
    assert.deepEqual(Object.keys(ask.body).sort(), ['approvalId', 'expiresAt', 'state'], 'the agent learns only that it is waiting');
    const id = ask.body.approvalId as string;
    const again = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    assert.equal(again.body.approvalId, id, 'the identical request is the same request');
    const decide = (token: string, decision = 'approve') => call('POST', `/api/v1/approvals/${id}`, { decision }, token);
    assert.equal((await decide(mine.token)).status, 401, 'the agent’s run token is no principal');
    assert.equal((await decide(APPROVER)).status, 403, 'an approver who is not an owner of this agent');
    assert.equal((await decide(OTHER)).status, 403);
    assert.equal((await decide(VIEWER)).status, 403);
    assert.equal(rolesOf('discord', '201'), undefined);
    const done = await decide(OWNER);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.applied, true);
    assert.deepEqual(rolesOf('discord', '201'), ['Family']);
    assert.equal((await decide(OWNER)).status, 409, 'approved once');
    const actions = ledger.query().map((e) => (e as { action?: string }).action);
    assert.ok(actions.indexOf('APPROVAL_GRANTED') < actions.lastIndexOf('AGENT_ROLES_ASSIGNED'), 'the decision is ledgered before the change is applied');
    await call('PUT', '/api/v1/agents/mine/role-assignments/discord/201', { roles: [] }, ADMIN);
  });

  it('a rejection assigns nothing; an admin may decide; an expired request cannot be decided', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const make = async () => (await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token)).body.approvalId as string;
    const first = await make();
    assert.equal((await call('POST', `/api/v1/approvals/${first}`, { decision: 'reject' }, OWNER)).status, 200);
    assert.equal(rolesOf('discord', '201'), undefined);
    const second = await make();
    assert.notEqual(second, first, 'a rejected request is not reopened by asking again');
    assert.equal((await call('POST', `/api/v1/approvals/${second}`, { decision: 'approve' }, ADMIN)).body.applied, true);
    await call('PUT', '/api/v1/agents/mine/role-assignments/discord/201', { roles: [] }, ADMIN);
    const stale = state.approvals.requestChange({ runId: mine.run.runId, agentId: 'mine', change: { type: 'role-assignment', provider: 'discord', identity: '201', roles: ['Family'] }, ttlMs: 1 }) as { approval: { approvalId: string } };
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await call('POST', `/api/v1/approvals/${stale.approval.approvalId}`, { decision: 'approve' }, OWNER)).status, 409);
    assert.equal(rolesOf('discord', '201'), undefined);
    assert.equal(state.approvals.get(stale.approval.approvalId)!.state, 'expired');
  });

  it('what is approved is checked again when it is applied: a role removed since is not given', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { 'google-calendar': { allow: ['*'] } } }] }, OWNER)).status, 200);
    const done = await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'approve' }, OWNER);
    assert.equal(done.body.applied, false);
    assert.equal(rolesOf('discord', '201'), undefined);
    await call('PUT', '/api/v1/agents/mine/settings', { roles: null }, OWNER);
  });
  it('a pending role request never holds the run: deciding a tool approval releases it', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    assert.equal(ask.status, 202);
    const held = await call('POST', '/api/v1/gatekeeper-egress/approvals', { runId: mine.run.runId, route: 'google-calendar', tool: 'create_event', argsSha256: 'a'.repeat(64) });
    assert.equal(held.status, 201, JSON.stringify(held.body));
    assert.equal(state.runs.get(mine.run.runId)!.state, 'BLOCKED_FOR_HUMAN');
    assert.equal((await call('POST', `/api/v1/approvals/${held.body.approvalId}`, { decision: 'approve' }, ADMIN)).status, 200);
    assert.notEqual(state.runs.get(mine.run.runId)!.state, 'BLOCKED_FOR_HUMAN', 'the change request did not keep the run blocked');
    assert.equal((await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'reject' }, OWNER)).status, 200);
  });

  it('what a change request says (a person’s external identity) is read only by those who may decide it', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    const listed = async (token: string) => {
      const got = await call('GET', '/api/v1/approvals?state=pending', undefined, token);
      assert.equal(got.status, 200, token);
      return got.body.find((a: { approvalId: string }) => a.approvalId === ask.body.approvalId);
    };
    for (const token of [VIEWER, APPROVER]) {
      const row = await listed(token);
      assert.ok(row, 'the request is listed, so approvers know something waits');
      assert.ok(row.change === undefined && !JSON.stringify(row).includes('"201"'), `${token} does not read the change`);
    }
    assert.equal((await call('GET', '/api/v1/approvals?state=pending', undefined, OWNER)).status, 403, 'a bare owner has no list; they are asked in their own channel (TSK-267)');
    assert.equal((await listed(ADMIN)).change.identity, '201');
    await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'reject' }, OWNER);
  });

  it('an owner acting alone in a signed-in console session is the requester; another signed-in person is not', async () => {
    const asPrincipal = async (actor: string) => {
      const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor, trigger: 'api' } as never);
      return call('POST', `/api/v1/runs/${run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, await tokens.mint({ runId: run.runId, agentId: 'mine' }));
    };
    const other = await asPrincipal('token:other-svc');
    assert.equal(other.status, 403);
    const owner = await asPrincipal('token:owner-svc');
    assert.equal(owner.status, 202, JSON.stringify(owner.body));
    await call('POST', `/api/v1/approvals/${owner.body.approvalId}`, { decision: 'reject' }, OWNER);
  });

  const mcp = async (token: string, name: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) });
    return JSON.stringify(await res.json());
  };

  it('the MCP approvals list hides a change from those who may not decide it, as the REST list does', async () => {
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
    assert.ok((await mcp(VIEWER, 'list_approvals')).includes(ask.body.approvalId), 'listed, so approvers know something waits');
    assert.ok(!(await mcp(VIEWER, 'list_approvals')).includes('201'), 'but not what it says');
    assert.ok(!(await mcp(APPROVER, 'list_approvals')).includes('201'));
    assert.ok((await mcp(ADMIN, 'list_approvals')).includes('201'));
    await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'reject' }, OWNER);
  });

  it('any owner of the agent decides a change, not only the owner who was asking; owners compare case-insensitively', async () => {
    assert.equal((await call('PUT', '/api/v1/agents/mine/owners', { owners: ['token:owner-svc', 'token:other-svc', 'token:cased-svc'] })).status, 200);
    try {
      const mine = await runFor({ provider: 'discord', id: '100' });
      const principalRun = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'token:Cased-Svc', trigger: 'api' } as never);
      const viaPrincipal = await call('POST', `/api/v1/runs/${principalRun.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, await tokens.mint({ runId: principalRun.runId, agentId: 'mine' }));
      assert.equal(viaPrincipal.status, 202, 'a principal whose actor is capitalised differently from the stored (lower-case) owner is still the requester');
      assert.equal((await call('POST', `/api/v1/approvals/${viaPrincipal.body.approvalId}`, { decision: 'reject' }, CASED)).status, 200, 'and decides');
      const ask = await call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: '201', roles: ['Family'] }, mine.token);
      assert.equal((await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'approve' }, OTHER)).body.applied, true, 'the second owner decides a request the first owner raised');
      assert.equal(state.approvals.get(ask.body.approvalId)!.state, 'consumed', 'applied and used up');
      assert.equal((await call('POST', `/api/v1/approvals/${ask.body.approvalId}`, { decision: 'approve' }, OTHER)).status, 409);
      await call('PUT', '/api/v1/agents/mine/role-assignments/discord/201', { roles: [] }, ADMIN);
    } finally {
      await call('PUT', '/api/v1/agents/mine/owners', { owners: ['token:owner-svc'] });
    }
  });

  it('at most five requests wait per agent; asking the same thing again is not refused and not ledgered twice; an expired request neither counts nor is reused', async () => {
    const links = state.identityLinks!;
    for (let i = 0; i < 6; i++) links.link('discord', `50${i}`, `cloudflare:p${i}@example.com`, 'admin', { name: `P${i}` });
    const mine = await runFor({ provider: 'discord', id: '100' });
    const ask = (id: string) => call('POST', `/api/v1/runs/${mine.run.runId}/role-requests`, { provider: 'discord', identity: id, roles: ['Family'] }, mine.token);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await ask(`50${i}`)).body.approvalId);
    assert.equal((await ask('505')).status, 429);
    const again = await ask('500');
    assert.equal(again.status, 200, 'an identical request at the cap is answered, not refused');
    assert.equal(again.body.approvalId, ids[0]);
    assert.equal(ledger.query().filter((e) => (e as { action?: string }).action === 'ROLE_ASSIGNMENT_REQUESTED' && (e as { approvalId?: string }).approvalId === ids[0]).length, 1, 'ledgered once');
    for (const id of ids) await call('POST', `/api/v1/approvals/${id}`, { decision: 'reject' }, OWNER);
    // Expired requests: five that lapsed do not block, and a lapsed identical request is not handed back.
    const lapsed = [0, 1, 2, 3, 4].map((i) => state.approvals.requestChange({ runId: mine.run.runId, agentId: 'mine', change: { type: 'role-assignment', provider: 'discord', identity: `50${i}`, roles: ['Family'] }, ttlMs: 1 }) as { approval: { approvalId: string } });
    await new Promise((r) => setTimeout(r, 15));
    const fresh = await ask('500');
    assert.equal(fresh.status, 202, 'lapsed requests do not count against the cap');
    assert.notEqual(fresh.body.approvalId, lapsed[0].approval.approvalId, 'a lapsed request is not returned as the live one');
    await call('POST', `/api/v1/approvals/${fresh.body.approvalId}`, { decision: 'reject' }, OWNER);
  });

  it('a direct change keeps a role the agent no longer defines, drops duplicates, accepts only well-formed identities and is ledgered only when it changes something', async () => {
    const links = state.identityLinks!;
    links.link('discord', '600', 'cloudflare:legacy@example.com', 'admin', { name: 'Legacy', agentRoles: { mine: ['Legacy'] } });
    const put = (id: string, roles: unknown) => call('PUT', `/api/v1/agents/mine/role-assignments/discord/${id}`, { roles }, OWNER);
    assert.equal((await put('600', ['Legacy', 'Family'])).status, 200, 'a role the person already has stays assignable');
    assert.equal((await put('600', ['Other'])).status, 400, 'a role the agent never defined does not');
    const dup = await put('600', ['Family', 'Family']);
    assert.deepEqual(dup.body.roles, ['Family']);
    const assigned = () => ledger.query().filter((e) => (e as { action?: string }).action === 'AGENT_ROLES_ASSIGNED').length;
    const before = assigned();
    assert.equal((await put('600', ['Family'])).body.changed, false);
    assert.equal(assigned(), before, 'nothing changed, nothing ledgered');
    assert.equal((await put('a%20b', ['Family'])).body.error, 'unknown_identity');
    await put('600', []);
  });
});
