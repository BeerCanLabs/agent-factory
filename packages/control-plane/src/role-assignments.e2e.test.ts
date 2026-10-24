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
    const stale = state.approvals.requestChange({ runId: mine.run.runId, agentId: 'mine', change: { type: 'role-assignment', provider: 'discord', identity: '201', roles: ['Family'] }, ttlMs: 1 });
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
});
