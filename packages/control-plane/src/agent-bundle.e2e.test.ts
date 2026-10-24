// TSK-266 (DESIGN_AUTHORITY.md §6.18 CF3): export and import of an agent's whole configuration as one bundle.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { adoptionStore, loadSkills, recordSkillChecks } from './skills.js';

const ADMIN = 'admin-bundle';
const OWNER = 'owner-bundle';
const VIEWER = 'viewer-bundle';
const OTHER = 'other-bundle';
const SHA = '6'.repeat(40);
const RUNTIME_SHA = 'd'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:test';
const KEY = 'bundle-run-token-key-0123456789abcdef';

describe('an agent moves as one bundle (CF3, TSK-266)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);
  const deployed: Array<{ agentId: string; image: string }> = [];
  const built: number[] = [];
  const call = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const cartridge = (id: string) => ({ id, name: id, memory: { archetype: 'personal-assistant' }, skills: [], roles: {} });
  const NEW = { id: 'nova', name: 'Nova', soul: 'You are Nova. SECRET-SOUL.', memory: { archetype: 'personal-assistant' }, roles: [{ name: 'Family', skills: { '*': { allow: ['*'] } } }] };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-create-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'owner-svc', token: OWNER, roles: [] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'other-svc', token: OTHER, roles: [] },
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
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async () => { built.push(1); throw new Error('a configuration agent is never built from a repository'); },
        provisionIdentity: async () => ({ identity: 'id', executionIdentity: 'exec' }),
        registerCompute: async (agentId: string, image: string) => { deployed.push({ agentId, image }); },
      },
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const NOVA = {
    id: 'nova',
    name: 'Nova',
    role: 'Family assistant',
    model: 'test-small',
    soul: 'You are Nova. BUNDLE-SOUL-MARKER.',
    memory: { archetype: 'personal-assistant' },
    roles: [{ name: 'Family', skills: { '*': { allow: ['*'] } } }, { name: 'Tracker', skills: { 'discord-progress': { allow: ['*'] } } }],
  };
  const manifest = { id: 'discord-progress', version: '1.0.0', name: 'Discord progress', description: 'Status.', language: 'python', entry: 'progress', requires: { routes: ['models'] } };
  const actions = () => ledger.query().map((e) => e.action);

  it('exports an agent as one bundle: its configuration, and no owner, person, secret or memory', async () => {
    assert.equal((await call('POST', '/api/v1/agents', { ...NOVA, roles: [NOVA.roles[0]] })).status, 201);
    assert.equal((await call('PUT', '/api/v1/agents/nova/policy', { routes: ['models'], models: ['test-small'] })).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/nova/owners', { owners: ['token:owner-svc', 'cloudflare:dale@example.com'] })).status, 200);
    const out = await call('GET', '/api/v1/agents/nova/bundle');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.format, 'agent-factory.bundle/1');
    assert.equal(out.body.origin, 'configuration');
    assert.equal(out.body.agent.name, 'Nova');
    assert.equal(out.body.settings.soul, NOVA.soul);
    assert.deepEqual(out.body.policy.routes, ['models']);
    assert.equal(out.body.source, undefined, 'the runtime pin belongs to the factory that runs it');
    assert.ok(!JSON.stringify(out.body).includes('dale@example.com') && !JSON.stringify(out.body).includes('owner-svc'), 'no owner');
    assert.ok(actions().includes('CONFIG_BUNDLE_EXPORTED'));
    assert.ok(!JSON.stringify(ledger.query()).includes('BUNDLE-SOUL-MARKER'), 'the soul is not in the ledger');
  });

  it('is exported by the agent\'s owner or an admin, and by no one else', async () => {
    assert.equal((await call('GET', '/api/v1/agents/nova/bundle', undefined, OWNER)).status, 200);
    assert.equal((await call('GET', '/api/v1/agents/nova/bundle', undefined, OTHER)).status, 403, 'another agent\'s owner');
    assert.equal((await call('GET', '/api/v1/agents/nova/bundle', undefined, VIEWER)).status, 403);
    assert.equal((await call('GET', '/api/v1/agents/missing/bundle')).status, 404);
  });

  it('records an agent that runs from a repository as read-only, and refuses to import it', async () => {
    state.newAgentsFromConfigurationOnly = false;
    const reg = await call('POST', '/api/v1/registry/agents', { repo: 'https://github.com/beercanlabs/SM-old', commit: SHA, cartridge: { id: 'old', name: 'old', memory: { archetype: 'personal-assistant' } } });
    state.newAgentsFromConfigurationOnly = true;
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const exported = await call('GET', '/api/v1/agents/old/bundle');
    assert.equal(exported.body.origin, 'repository');
    assert.equal(exported.body.settings, undefined);
    assert.equal(exported.body.source.commit, SHA);
    const imported = await call('POST', '/api/v1/agents/import', { ...exported.body, agent: { ...exported.body.agent, id: 'old-copy' } });
    assert.equal(imported.status, 422);
    assert.equal(imported.body.error, 'bundle_not_importable');
    assert.equal(state.agents.has('old-copy'), false);
    assert.ok(actions().includes('AGENT_IMPORT_REFUSED:bundle_not_importable'));
  });

  it('refuses a hand-built bundle that claims a repository origin yet carries settings', async () => {
    const bundle = (await call('GET', '/api/v1/agents/nova/bundle')).body;
    const forged = await call('POST', '/api/v1/agents/import', { ...bundle, origin: 'repository', agent: { ...bundle.agent, id: 'forged' } });
    assert.equal(forged.status, 422);
    assert.equal(forged.body.error, 'bundle_not_importable');
    assert.equal(state.agents.has('forged'), false);
  });

  it('imports a bundle as a new agent owned by the importer; it grants nothing: the policy is only reported, skills are only requested', async () => {
    assert.equal((await call('POST', '/api/v1/registry/skills', { repo: 'https://github.com/BeerCanLabs/skill-progress', path: '.', commit: SHA, manifest })).status, 201);
    recordSkillChecks(state, 'discord-progress', '1.0.0', { passed: true });
    assert.equal((await call('POST', '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', {})).status, 200);
    const bundle = (await call('GET', '/api/v1/agents/nova/bundle')).body;
    const withSkills = { ...bundle, agent: { ...bundle.agent, id: 'nova-two' }, skills: [{ id: 'discord-progress', version: '1.0.0' }, { id: 'unknown-skill', version: '1.0.0' }], settings: { ...bundle.settings, roles: NOVA.roles } };
    const done = await call('POST', '/api/v1/agents/import', withSkills);
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const a = state.agents.get('nova-two')!;
    assert.equal(a.createdFrom, 'configuration');
    assert.equal(state.policies.has('nova-two'), false, 'the bundle\'s policy is never applied');
    assert.deepEqual(done.body.policyRequested.routes, ['models']);
    assert.equal(done.body.policyApplied, false);
    assert.deepEqual(done.body.skills.map((s: { id: string; state: string }) => [s.id, s.state]), [['discord-progress', 'requested'], ['unknown-skill', 'unavailable']]);
    const cfg = state.configs!.current('nova-two')!;
    assert.deepEqual(cfg.skills, [], 'nothing is adopted until an admin decides (SK3)');
    assert.deepEqual(cfg.owners, ['token:admin'], 'the importer owns it, whoever owned the original');
    assert.equal(cfg.agent!.soul, NOVA.soul);
    assert.equal(cfg.agent!.roles!.length, 2, 'a role may name a skill that is being requested');
    assert.ok(actions().includes('AGENT_IMPORTED') && actions().includes('AGENT_IMPORT_POLICY_REQUESTED') && actions().includes('SKILL_ADOPTION_REQUESTED'));
    assert.ok(!JSON.stringify(ledger.query()).includes('BUNDLE-SOUL-MARKER'));
  });

  it('an import is all or nothing: a role may name only a skill this factory can adopt, and a failure leaves nothing', async () => {
    const bundle = (await call('GET', '/api/v1/agents/nova/bundle')).body;
    const roleNaming = (skill: string) => [{ name: 'R', skills: { [skill]: { allow: ['*'] } } }];
    const into = (id: string, skills: unknown[], roles: unknown) => call('POST', '/api/v1/agents/import', { ...bundle, agent: { ...bundle.agent, id }, skills, settings: { ...bundle.settings, roles } });
    const ghost = await into('ghosted', [{ id: 'ghost-skill', version: '1.0.0' }], roleNaming('ghost-skill'));
    assert.equal(ghost.status, 422, 'unavailable in this factory');
    assert.equal(ghost.body.error, 'unknown_skill');
    const absent = await into('absent', [], roleNaming('discord-progress'));
    assert.equal(absent.status, 422, 'not in the bundle');
    for (const id of ['ghosted', 'absent']) assert.equal(state.agents.has(id) || !!state.configs!.current(id), false);
    assert.equal((await into('bad-skill-id', [{ id: '../x', version: '1.0.0' }], [])).status, 400);
    const noSettings = { ...bundle, agent: { ...bundle.agent, id: 'no-settings' } };
    delete noSettings.settings;
    assert.equal((await call('POST', '/api/v1/agents/import', noSettings)).status, 422);
    // A failure after the agent exists: the ledger refuses the adoption row.
    const realAppend = ledger.append.bind(ledger);
    (ledger as any).append = (e: { action: string }) => {
      if (e.action === 'SKILL_ADOPTION_REQUESTED') throw new Error('boom');
      return realAppend(e as never);
    };
    try {
      const failed = await into('half', [{ id: 'discord-progress', version: '1.0.0' }], roleNaming('discord-progress'));
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.body, { error: 'import_failed' }, 'no raw message');
    } finally {
      (ledger as any).append = realAppend;
    }
    assert.equal(state.agents.has('half'), false);
    assert.equal(adoptionStore(state).get('half', 'discord-progress'), undefined, 'no request is left for the removed agent');
    assert.equal(state.configs!.current('half'), undefined);
    assert.equal((await into('half', [{ id: 'discord-progress', version: '1.0.0' }], roleNaming('discord-progress'))).status, 201, 'the id can be tried again');
  });

  it('is an admin\'s act, and refuses an id that exists (registered or retired) and anything malformed', async () => {
    const bundle = (await call('GET', '/api/v1/agents/nova/bundle')).body;
    const into = (id: string, token = ADMIN, extra: Record<string, unknown> = {}) => call('POST', '/api/v1/agents/import', { ...bundle, ...extra, agent: { ...bundle.agent, id } }, token);
    assert.equal((await into('nova-three', OWNER)).status, 403, 'an owner cannot create agents');
    assert.equal((await into('nova-three', VIEWER)).status, 403);
    assert.equal((await into('nova')).status, 409, 'the id exists');
    state.agents.get('nova-two')!.state = 'RETIRED_PENDING_PURGE';
    assert.equal((await into('nova-two')).status, 409, 'a retired id is not free');
    assert.equal((await call('POST', '/api/v1/agents/import', { format: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/v1/agents/import', { ...bundle, skills: 'all' })).status, 400);
    const smuggled = await into('nova-four', ADMIN, { owners: ['token:evil'], token: 'secret' });
    assert.equal(smuggled.status, 201);
    assert.deepEqual(state.configs!.current('nova-four')!.owners, ['token:admin'], 'an owner named in a bundle is ignored');
    assert.equal((await call('POST', '/api/v1/agents/import', { bundle: { ...bundle, agent: { ...bundle.agent, id: 'nova-five' } } })).status, 201, 'the bundle may be wrapped');
    state.sharedRuntime = undefined;
    assert.equal((await into('nova-six')).status, 503);
  });
});
