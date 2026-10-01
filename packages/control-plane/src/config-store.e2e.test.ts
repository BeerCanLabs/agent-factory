// TSK-052 (§6.14 SK3, §6.13 R1): every agent's deployment configuration is versioned on change, ledgered with its
// hash, readable by a viewer, exportable by an admin, migrated from today's state, and served from memory.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore, RunTokens } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { loadDynamicRegistry } from './catalog.js';
import { FileConfigBackend, VersionedConfigStore, configHash, migrateConfigs, type ConfigBackend, type ConfigRecord } from './config-store.js';

const ADMIN = 'admin-config-token';
const VIEWER = 'viewer-config-token';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Counts every backend call, so a test can prove reads never reach the store. */
function counting(inner: ConfigBackend) {
  const calls = { loadAll: 0, write: 0 };
  const backend: ConfigBackend = {
    description: inner.description,
    loadAll: () => { calls.loadAll += 1; return inner.loadAll(); },
    write: (r) => { calls.write += 1; return inner.write(r); },
    remove: (id, m) => inner.remove(id, m),
  };
  return { backend, calls };
}

function baseState(dir: string, ledger: MemoryLedger, policies = new PolicyStore()): FactoryState {
  return {
    agents: new Map(),
    registryDir: join(dir, 'registry'),
    ledger,
    auth: bearerAuth([
      { name: 'admin', token: ADMIN, roles: ['admin'] },
      { name: 'viewer', token: VIEWER, roles: ['viewer'] },
    ]),
    version: '0.1.0',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    approvals: new ApprovalStore(),
    policies,
    spend: new SpendTracker(),
    resolveCommit: async () => SHA1,
    secretValues: new Set(),
    runTokens: new RunTokens('config-store-test-run-token-key-0123456789'),
    callbacks: { allowedProtocols: ['https:'], allowedHostnames: [], allowPrivateIps: false },
    idleMs: 0,
    idleTimers: new Map(),
  };
}

