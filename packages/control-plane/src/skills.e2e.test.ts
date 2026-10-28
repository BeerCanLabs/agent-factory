// TSK-053: the skill registry (DESIGN_AUTHORITY.md §6.14 SK1, SK2). Register, admit, approve per version, list; only
// approved versions are adoptable; every registration, refusal and decision is ledgered.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, checkOwnsAnyAgent, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime, createRun } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { GroupStore, VersionedConfigStore, type ConfigBackend, type ConfigRecord } from '@beercanlabs/factory-registrar';
import { approvedSkill, loadSkills, recordSkillChecks, setSkillUsage, skillPackageStore, skillRegistry } from './skills.js';

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  return { description: 'memory', loadAll: async () => records, write: async (r) => { records.push(r); }, remove: async () => {} };
};

const ADMIN = 'admin-skills-token';
const OPERATOR = 'operator-skills-token';
const OTHER_OWNER = 'other-owner-token';
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

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const defaultContentType = isBuffer ? 'application/gzip' : 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': defaultContentType, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : isBuffer ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
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
      agents: new Map([
        ['operator-agent', { id: 'operator-agent', name: 'Operator Agent', owners: ['operator', 'token:operator'] } as any],
        ['other-agent', { id: 'other-agent', name: 'Other Agent', owners: ['other-owner', 'token:other-owner'] } as any],
      ]),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'other-owner', token: OTHER_OWNER, roles: ['operator'] },
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
    state.configs = await VersionedConfigStore.open(memoryBackend());
    await state.configs.put({ agentId: 'operator-agent', source: {}, skills: [], policy: null, owners: ['token:operator'] }, { updatedBy: 'test', reason: 'owners' });
    await state.configs.put({ agentId: 'other-agent', source: {}, skills: [], policy: null, owners: ['token:other-owner'] }, { updatedBy: 'test', reason: 'owners' });
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    delete process.env.FACTORY_SKILL_CHECKER;
    delete process.env.FACTORY_TOKENS;
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
    // TSK-055: the catalog carries what the console shows for each decision: who, when, and why; a rejection is not a revocation.
    const rejected = list.body[0].versions.find((v: { version: string }) => v.version === '1.2.0');
    assert.equal(rejected.reason, 'posts tokens to the channel');
    assert.equal(rejected.decidedBy, 'token:admin');
    assert.equal(rejected.revoked, undefined);
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

  it('A8 skills.register role gating: viewer without agent is refused (403); an agent owner may register', async () => {
    const m = { ...manifest('0.1.0'), id: 'viewer-skill' };
    const refused = await call(port, '/api/v1/registry/skills', 'POST', VIEWER, { repo: 'https://github.com/example/skills', path: 'skills/viewer-skill/', commit: SHA1, manifest: m });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'forbidden');
    assert.equal(refused.body.required, 'admin');

    const reg = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, { repo: 'https://github.com/example/skills', path: 'skills/viewer-skill/', commit: SHA1, manifest: m });
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
    assert.equal(forced.body.revoked, true, 'a rejection of an approved version is recorded as a revocation');
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

