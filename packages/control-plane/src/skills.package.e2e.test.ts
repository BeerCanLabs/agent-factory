/**
 * End-to-end tests for skill package intake, raw gzip upload, package store,
 * role gating, and validation (TSK-276, GAP-202, A1, A5, A6, A8, A19, A21).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFactoryServer, type FactoryState } from './app.js';
import { loadSkills, packageStoreOf } from './skills.js';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { FileConfigBackend, VersionedConfigStore, MemorySkillPackageStore } from '@beercanlabs/factory-registrar';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { packSkillDirectory } from '@beercanlabs/factory-contract';

const ADMIN = 'secret-admin-token';
const VIEWER = 'secret-viewer-token';
const OPERATOR = 'secret-operator-token';
const AGENT_OWNER = 'secret-agent-owner-token';
const STRANGER = 'secret-stranger-token';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      resolve(addr.port);
    });
  });
}

describe('Skill Packages Intake & Store (Slice 2, TSK-276)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let packageStore: MemorySkillPackageStore;
  let e2ePingPackage: Buffer;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-skill-pkg-'));
    ledger = new MemoryLedger();
    packageStore = new MemorySkillPackageStore();

    const configs = await VersionedConfigStore.open(new FileConfigBackend(join(dataDir, 'config')));
    // Agent 'donna' owned by agent-owner
    await configs.put({
      agentId: 'donna',
      owners: ['token:agent-owner'],
    }, {
      by: 'setup',
      reason: 'initial setup',
    });

    state = {
      agents: new Map([
        ['donna', { id: 'donna', version: '0.1.0', runtime: 'python', state: 'SLEEPING', roles: [], credentials: [] } as any],
      ]),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'agent-owner', token: AGENT_OWNER, roles: [] },
        { name: 'stranger', token: STRANGER, roles: [] },
      ]),
      configs,
      skillPackageStore: packageStore,
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

    // Pack examples/skills/e2e-ping fixture
    const pingDir = join(process.cwd(), 'examples', 'skills', 'e2e-ping');
    e2ePingPackage = await packSkillDirectory(pingDir);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('unauthenticated upload is 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 401);
  });

  it('viewer role without agent ownership is 403 (A8)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${VIEWER}`,
      },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 403);
    const json = (await res.json()) as any;
    assert.equal(json.error, 'forbidden');
    assert.equal(json.required, 'admin');
  });

  it('operator role without agent ownership is 403 (A8)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${OPERATOR}`,
      },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 403);
  });

  it('stranger without roles or agent ownership is 403 (A8)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${STRANGER}`,
      },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 403);
  });

  it('caller who owns an agent can upload package without admin role (A8)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${AGENT_OWNER}`,
      },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as any;
    assert.equal(json.id, 'e2e-ping');
    assert.equal(json.version, '1.0.0');
    assert.equal(json.status, 'pending');
    assert.equal(json.tests, 'pending-build');
    assert.ok(json.packageHash);
    assert.equal(json.registeredBy, 'token:agent-owner');

    // Stored in package store
    const stored = await packageStore.get(json.packageHash);
    assert.ok(stored);
    assert.equal(stored.length, e2ePingPackage.length);

    // Ledger has SKILL_REGISTERED with packageHash
    const events = ledger.query().filter((e) => e.agentId === 'skill:e2e-ping@1.0.0');
    assert.ok(events.some((e) => e.action === 'SKILL_REGISTERED' && e.payloadSha256 === json.packageHash));
  });

  it('duplicate version registration is refused 422', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${ADMIN}`,
      },
      body: new Uint8Array(e2ePingPackage),
    });
    assert.equal(res.status, 422);
    const json = (await res.json()) as any;
    assert.equal(json.error, 'skill_refused');
    assert.ok(json.reasons.some((r: string) => r.includes('already registered')));
  });

  it('payload exceeding 5 MiB is 413 Payload Too Large', async () => {
    // 5 MiB + 100 bytes
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 100, 0);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(oversized.length),
        Authorization: `Bearer ${ADMIN}`,
      },
      body: new Uint8Array(oversized),
    });
    assert.equal(res.status, 413);
    const json = (await res.json()) as any;
    assert.equal(json.error, 'payload_too_large');
  });

  it('corrupt or non-tar gzip package is 422 skill_refused', async () => {
    const zlib = await import('node:zlib');
    const randomGzip = zlib.gzipSync(Buffer.from('not a tar archive at all'));
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${ADMIN}`,
      },
      body: new Uint8Array(randomGzip),
    });
    assert.equal(res.status, 422);
    const json = (await res.json()) as any;
    assert.equal(json.error, 'skill_refused');
  });

  it('package missing skill.yaml is 422 skill_refused', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'missing-yaml-'));
    writeFileSync(join(tmp, 'foo.py'), 'print("hi")\n');
    const pkg = await packSkillDirectory(tmp);
    rmSync(tmp, { recursive: true, force: true });

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${ADMIN}`,
      },
      body: new Uint8Array(pkg),
    });
    assert.equal(res.status, 422);
    const json = (await res.json()) as any;
    assert.equal(json.error, 'skill_refused');
    assert.ok(json.reasons.some((r: string) => r.includes('missing skill.yaml')));
  });

  it('admin can register a valid package via application/octet-stream', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'valid-octet-'));
    writeFileSync(join(tmp, 'skill.yaml'), 'spec: 1\nid: octet-skill\nversion: 0.1.0\nname: Octet Skill\ndescription: A test skill.\nlanguage: python\nentry: run.py\n');
    writeFileSync(join(tmp, 'run.py'), 'def tools(): return []\n');
    mkdirSync(join(tmp, 'tests'), { recursive: true });
    writeFileSync(join(tmp, 'tests', 'test_run.py'), 'import unittest\nclass T(unittest.TestCase):\n  def test_ok(self): pass\n');
    const pkg = await packSkillDirectory(tmp);
    rmSync(tmp, { recursive: true, force: true });

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${ADMIN}`,
      },
      body: new Uint8Array(pkg),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as any;
    assert.equal(json.id, 'octet-skill');
    assert.equal(json.version, '0.1.0');
  });
});
