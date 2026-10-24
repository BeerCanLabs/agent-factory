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
import { loadSkills, recordSkillChecks } from './skills.js';
import { configOf } from './config-store.js';

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

  /** Makes every store write take 40 ms, so changes started a few ms apart genuinely overlap. */
  const slowStore = async <T>(fn: () => Promise<T>): Promise<T> => {
    const backend = (state.configs as unknown as { backend: { write: (r: unknown) => Promise<void> } }).backend;
    const real = backend.write.bind(backend);
    backend.write = async (r) => {
      await new Promise((done) => setTimeout(done, 40));
      return real(r);
    };
    try {
      return await fn();
    } finally {
      backend.write = real;
    }
  };
  const later = <T>(ms: number, fn: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(fn()), ms));

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
    loadSkills(state, join(dir, 'skills'));
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

  it('a viewer reading the configuration sees which parts are set, never the soul, roles or memory; the owner sees them', async () => {
    const viewer = await call('GET', '/api/v1/agents/mine/config', undefined, VIEWER);
    assert.equal(viewer.status, 200);
    assert.ok(!JSON.stringify(viewer.body).includes('SECRET-SOUL-TEXT'));
    assert.deepEqual(viewer.body.agent, { soulSet: true, memorySet: true }, 'a viewer learns which parts are set, not what they say');
    assert.ok(!JSON.stringify(viewer.body).includes('team-member'), 'nor the memory settings');
    const versions = await call('GET', `/api/v1/agents/mine/config/versions/${viewer.body.version}`, undefined, VIEWER);
    assert.equal(versions.status, 200);
    assert.ok(!JSON.stringify(versions.body).includes('SECRET-SOUL-TEXT'), 'a single version is redacted too');
    assert.ok(JSON.stringify((await call('GET', `/api/v1/agents/mine/config/versions/${viewer.body.version}`, undefined, OWNER)).body).includes('SECRET-SOUL-TEXT'));
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

  it('a change of another kind made while a settings change is being stored is not put back, and does not put back the settings', async () => {
    // Settings first, then owners and policy built from a record that does not yet hold the soul.
    await slowStore(async () => {
      const [soul, owners, policy] = await Promise.all([
        call('PUT', '/api/v1/agents/theirs/settings', { soul: 'raced soul' }),
        later(10, () => call('PUT', '/api/v1/agents/theirs/owners', { owners: ['token:other-svc', 'token:owner-svc'] })),
        later(20, () => call('PUT', '/api/v1/agents/theirs/policy', { routes: ['google-calendar'] })),
      ]);
      assert.deepEqual([soul.status, owners.status, policy.status], [200, 200, 200]);
    });
    let now = state.configs!.current('theirs')!;
    assert.equal(now.agent?.soul, 'raced soul', 'owners and policy changes built from an older record did not drop the soul');
    assert.deepEqual(now.owners, ['token:other-svc', 'token:owner-svc']);
    assert.deepEqual(now.policy?.routes, ['google-calendar']);
    // The other way: owners first, then a settings change built from a record that does not yet hold the new owners.
    await slowStore(async () => {
      const [owners, soul] = await Promise.all([
        call('PUT', '/api/v1/agents/theirs/owners', { owners: ['token:other-svc'] }),
        later(10, () => call('PUT', '/api/v1/agents/theirs/settings', { soul: 'second soul' })),
      ]);
      assert.deepEqual([owners.status, soul.status], [200, 200]);
    });
    now = state.configs!.current('theirs')!;
    assert.deepEqual(now.owners, ['token:other-svc'], 'a settings change built from an older record did not put back the older owners');
    assert.equal(now.agent?.soul, 'second soul');
    await call('PUT', '/api/v1/agents/theirs/settings', { soul: null });
  });

  it('a built-in agent has no settings', async () => {
    const reg = await call('POST', '/api/v1/registry/agents', { repo: 'https://github.com/beercanlabs/SM-bi', commit: SHA, cartridge: cartridge('bi') });
    assert.equal(reg.status, 201);
    state.agents.set('bi', { ...state.agents.get('bi')!, isBuiltin: true } as never);
    assert.equal((await call('PUT', '/api/v1/agents/bi/settings', { soul: 'x' })).status, 400);
  });

  it('two changes at once never overwrite each other', async () => {
    const [a, b] = await slowStore(() => Promise.all([
      call('PUT', '/api/v1/agents/theirs/settings', { soul: 'concurrent soul' }),
      later(10, () => call('PUT', '/api/v1/agents/theirs/settings', { memory: { archetype: 'purpose-built' } })),
    ]));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const got = (await call('GET', '/api/v1/agents/theirs/settings')).body.settings;
    assert.equal(got.soul, 'concurrent soul');
    assert.equal(got.memory.archetype, 'purpose-built');
    // A body that arrives slowly is merged against the settings as they are when it lands.
    const slow = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/agents/theirs/settings', method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}`, 'transfer-encoding': 'chunked' } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode ?? 0)); });
      req.on('error', reject);
      req.write('{"memory":{"archetype":"team-member"}');
      setTimeout(async () => {
        await call('PUT', '/api/v1/agents/theirs/settings', { soul: 'landed meanwhile' });
        req.end('}');
      }, 100);
    });
    assert.equal(slow, 200);
    const final = (await call('GET', '/api/v1/agents/theirs/settings')).body.settings;
    assert.equal(final.soul, 'landed meanwhile');
    assert.equal(final.memory.archetype, 'team-member');
    await call('PUT', '/api/v1/agents/theirs/settings', { soul: null, memory: null });
  });

  it('a person can be given a role the factory defines, through the identity link, while the cartridge does not define it', async () => {
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { 'google-calendar': { allow: ['*'] } } }] }, OWNER)).status, 200);
    const link = await call('PUT', '/api/v1/identity-links/discord/301', { actor: 'cloudflare:guest@example.com', agentRoles: { mine: ['Guest'] } });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const refused = await call('PUT', '/api/v1/identity-links/discord/302', { actor: 'cloudflare:x@example.com', agentRoles: { mine: ['Family'] } });
    assert.equal(refused.status, 400, 'the cartridge’s Family is replaced by the factory’s roles');
    // The egress sees the factory's role: Guest may use the calendar route, which the cartridge's roles never named for it.
    const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'x', trigger: 'api', requestedBy: { provider: 'discord', id: '301' } } as never);
    assert.deepEqual(accessForRun(state, run, state.agents.get('mine')!), { restricted: true, routes: { 'google-calendar': 'allowed' } });
    await call('PUT', '/api/v1/agents/mine/settings', { roles: null }, OWNER);
    assert.equal((accessForRun(state, run, state.agents.get('mine')!) as { routes: Record<string, string> }).routes['google-calendar'], 'denied', 'without the section the cartridge’s roles apply: Guest is not one of them');
  });

  it('refuses malformed settings and built-in or unknown agents', async () => {
    for (const body of [{ soul: 5 }, { memory: { archetype: 'chaos' } }, { roles: 'x' }, { nope: 1 }, []]) {
      assert.equal((await call('PUT', '/api/v1/agents/mine/settings', body, OWNER)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('PUT', '/api/v1/agents/ghost/settings', { soul: 'x' })).status, 404);
  });

  it('a role may name a skill the agent has adopted, and the adopted skill’s routes are what the egress then enforces', async () => {
    const manifest = { id: 'print', version: '1.0.0', name: 'print', description: 'Print.', language: 'python', entry: 'print', visibility: 'private', owner: 'mine', requires: { routes: ['print'] } };
    assert.equal((await call('POST', '/api/v1/registry/skills', { repo: 'https://github.com/BeerCanLabs/skill-print', path: '.', commit: SHA, manifest })).status, 201);
    recordSkillChecks(state, 'print', '1.0.0', { passed: true });
    const approved = await call('POST', '/api/v1/registry/skills/print/versions/1.0.0/approve', {});
    assert.deepEqual(approved.body.adopted, ['mine'], JSON.stringify(approved.body));
    // Not declared by the cartridge, adopted: the ceiling accepts it.
    const set = await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { print: { deny: ['*'] }, 'google-calendar': { allow: ['*'] } } }] }, OWNER);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    state.identityLinks!.link('discord', '302', 'cloudflare:guest2@example.com', 'admin', { name: 'Guest Two', agentRoles: { mine: ['Guest'] } });
    const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'factory:ingress', trigger: 'api', requestedBy: { provider: 'discord', id: '302' } } as never);
    const access = accessForRun(state, run, state.agents.get('mine')!);
    assert.equal(access.routes?.print, 'denied', 'the adopted skill’s manifest route is judged by the role');
    assert.equal(access.routes?.['google-calendar'], 'allowed', 'and the role’s own allowance on a declared skill still holds');
    // A skill the cartridge declares keeps the cartridge's routes even when the same id is adopted with others.
    const dup = { id: 'google-calendar', version: '1.0.0', name: 'gc', description: 'Calendar.', language: 'python', entry: 'gc', requires: { routes: ['elsewhere'] } };
    assert.equal((await call('POST', '/api/v1/registry/skills', { repo: 'https://github.com/BeerCanLabs/skill-gc', path: '.', commit: SHA, manifest: dup })).status, 201);
    recordSkillChecks(state, 'google-calendar', '1.0.0', { passed: true });
    assert.equal((await call('POST', '/api/v1/registry/skills/google-calendar/versions/1.0.0/approve', {})).status, 200);
    const skills = [...state.configs!.current('mine')!.skills, { id: 'google-calendar', version: '1.0.0' }];
    await state.configs!.put({ ...configOf(state, 'mine'), skills }, { updatedBy: 'test', reason: 'adopt', replaces: ['skills'] });
    assert.equal(accessForRun(state, run, state.agents.get('mine')!).routes?.elsewhere, undefined, 'the cartridge’s routes win');
    // A skill neither declared nor adopted is still refused.
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: [{ name: 'Guest', skills: { gmail: { deny: ['*'] } } }] }, OWNER)).status, 422);
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { roles: null }, OWNER)).status, 200);
  });

  it('an adoption removed while a settings change is being stored does not drop the soul, and the soul change does not put the adoption back', async () => {
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { soul: 'before' }, OWNER)).status, 200);
    await slowStore(async () => {
      const [soul, removed] = await Promise.all([
        call('PUT', '/api/v1/agents/mine/settings', { soul: 'after the race' }, OWNER),
        later(10, () => call('DELETE', '/api/v1/agents/mine/skills/print', { reason: 'race' }, OWNER)),
      ]);
      assert.equal(soul.status, 200);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    });
    const now = state.configs!.current('mine')!;
    assert.equal(now.agent?.soul, 'after the race');
    assert.ok(!now.skills.some((k) => k.id === 'print'), 'the removal stands');
    // And the reverse: the removal's write is queued first, the soul change was built before it landed.
    assert.equal((await call('PUT', '/api/v1/agents/mine/settings', { soul: null }, OWNER)).status, 200);
  });

  it('the other agent was never touched', async () => {
    assert.equal((await call('GET', '/api/v1/agents/theirs/settings')).body.managed, false);
  });
});