function createTarHeader(opts: { name: string; size?: number; mode?: number; typeflag?: string }): Buffer {
  const block = Buffer.alloc(512, 0);
  const name = opts.name;
  const size = opts.size ?? 0;
  const mode = opts.mode ?? 0o644;
  const typeflag = opts.typeflag ?? '0';

  block.write(name, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write(typeflag, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i];
  }
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

function makeTarball(entries: Array<{ header: Buffer; content?: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(entry.header);
    if (entry.content && entry.content.length > 0) {
      blocks.push(entry.content);
      const rem = entry.content.length % 512;
      if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function makeValidPackage(id = 'test-packaged-skill', version = '1.0.0', opts: { description?: string } = {}): Buffer {
  const desc = opts.description ?? 'Test packaged skill';
  const yaml = `spec: 1\nid: ${id}\nname: Packaged Skill\nversion: ${version}\nlanguage: python\ndescription: ${desc}\nentry: entry.py\nsmoke:\n  action: ping\n  input: {}\n`;
  const entry = `def tools():\n    return []\n`;
  const test = `def test_smoke():\n    assert True\n`;
  const yBuf = Buffer.from(yaml, 'utf8');
  const eBuf = Buffer.from(entry, 'utf8');
  const tBuf = Buffer.from(test, 'utf8');
  const tar = makeTarball([
    { header: createTarHeader({ name: 'skill.yaml', size: yBuf.length }), content: yBuf },
    { header: createTarHeader({ name: 'entry.py', size: eBuf.length }), content: eBuf },
    { header: createTarHeader({ name: 'test_entry.py', size: tBuf.length }), content: tBuf },
  ]);
  return zlib.gzipSync(tar);
}

describe('A5 raw application/gzip package upload intake, A8 role gating, and package store wiring (TSK-276 Sub-slice 2c)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  const actions = () => ledger.query().filter((e) => e.agentId.startsWith('skill:'));

  before(async () => {
    process.env.FACTORY_SKILL_CHECKER = 'local';
    dataDir = mkdtempSync(join(tmpdir(), 'cp-pkg-upload-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map([
        ['operator-agent', { id: 'operator-agent', name: 'Operator Agent', owners: ['operator', 'token:operator'] } as any],
        ['other-agent', { id: 'other-agent', name: 'Other Agent', owners: ['other-owner', 'token:other-owner'] } as any],
      ]),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'other-owner', token: OTHER_OWNER, roles: ['operator'] },
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
    state.configs = await VersionedConfigStore.open(memoryBackend());
    await state.configs.put({ agentId: 'operator-agent', source: {}, skills: [], policy: null, owners: ['token:operator'] }, { updatedBy: 'test', reason: 'owners' });
    await state.configs.put({ agentId: 'other-agent', source: {}, skills: [], policy: null, owners: ['token:other-owner'] }, { updatedBy: 'test', reason: 'owners' });
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    delete process.env.FACTORY_SKILL_CHECKER;
    delete process.env.FACTORY_TOKENS;
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts raw application/gzip upload, returns 201, stores in SkillPackageStore and registry, and ledgers registration (A5)', async () => {
    const pkg = makeValidPackage('math-tools', '1.0.0');
    const hash = createHash('sha256').update(pkg).digest('hex');

    const res = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.id, 'math-tools');
    assert.equal(res.body.version, '1.0.0');
    assert.equal(res.body.packageHash, hash);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.tests, 'pending-build');
    assert.equal(res.body.registeredBy, 'token:admin');

    // Content-addressed immutable store has the package
    const store = skillPackageStore(state);
    assert.equal(await store.has(hash), true);
    const rec = await store.getRecord(hash);
    assert.ok(rec);
    assert.equal(rec.sha256, hash);
    assert.equal(rec.quarantinedAt, undefined);

    // Persisted on data volume
    assert.ok(existsSync(join(dataDir, 'skill-packages', 'packages', `${hash}.tar.gz`)), 'package file exists on disk');

    // In registry
    const skill = skillRegistry(state).get('math-tools', '1.0.0');
    assert.ok(skill);
    assert.equal(skill.packageHash, hash);

    // Ledgered
    const entry = actions().find((e) => e.action === 'SKILL_REGISTERED' && e.agentId === 'skill:math-tools@1.0.0');
    assert.ok(entry);
    assert.equal(entry.actor, 'token:admin');
    assert.equal(entry.payloadSha256, hash);
  });

  it('refuses package upload from viewer without agent ownership (403 forbidden, A8)', async () => {
    const pkg = makeValidPackage('viewer-denied', '1.0.0');
    const res = await call(port, '/api/v1/registry/skills', 'POST', VIEWER, pkg);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
    assert.equal(res.body.required, 'admin');
  });

  it('refuses unauthenticated package upload (401 unauthorized)', async () => {
    const pkg = makeValidPackage('unauth-denied', '1.0.0');
    const res = await call(port, '/api/v1/registry/skills', 'POST', undefined, pkg);
    assert.equal(res.status, 401);
  });

  it('allows package upload from agent owner holding operator token (A8)', async () => {
    const pkg = makeValidPackage('owner-allowed', '1.0.0');
    const hash = createHash('sha256').update(pkg).digest('hex');

    const res = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, pkg);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.id, 'owner-allowed');
    assert.equal(res.body.packageHash, hash);
    assert.equal(res.body.registeredBy, 'token:operator');
  });

  it('refuses upload exceeding 5 MiB route cap (413 payload too large, Connection: close, A5)', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 0);
    try {
      const res = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, oversized);
      assert.equal(res.status, 413);
      assert.equal(res.headers.get('connection'), 'close');
      assert.equal(res.body?.error, 'payload_too_large');
    } catch (err: any) {
      // Server responds 413 and immediately closes the socket; client fetch may see EPIPE / ECONNRESET race
      assert.ok(err?.message?.includes('fetch failed') || err?.code === 'EPIPE' || err?.code === 'ECONNRESET');
    }
  });

  it('refuses streaming upload exceeding 5 MiB without Content-Length (413 and connection close, capped drain, A5)', async () => {
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/registry/skills',
          method: 'POST',
          headers: {
            'content-type': 'application/gzip',
            authorization: `Bearer ${ADMIN}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', () => {
        // Socket may be reset/closed by server on 413
      });
      const chunk = Buffer.alloc(64 * 1024, 0);
      let chunksWritten = 0;
      const totalChunks = Math.ceil((5 * 1024 * 1024 + 256 * 1024) / chunk.length);
      function writeMore() {
        while (chunksWritten < totalChunks) {
          chunksWritten++;
          try {
            const canContinue = req.write(chunk);
            if (!canContinue) {
              req.once('drain', writeMore);
              return;
            }
          } catch {
            return;
          }
        }
        try { req.end(); } catch {}
      }
      writeMore();
    });

    assert.equal(res.status, 413);
    assert.equal(res.headers['connection'], 'close');
    assert.equal(res.body?.error, 'payload_too_large');
  });

  it('refuses corrupted or invalid package (422 unprocessable entity, ledgered, A5, A19)', async () => {
    const corrupt = Buffer.from('this is definitely not a valid gzip tarball');
    const res = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, corrupt);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'package_invalid');
    assert.ok(Array.isArray(res.body.reasons));

    const entry = actions().find((e) => e.action === 'SKILL_REFUSED' && e.agentId === 'skill:(invalid)');
    assert.ok(entry);
    assert.equal(entry.actor, 'token:admin');
  });

  it('refuses duplicate version upload (422 unprocessable entity, ledgered, A5)', async () => {
    const pkg = makeValidPackage('math-tools', '1.0.0');
    const res = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'skill_refused');
    assert.ok(res.body.reasons.some((r: string) => /already registered/.test(r)));

    const entry = actions().find((e) => e.action === 'SKILL_REFUSED' && e.agentId === 'skill:math-tools@1.0.0');
    assert.ok(entry);
    assert.equal(entry.actor, 'token:admin');
  });

  it('refuses non-gzip / non-json content type (415 unsupported media type, Nit 6)', async () => {
    const res = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, Buffer.from('hello'), {
      'content-type': 'text/plain',
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.error, 'unsupported_media_type');
  });

  it('refuses package upload if configured checker does not support packages (501 not implemented, Finding 1)', async () => {
    // 1. Checker with supportsPackages: false
    const unsupportedState = {
      ...state,
      agents: new Map(state.agents),
      skillChecker: {
        name: 'legacy-checker',
        supportsPackages: false,
        check: async () => ({ status: 'passed' as const, summary: 'ok' }),
      },
    } as FactoryState;
    loadSkills(unsupportedState, join(dataDir, 'skills-unsupported'));
    const unsuppServer = createFactoryServer(unsupportedState);
    const unsuppPort = await listen(unsuppServer);
    try {
      const pkg = makeValidPackage('unsupp-checker-skill', '1.0.0');
      const res = await call(unsuppPort, '/api/v1/registry/skills', 'POST', ADMIN, pkg);
      assert.equal(res.status, 501);
      assert.equal(res.body.error, 'package_checks_unsupported');
      assert.ok(res.body.message.includes('legacy-checker'));
    } finally {
      unsuppServer.close();
    }

    // 2. AWS CodeBuild checker supports packages in Sub-slice 2d; GCP CloudBuild remains false (honest 501) until GCP landing zone slice (Finding G1)
    const { codeBuildSkillChecker } = await import('./aws/skill-checker.js');
    const { cloudBuildSkillChecker } = await import('./gcp/skill-checker.js');
    assert.equal(codeBuildSkillChecker().supportsPackages, true);
    assert.equal(cloudBuildSkillChecker().supportsPackages, false);

    const gcpState = {
      ...state,
      agents: new Map(state.agents),
      skillChecker: cloudBuildSkillChecker(),
    } as FactoryState;
    loadSkills(gcpState, join(dataDir, 'skills-gcp-unsupp'));
    const gcpServer = createFactoryServer(gcpState);
    const gcpPort = await listen(gcpServer);
    try {
      const pkg = makeValidPackage('gcp-unsupp-skill', '1.0.0');
      const res = await call(gcpPort, '/api/v1/registry/skills', 'POST', ADMIN, pkg);
      assert.equal(res.status, 501);
      assert.equal(res.body.error, 'package_checks_unsupported');
      assert.ok(res.body.message.includes('cloudbuild'));
    } finally {
      gcpServer.close();
    }

    // 3. No checker configured at all (FACTORY_SKILL_CHECKER=none or undefined)
    const prevChecker = process.env.FACTORY_SKILL_CHECKER;
    process.env.FACTORY_SKILL_CHECKER = 'none';

    const noneState = { ...state, agents: new Map(state.agents) } as FactoryState;
    loadSkills(noneState, join(dataDir, 'skills-none'));
    const noneServer = createFactoryServer(noneState);
    const nonePort = await listen(noneServer);
    try {
      const pkg = makeValidPackage('none-checker-skill', '1.0.0');
      const res = await call(nonePort, '/api/v1/registry/skills', 'POST', ADMIN, pkg);
      assert.equal(res.status, 501);
      assert.equal(res.body.error, 'package_checks_unsupported');
      assert.ok(res.body.message.includes('no skill checker is configured'));
    } finally {
      noneServer.close();
      if (prevChecker !== undefined) process.env.FACTORY_SKILL_CHECKER = prevChecker;
      else delete process.env.FACTORY_SKILL_CHECKER;
    }
  });

  it('atomic duplicate check under concurrent uploads with different packages (Promise.all, Finding 2, Nit 3)', async () => {
    const pkg1 = makeValidPackage('concurrent-skill', '1.0.0', { description: 'package variant A' });
    const pkg2 = makeValidPackage('concurrent-skill', '1.0.0', { description: 'package variant B' });
    const hash1 = createHash('sha256').update(pkg1).digest('hex');
    const hash2 = createHash('sha256').update(pkg2).digest('hex');
    assert.notEqual(hash1, hash2, 'two package variants must have different hashes');

    const [r1, r2] = await Promise.all([
      call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg1),
      call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg2),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 422]);

    const winner = r1.status === 201 ? r1 : r2;
    const loser = r1.status === 201 ? r2 : r1;
    const expectedHash = r1.status === 201 ? hash1 : hash2;

    assert.equal(winner.body.packageHash, expectedHash);
    assert.equal(loser.body.error, 'skill_refused');
    assert.ok(loser.body.reasons.some((r: string) => /already registered/.test(r)));

    const stored = skillRegistry(state).get('concurrent-skill', '1.0.0');
    assert.ok(stored);
    assert.equal(stored.packageHash, expectedHash);
  });

  it('races two different users on a brand-new skill id (Finding 2)', async () => {
    const pkgA = makeValidPackage('race-new-id', '1.0.0');
    const pkgB = makeValidPackage('race-new-id', '1.0.1');

    const [resA, resB] = await Promise.all([
      call(port, '/api/v1/registry/skills', 'POST', OPERATOR, pkgA),
      call(port, '/api/v1/registry/skills', 'POST', OTHER_OWNER, pkgB),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 422]);

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;

    assert.ok(loser.body.reasons.some((r: string) => r.includes('new versions must come from the owner or an admin (A15)')));
    const versions = skillRegistry(state).versions('race-new-id');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].registeredBy, winner.body.registeredBy);
  });

  it('allows adoption of approved packaged skills (Sub-slice 2d, A14)', async () => {
    // Approve math-tools 1.0.0
    const reg = skillRegistry(state);
    const rec = reg.get('math-tools', '1.0.0');
    assert.ok(rec);
    rec.status = 'approved';
    reg.save(rec);

    const res = await call(port, '/api/v1/agents/operator-agent/skills', 'POST', ADMIN, {
      skillId: 'math-tools',
      version: '1.0.0',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, 'requested');
    assert.equal(res.body.skillId, 'math-tools');
    assert.equal(res.body.version, '1.0.0');

    // Admin approves the adoption request
    const appRes = await call(port, '/api/v1/agents/operator-agent/skills/math-tools/adoption/approve', 'POST', ADMIN, {});
    assert.equal(appRes.status, 200);

    // Verify GET /api/v1/agents/operator-agent/skills lists the adopted package skill
    const getRes = await call(port, '/api/v1/agents/operator-agent/skills', 'GET', ADMIN);
    assert.equal(getRes.status, 200);
    assert.ok(getRes.body.adopted.some((s: any) => s.id === 'math-tools' && s.version === '1.0.0'));
  });

  it('enforces A15 owner rule: new version of existing skill must come from owner or admin (Finding 1)', async () => {
    // 1. operator registers version 1.0.0 -> owner is token:operator
    const pkg1 = makeValidPackage('owner-rule-skill', '1.0.0');
    const r1 = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, pkg1);
    assert.equal(r1.status, 201);
    assert.equal(r1.body.registeredBy, 'token:operator');

    // 2. other-owner (not owner, not admin) tries to register 1.1.0 -> 422
    const pkg2 = makeValidPackage('owner-rule-skill', '1.1.0');
    const r2 = await call(port, '/api/v1/registry/skills', 'POST', OTHER_OWNER, pkg2);
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, 'skill_refused');
    assert.ok(r2.body.reasons.some((r: string) => r.includes('new versions must come from the owner or an admin (A15)')));

    // 3. admin registers 1.1.0 -> 201
    const r3 = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg2);
    assert.equal(r3.status, 201);

    // 4. original owner (operator) registers 1.2.0 -> 201
    const pkg3 = makeValidPackage('owner-rule-skill', '1.2.0');
    const r4 = await call(port, '/api/v1/registry/skills', 'POST', OPERATOR, pkg3);
    assert.equal(r4.status, 201);
  });

  it('forbids mixing repository and package registrations for the same id (Finding 1, A15)', async () => {
    // 1. Register repo-first as repository skill
    const repoRes = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, {
      repo: REPO,
      path: 'discord_progress',
      commit: SHA1,
      manifest: manifest('1.0.0', { routes: ['discord'], credentials: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord' }] }),
    });
    // Manifest id in manifest() is discord-progress
    assert.equal(repoRes.status, 201);

    // 2. Try to register discord-progress 2.0.0 via package upload -> 422
    const pkgDiscord = makeValidPackage('discord-progress', '2.0.0');
    const pkgRes = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkgDiscord);
    assert.equal(pkgRes.status, 422);
    assert.equal(pkgRes.body.error, 'skill_refused');
    assert.ok(pkgRes.body.reasons.some((r: string) => r.includes('cannot mix repository and package versions for this id (A15)')));

    // 3. Try to register math-tools (previously package-registered) via repository JSON -> 422
    const mixedRepoRes = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, {
      repo: REPO,
      path: 'math_tools',
      commit: SHA1,
      manifest: {
        id: 'math-tools',
        version: '2.0.0',
        name: 'Math Tools',
        description: 'desc',
        language: 'python',
        entry: 'entry.py',
        requires: { routes: [], credentials: [] },
      },
    });
    assert.equal(mixedRepoRes.status, 422);
    assert.equal(mixedRepoRes.body.error, 'skill_refused');
    assert.ok(mixedRepoRes.body.reasons.some((r: string) => r.includes('cannot mix repository and package versions for this id (A15)')));
  });
});

describe('TSK-277 Sub-slice 3b: Skill ownership, transfer, groups, and package inspection', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;

  const ALICE = 'alice-token';
  const BOB = 'bob-token';
  const CHARLIE = 'charlie-token';
  const HELPER_AGENT = 'helper-agent-token';

  before(async () => {
    process.env.FACTORY_SKILL_CHECKER = 'local';
    process.env.FACTORY_TOKENS = JSON.stringify([
      { name: 'admin', token: ADMIN, roles: ['admin'] },
      { name: 'alice', token: ALICE, roles: ['viewer'] },
      { name: 'bob', token: BOB, roles: ['viewer'] },
      { name: 'charlie', token: CHARLIE, roles: ['viewer'] },
      { name: 'agent:helper', token: HELPER_AGENT, roles: ['operator'] },
    ]);
    dataDir = mkdtempSync(join(tmpdir(), 'cp-slice3b-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map([
        ['alice-agent', { id: 'alice-agent', name: 'Alice Agent', owners: ['token:alice'] } as any],
        ['bob-agent', { id: 'bob-agent', name: 'Bob Agent', owners: ['token:bob'] } as any],
        ['helper', { id: 'helper', name: 'Helper Agent', owners: ['token:bob'] } as any],
      ]),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'alice', token: ALICE, roles: ['viewer'] },
        { name: 'bob', token: BOB, roles: ['viewer'] },
        { name: 'charlie', token: CHARLIE, roles: ['viewer'] },
        { name: 'agent:helper', token: HELPER_AGENT, roles: ['operator'] },
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
      runTokens: new RunTokens('slice3b-test-run-token-key-0123456789'),
      secretValues: new Set(),
    } as FactoryState;
    state.configs = await VersionedConfigStore.open(memoryBackend());
    await state.configs.put({ agentId: 'alice-agent', source: {}, skills: [], policy: null, owners: ['token:alice'] }, { updatedBy: 'test', reason: 'owners' });
    await state.configs.put({ agentId: 'bob-agent', source: {}, skills: [], policy: null, owners: ['token:bob'] }, { updatedBy: 'test', reason: 'owners' });
    state.groups = await GroupStore.open(join(dataDir, 'groups'));
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    delete process.env.FACTORY_SKILL_CHECKER;
    delete process.env.FACTORY_TOKENS;
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('human user registers a package: owner is set to principal.actor (H3, H4)', async () => {
    const pkg = makeValidPackage('text-analysis', '1.0.0');
    const res = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.id, 'text-analysis');
    assert.equal(res.body.version, '1.0.0');
    assert.equal(res.body.registeredBy, 'token:alice');
    assert.equal(res.body.owner, 'token:alice');

    // Verify GET /api/v1/skills/text-analysis/versions/1.0.0 reflects owner
    const verRes = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0', 'GET', ALICE);
    assert.equal(verRes.status, 200);
    assert.equal(verRes.body.owner, 'token:alice');

    // Verify GET /api/v1/skills/text-analysis reflects owner
    const skillRes = await call(port, '/api/v1/skills/text-analysis', 'GET', ALICE);
    assert.equal(skillRes.status, 200);
    assert.equal(skillRes.body.owner, 'token:alice');
  });

  it('agent registers on behalf of verified human requester (A11, H4)', async () => {
    const pkg = makeValidPackage('agent-registered-skill', '1.0.0');

    // 1. Agent calls with static token (no verified run) -> 403
    const noReq = await call(port, '/api/v1/registry/skills', 'POST', HELPER_AGENT, pkg);
    assert.equal(noReq.status, 403);
    assert.equal(noReq.body.error, 'agent_must_have_verified_requester');

    // 2. Agent in cron run (trigger: 'cron', no human requester) -> 403
    const cronRun = state.runs.create({
      agentId: 'helper',
      state: 'WORKING',
      actor: 'system',
      trigger: 'cron',
    });
    const cronToken = await state.runTokens!.mint(cronRun);
    const cronRes = await call(port, '/api/v1/registry/skills', 'POST', cronToken, pkg);
    assert.equal(cronRes.status, 403);
    assert.equal(cronRes.body.error, 'agent_must_have_verified_requester');

    // 3. Agent in run whose requester lacks skills.register (Charlie) -> 403
    const charlieRun = state.runs.create({
      agentId: 'helper',
      state: 'WORKING',
      actor: 'token:charlie',
      trigger: 'api',
    });
    const charlieToken = await state.runTokens!.mint(charlieRun);
    const unauthedReq = await call(port, '/api/v1/registry/skills', 'POST', charlieToken, pkg);
    assert.equal(unauthedReq.status, 403);
    assert.equal(unauthedReq.body.error, 'requester_lacks_skills_register');

    // 4. Agent attempts to spoof requester via header x-factory-run-requester -> header ignored, still 403
    const spoofReq = await call(port, '/api/v1/registry/skills', 'POST', charlieToken, pkg, {
      'x-factory-run-requester': 'token:bob',
    });
    assert.equal(spoofReq.status, 403);
    assert.equal(spoofReq.body.error, 'requester_lacks_skills_register');

    // 5. Agent in run whose requester holds skills.register (Bob, who owns bob-agent) -> 201
    const bobRun = state.runs.create({
      agentId: 'helper',
      state: 'WORKING',
      actor: 'token:bob',
      trigger: 'api',
    });
    const bobToken = await state.runTokens!.mint(bobRun);
    const okReq = await call(port, '/api/v1/registry/skills', 'POST', bobToken, pkg);
    assert.equal(okReq.status, 201, JSON.stringify(okReq.body));
    assert.equal(okReq.body.registeredBy, 'agent:helper');
    assert.equal(okReq.body.owner, 'token:bob');

    // Ledger records agent as actor and verified requester as subject
    const rows = ledger.query().filter((e) => e.agentId === 'skill:agent-registered-skill@1.0.0' && e.action === 'SKILL_REGISTERED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'agent:helper');
    assert.equal(rows[0].subject, 'token:bob');

    // 6. Finding 6: Agent in Bob's run adds a new version (1.1.0) to Bob's skill -> 201
    const pkg11 = makeValidPackage('agent-registered-skill', '1.1.0');
    const okVer = await call(port, '/api/v1/registry/skills', 'POST', bobToken, pkg11);
    assert.equal(okVer.status, 201, JSON.stringify(okVer.body));
    assert.equal(okVer.body.registeredBy, 'agent:helper');
    assert.equal(okVer.body.owner, 'token:bob');

    // 7. Finding 6: Agent in Bob's run tries to add a new version to Alice's skill -> 422
    const alicePkg = makeValidPackage('text-analysis', '1.4.0');
    const failVer = await call(port, '/api/v1/registry/skills', 'POST', bobToken, alicePkg);
    assert.equal(failVer.status, 422);
    assert.equal(failVer.body.error, 'skill_refused');
    assert.ok(failVer.body.reasons.some((r: string) => r.includes('new versions must come from the owner or an admin (A15)')));
  });

  it('new version registration rules and inheritance (A15, A23)', async () => {
    const pkg11 = makeValidPackage('text-analysis', '1.1.0');

    // 1. Non-owner (Bob) cannot register new version of Alice's skill -> 422
    const refused = await call(port, '/api/v1/registry/skills', 'POST', BOB, pkg11);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'skill_refused');
    assert.ok(refused.body.reasons.some((r: string) => r.includes('new versions must come from the owner or an admin (A15)')));

    // 2. Owner (Alice) registers 1.1.0 -> 201
    const aliceRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg11);
    assert.equal(aliceRes.status, 201);
    assert.equal(aliceRes.body.owner, 'token:alice');

    // 3. Admin registers 1.2.0 -> 201, inherits Alice as owner
    const pkg12 = makeValidPackage('text-analysis', '1.2.0');
    const adminRes = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, pkg12);
    assert.equal(adminRes.status, 201);
    assert.equal(adminRes.body.owner, 'token:alice');
  });

  it('two-step ownership transfer: request, recipient accept, cancel, and admin override (A24)', async () => {
    // 0. Recipient must be human (non-blocking finding)
    const agentReq1 = await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', ALICE, { recipient: 'token:agent:helper' });
    assert.equal(agentReq1.status, 400);
    assert.equal(agentReq1.body.error, 'invalid_recipient');

    const agentReq2 = await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', ALICE, { recipient: 'agent:helper' });
    assert.equal(agentReq2.status, 400);
    assert.equal(agentReq2.body.error, 'invalid_recipient');

    // Finding 3: Transfer to human admin (via FACTORY_ADMIN_EMAILS) succeeds
    process.env.FACTORY_ADMIN_EMAILS = 'boss@example.com';
    try {
      const adminReq = await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', ALICE, { recipient: 'cloudflare:boss@example.com' });
      assert.equal(adminReq.status, 200, JSON.stringify(adminReq.body));
      assert.equal(adminReq.body.transferPending.recipient, 'cloudflare:boss@example.com');
      // Cancel so subsequent steps can continue with Bob
      await call(port, '/api/v1/skills/text-analysis/transfer/cancel', 'POST', ALICE, {});
    } finally {
      delete process.env.FACTORY_ADMIN_EMAILS;
    }

    // 1. Request transfer to recipient lacking skills.register -> 422
    const badReq = await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', ALICE, { recipient: 'token:charlie' });
    assert.equal(badReq.status, 422);
    assert.equal(badReq.body.error, 'recipient_lacks_skills_register');

    // 2. Request transfer to Bob -> 200
    const reqRes = await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', ALICE, { recipient: 'token:bob' });
    assert.equal(reqRes.status, 200, JSON.stringify(reqRes.body));
    assert.equal(reqRes.body.transferPending.recipient, 'token:bob');
    assert.equal(reqRes.body.transferPending.requestedBy, 'token:alice');

    // Check ledger recorded SKILL_TRANSFER_REQUESTED
    const reqRows = ledger.query().filter((e) => e.action === 'SKILL_TRANSFER_REQUESTED');
    assert.ok(reqRows.length >= 1);

    // 3. Unauthorized user (Charlie) tries to accept -> 403
    const badAccept = await call(port, '/api/v1/skills/text-analysis/transfer/accept', 'POST', CHARLIE, {});
    assert.equal(badAccept.status, 403);

    // 4. Bob accepts transfer -> 200
    const acceptRes = await call(port, '/api/v1/skills/text-analysis/transfer/accept', 'POST', BOB, {});
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    assert.equal(acceptRes.body.owner, 'token:bob');

    // Verify GET /api/v1/skills/text-analysis shows Bob as owner and no transferPending
    const getSkill = await call(port, '/api/v1/skills/text-analysis', 'GET', BOB);
    assert.equal(getSkill.body.owner, 'token:bob');
    assert.equal(getSkill.body.transferPending, undefined);

    // Check ledger recorded SKILL_TRANSFER_ACCEPTED
    const acceptRows = ledger.query().filter((e) => e.action === 'SKILL_TRANSFER_ACCEPTED');
    assert.ok(acceptRows.length >= 1);

    // 5. Cancel transfer: Bob requests transfer to Alice, then cancels
    await call(port, '/api/v1/skills/text-analysis/transfer', 'POST', BOB, { recipient: 'token:alice' });
    const cancelRes = await call(port, '/api/v1/skills/text-analysis/transfer/cancel', 'POST', BOB, {});
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.transferPending, null);
    const cancelRows = ledger.query().filter((e) => e.action === 'SKILL_TRANSFER_CANCELLED');
    assert.ok(cancelRows.length >= 1);

    // 6. Admin transfer override (Finding 4): Bob still holds skills.register -> 409
    const refusedAdmin = await call(port, '/api/v1/skills/text-analysis/transfer/admin', 'POST', ADMIN, { recipient: 'token:alice' });
    assert.equal(refusedAdmin.status, 409);
    assert.equal(refusedAdmin.body.error, 'owner_rights_not_revoked');

    // Finding 4: Revoke Bob's rights (remove agents owned by Bob) -> admin override succeeds unconditionally without acceptance
    state.agents.delete('bob-agent');
    state.agents.delete('helper');
    await state.configs.remove('bob-agent');
    try {
      const okAdmin = await call(port, '/api/v1/skills/text-analysis/transfer/admin', 'POST', ADMIN, { recipient: 'token:alice' });
      assert.equal(okAdmin.status, 200, JSON.stringify(okAdmin.body));
      assert.equal(okAdmin.body.owner, 'token:alice');
      const adminRows = ledger.query().filter((e) => e.action === 'SKILL_TRANSFERRED_BY_ADMIN');
      assert.ok(adminRows.length >= 1);
    } finally {
      // Restore Bob's agents for subsequent tests
      state.agents.set('bob-agent', { id: 'bob-agent', name: 'Bob Agent', owners: ['token:bob'] } as any);
      state.agents.set('helper', { id: 'helper', name: 'Helper Agent', owners: ['token:bob'] } as any);
      await state.configs.put({ agentId: 'bob-agent', source: {}, skills: [], policy: null, owners: ['token:bob'] }, { updatedBy: 'test', reason: 'restore' });
    }
  });

  it('group assignment, group roles, and group member version addition (H5, A18, A23)', async () => {
    // 1. Create group 'engineering'
    state.groups!.createGroup({
      id: 'engineering',
      name: 'Engineering',
      roles: ['skill-owner', 'skills.register'],
      members: ['token:bob', 'token:charlie'],
    });

    // 2. Alice (owner of text-analysis) is not in engineering -> assignment fails with 422
    const failAssign = await call(port, '/api/v1/skills/text-analysis/group', 'PUT', ALICE, { groupId: 'engineering' });
    assert.equal(failAssign.status, 422);
    assert.equal(failAssign.body.error, 'owner_not_group_member');

    // 3. Add Alice to group
    state.groups!.addMember('engineering', 'token:alice');

    // 4. Alice assigns text-analysis to engineering -> 200
    const okAssign = await call(port, '/api/v1/skills/text-analysis/group', 'PUT', ALICE, { groupId: 'engineering' });
    assert.equal(okAssign.status, 200);
    assert.equal(okAssign.body.groupId, 'engineering');

    // Verify GET reflects group
    const getRes = await call(port, '/api/v1/skills/text-analysis', 'GET', ALICE);
    assert.equal(getRes.body.groupId, 'engineering');

    // Check ledger recorded SKILL_GROUP_ASSIGNED
    const assignRows = ledger.query().filter((e) => e.action === 'SKILL_GROUP_ASSIGNED');
    assert.ok(assignRows.length >= 1);

    // Finding 2: Group member with skill-owner role (Charlie) can inspect package files and file content
    const charlieList = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/files', 'GET', CHARLIE);
    assert.equal(charlieList.status, 200, JSON.stringify(charlieList.body));
    assert.ok(charlieList.body.files.some((f: any) => f.path === 'skill.yaml'));

    const charlieFile = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/file?path=entry.py', 'GET', CHARLIE);
    assert.equal(charlieFile.status, 200);
    assert.ok(charlieFile.body.content.includes('def tools():'));

    // 5. Bob (member of engineering which holds skill-owner) registers version 1.3.0 -> 201!
    const pkg13 = makeValidPackage('text-analysis', '1.3.0');
    const bobRes = await call(port, '/api/v1/registry/skills', 'POST', BOB, pkg13);
    assert.equal(bobRes.status, 201);
    assert.equal(bobRes.body.owner, 'token:alice');
    assert.equal(bobRes.body.groupId, 'engineering');

    // 6. Charlie (no agent, but member of engineering holding skills.register) registers a new skill -> 201!
    const charliePkg = makeValidPackage('charlie-skill', '1.0.0');
    const charlieRes = await call(port, '/api/v1/registry/skills', 'POST', CHARLIE, charliePkg);
    assert.equal(charlieRes.status, 201);
    assert.equal(charlieRes.body.owner, 'token:charlie');

    // 7. Finding 2: Group member (Charlie) unassigns group -> 200
    const unassign = await call(port, '/api/v1/skills/text-analysis/group', 'DELETE', CHARLIE);
    assert.equal(unassign.status, 200);
    assert.equal(unassign.body.groupId, null);
    const unassignRows = ledger.query().filter((e) => e.action === 'SKILL_GROUP_UNASSIGNED');
    assert.ok(unassignRows.length >= 1);
  });

  it('read-only package view: listing files and inspecting content (A21)', async () => {
    // 1. Alice (owner) lists files
    const filesRes = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/files', 'GET', ALICE);
    assert.equal(filesRes.status, 200, JSON.stringify(filesRes.body));
    assert.ok(Array.isArray(filesRes.body.files));
    assert.ok(filesRes.body.files.some((f: any) => f.path === 'skill.yaml'));
    assert.ok(filesRes.body.files.some((f: any) => f.path === 'entry.py'));

    // 2. Stranger (Charlie, now that text-analysis has no group) is refused -> 403
    const strangerRes = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/files', 'GET', CHARLIE);
    assert.equal(strangerRes.status, 403);

    // 3. Admin can list files -> 200
    const adminFiles = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/files', 'GET', ADMIN);
    assert.equal(adminFiles.status, 200);

    // 4. Inspect file content: entry.py
    const fileRes = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/file?path=entry.py', 'GET', ALICE);
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.body.path, 'entry.py');
    assert.ok(fileRes.body.content.includes('def tools():'));

    // 5. Non-existent file -> 404
    const notFoundRes = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/file?path=missing.py', 'GET', ALICE);
    assert.equal(notFoundRes.status, 404);

    // 6. Missing path query parameter -> 400
    const missingParam = await call(port, '/api/v1/skills/text-analysis/versions/1.0.0/package/file', 'GET', ALICE);
    assert.equal(missingParam.status, 400);
  });

  it('repository registration enforces owner or admin for new versions (Finding 5, A15, A23)', async () => {
    // 1. Alice registers repo-skill@1.0.0
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, {
      repo: 'https://github.com/BeerCanLabs/test-repo-skill',
      path: '.',
      commit: '1111111111111111111111111111111111111111',
      manifest: {
        id: 'repo-skill',
        name: 'Repo Skill',
        version: '1.0.0',
        description: 'Repo skill test',
        language: 'python',
        entry: 'entry.py',
        visibility: 'public',
      },
    });
    assert.equal(regRes.status, 201, JSON.stringify(regRes.body));
    assert.equal(regRes.body.owner, 'token:alice');

    // 2. Bob (holding skills.register, but not owner or admin) attempts to register version 1.1.0 -> 422
    const bobRefused = await call(port, '/api/v1/registry/skills', 'POST', BOB, {
      repo: 'https://github.com/BeerCanLabs/test-repo-skill',
      path: '.',
      commit: '2222222222222222222222222222222222222222',
      manifest: {
        id: 'repo-skill',
        name: 'Repo Skill',
        version: '1.1.0',
        description: 'Repo skill test v1.1.0',
        language: 'python',
        entry: 'entry.py',
        visibility: 'public',
      },
    });
    assert.equal(bobRefused.status, 422);
    assert.equal(bobRefused.body.error, 'skill_refused');
    assert.ok(bobRefused.body.reasons.some((r: string) => r.includes('new versions must come from the owner or an admin (A15)')));

    // 3. Alice (owner) registers version 1.1.0 -> 201
    const aliceRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, {
      repo: 'https://github.com/BeerCanLabs/test-repo-skill',
      path: '.',
      commit: '2222222222222222222222222222222222222222',
      manifest: {
        id: 'repo-skill',
        name: 'Repo Skill',
        version: '1.1.0',
        description: 'Repo skill test v1.1.0',
        language: 'python',
        entry: 'entry.py',
        visibility: 'public',
      },
    });
    assert.equal(aliceRes.status, 201);
    assert.equal(aliceRes.body.owner, 'token:alice');

    // 4. Admin registers version 1.2.0 -> 201, inherits Alice as owner
    const adminRes = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/test-repo-skill',
      path: '.',
      commit: '3333333333333333333333333333333333333333',
      manifest: {
        id: 'repo-skill',
        name: 'Repo Skill',
        version: '1.2.0',
        description: 'Repo skill test v1.2.0',
        language: 'python',
        entry: 'entry.py',
        visibility: 'public',
      },
    });
    assert.equal(adminRes.status, 201);
    assert.equal(adminRes.body.owner, 'token:alice');
  });
});

describe('TSK-278 Slice 4: Publishing workflow, adoption rules, retirement, and hardening', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;

  const ADMIN = 'admin-token-s4';
  const ALICE = 'alice-token-s4';
  const BOB = 'bob-token-s4';
  const CHARLIE = 'charlie-token-s4';

  before(async () => {
    process.env.FACTORY_SKILL_CHECKER = 'local';
    process.env.FACTORY_TOKENS = JSON.stringify([
      { name: 'admin', token: ADMIN, roles: ['admin'] },
      { name: 'alice', token: ALICE, roles: ['viewer'] },
      { name: 'bob', token: BOB, roles: ['viewer'] },
      { name: 'charlie', token: CHARLIE, roles: ['viewer'] },
    ]);
    dataDir = mkdtempSync(join(tmpdir(), 'cp-slice4-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map([
        ['alice-agent', { id: 'alice-agent', name: 'Alice Agent', owners: ['token:alice'], deployedSkills: [] } as any],
        ['bob-agent', { id: 'bob-agent', name: 'Bob Agent', owners: ['token:bob'], deployedSkills: [] } as any],
      ]),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'alice', token: ALICE, roles: ['viewer'] },
        { name: 'bob', token: BOB, roles: ['viewer'] },
        { name: 'charlie', token: CHARLIE, roles: ['viewer'] },
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
      secretValues: new Set<string>(),
      configs: new VersionedConfigStore(memoryBackend()),
      groups: await GroupStore.open(join(dataDir, 'groups')),
    } as unknown as FactoryState;

    await state.configs.put({ agentId: 'alice-agent', source: {}, skills: [], policy: null, owners: ['token:alice'] }, { updatedBy: 'test', reason: 'init' });
    await state.configs.put({ agentId: 'bob-agent', source: {}, skills: [], policy: null, owners: ['token:bob'] }, { updatedBy: 'test', reason: 'init' });
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    delete process.env.FACTORY_SKILL_CHECKER;
    delete process.env.FACTORY_TOKENS;
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('publishing request, rejection, and approval with future version auto-publishing (H8, H9, A8)', async () => {
    // 1. Alice registers pub-skill 1.0.0
    const pkg1 = makeValidPackage('pub-skill', '1.0.0');
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg1);
    assert.equal(regRes.status, 201);
    assert.equal(regRes.body.owner, 'token:alice');
    assert.equal(regRes.body.published, undefined);

    // 2. Bob (non-owner) requests publication -> 403
    const bobPub = await call(port, '/api/v1/skills/pub-skill/publish', 'POST', BOB, { notes: 'Bob wants this' });
    assert.equal(bobPub.status, 403);

    // 3. Alice requests publication -> 200
    const alicePub = await call(port, '/api/v1/skills/pub-skill/publish', 'POST', ALICE, { notes: 'Ready for all' });
    assert.equal(alicePub.status, 200);
    assert.equal(alicePub.body.publishRequested, true);

    // 4. Duplicate publish request -> 409
    const dupPub = await call(port, '/api/v1/skills/pub-skill/publish', 'POST', ALICE, { notes: 'Again' });
    assert.equal(dupPub.status, 409);
    assert.equal(dupPub.body.error, 'publish_already_requested');

    // 5. Non-admin calls decide -> 403
    const bobDecide = await call(port, '/api/v1/skills/pub-skill/publish/decide', 'POST', BOB, { decision: 'approve' });
    assert.equal(bobDecide.status, 403);

    // 6. Admin rejects first with reason
    const adminReject = await call(port, '/api/v1/skills/pub-skill/publish/decide', 'POST', ADMIN, { decision: 'reject', reason: 'Needs better docs' });
    assert.equal(adminReject.status, 200);
    assert.equal(adminReject.body.status, 'unpublished');

    // 7. Alice re-requests, and Admin approves
    const alicePub2 = await call(port, '/api/v1/skills/pub-skill/publish', 'POST', ALICE, { notes: 'Updated docs' });
    assert.equal(alicePub2.status, 200);

    const adminApprove = await call(port, '/api/v1/skills/pub-skill/publish/decide', 'POST', ADMIN, { decision: 'approve' });
    assert.equal(adminApprove.status, 200);
    assert.equal(adminApprove.body.status, 'published');

    const rows = ledger.query().filter((e) => e.action === 'SKILL_PUBLISHED');
    assert.ok(rows.length >= 1);

    // 8. Auto-publish future versions (H9): Alice registers 1.1.0 -> automatically published
    const pkg2 = makeValidPackage('pub-skill', '1.1.0');
    const regRes2 = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg2);
    assert.equal(regRes2.status, 201);
    assert.equal(regRes2.body.published, true);
  });

  it('adoption rules: private skills restricted to owner/group; published skills adoptable by all (H7, A7, A12, H10)', async () => {
    // 1. Alice registers private-skill 1.0.0
    const pkg = makeValidPackage('private-skill', '1.0.0');
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg);
    assert.equal(regRes.status, 201);

    // Mark check passed so guardrails pass
    recordSkillChecks(state, 'private-skill', '1.0.0', { passed: true });
    recordSkillChecks(state, 'pub-skill', '1.0.0', { passed: true });

    // 2. Bob attempts to adopt private-skill on bob-agent -> 403 skill_private
    const bobAdoptPriv = await call(port, '/api/v1/agents/bob-agent/skills', 'POST', BOB, { skillId: 'private-skill', version: '1.0.0' });
    assert.equal(bobAdoptPriv.status, 403);
    assert.equal(bobAdoptPriv.body.error, 'skill_private');

    // 3. Alice adopts private-skill on alice-agent -> 201 requested, then admin approves -> 200
    const aliceAdopt = await call(port, '/api/v1/agents/alice-agent/skills', 'POST', ALICE, { skillId: 'private-skill', version: '1.0.0' });
    assert.equal(aliceAdopt.status, 201);
    const aliceApprove = await call(port, '/api/v1/agents/alice-agent/skills/private-skill/adoption/approve', 'POST', ADMIN, {});
    assert.equal(aliceApprove.status, 200);

    // 4. Bob adopts pub-skill (published) on bob-agent -> 201 requested, then admin approves -> 200
    const bobAdoptPub = await call(port, '/api/v1/agents/bob-agent/skills', 'POST', BOB, { skillId: 'pub-skill', version: '1.0.0' });
    assert.equal(bobAdoptPub.status, 201);
    const bobApprove = await call(port, '/api/v1/agents/bob-agent/skills/pub-skill/adoption/approve', 'POST', ADMIN, {});
    assert.equal(bobApprove.status, 200);
  });

  it('unpublishing stops future adoptions without disrupting running agents (A13)', async () => {
    // 1. Alice unpublishes pub-skill
    const unpubRes = await call(port, '/api/v1/skills/pub-skill/unpublish', 'POST', ALICE, { reason: 'Deprecating public access' });
    assert.equal(unpubRes.status, 200);
    assert.equal(unpubRes.body.published, false);

    const rows = ledger.query().filter((e) => e.action === 'SKILL_UNPUBLISHED');
    assert.ok(rows.length >= 1);

    // 2. Bob\'s existing config still pins pub-skill (existing adopters undisturbed)
    const bobConfig = state.configs!.current('bob-agent');
    assert.ok(bobConfig?.skills.some((s) => s.id === 'pub-skill'));

    // 3. Charlie attempts to adopt pub-skill now that it is unpublished -> 403 skill_private
    await state.configs.put({ agentId: 'charlie-agent', source: {}, skills: [], policy: null, owners: ['token:charlie'] }, { updatedBy: 'test', reason: 'charlie' });
    state.agents.set('charlie-agent', { id: 'charlie-agent', name: 'Charlie Agent', owners: ['token:charlie'], deployedSkills: [] } as any);

    const charlieAdopt = await call(port, '/api/v1/agents/charlie-agent/skills', 'POST', CHARLIE, { skillId: 'pub-skill', version: '1.0.0' });
    assert.equal(charlieAdopt.status, 403);
    assert.equal(charlieAdopt.body.error, 'skill_private');
  });

  it('skill retirement: owner scope, in-use refusal without force, admin force retirement (A8, A13)', async () => {
    // private-skill is adopted by alice-agent
    // 1. Bob attempts to retire private-skill -> 403 (Bob not owner/admin)
    const bobRetire = await call(port, '/api/v1/skills/private-skill/retire', 'POST', BOB, {});
    assert.equal(bobRetire.status, 403);

    // 2. Alice attempts to retire without force -> 409 skill_in_use
    const aliceRetire = await call(port, '/api/v1/skills/private-skill/retire', 'POST', ALICE, {});
    assert.equal(aliceRetire.status, 409);
    assert.equal(aliceRetire.body.error, 'skill_in_use');

    // 3. Alice calls with force: true -> 403 forbidden (skills.retire.force is admin only)
    const aliceForce = await call(port, '/api/v1/skills/private-skill/retire', 'POST', ALICE, { force: true });
    assert.equal(aliceForce.status, 403);

    // 4. Admin calls with force: true -> 200, retired and stripped from alice-agent
    const adminRetire = await call(port, '/api/v1/skills/private-skill/retire', 'POST', ADMIN, { force: true, reason: 'Security deprecation' });
    assert.equal(adminRetire.status, 200);
    assert.deepEqual(adminRetire.body.removedFrom, ['alice-agent']);

    const vers = skillRegistry(state).versions('private-skill');
    assert.ok(vers.every((v) => v.retired));
  });

  it('hardening: Archie Finding A (indeterminate owner rights) and Finding B (canonical recipient validation)', async () => {
    // Finding B: recipient must be canonical actor format
    const badRecipient = await call(port, '/api/v1/skills/pub-skill/transfer', 'POST', ALICE, { recipient: 'bob' });
    assert.equal(badRecipient.status, 400);
    assert.equal(badRecipient.body.error, 'invalid_recipient');

    const bareAdmin = await call(port, '/api/v1/skills/pub-skill/transfer', 'POST', ALICE, { recipient: 'admin' });
    assert.equal(bareAdmin.status, 400);

    // Finding A: External unknown actor with indeterminate rights
    const reg = skillRegistry(state);
    reg.saveIfAbsent({
      id: 'external-skill',
      name: 'External Skill',
      version: '1.0.0',
      description: 'External',
      language: 'python',
      entry: 'entry.py',
      tests: 'passed',
      status: 'approved',
      registeredBy: 'oidc:contractor@external-idp.example.com',
      owner: 'oidc:contractor@external-idp.example.com',
      registeredAt: new Date().toISOString(),
    });

    const adminOverride = await call(port, '/api/v1/skills/external-skill/transfer/admin', 'POST', ADMIN, { recipient: 'token:alice' });
    assert.equal(adminOverride.status, 409);
    assert.equal(adminOverride.body.error, 'owner_rights_indeterminate');
    assert.equal(adminOverride.body.message, "cannot determine the owner's rights");
  });
});
