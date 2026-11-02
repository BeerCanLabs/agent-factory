// TSK-299: Skill action hold overrides and deployedSkills synchronization (GAP-223, #369).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { VersionedConfigStore, type ConfigBackend, type ConfigRecord } from '@beercanlabs/factory-registrar';
import { effectiveAgentSkillActionHolds, loadSkills, skillRegistry } from './skills.js';

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  return {
    description: 'memory',
    loadAll: async () => records,
    write: async (r) => { records.push(r); },
    remove: async () => {},
  };
};

const ADMIN = 'admin-skill-holds-token';
const ALICE = 'alice-skill-holds-token';
const GATEKEEPER_EGRESS = 'gatekeeper-egress-token';

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

function createTarHeader(opts: { name: string; size: number }): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(opts.name, 0, 100, 'utf8');
  buf.write('0000777\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  const sizeOctal = opts.size.toString(8).padStart(11, '0') + ' ';
  buf.write(sizeOctal, 124, 12, 'utf8');
  buf.write('00000000000\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8');
  buf.write('0', 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chkOctal = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chkOctal, 148, 8, 'utf8');
  return buf;
}

function makeTarball(files: Array<{ header: Buffer; content: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(f.header);
    chunks.push(f.content);
    const pad = 512 - (f.content.length % 512);
    if (pad > 0 && pad < 512) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function buildPackageWithActions(id: string, version: string, actions: Array<{ id: string; route: string; method: string; path: string; hold: boolean }>): Buffer {
  const actionsYaml = actions
    .map((a) =>
      [
        `  - id: ${a.id}`,
        `    route: ${a.route}`,
        `    method: ${a.method}`,
        `    path: ${a.path}`,
        `    hold: ${a.hold}`,
      ].join('\n'),
    )
    .join('\n');
  const yaml = [
    'spec: 1',
    `id: ${id}`,
    `name: ${id}`,
    `version: ${version}`,
    'language: python',
    'description: hold test skill',
    'entry: entry.py',
    'requires:',
    '  routes: [google-gmail]',
    'actions:',
    actionsYaml,
    'smoke:',
    `  action: ${actions[0]?.id ?? 'test'}`,
    '  dryRun: true',
    '  input: {}',
    '',
  ].join('\n');
  const entry = 'def run():\n    pass\n';
  const test = 'def test_smoke():\n    assert True\n';
  const yBuf = Buffer.from(yaml, 'utf8');
  const eBuf = Buffer.from(entry, 'utf8');
  const tBuf = Buffer.from(test, 'utf8');
  return zlib.gzipSync(
    makeTarball([
      { header: createTarHeader({ name: 'skill.yaml', size: yBuf.length }), content: yBuf },
      { header: createTarHeader({ name: 'entry.py', size: eBuf.length }), content: eBuf },
      { header: createTarHeader({ name: 'test_entry.py', size: tBuf.length }), content: tBuf },
    ]),
  );
}

describe('TSK-299 S23 skill holds regression tests (#369)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-skill-holds-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'alice', token: ALICE, roles: ['operator'] },
        { name: 'gatekeeper-egress', token: GATEKEEPER_EGRESS, roles: ['gatekeeper-egress'] },
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
      skillChecker: {
        name: 'mock-checker',
        supportsPackages: true,
        start: async () => 'mock-run-id',
        result: async () => ({ passed: true, failures: [] }),
      },
    } as FactoryState;
    state.configs = await VersionedConfigStore.open(memoryBackend());
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('1. deploying an agent with tightened override, resetting back to false via PUT/PATCH /holds reflects false immediately on both GET /skills and gatekeeper-egress without redeploying', async () => {
    // Initialize agent
    state.agents.set('alice-agent', {
      id: 'alice-agent',
      name: 'Alice Agent',
      owners: ['token:alice'],
      deployedSkills: [],
    } as any);
    await state.configs!.put(
      { agentId: 'alice-agent', source: {}, skills: [], policy: null, owners: ['token:alice'] },
      { updatedBy: 'test', reason: 'init' },
    );

    // Register mail-skill@1.0.0 with send_mail (hold: true) and search_mail (hold: false)
    const pkg = buildPackageWithActions('mail-skill', '1.0.0', [
      { id: 'send_mail', route: 'google-gmail', method: 'POST', path: '/mail/send', hold: true },
      { id: 'search_mail', route: 'google-gmail', method: 'GET', path: '/mail/search', hold: false },
    ]);
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg);
    assert.equal(regRes.status, 201, JSON.stringify(regRes.body));
    const reg = skillRegistry(state);
    const rec = reg.get('mail-skill', '1.0.0')!;
    rec.tests = 'passed';
    rec.status = 'approved';
    reg.save(rec);

    // Adopt with tightened override search_mail: true
    const adoptRes = await call(port, '/api/v1/agents/alice-agent/skills', 'POST', ALICE, {
      skillId: 'mail-skill',
      version: '1.0.0',
      holds: { search_mail: true },
    });
    assert.equal(adoptRes.status, 201, JSON.stringify(adoptRes.body));
    const approveRes = await call(port, '/api/v1/agents/alice-agent/skills/mail-skill/adoption/approve', 'POST', ADMIN, {});
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes.body));

    // Agent is deployed with mail-skill@1.0.0 snapshotting search_mail: true
    const aliceAgent = state.agents.get('alice-agent')!;
    aliceAgent.deployedSkills = [{ id: 'mail-skill', version: '1.0.0', holds: { search_mail: true } }];

    // Gatekeeper-egress verifies search_mail is initially held true
    const run1 = state.runs.create({
      agentId: 'alice-agent',
      state: 'WORKING',
      actor: 'token:alice',
      trigger: 'conversation',
    });
    const run1Ctx = await call(port, `/api/v1/gatekeeper-egress/runs/${run1.runId}`, 'GET', GATEKEEPER_EGRESS);
    assert.equal(run1Ctx.status, 200, JSON.stringify(run1Ctx.body));
    const searchHold1 = run1Ctx.body.skillHolds.find((r: any) => r.actionId === 'search_mail');
    assert.ok(searchHold1, 'search_mail must be present in skillHolds');
    assert.equal(searchHold1.hold, true, 'search_mail must initially be held (tightened at deploy)');

    // Reset search_mail override back to false via PATCH /holds
    const resetRes = await call(port, '/api/v1/agents/alice-agent/skills/mail-skill/holds', 'PATCH', ALICE, {
      holds: { search_mail: false },
    });
    assert.equal(resetRes.status, 200, JSON.stringify(resetRes.body));
    assert.equal(resetRes.body.holds.search_mail, false);

    // GET /api/v1/agents/alice-agent/skills reports search_mail: false
    const skillsRes = await call(port, '/api/v1/agents/alice-agent/skills', 'GET', ALICE);
    assert.equal(skillsRes.status, 200, JSON.stringify(skillsRes.body));
    const adoptedSkill = skillsRes.body.adopted.find((s: any) => s.id === 'mail-skill');
    assert.ok(adoptedSkill);
    assert.equal(adoptedSkill.holds.search_mail, false, 'GET /skills must report search_mail: false');

    // GET /api/v1/gatekeeper-egress/runs/:id reflects false immediately without redeploying
    const run2 = state.runs.create({
      agentId: 'alice-agent',
      state: 'WORKING',
      actor: 'token:alice',
      trigger: 'conversation',
    });
    const run2Ctx = await call(port, `/api/v1/gatekeeper-egress/runs/${run2.runId}`, 'GET', GATEKEEPER_EGRESS);
    assert.equal(run2Ctx.status, 200, JSON.stringify(run2Ctx.body));
    const searchHold2 = run2Ctx.body.skillHolds.find((r: any) => r.actionId === 'search_mail');
    assert.ok(searchHold2, 'search_mail must be present in skillHolds');
    assert.equal(searchHold2.hold, false, 'search_mail must reflect false at runtime immediately without redeploying');
    const sendHold2 = run2Ctx.body.skillHolds.find((r: any) => r.actionId === 'send_mail');
    assert.ok(sendHold2, 'send_mail must be present in skillHolds');
    assert.equal(sendHold2.hold, true, 'send_mail must remain held true per manifest default');

    // Verify deployedSkills holds was synced by updateSkillHolds
    assert.equal(aliceAgent.deployedSkills[0]?.holds?.search_mail, false, 'deployedSkills holds must be synced on updateSkillHolds');
  });

  it('2. tightening at deploy, resetting to false via PATCH /holds, then removing skill from ConfigStore respects most recent false from history rather than initial deploy snapshot', async () => {
    const reg = skillRegistry(state);
    const aliceAgent = state.agents.get('alice-agent')!;

    // Register history-skill@1.0.0 with autonomous action auto_action (hold: false)
    const pkg = buildPackageWithActions('history-skill', '1.0.0', [
      { id: 'auto_action', route: 'google-gmail', method: 'GET', path: '/history/auto', hold: false },
    ]);
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg);
    assert.equal(regRes.status, 201, JSON.stringify(regRes.body));
    const rec = reg.get('history-skill', '1.0.0')!;
    rec.tests = 'passed';
    rec.status = 'approved';
    reg.save(rec);

    // Adopt with tightened override auto_action: true
    const adoptRes = await call(port, '/api/v1/agents/alice-agent/skills', 'POST', ALICE, {
      skillId: 'history-skill',
      version: '1.0.0',
      holds: { auto_action: true },
    });
    assert.equal(adoptRes.status, 201);
    const approveRes = await call(port, '/api/v1/agents/alice-agent/skills/history-skill/adoption/approve', 'POST', ADMIN, {});
    assert.equal(approveRes.status, 200);

    // Reset auto_action back to false via PATCH /holds
    const resetRes = await call(port, '/api/v1/agents/alice-agent/skills/history-skill/holds', 'PATCH', ALICE, {
      holds: { auto_action: false },
    });
    assert.equal(resetRes.status, 200, JSON.stringify(resetRes.body));
    assert.equal(resetRes.body.holds.auto_action, false);

    // Simulate stale initial deploy snapshot on aliceAgent.deployedSkills
    aliceAgent.deployedSkills = [{ id: 'history-skill', version: '1.0.0', holds: { auto_action: true } }];

    // Remove history-skill from ConfigStore (DELETE /skills/history-skill)
    const delRes = await call(port, '/api/v1/agents/alice-agent/skills/history-skill', 'DELETE', ALICE);
    assert.equal(delRes.status, 200, JSON.stringify(delRes.body));
    assert.deepEqual(state.configs!.current('alice-agent')!.skills.find((s) => s.id === 'history-skill'), undefined);

    // Runtime egress hold must respect the most recent false from history, NOT the stale deploy snapshot
    const run3 = state.runs.create({
      agentId: 'alice-agent',
      state: 'WORKING',
      actor: 'token:alice',
      trigger: 'conversation',
    });
    const run3Ctx = await call(port, `/api/v1/gatekeeper-egress/runs/${run3.runId}`, 'GET', GATEKEEPER_EGRESS);
    assert.equal(run3Ctx.status, 200, JSON.stringify(run3Ctx.body));
    const autoHold = run3Ctx.body.skillHolds.find((r: any) => r.skillId === 'history-skill' && r.actionId === 'auto_action');
    assert.ok(autoHold, 'auto_action must be present in skillHolds from deployedSkills');
    assert.equal(autoHold.hold, false, 'runtime egress hold must respect most recent false from history rather than stale deploy snapshot');
  });

  it('3. effectiveAgentSkillActionHolds does not mutate agent.pendingConfig.skills in place', () => {
    const aliceAgent = state.agents.get('alice-agent')!;
    const originalHolds = { search_mail: false };
    const originalSkill = { id: 'mail-skill', version: '1.0.0', holds: originalHolds };
    aliceAgent.pendingConfig = {
      skills: [originalSkill],
    };
    aliceAgent.deployedSkills = [{ id: 'mail-skill', version: '1.0.0', holds: { search_mail: true } }];

    // Freeze input objects to guarantee that any in-place mutation attempts throw
    Object.freeze(originalHolds);
    Object.freeze(originalSkill);
    Object.freeze(aliceAgent.pendingConfig.skills);

    const holds = effectiveAgentSkillActionHolds(state, 'alice-agent');
    assert.ok(holds.length > 0);
    assert.equal(originalHolds.search_mail, false, 'pendingConfig.skills[0].holds.search_mail must not be mutated');
    assert.equal(aliceAgent.pendingConfig.skills[0].holds?.search_mail, false);

    delete (aliceAgent as any).pendingConfig;
  });

  it('4. PUT/PATCH /holds on an unapproved adoption request (state === requested) does NOT mutate agent.deployedSkills or live runtime skillHolds', async () => {
    const reg = skillRegistry(state);
    const aliceAgent = state.agents.get('alice-agent')!;

    // Register unapproved-skill@1.0.0 with test_action (hold: false)
    const pkg = buildPackageWithActions('unapproved-skill', '1.0.0', [
      { id: 'test_action', route: 'google-gmail', method: 'GET', path: '/unapproved/test', hold: false },
    ]);
    const regRes = await call(port, '/api/v1/registry/skills', 'POST', ALICE, pkg);
    assert.equal(regRes.status, 201, JSON.stringify(regRes.body));
    const rec = reg.get('unapproved-skill', '1.0.0')!;
    rec.tests = 'passed';
    rec.status = 'approved';
    reg.save(rec);

    // Agent has unapproved-skill@1.0.0 in deployedSkills with test_action: false (e.g. deployed without ConfigStore history holds)
    aliceAgent.deployedSkills = [{ id: 'unapproved-skill', version: '1.0.0', holds: { test_action: false } }];

    // Request adoption with tightened override test_action: true (pending unapproved request, state === 'requested')
    const adoptRes = await call(port, '/api/v1/agents/alice-agent/skills', 'POST', ALICE, {
      skillId: 'unapproved-skill',
      version: '1.0.0',
      holds: { test_action: true },
    });
    assert.equal(adoptRes.status, 201, JSON.stringify(adoptRes.body));
    assert.equal(adoptRes.body.state, 'requested');

    // Update holds on the unapproved adoption request via PATCH /holds
    const patchRes = await call(port, '/api/v1/agents/alice-agent/skills/unapproved-skill/holds', 'PATCH', ALICE, {
      holds: { test_action: true },
    });
    assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
    assert.equal(patchRes.body.state, 'requested');

    // Verify agent.deployedSkills was NOT mutated by updateSkillHolds on the unapproved adoption request
    const deployed = aliceAgent.deployedSkills.find((d) => d.id === 'unapproved-skill' && d.version === '1.0.0');
    assert.ok(deployed);
    assert.equal(deployed.holds?.test_action, false, 'deployedSkills holds must NOT be updated by unapproved adoption requests');

    // Verify runtime egress hold evaluation does NOT reflect the unapproved hold
    const run = state.runs.create({
      agentId: 'alice-agent',
      state: 'WORKING',
      actor: 'token:alice',
      trigger: 'conversation',
    });
    const runCtx = await call(port, `/api/v1/gatekeeper-egress/runs/${run.runId}`, 'GET', GATEKEEPER_EGRESS);
    assert.equal(runCtx.status, 200, JSON.stringify(runCtx.body));
    const actionHold = runCtx.body.skillHolds.find((r: any) => r.skillId === 'unapproved-skill' && r.actionId === 'test_action');
    assert.ok(actionHold, 'test_action must be present in skillHolds from deployedSkills');
    assert.equal(actionHold.hold, false, 'live runtime skillHolds must NOT be altered by unapproved adoption request holds');
  });
});
