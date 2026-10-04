// TSK-105 (GAP-088, §6.14 SK3, §6.11 K5): an owner acts on its own agents and only those. Dale's list: wake, pause and
// resume the agent; view and export its configuration; supply its credentials and start or import its connections.
// Isolate, cancel and the conversation hand-off stay operator; the fleet-wide routes stay admin. Rights come from
// ownership, not from a role: one owner here holds only `ingest`.
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
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { FileConfigBackend, VersionedConfigStore } from './config-store.js';

const ADMIN = 'admin-owner-access';
const OPERATOR = 'operator-owner-access';
const ALICE = 'alice-owner-access'; // viewer; owns ada
const CAROL = 'carol-owner-access'; // ingest only; owns ada
const BOB = 'bob-owner-access'; // viewer; owns bea
const SHA = '1'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const passed = (status: number) => status !== 401 && status !== 403;

describe('an owner acts on its own agents (TSK-105)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let ledger: MemoryLedger;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-owner-access-'));
    ledger = new MemoryLedger();
    const state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'alice', token: ALICE, roles: ['viewer'] },
        { name: 'carol', token: CAROL, roles: ['ingest'] },
        { name: 'bob', token: BOB, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    cp = createFactoryServer(state);
    const port = await listen(cp);
    api = async (path, method = 'GET', token, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    for (const id of ['ada', 'bea']) {
      const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, cartridge: { id, name: id } });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
    }
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['token:alice', 'token:carol'] })).status, 200);
    assert.equal((await api('/api/v1/agents/bea/owners', 'PUT', ADMIN, { owners: ['token:bob'] })).status, 200);
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the owner wakes, pauses and resumes its own agent', async () => {
    assert.ok(passed((await api('/api/v1/agents/ada/wake', 'POST', ALICE, {})).status));
    assert.equal((await api('/api/v1/agents/ada/pause', 'POST', ALICE, {})).status, 200);
    assert.equal((await api('/api/v1/agents/ada/resume', 'POST', ALICE, {})).status, 200);
  });

  it('but not isolate, cancel, the conversation hand-off or another agent', async () => {
    for (const [path, role] of [
      ['/api/v1/agents/ada/isolate', 'operator'],
      ['/api/v1/runs/nope/cancel', 'operator'],
      ['/api/v1/agents/ada/conversation', 'operator'],
      ['/api/v1/agents/bea/wake', 'operator'],
      ['/api/v1/agents/bea/pause', 'operator'],
    ] as const) {
      const r = await api(path, 'POST', ALICE, {});
      assert.equal(r.status, 403, path);
      assert.equal(r.body.required, role, path);
    }
  });

  it('the owner reads and exports its own configuration, one agent only', async () => {
    assert.equal((await api('/api/v1/agents/ada/config', 'GET', ALICE)).status, 200);
    const out = await api('/api/v1/config/export?agent=ada', 'GET', ALICE);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.agents.map((a: { agentId: string }) => a.agentId), ['ada']);
    assert.ok(ledger.query({ agentId: 'ada' }).some((e) => e.action === 'CONFIG_EXPORTED' && e.actor === 'token:alice'));
    const all = await api('/api/v1/config/export', 'GET', ALICE);
    assert.equal(all.status, 403);
    assert.equal(all.body.required, 'admin');
    assert.equal((await api('/api/v1/config/export?agent=bea', 'GET', ALICE)).status, 403);
  });

  it('an unknown agent is the same 403 for a non-admin (no existence leak) and 404 for an admin', async () => {
    assert.equal((await api('/api/v1/config/export?agent=nope', 'GET', ALICE)).status, 403);
    assert.equal((await api('/api/v1/config/export?agent=nope', 'GET', ADMIN)).status, 404);
  });

  it('the owner supplies credentials and starts or imports a connection for its own agent only', async () => {
    assert.ok(passed((await api('/api/v1/keymaster/agents/ada/credentials', 'GET', ALICE)).status));
    assert.ok(passed((await api('/api/v1/keymaster/agents/ada/credentials/SOME_KEY', 'PUT', ALICE, {})).status));
    assert.ok(passed((await api('/api/v1/connections/ada/google/start', 'GET', ALICE)).status));
    assert.ok(passed((await api('/api/v1/connections/ada/google/import', 'POST', ALICE, {})).status));
    for (const [path, method] of [
      ['/api/v1/keymaster/agents/bea/credentials', 'GET'],
      ['/api/v1/keymaster/agents/bea/credentials/SOME_KEY', 'PUT'],
      ['/api/v1/connections/bea/google/start', 'GET'],
      ['/api/v1/connections/bea/google/import', 'POST'],
    ] as const) {
      const r = await api(path, method, ALICE, {});
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.required, 'admin');
    }
  });

  it('the fleet-wide and admin routes stay closed to an owner', async () => {
    for (const [path, method] of [
      ['/api/v1/keymaster/outstanding', 'GET'],
      ['/api/v1/keymaster/platform/credentials', 'GET'],
      ['/api/v1/agents/ada/policy', 'PUT'],
      ['/api/v1/agents/ada/owners', 'PUT'],
      ['/api/v1/registry/agents/ada/purge', 'POST'],
    ] as const) {
      assert.equal((await api(path, method, ALICE, {})).status, 403, `${method} ${path}`);
    }
  });

  it('the right comes from ownership, not from a role: an ingest-only owner wakes and reads its agent but nothing else', async () => {
    assert.ok(passed((await api('/api/v1/agents/ada/wake', 'POST', CAROL, {})).status));
    assert.equal((await api('/api/v1/agents/ada/config', 'GET', CAROL)).status, 200);
    assert.equal((await api('/api/v1/agents', 'GET', CAROL)).status, 403);
    assert.equal((await api('/api/v1/agents/bea/wake', 'POST', CAROL, {})).status, 403);
  });

  it("another agent's owner has no right here", async () => {
    const r = await api('/api/v1/agents/ada/wake', 'POST', BOB, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.required, 'operator');
    assert.equal((await api('/api/v1/agents/bea/config', 'GET', BOB)).status, 200);
  });

  it('operator and admin keep every access they had', async () => {
    assert.ok(passed((await api('/api/v1/agents/bea/wake', 'POST', OPERATOR, {})).status));
    assert.equal((await api('/api/v1/agents/bea/isolate', 'POST', OPERATOR, {})).status, 200);
    assert.equal((await api('/api/v1/config/export', 'GET', ADMIN)).status, 200);
    assert.equal((await api('/api/v1/config/export?agent=bea', 'GET', ADMIN)).status, 200);
    assert.ok(passed((await api('/api/v1/keymaster/agents/bea/credentials', 'GET', ADMIN)).status));
  });

  it('clearing the owners removes the rights at once', async () => {
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['token:carol'] })).status, 200);
    assert.equal((await api('/api/v1/agents/ada/wake', 'POST', ALICE, {})).status, 403);
    assert.equal((await api('/api/v1/config/export?agent=ada', 'GET', ALICE)).status, 403);
    assert.ok(passed((await api('/api/v1/agents/ada/wake', 'POST', CAROL, {})).status));
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: [] })).status, 200);
    assert.equal((await api('/api/v1/agents/ada/wake', 'POST', CAROL, {})).status, 403);
  });
});