describe('SK3 deployment configuration store (TSK-052)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let calls: { loadAll: number; write: number };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-config-store-'));
    ledger = new MemoryLedger();
    state = baseState(dir, ledger);
    const c = counting(new FileConfigBackend(join(dir, 'config')));
    calls = c.calls;
    state.configs = await VersionedConfigStore.open(c.backend);
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('register, then a policy change: history shows two versions with hashes, each ledgered without the policy', async () => {
    const reg = await call(port, '/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA1, cartridge: { id: 'ada', name: 'Ada' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const policy = { routes: ['models'], budgetUsd: { perDay: 5 } };
    const put = await call(port, '/api/v1/agents/ada/policy', 'PUT', ADMIN, policy, { 'x-change-reason': 'ada needs models' });
    assert.equal(put.status, 200);

    const hist = await call(port, '/api/v1/agents/ada/config/history', 'GET', VIEWER);
    assert.equal(hist.status, 200);
    assert.equal(hist.body.current, 2);
    const [v1, v2] = hist.body.versions as ConfigRecord[];
    assert.equal(hist.body.versions.length, 2);
    assert.deepEqual(
      { version: v1.version, source: v1.source, skills: v1.skills, policy: v1.policy, updatedBy: v1.updatedBy, reason: v1.reason },
      { version: 1, source: { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA1 }, skills: [], policy: null, updatedBy: 'token:admin', reason: 'registered' },
    );
    assert.deepEqual(
      { version: v2.version, policy: v2.policy, updatedBy: v2.updatedBy, reason: v2.reason },
      { version: 2, policy, updatedBy: 'token:admin', reason: 'ada needs models' },
    );
    for (const v of [v1, v2]) {
      assert.match(v.hash, /^[0-9a-f]{64}$/);
      assert.equal(v.hash, configHash(v));
      assert.ok(!Number.isNaN(Date.parse(v.updatedAt)));
    }
    assert.notEqual(v1.hash, v2.hash);

    const rows = ledger.query().filter((e) => e.action === 'CONFIG_VERSIONED');
    assert.deepEqual(
      rows.map((e) => ({ agentId: e.agentId, actor: e.actor, requestId: e.requestId, payloadSha256: e.payloadSha256 })),
      [
        { agentId: 'ada', actor: 'token:admin', requestId: 'config:ada:v1', payloadSha256: v1.hash },
        { agentId: 'ada', actor: 'token:admin', requestId: 'config:ada:v2', payloadSha256: v2.hash },
      ],
    );
    for (const e of rows) assert.ok(!JSON.stringify(e).includes('budgetUsd'), 'the policy body is never ledgered');

    // Existing state keeps working exactly as before.
    assert.deepEqual(state.policies.get('ada'), policy);
    assert.equal((await call(port, '/api/v1/agents/ada/policy', 'GET', VIEWER)).body.budgetUsd.perDay, 5);
  });

  it('re-registering with nothing changed adds no version; a new commit does', async () => {
    await call(port, '/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA1, cartridge: { id: 'ada', name: 'Ada' } });
    assert.equal(state.configs!.history('ada').length, 2);
    await call(port, '/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA2, cartridge: { id: 'ada', name: 'Ada' } });
    const current = (await call(port, '/api/v1/agents/ada/config', 'GET', VIEWER)).body as ConfigRecord;
    assert.equal(current.version, 3);
    assert.equal(current.source.commit, SHA2);
    assert.equal(current.reason, 're-registered');
    assert.deepEqual(current.policy, { routes: ['models'], budgetUsd: { perDay: 5 } }, 're-registering keeps the policy');
  });

  it('serves one version, and 404s for an unknown version or agent', async () => {
    const v1 = await call(port, '/api/v1/agents/ada/config/versions/1', 'GET', VIEWER);
    assert.equal(v1.status, 200);
    assert.equal(v1.body.version, 1);
    assert.equal((await call(port, '/api/v1/agents/ada/config/versions/9', 'GET', VIEWER)).status, 404);
    assert.equal((await call(port, '/api/v1/agents/ada/config/versions/x', 'GET', VIEWER)).status, 404);
    assert.deepEqual((await call(port, '/api/v1/agents/nobody/config', 'GET', VIEWER)).body, { error: 'not_found' });
    assert.equal((await call(port, '/api/v1/agents/ada/config', 'GET')).status, 401);
  });

  it('a viewer can read but not export; an admin exports every agent, ledgered', async () => {
    await call(port, '/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-bob', commit: SHA1, cartridge: { id: 'bob', name: 'Bob' } });
    assert.equal((await call(port, '/api/v1/agents/bob/config', 'GET', VIEWER)).status, 200);
    const denied = await call(port, '/api/v1/config/export', 'GET', VIEWER);
    assert.equal(denied.status, 403);
    const out = await call(port, '/api/v1/config/export', 'GET', ADMIN);
    assert.equal(out.status, 200);
    assert.deepEqual(
      out.body.agents.map((a: { agentId: string; current: number; versions: unknown[] }) => [a.agentId, a.current, a.versions.length]),
      [['ada', 3, 3], ['bob', 1, 1]],
    );
    assert.equal(ledger.query().filter((e) => e.action === 'CONFIG_EXPORTED' && e.actor === 'token:admin').length, 1);
  });

  it('budget and policy edits (including granted models) are versioned too', async () => {
    await call(port, '/api/v1/registry/agents/bob/budget', 'PUT', ADMIN, { spendLimitUsd: 3 });
    const current = (await call(port, '/api/v1/agents/bob/policy', 'GET', ADMIN)).body;
    await call(port, '/api/v1/agents/bob/policy', 'PUT', ADMIN, { ...current, models: ['claude-haiku-4-5'] });
    const hist = state.configs!.history('bob');
    assert.deepEqual(hist.map((r) => r.reason), ['registered', 'budget updated', 'policy updated']);
    assert.deepEqual(hist[2].policy?.models, ['claude-haiku-4-5']);
  });

  it('API reads never call the store', async () => {
    const before = { ...calls };
    for (const p of ['/api/v1/agents/ada/config', '/api/v1/agents/ada/config/history', '/api/v1/agents/ada/config/versions/2', '/api/v1/agents/nobody/config']) {
      await call(port, p, 'GET', VIEWER);
    }
    await call(port, '/api/v1/config/export', 'GET', ADMIN);
    assert.deepEqual(calls, before);
    assert.equal(calls.loadAll, 1, 'read once, on start');
  });

  it('a store failure never fails the change it records', async () => {
    const failing = mkdtempSync(join(tmpdir(), 'cp-config-fail-'));
    const l = new MemoryLedger();
    const s = baseState(failing, l);
    s.configs = await VersionedConfigStore.open({ description: 'broken', loadAll: async () => [], write: async () => { throw new Error('bucket unreachable'); }, remove: async () => undefined });
    const server = createFactoryServer(s);
    const p = await listen(server);
    try {
      const reg = await call(p, '/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-cy', commit: SHA1, cartridge: { id: 'cy' } });
      assert.equal(reg.status, 201);
      assert.equal((await call(p, '/api/v1/agents/cy/policy', 'PUT', ADMIN, { routes: ['models'] })).status, 200);
      assert.deepEqual(s.policies.get('cy'), { routes: ['models'] });
      assert.equal(l.query().filter((e) => e.action === 'CONFIG_VERSION_FAILED').length, 2);
      assert.deepEqual((await call(p, '/api/v1/agents/cy/config', 'GET', VIEWER)).body, { error: 'no_config' });
    } finally {
      server.close();
      rmSync(failing, { recursive: true, force: true });
    }
  });
});

