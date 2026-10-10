// TSK-158 (DESIGN_AUTHORITY.md §6.14 SK1, SK3, SK6, SK7): adoption is a configuration change with its own approval; a
// private skill adopts for its owner when a version is approved and is visible to no one else; removal and retirement.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { VersionedConfigStore, type ConfigBackend, type ConfigRecord } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { adoptionStore, loadSkills, recordSkillChecks } from './skills.js';

const ADMIN = 'adoption-admin-token';
const HIGGINS_OWNER = 'adoption-higgins-owner-token';
const DONNA_OWNER = 'adoption-donna-owner-token';
const STRANGER = 'adoption-stranger-token';
const REPO = 'https://github.com/BeerCanLabs/skill-x';
const SHA = 'a'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  // A slow write, so two changes to one agent genuinely overlap unless the control plane serializes them.
  const write = async (r: ConfigRecord) => {
    await new Promise((done) => setTimeout(done, 25));
    records.push(r);
  };
  return { description: 'memory', loadAll: async () => records, write, remove: async () => {} };
};

const publicManifest = (id: string, version: string, routes = ['tavily']) => ({
  id,
  version,
  name: id,
  description: `The ${id} skill.`,
  language: 'python',
  entry: id.replace(/-/g, '_'),
  requires: { routes },
});

const privateManifest = (id: string, version: string, owner: string, extra: Record<string, unknown> = {}) => ({
  ...publicManifest(id, version, ['print']),
  visibility: 'private',
  owner,
  actions: [{ id: 'print-page', route: 'print', method: 'POST', path: '/jobs', hold: true }],
  ...extra,
});

