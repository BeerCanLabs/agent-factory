// TSK-271 (DESIGN_AUTHORITY.md §6.18 CF5, §6.14 SK1 to SK3): a private skill version that passes the factory's checks is
// approved by the owner of its owner agent; a public one by an admin; approving grants nothing; an agent cannot approve.
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
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
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
    await new Promise((done) => setTimeout(done, 40));
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

describe('CF5 skill approval by owner (private) or admin (public) (TSK-271)', { concurrency: false }, () => {
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

  const decide = (id: string, version: string, d: 'approve' | 'reject', token: string, extra: Record<string, unknown> = {}) =>
    call(`/api/v1/registry/skills/${id}/versions/${version}/${d}`, 'POST', token, extra);
  const register = async (manifest: Record<string, unknown>, token: string) => {
    const reg = await call('/api/v1/registry/skills', 'POST', token, { repo: REPO, path: '.', commit: SHA, manifest });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
  };

  describe('a private skill version', () => {
    before(async () => {
      await register(privateManifest('print', '0.1.0', 'higgins'), HIGGINS_OWNER);
    });

    it('cannot be approved by its owner before the factory’s checks have passed', async () => {
      const r = await decide('print', '0.1.0', 'approve', HIGGINS_OWNER);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'checks_pending');
      assert.deepEqual(skillsOf('higgins'), []);
    });

    it('cannot be approved by anyone but an owner of its agent or an admin, and nothing changes', async () => {
      recordSkillChecks(state, 'print', '0.1.0', { passed: true });
      for (const token of [STRANGER, DONNA_OWNER]) {
        const r = await decide('print', '0.1.0', 'approve', token);
        assert.equal(r.status, 403, token);
        const rejected = await decide('print', '0.1.0', 'reject', token);
        assert.equal(rejected.status, 403, token);
      }
      assert.equal((await decide('print', '0.1.0', 'approve', undefined as never)).status, 401);
      assert.equal(actions('SKILL_APPROVED').length, 0);
      assert.deepEqual(skillsOf('higgins'), []);
    });

    it('is approved by its owner: adopted for that agent, the owner recorded as approver, ledgered', async () => {
      const r = await decide('print', '0.1.0', 'approve', HIGGINS_OWNER, { reason: 'mine' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'approved');
      assert.equal(r.body.decidedBy, 'token:higgins-owner');
      assert.deepEqual(r.body.adopted, ['higgins']);
      assert.deepEqual(skillsOf('higgins'), ['print@0.1.0']);
      assert.deepEqual(skillsOf('donna'), []);
      const row = actions('SKILL_APPROVED').at(-1)!;
      assert.deepEqual([row.agentId, row.actor], ['skill:print@0.1.0', 'token:higgins-owner']);
      const record = state.configs!.current('higgins')!;
      assert.equal(record.skillAdoptions![0].approvedBy, 'token:higgins-owner');
    });

    it('grants nothing: the owner cannot give their agent a route, and the policy is unchanged', async () => {
      const before = JSON.stringify(state.policies.get?.('higgins') ?? null);
      const put = await call('/api/v1/agents/higgins/policy', 'PUT', HIGGINS_OWNER, { routes: [{ name: 'print' }] });
      assert.equal(put.status, 403);
      assert.equal(JSON.stringify(state.policies.get?.('higgins') ?? null), before);
    });

    it('cannot be revoked by its owner once approved; an admin can', async () => {
      const r = await decide('print', '0.1.0', 'reject', HIGGINS_OWNER, { force: true });
      assert.equal(r.status, 403);
      assert.equal(state.configs!.current('higgins')!.skills!.length, 1);
      const admin = await decide('print', '0.1.0', 'reject', ADMIN, { force: true });
      assert.equal(admin.status, 200, JSON.stringify(admin.body));
    });

    it('is not put back by its owner once an admin has revoked or rejected it', async () => {
      // 0.1.0 was revoked by the admin in the test above; 0.4.0 is rejected by the admin while pending.
      assert.equal((await decide('print', '0.1.0', 'approve', HIGGINS_OWNER)).status, 403, 'revoked by an admin');
      await register(privateManifest('print', '0.4.0', 'higgins'), HIGGINS_OWNER);
      recordSkillChecks(state, 'print', '0.4.0', { passed: true });
      assert.equal((await decide('print', '0.4.0', 'reject', ADMIN, { reason: 'no' })).status, 200);
      assert.equal((await decide('print', '0.4.0', 'approve', HIGGINS_OWNER)).status, 403, 'rejected by an admin');
      assert.equal((await decide('print', '0.4.0', 'approve', ADMIN)).status, 200, 'an admin may still change their mind');
    });

    it('can be turned down by its owner while pending', async () => {
      await register(privateManifest('print', '0.2.0', 'higgins'), HIGGINS_OWNER);
      const r = await decide('print', '0.2.0', 'reject', HIGGINS_OWNER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'rejected');
      assert.equal(actions('SKILL_REJECTED').at(-1)!.actor, 'token:higgins-owner');
    });

    it('is still decided by an admin', async () => {
      await register(privateManifest('print', '0.3.0', 'higgins'), HIGGINS_OWNER);
      recordSkillChecks(state, 'print', '0.3.0', { passed: true });
      assert.equal((await decide('print', '0.3.0', 'approve', ADMIN)).status, 200);
    });
  });

  describe('a public skill version', () => {
    before(async () => {
      await register(publicManifest('lookup', '1.0.0'), ADMIN);
      recordSkillChecks(state, 'lookup', '1.0.0', { passed: true });
    });

    it('is approved by an admin only: no owner, not even of an agent that would use it', async () => {
      for (const token of [HIGGINS_OWNER, DONNA_OWNER, STRANGER]) {
        assert.equal((await decide('lookup', '1.0.0', 'approve', token)).status, 403, token);
        assert.equal((await decide('lookup', '1.0.0', 'reject', token)).status, 403, token);
      }
      assert.equal((await decide('lookup', '1.0.0', 'approve', ADMIN)).status, 200);
    });

    it('and an unknown version is not revealed to a caller who could decide nothing', async () => {
      assert.equal((await decide('nope', '1.0.0', 'approve', HIGGINS_OWNER)).status, 403);
      assert.equal((await decide('nope', '1.0.0', 'approve', ADMIN)).status, 404);
    });
  });
});
