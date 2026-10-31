import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { loadSkills, recordSkillChecks, defaultSkillsStore } from './skills.js';

const ADMIN = 'admin-default-skills';
const OPERATOR = 'operator-default-skills';
const VIEWER = 'viewer-default-skills';
const SHA = 'a'.repeat(40);
const RUNTIME_SHA = 'b'.repeat(40);
const IMAGE = 'registry.example/agent-runtime:test';
const KEY = 'default-skills-key-0123456789abcdef';

describe('Admin-managed default skills and automatic creation/conversion seeding (GAP-216, TSK-292)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);
  const builtImages: string[] = [];

  const call = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const registerSkill = async (id: string, version: string, extra?: Record<string, unknown>) => {
    const manifest = {
      id,
      version,
      name: id,
      description: `Test skill ${id}`,
      language: 'python',
      entry: id,
      visibility: 'public',
      requires: { routes: ['models'] },
      actions: [{ id: 'ping', route: 'models', method: 'GET', path: '/ping', hold: false }],
      smoke: { action: 'ping', input: {} },
      ...extra,
    };
    const reg = await call('POST', '/api/v1/registry/skills', {
      repo: `https://github.com/BeerCanLabs/skill-${id}`,
      path: '.',
      commit: SHA,
      manifest,
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    recordSkillChecks(state, id, version, { passed: true });
    return manifest;
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-default-skills-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async () => IMAGE,
        buildSkillsImage: async () => {
          builtImages.push('built-skills-image');
          return 'registry.example/skills-layered:test';
        },
        provisionIdentity: async () => ({ identity: 'id', executionIdentity: 'exec' }),
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
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces authorization on GET and PUT /api/v1/skills/defaults', async () => {
    // Viewer can read defaults
    const viewRes = await call('GET', '/api/v1/skills/defaults', undefined, VIEWER);
    assert.equal(viewRes.status, 200);
    assert.deepEqual(viewRes.body.skills, []);

    // Unauthenticated caller is rejected (401)
    const anonRes = await fetch(`http://127.0.0.1:${port}/api/v1/skills/defaults`);
    assert.equal(anonRes.status, 401);

    // Operator and viewer cannot set defaults (403)
    const opPut = await call('PUT', '/api/v1/skills/defaults', { skills: [] }, OPERATOR);
    assert.equal(opPut.status, 403);
    const viewPut = await call('PUT', '/api/v1/skills/defaults', { skills: [] }, VIEWER);
    assert.equal(viewPut.status, 403);
  });

  it('rejects registering a skill with reserved id "defaults"', async () => {
    const reg = await call('POST', '/api/v1/registry/skills', {
      repo: 'https://github.com/BeerCanLabs/skill-defaults',
      path: '.',
      commit: SHA,
      manifest: {
        id: 'defaults',
        version: '1.0.0',
        name: 'defaults',
        description: 'Should fail',
        language: 'python',
        entry: 'defaults',
        visibility: 'public',
      },
    });
    assert.equal(reg.status, 400);
    assert.equal(reg.body.error, 'invalid_skill_id');
  });

  it('validates PUT /api/v1/skills/defaults (nonexistent, unapproved, private, duplicate, malformed)', async () => {
    // Nonexistent skill
    const missing = await call('PUT', '/api/v1/skills/defaults', {
      skills: [{ id: 'nonexistent-skill', version: '1.0.0' }],
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not_found');

    // Register skills for validation testing
    await registerSkill('sched', '1.0.0');
    // Not approved yet
    const unapproved = await call('PUT', '/api/v1/skills/defaults', {
      skills: [{ id: 'sched', version: '1.0.0' }],
    });
    assert.equal(unapproved.status, 409);
    assert.equal(unapproved.body.error, 'skill_not_approved');

    // Approve sched@1.0.0
    const appRes = await call('POST', '/api/v1/registry/skills/sched/versions/1.0.0/approve', {});
    assert.equal(appRes.status, 200);

    // Register a private skill
    const privManifest = {
      id: 'priv-skill',
      version: '1.0.0',
      name: 'Private',
      description: 'Private',
      language: 'python',
      entry: 'priv',
      visibility: 'private',
      owner: 'some-agent',
    };
    // Pretend some-agent exists
    state.agents.set('some-agent', { id: 'some-agent' } as any);
    await call('POST', '/api/v1/registry/skills', {
      repo: 'https://github.com/BeerCanLabs/skill-priv',
      path: '.',
      commit: SHA,
      manifest: privManifest,
    });
    recordSkillChecks(state, 'priv-skill', '1.0.0', { passed: true });
    await call('POST', '/api/v1/registry/skills/priv-skill/versions/1.0.0/approve', {});

    const privPut = await call('PUT', '/api/v1/skills/defaults', {
      skills: [{ id: 'priv-skill', version: '1.0.0' }],
    });
    assert.equal(privPut.status, 409);
    assert.equal(privPut.body.error, 'skill_not_public');

    // Duplicate skill in list
    const dupPut = await call('PUT', '/api/v1/skills/defaults', {
      skills: [
        { id: 'sched', version: '1.0.0' },
        { id: 'sched', version: '1.0.0' },
      ],
    });
    assert.equal(dupPut.status, 400);
    assert.equal(dupPut.body.error, 'duplicate_skill');

    // Malformed body
    const badBody = await call('PUT', '/api/v1/skills/defaults', { skills: 'not-array' });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.error, 'invalid_defaults');

    const badEntry = await call('PUT', '/api/v1/skills/defaults', {
      skills: [{ id: 'invalid_id!', version: '1.0.0' }],
    });
    assert.equal(badEntry.status, 400);
    assert.equal(badEntry.body.error, 'invalid_defaults');
  });

  it('sets default skills, persists to disk, ledgers DEFAULT_SKILLS_SET, and enriches catalog summaries', async () => {
    await registerSkill('knowledge-retrieval', '2.0.0');
    await call('POST', '/api/v1/registry/skills/knowledge-retrieval/versions/2.0.0/approve', {});

    const setRes = await call('PUT', '/api/v1/skills/defaults', {
      skills: [
        { id: 'sched', version: '1.0.0' },
        { id: 'knowledge-retrieval', version: '2.0.0' },
      ],
      reason: 'Standard baseline skills',
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.ok, true);
    assert.equal(setRes.body.skills.length, 2);

    // Ledger check
    const ledgerRow = ledger.query({ action: 'DEFAULT_SKILLS_SET' });
    assert.ok(ledgerRow.length > 0);
    assert.equal(ledgerRow[ledgerRow.length - 1].agentId, 'factory');

    // GET /api/v1/skills/defaults
    const getRes = await call('GET', '/api/v1/skills/defaults');
    assert.equal(getRes.status, 200);
    assert.deepEqual(getRes.body.skills, [
      { id: 'sched', version: '1.0.0' },
      { id: 'knowledge-retrieval', version: '2.0.0' },
    ]);
    assert.ok(getRes.body.updatedAt);
    assert.equal(getRes.body.updatedBy, 'token:admin');

    // Catalog enrichment: GET /api/v1/skills and GET /api/v1/skills/:id
    const catalogRes = await call('GET', '/api/v1/skills');
    const schedSummary = catalogRes.body.find((s: any) => s.id === 'sched');
    assert.ok(schedSummary);
    assert.equal(schedSummary.defaultVersion, '1.0.0');

    const oneSched = await call('GET', '/api/v1/skills/sched');
    assert.equal(oneSched.status, 200);
    assert.equal(oneSched.body.defaultVersion, '1.0.0');

    // Persistence reload check
    loadSkills(state, join(dir, 'skills'));
    const reloaded = await call('GET', '/api/v1/skills/defaults');
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.skills.length, 2);
  });

  it('automatically seeds default skills into initial config on agent creation, and allows role references (CF2)', async () => {
    const created = await call('POST', '/api/v1/agents', {
      id: 'fleet-agent-1',
      name: 'Fleet Agent 1',
      soul: 'You are a fleet agent.',
      memory: { archetype: 'personal-assistant' },
      roles: [
        {
          name: 'Scheduler',
          skills: {
            sched: { allow: ['*'] },
          },
        },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.skills, [
      { id: 'sched', version: '1.0.0' },
      { id: 'knowledge-retrieval', version: '2.0.0' },
    ]);

    const storedCfg = state.configs!.current('fleet-agent-1')!;
    assert.deepEqual(storedCfg.skills, [
      { id: 'sched', version: '1.0.0' },
      { id: 'knowledge-retrieval', version: '2.0.0' },
    ]);
    assert.ok(storedCfg.skillAdoptions);
    assert.equal(storedCfg.skillAdoptions[0].approvedBy, 'factory:defaults');
  });

  it('prefers custom version in spec.skills over default skill version ("custom version wins")', async () => {
    // Register sched@1.1.0
    await registerSkill('sched', '1.1.0');
    await call('POST', '/api/v1/registry/skills/sched/versions/1.1.0/approve', {});

    const created = await call('POST', '/api/v1/agents', {
      id: 'fleet-agent-custom',
      name: 'Fleet Agent Custom',
      soul: 'You are a custom agent.',
      memory: { archetype: 'personal-assistant' },
      skills: [{ id: 'sched', version: '1.1.0' }],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.skills, [
      { id: 'sched', version: '1.1.0' },
      { id: 'knowledge-retrieval', version: '2.0.0' },
    ]);
    const storedCfg = state.configs!.current('fleet-agent-custom')!;
    assert.equal(storedCfg.skillAdoptions![0].approvedBy, 'token:admin');
    assert.equal(storedCfg.skillAdoptions![1].approvedBy, 'factory:defaults');
  });

  it('respects includeDefaultSkills: false and excludeDefaultSkills on creation', async () => {
    // includeDefaultSkills: false
    const optOutAll = await call('POST', '/api/v1/agents', {
      id: 'agent-opt-out-all',
      name: 'Opt Out',
      soul: 'Opt out',
      memory: { archetype: 'personal-assistant' },
      includeDefaultSkills: false,
    });
    assert.equal(optOutAll.status, 201);
    assert.deepEqual(optOutAll.body.skills, []);

    // excludeDefaultSkills: ['sched']
    const optOutOne = await call('POST', '/api/v1/agents', {
      id: 'agent-opt-out-sched',
      name: 'Opt Out Sched',
      soul: 'Opt out',
      memory: { archetype: 'personal-assistant' },
      excludeDefaultSkills: ['sched'],
    });
    assert.equal(optOutOne.status, 201);
    assert.deepEqual(optOutOne.body.skills, [{ id: 'knowledge-retrieval', version: '2.0.0' }]);
  });

  it('allows owner to remove a seeded default skill post-creation and it stays removed (SK6)', async () => {
    const delRes = await call('DELETE', '/api/v1/agents/fleet-agent-1/skills/sched');
    assert.equal(delRes.status, 200);

    const cfg = state.configs!.current('fleet-agent-1')!;
    assert.deepEqual(cfg.skills, [{ id: 'knowledge-retrieval', version: '2.0.0' }]);
  });

  it('automatically seeds default skills on repository agent convert-in-place unless opted out or overridden', async () => {
    // Create an old repository agent
    const repoAgent = {
      id: 'convert-demo',
      name: 'Convert Demo',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'cloud',
      artifact: 'registry.example/old-repo:test',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/tmp/convert-demo',
      model: 'gemini-2.0-flash',
      repo: 'https://github.com/BeerCanLabs/SM-demo',
      commit: SHA,
    };
    state.agents.set('convert-demo', repoAgent as any);
    state.policies.set('convert-demo', { routes: ['models'] } as any);
    await state.configs!.put(
      { agentId: 'convert-demo', source: { repo: repoAgent.repo, commit: repoAgent.commit }, skills: [], owners: ['token:admin'], policy: { routes: ['models'] } },
      { updatedBy: 'token:admin', reason: 'init' },
    );

    // Convert in place
    const conv = await call('POST', '/api/v1/agents/convert-demo/convert', {
      soul: 'Converted soul.',
      memory: { archetype: 'personal-assistant' },
      roles: [{ name: 'DefaultRole', skills: { sched: { allow: ['*'] } } }],
    });
    assert.equal(conv.status, 200, JSON.stringify(conv.body));
    const stored = state.configs!.current('convert-demo')!;
    assert.deepEqual(stored.skills, [
      { id: 'sched', version: '1.0.0' },
      { id: 'knowledge-retrieval', version: '2.0.0' },
    ]);
  });

  it('does NOT inject unrequested default skills on bundle import (CF3)', async () => {
    // Create an agent with no skills and export bundle
    await call('POST', '/api/v1/agents', {
      id: 'export-clean',
      name: 'Clean',
      soul: 'Clean soul',
      memory: { archetype: 'personal-assistant' },
      includeDefaultSkills: false,
    });
    const exported = await call('GET', '/api/v1/agents/export-clean/bundle');
    assert.equal(exported.status, 200);

    // Change bundle id and import
    const bundleData = exported.body;
    bundleData.agent.id = 'imported-clean';
    const imported = await call('POST', '/api/v1/agents/import', { bundle: bundleData });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));

    const cfg = state.configs!.current('imported-clean')!;
    assert.deepEqual(cfg.skills, [], 'bundle import must preserve exact skills (CF3)');
  });

  it('automatically prunes default skill on skill retirement or revocation or unpublish', async () => {
    // Current defaults: sched, knowledge-retrieval
    assert.equal(defaultSkillsStore(state).get().skills.length, 2);

    // 1. Retire knowledge-retrieval
    const retRes = await call('POST', '/api/v1/registry/skills/knowledge-retrieval/retire', { force: true });
    assert.equal(retRes.status, 200);

    const afterRetire = await call('GET', '/api/v1/skills/defaults');
    assert.deepEqual(afterRetire.body.skills, [{ id: 'sched', version: '1.0.0' }]);

    // 2. Reject/revoke sched@1.0.0
    const rejRes = await call('POST', '/api/v1/registry/skills/sched/versions/1.0.0/reject', { force: true });
    assert.equal(rejRes.status, 200);

    const afterRej = await call('GET', '/api/v1/skills/defaults');
    assert.deepEqual(afterRej.body.skills, []);
  });
});