describe('adoption: request, approve, remove, retire, and private skills (TSK-158)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;

  const call = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const actions = (name: string) => ledger.query().filter((e) => e.action === name);
  const skillsOf = (agent: string) => (state.configs!.current(agent)?.skills ?? []).map((s) => `${s.id}@${s.version}`);

  /** Registers a version, passes its checks and approves it as the admin. */
  async function publish(manifest: Record<string, unknown>, token = ADMIN) {
    const reg = await call('/api/v1/registry/skills', 'POST', token, { repo: REPO, path: '.', commit: SHA, manifest });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    recordSkillChecks(state, manifest.id as string, manifest.version as string, { passed: true });
    const approved = await call(`/api/v1/registry/skills/${manifest.id}/versions/${manifest.version}/approve`, 'POST', ADMIN, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    return approved.body;
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-adoption-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'higgins-owner', token: HIGGINS_OWNER, roles: ['viewer'] },
        { name: 'donna-owner', token: DONNA_OWNER, roles: ['viewer'] },
        { name: 'stranger', token: STRANGER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
    } as FactoryState;
    for (const id of ['higgins', 'donna']) {
      state.agents.set(id, { id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: `/agents/${id}` } as never);
    }
    state.configs = await VersionedConfigStore.open(memoryBackend());
    await state.configs.put({ agentId: 'higgins', source: {}, skills: [], policy: null, owners: ['token:higgins-owner'] }, { updatedBy: 'test', reason: 'owners' });
    await state.configs.put({ agentId: 'donna', source: {}, skills: [], policy: null, owners: ['token:donna-owner'] }, { updatedBy: 'test', reason: 'owners' });
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('registering a private skill (SK1)', () => {
    it('refuses an unknown owner agent and a registrant who is neither an admin nor that agent’s owner', async () => {
      const unknown = await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.1.0', 'ghost') });
      assert.equal(unknown.status, 422);
      assert.ok(unknown.body.reasons.some((r: string) => /agent ghost is not registered/.test(r)), JSON.stringify(unknown.body));
      for (const token of [STRANGER, DONNA_OWNER]) {
        const refused = await call('/api/v1/registry/skills', 'POST', token, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.1.0', 'higgins') });
        assert.equal(refused.status, 422, token);
        assert.ok(refused.body.reasons.some((r: string) => /only an admin or an owner of higgins/.test(r)), JSON.stringify(refused.body));
      }
    });

    it('accepts the owner of the named agent', async () => {
      const reg = await call('/api/v1/registry/skills', 'POST', HIGGINS_OWNER, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.1.0', 'higgins') });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      assert.equal(reg.body.manifest.visibility, 'private');
      assert.equal(reg.body.registeredBy, 'token:higgins-owner');
    });
  });

  describe('a private skill adopts for its owner when a version is approved (SK3)', () => {
    it('approving the version adopts it for higgins only, with the admin as approver, and ledgers it as automatic', async () => {
      recordSkillChecks(state, 'print', '0.1.0', { passed: true });
      const approved = await call('/api/v1/registry/skills/print/versions/0.1.0/approve', 'POST', ADMIN, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.deepEqual(approved.body.adopted, ['higgins']);
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0']);
      assert.deepEqual(skillsOf('donna'), []);
      const record = state.configs!.current('higgins')!;
      assert.deepEqual(record.skillAdoptions, [{ id: 'print', version: '0.1.0', requestedBy: 'token:higgins-owner', requestedAt: record.skillAdoptions![0].requestedAt, approvedBy: 'token:admin', approvedAt: record.skillAdoptions![0].approvedAt, auto: true }]);
      const row = actions('SKILL_ADOPTED_PRIVATE').at(-1)!;
      assert.deepEqual([row.agentId, row.actor, row.requestId], ['higgins', 'token:admin', 'skill:print@0.1.0']);
      assert.ok(actions('CONFIG_VERSIONED').some((e) => e.agentId === 'higgins' && e.requestId === `config:higgins:v${record.version}`));
    });

    it('is visible to admins and higgins’s owner, and does not exist for anyone else', async () => {
      for (const token of [ADMIN, HIGGINS_OWNER]) {
        const list = await call('/api/v1/skills', 'GET', token);
        assert.deepEqual(list.body.map((s: { id: string }) => s.id), ['print'], token);
        assert.equal(list.body[0].visibility, 'private');
        assert.equal(list.body[0].owner, 'higgins');
        assert.deepEqual(list.body[0].adopters.map((a: { agentId: string }) => a.agentId), ['higgins']);
        assert.equal((await call('/api/v1/skills/print', 'GET', token)).status, 200);
        assert.equal((await call('/api/v1/skills/print/versions/0.1.0', 'GET', token)).status, 200);
        assert.equal((await call('/api/v1/skills/print/adopters', 'GET', token)).status, 200);
      }
      for (const token of [STRANGER, DONNA_OWNER]) {
        assert.deepEqual((await call('/api/v1/skills', 'GET', token)).body, [], token);
        for (const path of ['/api/v1/skills/print', '/api/v1/skills/print/versions/0.1.0', '/api/v1/skills/print/adopters']) {
          assert.equal((await call(path, 'GET', token)).status, 404, `${token} ${path}`);
        }
      }
    });

    it('refuses to give it to another agent, and refuses another version’s visibility or owner', async () => {
      const donna = await call('/api/v1/agents/donna/skills', 'POST', ADMIN, { skillId: 'print', version: '0.1.0' });
      assert.equal(donna.status, 403);
      assert.equal(donna.body.error, 'skill_private');
      const asPublic = await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: publicManifest('print', '0.2.0', ['print']) });
      assert.equal(asPublic.status, 422);
      assert.ok(asPublic.body.reasons.some((r: string) => /cannot make it public.*register a new skill/.test(r)), JSON.stringify(asPublic.body));
      const otherOwner = await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.2.0', 'donna') });
      assert.equal(otherOwner.status, 422);
    });
  });

  describe('a public skill is requested, then decided (SK3)', () => {
    before(async () => {
      await publish(publicManifest('tavily-search', '0.1.0'));
    });

    it('approving a public version adopts it for nobody', async () => {
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0']);
      const list = await call('/api/v1/skills/tavily-search', 'GET', STRANGER);
      assert.equal(list.status, 200, 'a public skill is visible to every viewer');
      assert.deepEqual(list.body.adopters, []);
    });

    it('lists what an agent could adopt: public skills and its own private ones, not another agent’s', async () => {
      const higgins = await call('/api/v1/agents/higgins/skills', 'GET', HIGGINS_OWNER);
      assert.equal(higgins.status, 200);
      assert.deepEqual(higgins.body.available.map((s: { id: string }) => s.id), ['print', 'tavily-search']);
      const donna = await call('/api/v1/agents/donna/skills', 'GET', DONNA_OWNER);
      assert.deepEqual(donna.body.available.map((s: { id: string }) => s.id), ['tavily-search']);
      // Any viewer may read this route, so it must not name a private skill to someone who may not see it (SK7).
      for (const token of [DONNA_OWNER, STRANGER]) {
        const seen = await call('/api/v1/agents/higgins/skills', 'GET', token);
        assert.equal(seen.status, 200);
        assert.deepEqual(seen.body.adopted, [], `${token} must not learn that higgins runs the private print skill`);
        assert.deepEqual(seen.body.available.map((s: { id: string }) => s.id), ['tavily-search']);
      }
      assert.deepEqual((await call('/api/v1/agents/higgins/skills', 'GET', ADMIN)).body.adopted.map((a: { id: string }) => a.id), ['print']);
      assert.equal((await call('/api/v1/agents/ghost/skills', 'GET', ADMIN)).status, 404);
    });

    it('an owner can ask, a stranger and a viewer cannot, and nothing changes until an admin decides', async () => {
      const ask = { skillId: 'tavily-search', version: '0.1.0', reason: 'real-time search' };
      assert.equal((await call('/api/v1/agents/higgins/skills', 'POST', STRANGER, ask)).status, 403);
      assert.equal((await call('/api/v1/agents/higgins/skills', 'POST', DONNA_OWNER, ask)).status, 403);
      assert.equal((await call('/api/v1/agents/higgins/skills', 'POST')).status, 401);
      const asked = await call('/api/v1/agents/higgins/skills', 'POST', HIGGINS_OWNER, ask);
      assert.equal(asked.status, 201, JSON.stringify(asked.body));
      assert.equal(asked.body.state, 'requested');
      assert.deepEqual(asked.body.accessAdded.routes, ['tavily'], 'the approver sees what the skill would add');
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0']);
      const versions = state.configs!.history('higgins').length;
      const pending = (await call('/api/v1/skills/tavily-search/adopters', 'GET', ADMIN)).body;
      assert.deepEqual(pending.map((a: { agentId: string; state: string }) => [a.agentId, a.state]), [['higgins', 'requested']]);
      assert.equal(state.configs!.history('higgins').length, versions, 'a request creates no configuration version');
      assert.equal(actions('SKILL_ADOPTION_REQUESTED').at(-1)!.requestId, 'skill:tavily-search@0.1.0');
    });

    it('the owner cannot approve its own agent’s adoption; an admin can, and it lands as a configuration version', async () => {
      const approve = '/api/v1/agents/higgins/skills/tavily-search/adoption/approve';
      assert.equal((await call(approve, 'POST', HIGGINS_OWNER, {})).status, 403);
      assert.equal((await call(approve, 'POST', STRANGER, {})).status, 403);
      const done = await call(approve, 'POST', ADMIN, { reason: 'Approved for Higgins' });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0', 'tavily-search@0.1.0']);
      const record = state.configs!.current('higgins')!;
      assert.equal(done.body.configVersion, record.version);
      assert.deepEqual(record.skillAdoptions!.map((a) => [a.id, a.requestedBy, a.approvedBy, a.auto]), [['tavily-search', 'token:higgins-owner', 'token:admin', undefined]]);
      assert.equal(adoptionStore(state).get('higgins', 'tavily-search'), undefined, 'the request is gone');
      assert.equal(actions('SKILL_ADOPTION_APPROVED').at(-1)!.actor, 'token:admin');
      const agent = await call('/api/v1/agents/higgins/skills', 'GET', HIGGINS_OWNER);
      assert.deepEqual(agent.body.adopted.map((a: { id: string }) => a.id), ['print', 'tavily-search']);
    });

    it('refuses what is already adopted, what is unknown or unapproved, and a second approval', async () => {
      const ask = (body: unknown) => call('/api/v1/agents/higgins/skills', 'POST', HIGGINS_OWNER, body);
      assert.equal((await ask({ skillId: 'tavily-search', version: '0.1.0' })).body.error, 'already_adopted');
      assert.equal((await ask({ skillId: 'nope', version: '1.0.0' })).status, 404);
      assert.equal((await ask({ skillId: 'tavily-search', version: '9.9.9' })).status, 404);
      assert.equal((await ask({ skillId: 'Bad Id', version: '1.0.0' })).status, 400);
      await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: publicManifest('tavily-search', '0.2.0') });
      assert.equal((await ask({ skillId: 'tavily-search', version: '0.2.0' })).body.error, 'skill_not_approved');
      assert.equal((await call('/api/v1/agents/higgins/skills/tavily-search/adoption/approve', 'POST', ADMIN, {})).body.error, 'no_request');
    });

    it('a rejection changes nothing and ends the request', async () => {
      await call('/api/v1/agents/donna/skills', 'POST', DONNA_OWNER, { skillId: 'tavily-search', version: '0.1.0' });
      const rejected = await call('/api/v1/agents/donna/skills/tavily-search/adoption/reject', 'POST', ADMIN, { reason: 'not yet' });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.state, 'rejected');
      assert.deepEqual(skillsOf('donna'), []);
      assert.equal((await call('/api/v1/agents/donna/skills/tavily-search/adoption/approve', 'POST', ADMIN, {})).body.error, 'no_request');
      assert.equal(actions('SKILL_ADOPTION_REJECTED').at(-1)!.agentId, 'donna');
    });

    it('two adoptions approved at once for one agent both land', async () => {
      await publish(publicManifest('factory-schedules', '0.1.0', ['factory']));
      await publish(publicManifest('discord-progress', '0.1.0', ['discord']));
      for (const skillId of ['factory-schedules', 'discord-progress']) {
        assert.equal((await call('/api/v1/agents/donna/skills', 'POST', DONNA_OWNER, { skillId, version: '0.1.0' })).status, 201);
      }
      const both = await Promise.all(['factory-schedules', 'discord-progress'].map((id) => call(`/api/v1/agents/donna/skills/${id}/adoption/approve`, 'POST', ADMIN, {})));
      assert.deepEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body)));
      assert.deepEqual(skillsOf('donna'), ['discord-progress@0.1.0', 'factory-schedules@0.1.0']);
    });
  });

  describe('removing an adoption (SK3, SK6)', () => {
    it('the owner removes a public skill: a new version without it, ledgered; removing again is a 404', async () => {
      const before = state.configs!.current('higgins')!.version;
      const removed = await call('/api/v1/agents/higgins/skills/tavily-search', 'DELETE', HIGGINS_OWNER, { reason: 'no longer needed' });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(removed.body.configVersion, before + 1);
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0']);
      assert.equal(actions('SKILL_ADOPTION_REMOVED').at(-1)!.requestId, 'skill:tavily-search@0.1.0');
      assert.equal((await call('/api/v1/agents/higgins/skills/tavily-search', 'DELETE', HIGGINS_OWNER)).status, 404);
      assert.equal((await call('/api/v1/agents/donna/skills/factory-schedules', 'DELETE', HIGGINS_OWNER)).status, 403, 'not the owner of donna');
    });

    it('withdrawing a pending request is a removal that creates no version', async () => {
      await call('/api/v1/agents/higgins/skills', 'POST', HIGGINS_OWNER, { skillId: 'tavily-search', version: '0.1.0' });
      const versions = state.configs!.history('higgins').length;
      const out = await call('/api/v1/agents/higgins/skills/tavily-search', 'DELETE', HIGGINS_OWNER);
      assert.equal(out.status, 200);
      assert.equal(out.body.configVersion, undefined);
      assert.equal(state.configs!.history('higgins').length, versions);
      assert.equal(adoptionStore(state).get('higgins', 'tavily-search'), undefined);
    });

    it('removing a private skill from its owner stops later versions adopting by themselves, until a request is approved (SK6)', async () => {
      assert.equal((await call('/api/v1/agents/higgins/skills/print', 'DELETE', HIGGINS_OWNER)).status, 200);
      assert.deepEqual(skillsOf('higgins'), []);
      assert.equal(adoptionStore(state).blocksAutoAdopt('higgins', 'print'), true);

      await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.2.0', 'higgins') });
      recordSkillChecks(state, 'print', '0.2.0', { passed: true });
      const approved = await call('/api/v1/registry/skills/print/versions/0.2.0/approve', 'POST', ADMIN, {});
      assert.equal(approved.status, 200);
      assert.deepEqual(approved.body.adopted, [], 'the revocation holds');
      assert.deepEqual(skillsOf('higgins'), []);

      const ask = await call('/api/v1/agents/higgins/skills', 'POST', HIGGINS_OWNER, { skillId: 'print', version: '0.2.0' });
      assert.equal(ask.status, 201);
      assert.equal(adoptionStore(state).blocksAutoAdopt('higgins', 'print'), false);
      assert.equal((await call('/api/v1/agents/higgins/skills/print/adoption/approve', 'POST', ADMIN, {})).status, 200);
      assert.deepEqual(skillsOf('higgins'), ['print@0.2.0']);
    });

    it('a new version of an adopted private skill moves its owner to it', async () => {
      await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: privateManifest('print', '0.3.0', 'higgins') });
      recordSkillChecks(state, 'print', '0.3.0', { passed: true });
      const approved = await call('/api/v1/registry/skills/print/versions/0.3.0/approve', 'POST', ADMIN, {});
      assert.deepEqual(approved.body.adopted, ['higgins']);
      assert.deepEqual(skillsOf('higgins'), ['print@0.3.0']);
    });
  });

  describe('retiring a skill (SK6)', () => {
    it('is refused while an agent’s configuration adopts it, naming the agents', async () => {
      const out = await call('/api/v1/registry/skills/discord-progress/retire', 'POST', ADMIN, {});
      assert.equal(out.status, 409);
      assert.equal(out.body.error, 'skill_in_use');
      assert.deepEqual(out.body.agents, ['donna']);
      assert.equal((await call('/api/v1/registry/skills/discord-progress/retire', 'POST', HIGGINS_OWNER, {})).status, 403);
    });

    it('with force pauses the adopters, removes the skill from their configuration and retires every version', async () => {
      const forced = await call('/api/v1/registry/skills/discord-progress/retire', 'POST', ADMIN, { force: true, reason: 'replaced' });
      assert.equal(forced.status, 200, JSON.stringify(forced.body));
      assert.deepEqual([forced.body.retired, forced.body.paused, forced.body.removedFrom], [['0.1.0'], ['donna'], ['donna']]);
      assert.deepEqual(skillsOf('donna'), ['factory-schedules@0.1.0']);
      assert.equal(state.agents.get('donna')!.state, 'PAUSED');
      assert.equal(actions('SKILL_RETIRED_FORCED').at(-1)!.agentId, 'skill:discord-progress');
      assert.equal((await call('/api/v1/registry/skills/discord-progress/retire', 'POST', ADMIN, {})).body.error, 'already_retired');
    });

    it('a retired skill cannot be adopted, takes no new version and has no latest approved version', async () => {
      const ask = await call('/api/v1/agents/higgins/skills', 'POST', HIGGINS_OWNER, { skillId: 'discord-progress', version: '0.1.0' });
      assert.equal(ask.status, 409);
      assert.equal(ask.body.error, 'skill_retired');
      const reg = await call('/api/v1/registry/skills', 'POST', ADMIN, { repo: REPO, path: '.', commit: SHA, manifest: publicManifest('discord-progress', '0.2.0', ['discord']) });
      assert.equal(reg.status, 422);
      assert.ok(reg.body.reasons.some((r: string) => /is retired/.test(r)), JSON.stringify(reg.body));
      const summary = await call('/api/v1/skills/discord-progress', 'GET', STRANGER);
      assert.deepEqual([summary.body.retired, summary.body.latestApproved], [true, null]);
    });

    it('retiring an unused skill needs no force, and unknown is a 404', async () => {
      const out = await call('/api/v1/registry/skills/tavily-search/retire', 'POST', ADMIN, {});
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(out.body.retired, ['0.1.0', '0.2.0']);
      assert.equal(actions('SKILL_RETIRED').at(-1)!.agentId, 'skill:tavily-search');
      assert.equal((await call('/api/v1/registry/skills/nope/retire', 'POST', ADMIN, {})).status, 404);
    });
  });
});
