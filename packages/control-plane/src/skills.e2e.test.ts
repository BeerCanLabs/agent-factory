// TSK-053: the skill registry (DESIGN_AUTHORITY.md §6.14 SK1, SK2). Register, admit, approve per version, list; only
// approved versions are adoptable; every registration, refusal and decision is ledgered.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { approvedSkill, loadSkills, recordSkillChecks, setSkillUsage, skillRegistry } from './skills.js';

const ADMIN = 'admin-skills-token';
const OPERATOR = 'operator-skills-token';
const VIEWER = 'viewer-skills-token';
const REPO = 'https://github.com/BeerCanLabs/skill-discord-progress';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function manifest(version: string, requires: Record<string, unknown> = { routes: ['discord'], credentials: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord' }] }) {
  return {
    id: 'discord-progress',
    version,
    name: 'Discord progress',
    description: 'One live status message per run.',
    language: 'node',
    entry: 'src/index.ts',
    requires,
  };
}

describe('SK1 SK2 skill registry: register, admit, approve per version, catalog (TSK-053)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  const actions = () => ledger.query().filter((e) => e.agentId.startsWith('skill:'));

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-skills-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(['ANTHROPIC_API_KEY']),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
    } as FactoryState;
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('SK1 registration pins the commit, records the version as pending, and is ledgered', async () => {
    const reg = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: SHA1, manifest: manifest('1.0.0') });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.id, 'discord-progress');
    assert.equal(reg.body.version, '1.0.0');
    assert.equal(reg.body.commit, SHA1);
    assert.equal(reg.body.status, 'pending');
    assert.equal(reg.body.tests, 'pending-build');
    assert.equal(reg.body.registeredBy, 'token:operator');
    assert.deepEqual(reg.body.manifest.requires.models, []);
    assert.ok(existsSync(join(dataDir, 'skills', 'discord-progress', '1.0.0.json')), 'R1: persisted on the data volume');

    const row = actions().find((e) => e.action === 'SKILL_REGISTERED');
    assert.ok(row);
    assert.equal(row.agentId, 'skill:discord-progress@1.0.0');
    assert.equal(row.commit, SHA1);
    assert.equal(row.actor, 'token:operator');
  });

  it('SK1 a pending version is listed but has no latest approved version and is not adoptable', async () => {
    const list = await call(port, '/api/v1/skills', 'GET', VIEWER);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].latestApproved, null);
    assert.equal(list.body[0].versions[0].status, 'pending');
    assert.deepEqual(list.body[0].requires.routes, ['discord']);
    assert.equal(approvedSkill(state, 'discord-progress', '1.0.0'), undefined);
  });

  it('SK1 a viewer or operator cannot approve; only an admin can', async () => {
    assert.equal((await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', VIEWER, {})).status, 403);
    assert.equal((await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', OPERATOR, {})).status, 403);
    assert.equal((await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST')).status, 401);
    assert.equal(approvedSkill(state, 'discord-progress', '1.0.0'), undefined);
    assert.equal(actions().filter((e) => e.action === 'SKILL_APPROVED').length, 0);
  });

  it('SK1 an admin approves the version: it is the latest approved and adoptable, and the decision is ledgered', async () => {
    // SK1: like a pull request, approval waits for the factory's checks on the code.
    const early = await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', ADMIN, { reason: 'reviewed' });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'checks_pending');
    recordSkillChecks(state, 'discord-progress', '1.0.0', { passed: true });
    const ok = await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', ADMIN, { reason: 'reviewed' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.decidedBy, 'token:admin');
    assert.equal(ok.body.reason, 'reviewed');

    const list = await call(port, '/api/v1/skills', 'GET', VIEWER);
    assert.equal(list.body[0].latestApproved, '1.0.0');
    const one = await call(port, '/api/v1/skills/discord-progress', 'GET', VIEWER);
    assert.equal(one.status, 200);
    assert.equal(one.body.versions[0].manifest.id, 'discord-progress');
    const ver = await call(port, '/api/v1/skills/discord-progress/versions/1.0.0', 'GET', VIEWER);
    assert.equal(ver.body.status, 'approved');
    assert.equal(approvedSkill(state, 'discord-progress', '1.0.0')?.commit, SHA1);

    const row = actions().find((e) => e.action === 'SKILL_APPROVED');
    assert.ok(row);
    assert.equal(row.actor, 'token:admin');
    assert.equal(row.agentId, 'skill:discord-progress@1.0.0');
    assert.equal((await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/approve', 'POST', ADMIN, {})).status, 409);
  });

  it('SK1 a version already registered is refused (422, ledgered): versions are immutable', async () => {
    const before = actions().filter((e) => e.action === 'SKILL_REFUSED').length;
    const dup = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: SHA2, manifest: manifest('1.0.0') });
    assert.equal(dup.status, 422);
    assert.ok(dup.body.reasons.some((r: string) => /already registered/.test(r)));
    assert.equal(skillRegistry(state).get('discord-progress', '1.0.0')?.commit, SHA1, 'the approved record is untouched');
    assert.equal(actions().filter((e) => e.action === 'SKILL_REFUSED').length, before + 1);
  });

  it('E1 SK2 a skill that declares a raw host is refused (422, ledgered)', async () => {
    const res = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, {
      repo: REPO, path: '.', commit: SHA2, manifest: manifest('1.1.0', { routes: ['discord.com'] }),
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.reasons.some((r: string) => /host/.test(r)));
    const row = actions().filter((e) => e.action === 'SKILL_REFUSED').at(-1);
    assert.equal(row?.agentId, 'skill:discord-progress@1.1.0');
    assert.equal(skillRegistry(state).get('discord-progress', '1.1.0'), undefined);
  });

  it('S1 E5 a skill that declares a gatekeeper-held platform key is refused', async () => {
    const res = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, {
      repo: REPO, path: '.', commit: SHA2, manifest: manifest('1.1.0', { credentials: [{ name: 'ANTHROPIC_API_KEY' }] }),
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.reasons.some((r: string) => /gatekeeper-egress holds/.test(r)));
  });

  it('SK1 admission pins a full commit and a path inside the repository; an invalid manifest is refused with reasons', async () => {
    const short = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: 'abc123', manifest: manifest('1.1.0') });
    assert.equal(short.status, 422);
    assert.ok(short.body.reasons.some((r: string) => /commit/.test(r)));
    const branch = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: 'main', manifest: manifest('1.1.0') });
    assert.equal(branch.status, 422);
    const escape = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '../x', commit: SHA2, manifest: manifest('1.1.0') });
    assert.equal(escape.status, 422);
    assert.ok(escape.body.reasons.some((r: string) => /path/.test(r)));
    const bad = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: SHA2, manifest: { ...manifest('1.1.0'), id: 'Not_Kebab' } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.reasons.some((r: string) => /manifest\.id/.test(r)));
    assert.equal(skillRegistry(state).versions('discord-progress').length, 1);
  });

  it('SK1 a rejected version is not adoptable, and the latest approved stays the previous one', async () => {
    const reg = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: SHA2, manifest: manifest('1.2.0') });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const rej = await call(port, '/api/v1/registry/skills/discord-progress/versions/1.2.0/reject', 'POST', ADMIN, { reason: 'posts tokens to the channel' });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.status, 'rejected');
    assert.equal(approvedSkill(state, 'discord-progress', '1.2.0'), undefined);
    const list = await call(port, '/api/v1/skills', 'GET', VIEWER);
    assert.equal(list.body[0].latestApproved, '1.0.0');
    assert.deepEqual(list.body[0].versions.map((v: { version: string; status: string }) => `${v.version}:${v.status}`), ['1.0.0:approved', '1.2.0:rejected']);
    const row = actions().find((e) => e.action === 'SKILL_REJECTED');
    assert.equal(row?.actor, 'token:admin');
    assert.equal(row?.commit, SHA2);
  });

  it('SK1 unknown skills and versions are 404; the catalog needs a viewer', async () => {
    assert.equal((await call(port, '/api/v1/skills/nope', 'GET', VIEWER)).status, 404);
    assert.equal((await call(port, '/api/v1/skills/discord-progress/versions/9.9.9', 'GET', VIEWER)).status, 404);
    assert.equal((await call(port, '/api/v1/registry/skills/nope/versions/1.0.0/approve', 'POST', ADMIN, {})).status, 404);
    assert.equal((await call(port, '/api/v1/skills')).status, 401);
  });

  it('R1 records survive a restart: a new registry loads them from the data directory into memory', () => {
    const file = JSON.parse(readFileSync(join(dataDir, 'skills', 'discord-progress', '1.2.0.json'), 'utf8'));
    assert.equal(file.status, 'rejected');
    const fresh = { ...state } as FactoryState;
    loadSkills(fresh, join(dataDir, 'skills'));
    assert.equal(approvedSkill(fresh, 'discord-progress', '1.0.0')?.commit, SHA1);
    assert.equal(approvedSkill(fresh, 'discord-progress', '1.2.0'), undefined);
    assert.equal(skillRegistry(fresh).versions('discord-progress').length, 2);
  });

  it('SK1 any authenticated user may register a skill (a viewer), and a folder path is normalised; it still needs approval', async () => {
    const m = { ...manifest('0.1.0'), id: 'viewer-skill' };
    const reg = await call(port, '/api/v1/registry/skills', 'POST', VIEWER, { repo: 'https://github.com/example/skills', path: 'skills/viewer-skill/', commit: SHA1, manifest: m });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.path, 'skills/viewer-skill');
    assert.equal(reg.body.status, 'pending');
    assert.equal(approvedSkill(state, 'viewer-skill', '0.1.0'), undefined);
    assert.equal((await call(port, '/api/v1/registry/skills', 'POST', undefined, { repo: REPO, path: '.', commit: SHA1, manifest: m })).status, 401);
  });

  it('SK1 a different repository or path is a different skill, never a new version of an existing one', async () => {
    const otherRepo = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: 'https://github.com/someone-else/discord-progress', path: '.', commit: SHA2, manifest: manifest('9.0.0') });
    assert.equal(otherRepo.status, 422);
    assert.ok(otherRepo.body.reasons.some((r: string) => /different skill/.test(r)), JSON.stringify(otherRepo.body));
    const otherPath = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: 'elsewhere', commit: SHA2, manifest: manifest('9.0.1') });
    assert.equal(otherPath.status, 422);
  });

  it('SK1 revoking an approved version in use is refused until its agents are redeployed without it; an admin override pauses them', async () => {
    state.agents.set('ada', { id: 'ada', name: 'Ada', role: 'Test', state: 'SLEEPING', provider: 'cloud', artifact: 'x', requires: [], ungated: [], gated: [], triggers: [], dir: '/tmp/ada' } as never);
    let users: string[] = [];
    setSkillUsage(state, (id, version) => (id === 'discord-progress' && version === '1.0.0' ? users : []));

    users = ['ada'];
    const blocked = await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/reject', 'POST', ADMIN, { reason: 'leaks' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'skill_in_use');
    assert.deepEqual(blocked.body.agents, ['ada']);
    assert.ok(approvedSkill(state, 'discord-progress', '1.0.0'), 'still approved');

    const forced = await call(port, '/api/v1/registry/skills/discord-progress/versions/1.0.0/reject', 'POST', ADMIN, { reason: 'leaks', force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.deepEqual(forced.body.paused, ['ada']);
    assert.equal(state.agents.get('ada')?.state, 'PAUSED');
    assert.equal(approvedSkill(state, 'discord-progress', '1.0.0'), undefined);
    assert.ok(actions().some((e) => e.action === 'SKILL_REVOKED_FORCED' && e.actor === 'token:admin'));
    assert.ok(ledger.query().some((e) => e.action === 'PAUSE' && e.agentId === 'ada' && e.actor === 'token:admin'), 'the pause is ledgered');
  });

  it('SK1 a version whose checks failed cannot be approved; the failures are shown and ledgered', async () => {
    const reg = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: REPO, path: '.', commit: SHA2, manifest: manifest('2.0.0') });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    recordSkillChecks(state, 'discord-progress', '2.0.0', { passed: false, failures: ['imports boto3 (provider SDK)'] });
    const res = await call(port, '/api/v1/registry/skills/discord-progress/versions/2.0.0/approve', 'POST', ADMIN, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'checks_failed');
    assert.deepEqual(res.body.failures, ['imports boto3 (provider SDK)']);
    assert.equal(approvedSkill(state, 'discord-progress', '2.0.0'), undefined);
    assert.ok(actions().some((e) => e.action === 'SKILL_CHECKS_FAILED' && e.actor === 'factory:admission'));
  });
});
