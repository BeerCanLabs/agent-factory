// TSK-264 (DESIGN_AUTHORITY.md CF1): an agent's soul, roles and memory settings are part of its versioned configuration.
// Real control plane over HTTP: who may read and set them, that nothing creates the section by itself, that the roles in
// force change what a person may use (E12), that the soul is not shown to every viewer, and that an agent cannot reach it.
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
const SHA = '5'.repeat(40);
const KEY = 'settings-run-token-key-0123456789abc';

describe('an agent’s settings are part of its versioned configuration (CF1, TSK-264)', { concurrency: false }, () => {
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
    roles: { Family: { skills: { 'google-calendar': { allow: ['*'] } } } },
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
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('registering, committing and changing owners or policy never creates the section: an existing agent reads as it did', async () => {
    const before = await call('GET', '/api/v1/agents/mine/settings');
    assert.equal(before.status, 200);
    assert.equal(before.body.managed, false);
    assert.equal(before.body.settings, undefined);
    const cfg = await call('GET', '/api/v1/agents/mine/config');
    assert.equal(cfg.body.agent, undefined);
    const roles = await call('GET', '/api/v1/agents/mine/roles');
    assert.deepEqual(roles.body.roles.map((r: { name: string }) => r.name), ['Family']);
    // Access decisions see the very record the cartridge produced: adoption alone changes nothing for it.
    const rec = state.agents.get('mine')!;
    assert.equal(agentInForce(state, rec), rec);
  });

  it('only the agent’s owner or an admin reads or sets it; another agent’s owner, a viewer and an agent’s run token cannot', async () => {
    const body = { soul: 'You are careful.' };
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', body, OTHER)).status, 403);
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', body, VIEWER)).status, 403);
    assert.equal((await call('GET', '/api/v1/agents/mine/settings', undefined, VIEWER)).status, 403);
    const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'x', trigger: 'api' } as never);
    const runToken = await tokens.mint({ runId: run.runId, agentId: 'mine' });
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', body, runToken)).status, 401);
    assert.equal((await call('GET', '/api/v1/agents/mine/settings', undefined, runToken)).status, 401);
    assert.equal((await call('GET', '/api/v1/agents/mine/settings', undefined, OTHER)).status, 403);
    assert.equal((await call('GET', '/api/v1/agents/mine/settings')).body.managed, false, 'nothing was stored');
  });

  it('the owner sets the soul and memory: a new version, ledgered by part name only, the soul never in the ledger', async () => {
    const soul = 'You are Mine. SECRET-SOUL-TEXT.';
    const put = await call('PUT', '/api/v1/agents/mine/settings', { soul, memory: { archetype: 'team-member' } }, OWNER);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.changed.sort(), ['memory', 'soul']);
    const got = await call('GET', '/api/v1/agents/mine/settings', undefined, OWNER);
    assert.equal(got.body.managed, true);
    assert.equal(got.body.settings.soul, soul);
    assert.equal(got.body.settings.memory.archetype, 'team-member');
    const rows = ledger.query().filter((e) => (e as { action?: string }).action === 'AGENT_SETTINGS_CHANGED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'token:owner-svc');
    assert.ok(!JSON.stringify(ledger.query()).includes('SECRET-SOUL-TEXT'));
    // The same change again is not a new version.
    const again = await call('PUT', '/api/v1/agents/mine/settings', { soul }, OWNER);
    assert.deepEqual(again.body.changed, []);
    assert.equal(again.body.version, put.body.version);
  });

  it('a viewer reading the configuration sees a hash of the soul, never the soul; the owner sees it', async () => {
    const viewer = await call('GET', '/api/v1/agents/mine/config', undefined, VIEWER);
    assert.equal(viewer.status, 200);
    assert.ok(!JSON.stringify(viewer.body).includes('SECRET-SOUL-TEXT'));
    assert.ok(viewer.body.agent.soulSha256);
    const hist = await call('GET', '/api/v1/agents/mine/config/history', undefined, VIEWER);
    assert.ok(!JSON.stringify(hist.body).includes('SECRET-SOUL-TEXT'));
    const owner = await call('GET', '/api/v1/agents/mine/config', undefined, OWNER);
    assert.ok(JSON.stringify(owner.body).includes('SECRET-SOUL-TEXT'));
  });

  it('later configuration changes carry the section forward', async () => {
    assert.equal((await call('PUT', '/api/v1/agents/mine/owners', { owners: ['token:owner-svc'] })).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/mine/policy', { routes: ['google-calendar'] })).status, 200);
    const got = await call('GET', '/api/v1/agents/mine/settings');
    assert.equal(got.body.settings.memory.archetype, 'team-member');
  });

  it('roles set in the factory win over the cartridge’s, and may name only skills the agent declares or has adopted', async () => {
    const bad = await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { gmail: { allow: ['*'] } } }] }, OWNER);
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'unknown_skill');
    const ok = await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { 'google-calendar': { deny: ['*'] } } }] }, OWNER);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const roles = await call('GET', '/api/v1/agents/mine/roles');
    assert.deepEqual(roles.body.roles.map((r: { name: string }) => r.name), ['Guest']);
    // `null` removes the roles: the cartridge's apply again.
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: null }, OWNER)).status, 200);
    assert.deepEqual((await call('GET', '/api/v1/agents/mine/roles')).body.roles.map((r: { name: string }) => r.name), ['Family']);
  });

  it('the roles in force are what the egress enforces: a person assigned a factory-defined role is judged by it', async () => {
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { 'google-calendar': { deny: ['*'] } } }] }, OWNER)).status, 200);
    state.identityLinks!.link('discord', '301', 'cloudflare:guest@example.com', 'admin', { name: 'Guest', agentRoles: { mine: ['Guest'] } });
    const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'factory:ingress', trigger: 'api', requestedBy: { provider: 'discord', id: '301' } } as never);
    assert.deepEqual(accessForRun(state, run, state.agents.get('mine')!), { restricted: true, routes: { 'google-calendar': 'denied' } });
    // Without the section the cartridge's roles apply again: Guest does not exist there, so it holds nothing.
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: null }, OWNER)).status, 200);
    assert.deepEqual(accessForRun(state, run, state.agents.get('mine')!), { restricted: true, routes: { 'google-calendar': 'denied' } });
  });

  it('refuses malformed settings and built-in or unknown agents', async () => {
    for (const body of [{ soul: 5 }, { memory: { archetype: 'chaos' } }, { roles: 'x' }, { nope: 1 }, []]) {
      assert.equal((await call('PUT', '/api/v1/agents/mine/settings', body, OWNER)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('PUT', '/api/v1/agents/ghost/settings', { soul: 'x' })).status, 404);
  });

  it('the other agent was never touched', async () => {
    assert.equal((await call('GET', '/api/v1/agents/theirs/settings')).body.managed, false);
  });
});