describe('SK3 migration on start (TSK-052)', () => {
  it('creates version 1 from registry and policy state, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-config-migrate-'));
    try {
      const registryDir = join(dir, 'registry');
      const policiesDir = join(dir, 'policies');
      mkdirSync(registryDir, { recursive: true });
      mkdirSync(policiesDir, { recursive: true });
      writeFileSync(join(registryDir, 'donna.json'), JSON.stringify({ id: 'donna', name: 'Donna', repo: 'https://github.com/beercanlabs/SM-donna', commit: SHA1, state: 'SLEEPING' }));
      writeFileSync(join(policiesDir, 'donna.json'), JSON.stringify({ routes: ['discord'] }));
      writeFileSync(join(policiesDir, 'finley.json'), JSON.stringify({ routes: ['models'], budgetUsd: { perDay: 2 } }));
      writeFileSync(join(policiesDir, '__global__.json'), JSON.stringify({ routes: [], budgetUsd: { perDay: 1 } }));
      // GAP-060: a policy whose id is not a known agent never becomes a configuration record.
      writeFileSync(join(policiesDir, '6f1c2a9e-1b7d-4c55-9d0e-3a8b7c6d5e4f.json'), JSON.stringify({ budgetUsd: { perDay: 100 }, routes: [] }));

      const ledger = new MemoryLedger();
      const state = baseState(dir, ledger, new PolicyStore(policiesDir));
      const registry = loadDynamicRegistry(registryDir);
      for (const a of registry) state.agents.set(a.id, a);
      // finley is a known agent (a baked cartridge) with a policy but no registry record.
      state.agents.set('finley', { id: 'finley', name: 'Finley', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/finley' });
      const configDir = join(dir, 'config');
      state.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));

      const first = await migrateConfigs(state, [...registry.map((a) => a.id), ...state.policies.ids()]);
      assert.deepEqual(first.map((r) => [r.agentId, r.version, r.updatedBy]), [['donna', 1, 'migration'], ['finley', 1, 'migration']]);
      assert.deepEqual(state.configs.current('donna')?.source, { repo: 'https://github.com/beercanlabs/SM-donna', commit: SHA1 });
      assert.deepEqual(state.configs.current('donna')?.policy, { routes: ['discord'] });
      assert.deepEqual(state.configs.current('finley')?.source, {});
      assert.deepEqual(state.configs.current('finley')?.policy, { routes: ['models'], budgetUsd: { perDay: 2 } });
      assert.equal(state.configs.current('__global__'), undefined, 'the global default is not an agent');
      assert.equal(state.configs.current('6f1c2a9e-1b7d-4c55-9d0e-3a8b7c6d5e4f'), undefined, 'an unknown id is never migrated');
      assert.equal(ledger.query().filter((e) => e.action === 'CONFIG_VERSIONED' && e.actor === 'migration').length, 2);

      // Idempotent, including across a restart.
      assert.deepEqual(await migrateConfigs(state, ['donna', 'finley']), []);
      state.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));
      assert.deepEqual(await migrateConfigs(state, [...registry.map((a) => a.id), ...state.policies.ids()]), []);
      assert.equal(state.configs.history('donna').length, 1);
      assert.equal(ledger.query().filter((e) => e.action === 'CONFIG_VERSIONED').length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
