// TSK-270 (DESIGN_AUTHORITY.md §6.18 CF6, RT1): an agent is created from a configuration on the pinned shared runtime, a new
// agent id is no longer registered from a repository, and every agent that already exists is untouched.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
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
import { loadSkills, recordSkillChecks } from './skills.js';

const ADMIN = 'admin-create';
const OPERATOR = 'operator-create';
const OWNER = 'owner-create';
const VIEWER = 'viewer-create';
const SHA = '6'.repeat(40);
const RUNTIME_SHA = 'd'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:test';
const KEY = 'creation-run-token-key-0123456789abc';

describe('agents are created from a configuration on the shared runtime (CF6, RT1, TSK-270)', { concurrency: false }, () => {
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
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'owner-svc', token: OWNER, roles: [] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({ FACTORY_GITHUB_WEBHOOK_SECRET: 'test-creation-secret' })],
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

  it('registers an existing agent from its repository while the old way is still open (before the rule is on)', async () => {
    const reg = await call('POST', '/api/v1/registry/agents', { repo: 'https://github.com/beercanlabs/SM-old', commit: SHA, cartridge: cartridge('old') });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    state.newAgentsFromConfigurationOnly = true;
    state.repositoryAgentIds = new Set(['house-staff']);
  });

  it('a release of the runtime repository does not offer an update to a configuration agent', async () => {
    const rec = { id: 'hooked-cfg', name: 'h', role: 'Agent', state: 'SLEEPING', provider: 'cloud', artifact: IMAGE, requires: [], ungated: [], gated: [], triggers: [], dir: '/x', repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, createdFrom: 'configuration' } as never;
    state.agents.set('hooked-cfg', rec);
    const bodyStr = JSON.stringify({ action: 'published', repository: { html_url: 'https://github.com/BeerCanLabs/agent-factory' }, release: { tag_name: 'v9.9.9', target_commitish: 'f'.repeat(40) } });
    const sig = 'sha256=' + createHmac('sha256', 'test-creation-secret').update(bodyStr).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'release',
        'x-hub-signature-256': sig,
      },
      body: bodyStr,
    });
    assert.equal(res.status, 200);
    const after = state.agents.get('hooked-cfg')!;
    assert.equal(after.offeredCommit, undefined);
    assert.equal(after.updateAvailable, undefined);
    state.agents.delete('hooked-cfg');
  });

  it('an admin or operator creates an agent; a bare owner, a viewer and a run token cannot (CF6, decision 7)', async () => {
    assert.equal((await call('POST', '/api/v1/agents', NEW, OWNER)).status, 403);
    assert.equal((await call('POST', '/api/v1/agents', NEW, VIEWER)).status, 403);
    const run = state.runs.create({ agentId: 'old', state: 'WORKING', actor: 'x', trigger: 'api' } as never);
    assert.equal((await call('POST', '/api/v1/agents', NEW, await tokens.mint({ runId: run.runId, agentId: 'old' }))).status, 401);
    assert.equal(state.agents.has('nova'), false);
    const opCreated = await call('POST', '/api/v1/agents', { ...NEW, id: 'op-nova' }, OPERATOR);
    assert.equal(opCreated.status, 201);
    assert.equal(state.agents.has('op-nova'), true);
    assert.deepEqual(state.configs!.current('op-nova')!.owners, ['token:operator']);
  });

  it('creates an agent with no repository: pinned to the runtime, owned by its creator, with nothing granted', async () => {
    const created = await call('POST', '/api/v1/agents', NEW);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const a = state.agents.get('nova')!;
    assert.equal(a.createdFrom, 'configuration');
    assert.equal(a.commit, RUNTIME_SHA);
    assert.equal(a.artifact, IMAGE);
    assert.deepEqual([a.requires, a.egress, a.triggers], [[], undefined, []], 'no host, credential or trigger of its own (E8)');
    assert.equal(a.state, 'PENDING_BUDGET');
    assert.equal(state.policies.has('nova'), false, 'E7: no policy until an admin sets one');
    const cfg = state.configs!.current('nova')!;
    assert.equal(cfg.agent?.soul, NEW.soul);
    assert.deepEqual(cfg.owners, ['token:admin']);
    assert.deepEqual(cfg.skills, []);
    assert.equal(cfg.source.commit, RUNTIME_SHA);
    const rows = ledger.query({ agent: 'nova' }).filter((e) => e.action === 'AGENT_CREATED_FROM_CONFIGURATION');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'token:admin');
    assert.ok(!JSON.stringify(ledger.query()).includes('SECRET-SOUL'), 'the soul is never in the ledger');
    assert.equal((await call('GET', '/api/v1/agents/nova/settings')).body.settings.soul, NEW.soul);
  });

  it('refuses a duplicate, a reserved id, an id that is still held, a missing archetype, a role naming a skill it lacks and a bad id', async () => {
    assert.equal((await call('POST', '/api/v1/agents', NEW)).status, 409, 'an existing new agent');
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'old' })).status, 409, 'an agent registered from a repository');
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'house-staff' })).status, 409, 'staff');
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'coach' })).status, 409, 'built in');
    await state.configs!.put({ agentId: 'orphan', source: {}, skills: [], policy: null }, { updatedBy: 't', reason: 'x' });
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'orphan' })).body.error, 'configuration_exists');
    assert.equal((await call('POST', '/api/v1/agents', { id: 'nomem', soul: 'x' })).body.error, 'archetype_required');
    const role = await call('POST', '/api/v1/agents', { ...NEW, id: 'norole', roles: [{ name: 'G', skills: { gmail: { allow: ['*'] } } }] });
    assert.equal(role.body.error, 'unknown_skill');
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: '__x' })).status, 400);
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'a/b' })).status, 400);
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'big', soul: 'x'.repeat(70000) })).status, 400);
    for (const id of ['nomem', 'norole', '__x', 'a/b', 'big']) assert.equal(state.agents.has(id), false);
  });

  it('cannot be created without a pinned shared runtime', async () => {
    const pin = state.sharedRuntime;
    state.sharedRuntime = undefined;
    try {
      assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'unpinned' })).status, 503);
    } finally {
      state.sharedRuntime = pin;
    }
    assert.equal(state.agents.has('unpinned'), false);
    state.sharedRuntime = { ...pin!, commit: 'abc123' };
    try {
      assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'unpinned' })).status, 503, 'a runtime pinned to a short commit is not a pin');
    } finally {
      state.sharedRuntime = pin;
    }
  });

  it('two creations of one id at once give one agent', async () => {
    const both = await Promise.all([call('POST', '/api/v1/agents', { ...NEW, id: 'twin' }), call('POST', '/api/v1/agents', { ...NEW, id: 'twin' })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  });

  it('leaves nothing behind when a creation fails part way, so the id can be tried again', async () => {
    const realAppend = ledger.append.bind(ledger);
    let failed = false;
    (ledger as { append: unknown }).append = (row: { action?: string }) => {
      if (row.action === 'AGENT_CREATED_FROM_CONFIGURATION' && !failed) {
        failed = true;
        throw new Error('ledger down');
      }
      return realAppend(row as never);
    };
    try {
      assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'flaky' })).status, 500);
    } finally {
      (ledger as { append: unknown }).append = realAppend;
    }
    assert.equal(state.agents.has('flaky'), false);
    assert.equal(state.configs!.current('flaky'), undefined, 'no orphaned configuration');
    assert.equal(existsSync(join(dir, 'registry', 'flaky.json')), false, 'and no registry file to come back after a restart');
    assert.equal((await call('POST', '/api/v1/agents', { ...NEW, id: 'flaky' })).status, 201, 'the id is free');
  });

  it('serves the run on the shared runtime its own agent’s configuration, and no one else', async () => {
    const run = state.runs.create({ agentId: 'nova', state: 'WORKING', actor: 'token:admin', trigger: 'api' } as never);
    const token = await tokens.mint({ runId: run.runId, agentId: 'nova' });
    const got = await call('GET', `/api/v1/runs/${run.runId}/agent-config`, undefined, token);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.soul, NEW.soul);
    assert.deepEqual(got.body.memory, { archetype: 'personal-assistant' });
    assert.deepEqual(got.body.skills, []);
    assert.equal((await call('GET', `/api/v1/runs/${run.runId}/agent-config`, undefined, ADMIN)).status, 401, 'a principal is not a run');
    const old = state.runs.create({ agentId: 'old', state: 'WORKING', actor: 'token:admin', trigger: 'api' } as never);
    const oldToken = await tokens.mint({ runId: old.runId, agentId: 'old' });
    assert.equal((await call('GET', `/api/v1/runs/${old.runId}/agent-config`, undefined, oldToken)).status, 404, 'an agent registered from a repository has no such configuration');
    assert.equal((await call('GET', `/api/v1/runs/${run.runId}/agent-config`, undefined, oldToken)).status, 401, 'another agent’s token does not read it');
    // Even a repository agent that was given a section by its owner is not served one: it runs its own copy.
    assert.equal((await call('PUT', '/api/v1/agents/old/settings', { soul: 'repo agent soul' })).status, 200);
    assert.equal((await call('GET', `/api/v1/runs/${old.runId}/agent-config`, undefined, oldToken)).status, 404);
    await call('PUT', '/api/v1/agents/old/settings', { soul: null });
  });

  it('refuses to register a new agent id from a repository, with a message that says how to create one; existing, retired and staff ids keep the old way; a purged id is new', async () => {
    const reg = (id: string) => call('POST', '/api/v1/registry/agents', { repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, cartridge: cartridge(id) });
    const refused = await reg('fresh');
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'new_agents_use_configuration');
    assert.match(refused.body.message, /POST \/api\/v1\/agents/);
    assert.equal(state.agents.has('fresh'), false);
    assert.ok(ledger.query({ agent: 'fresh' }).some((e) => e.action === 'AGENT_REGISTRATION_REFUSED:new_agents_use_configuration'));
    assert.equal((await reg('old')).status, 201, 'an existing agent re-registers (a new commit, a redeploy)');
    state.agents.get('old')!.state = 'RETIRED_PENDING_PURGE';
    assert.equal((await reg('old')).status, 201, 'a retired agent keeps its repository flow');
    assert.equal((await reg('house-staff')).status, 201, 'L2 staff an operator admits');
    state.agents.delete('old');
    assert.equal((await reg('old')).status, 422, 'a purged id is new');
    // An agent created from a configuration is never re-registered from a repository, which would strip its configuration.
    const again = await reg('nova');
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'configuration_agent');
    assert.equal(state.agents.get('nova')!.createdFrom, 'configuration');
    assert.equal(state.agents.get('nova')!.commit, RUNTIME_SHA);
    // Nor does the repository update machinery move it off the pinned runtime.
    assert.equal((await call('POST', '/api/v1/agents/nova/updates/check', {})).status, 409);
    assert.equal((await call('POST', '/api/v1/agents/nova/updates/install', { commit: 'f'.repeat(40) })).status, 409);
    assert.equal(state.agents.get('nova')!.commit, RUNTIME_SHA);
    // The MCP tools are the same routes by another door.
    for (const name of ['check_agent_update', 'install_agent_update']) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { id: 'nova' } } }) });
      assert.ok((await res.text()).includes('configuration_agent'), name);
    }
    assert.equal(state.agents.get('nova')!.deployedCommit, undefined, 'nothing marked it deployed');
  });

  it('deploys an agent created from a configuration on the runtime image, only with a policy and without adopted skills; nothing else is touched', async () => {
    const deploy = () => call('POST', '/api/v1/registry/agents/nova/deploy', {});
    assert.equal((await deploy()).body.error, 'policy_required');
    assert.equal((await call('PUT', '/api/v1/agents/nova/policy', { routes: ['models'] })).status, 200);
    const ok = await deploy();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(deployed, [{ agentId: 'nova', image: IMAGE }]);
    assert.equal(state.agents.get('nova')!.state, 'SLEEPING');
    assert.equal(state.agents.get('nova')!.deployedCommit, RUNTIME_SHA);
    // With an adopted skill the image would need a build that does not exist yet: refused, not deployed without it.
    const manifest = { id: 'notes', version: '1.0.0', name: 'notes', description: 'Notes.', language: 'python', entry: 'notes', visibility: 'private', owner: 'nova', requires: { routes: ['models'] } };
    assert.equal((await call('POST', '/api/v1/registry/skills', { repo: 'https://github.com/BeerCanLabs/skill-notes', path: '.', commit: SHA, manifest })).status, 201);
    recordSkillChecks(state, 'notes', '1.0.0', { passed: true });
    assert.deepEqual((await call('POST', '/api/v1/registry/skills/notes/versions/1.0.0/approve', {})).body.adopted, ['nova']);
    const withSkill = await deploy();
    assert.equal(withSkill.body.error, 'skills_image_not_supported', JSON.stringify(withSkill.body));
    assert.equal(deployed.length, 1, 'nothing was deployed without its skill');
    assert.deepEqual(built, [], 'and the configuration apply never builds this repository as if it were a cartridge');
    assert.ok(ledger.query({ agent: 'nova' }).some((e) => e.action === 'AGENT_CONFIG_APPLY_SKIPPED'), 'the skipped apply is on the record');
    assert.equal(state.agents.get('nova')!.artifact, IMAGE);
  });
});
