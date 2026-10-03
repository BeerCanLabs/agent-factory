// TSK-057 (GAP-060; E7, SK3, R1): no policy or configuration record exists for an agent that does not exist. The
// policy and budget endpoints refuse unknown ids; on start, orphaned policy files are archived (moved, ledgered) and
// orphaned configuration records removed (recoverably), never when the agent list may be incomplete.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore, RunTokens } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, PolicyStore, archiveStamp } from './policy.js';
import { BUILTIN_SYSTEM_AGENTS, loadDynamicRegistry, mergeAgents } from './catalog.js';
import {
  FileConfigBackend,
  S3ConfigBackend,
  VersionedConfigStore,
  checkRegistry,
  configHash,
  migrateConfigs,
  pruneOrphans,
  pruneRefusal,
  type ConfigRecord,
} from './config-store.js';

const ADMIN = 'admin-orphan-token';
const SHA = '1'.repeat(40);
const BUILTINS = BUILTIN_SYSTEM_AGENTS.map((a) => a.id);
const ORPHANS = ['0b7e5a52-8f0e-4d43-9a8e-0f1f2e3d4c5b', '6f1c2a9e-1b7d-4c55-9d0e-3a8b7c6d5e4f', 'c3d2e1f0-a9b8-4c7d-8e6f-5a4b3c2d1e0f'];
const REAL = ['archie', 'donna'];
const ORPHAN_POLICY = `${JSON.stringify({ budgetUsd: { perDay: 100 }, routes: [] })}`;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function baseState(registryDir: string, ledger: MemoryLedger, policies: PolicyStore): FactoryState {
  return {
    agents: new Map(mergeAgents(BUILTIN_SYSTEM_AGENTS, [], loadDynamicRegistry(registryDir)).map((a) => [a.id, a])),
    registryDir,
    ledger,
    auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
    version: '0.1.0',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    approvals: new ApprovalStore(),
    policies,
    spend: new SpendTracker(),
    resolveCommit: async () => SHA,
    secretValues: new Set(),
    runTokens: new RunTokens('orphan-test-run-token-key-0123456789abc'),
    callbacks: { allowedProtocols: ['https:'], allowedHostnames: [], allowPrivateIps: false },
    idleMs: 0,
    idleTimers: new Map(),
  };
}

/** A data dir as production had it: two real agents, `__global__`, and orphaned UUID policies. */
function seed(dir: string) {
  const registryDir = join(dir, 'registry');
  const policiesDir = join(dir, 'policies');
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(policiesDir, { recursive: true });
  for (const id of REAL) {
    writeFileSync(join(registryDir, `${id}.json`), JSON.stringify({ id, name: id, repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, state: 'SLEEPING' }));
    writeFileSync(join(policiesDir, `${id}.json`), JSON.stringify({ routes: ['models'], budgetUsd: { perDay: 5 } }, null, 2));
  }
  writeFileSync(join(policiesDir, '__global__.json'), JSON.stringify({ routes: [], budgetUsd: { perDay: 100 } }));
  for (const id of ORPHANS) writeFileSync(join(policiesDir, `${id}.json`), ORPHAN_POLICY);
  return { registryDir, policiesDir };
}

function snapshot(dir: string, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, readFileSync(join(dir, `${id}.json`), 'utf8')]));
}

describe('GAP-060 guard: policy and budget endpoints refuse ids that are not agents', () => {
  it('404s an unknown id and writes nothing; real agents and __global__ keep working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-guard-'));
    const { registryDir, policiesDir } = seed(dir);
    for (const id of ORPHANS) rmSync(join(policiesDir, `${id}.json`));
    const ledger = new MemoryLedger();
    const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
    const server = createFactoryServer(state);
    const port = await listen(server);
    try {
      const ghost = ORPHANS[0];
      assert.deepEqual(await call(port, `/api/v1/agents/${ghost}/policy`, 'PUT', { routes: [], budgetUsd: { perDay: 100 } }), { status: 404, body: { error: 'not_found' } });
      assert.deepEqual(await call(port, `/api/v1/agents/${ghost}/policy`), { status: 404, body: { error: 'not_found' } });
      assert.deepEqual(await call(port, `/api/v1/registry/agents/${ghost}/budget`, 'PUT', { spendLimitUsd: 100, period: 'daily' }), { status: 404, body: { error: 'not_found' } });
      assert.deepEqual(await call(port, `/api/v1/registry/agents/${ghost}/budget`, 'PUT', { routes: [], budgetUsd: { perDay: 100 } }), { status: 404, body: { error: 'not_found' } });
      assert.equal(state.policies.has(ghost), false);
      assert.equal(existsSync(join(policiesDir, `${ghost}.json`)), false, 'no policy file for an unknown id');

      // __global__ is not an agent: never set through the agent policy endpoint, only through the global one.
      assert.equal((await call(port, '/api/v1/agents/__global__/policy', 'PUT', { routes: [] })).status, 404);
      const global = await call(port, '/api/v1/policies/budget', 'PUT', { routes: [], budgetUsd: { perDay: 7 } });
      assert.equal(global.status, 200);
      assert.deepEqual(state.policies.get('__global__'), { routes: [], budgetUsd: { perDay: 7 } });
      const reg = await call(port, '/api/v1/registry/agents', 'POST', { repo: 'https://github.com/beercanlabs/SM-nick', commit: SHA, cartridge: { id: 'nick' } });
      assert.equal(reg.status, 201);
      assert.equal(reg.body.state, 'PENDING_DEPLOY', 'a first registration still gets the global default');
      assert.deepEqual(state.policies.get('nick').budgetUsd, { perDay: 7 });

      // Real agents.
      assert.equal((await call(port, '/api/v1/agents/archie/policy', 'PUT', { routes: ['models'], budgetUsd: { perDay: 3 } })).status, 200);
      assert.deepEqual((await call(port, '/api/v1/agents/archie/policy')).body, { routes: ['models'], budgetUsd: { perDay: 3 } });
      assert.equal((await call(port, '/api/v1/registry/agents/donna/budget', 'PUT', { spendLimitUsd: 9, period: 'monthly' })).status, 200);
      assert.deepEqual(state.policies.get('donna').budgetUsd, { perDay: 5, perMonth: 9 });
      assert.equal((await call(port, '/api/v1/agents/gatekeeper-ingress/policy', 'PUT', { routes: [] })).status, 200, 'a built-in is a known agent');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GAP-060 orphan prune on start (filesystem)', () => {
  it('moves orphaned policy files, removes their configuration records, ledgers each, and leaves real agents untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-fs-'));
    try {
      const { registryDir, policiesDir } = seed(dir);
      const configDir = join(dir, 'config');
      const ledger = new MemoryLedger();
      const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
      // The TSK-052 migration as it ran in production: a record for every policy id, orphans included.
      state.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));
      for (const id of [...REAL, ...ORPHANS]) {
        await state.configs.put({ agentId: id, source: {}, skills: [], policy: state.policies.get(id) }, { updatedBy: 'migration', reason: 'migrated' });
      }
      const realBefore = snapshot(policiesDir, [...REAL, '__global__']);
      const realConfigBefore = REAL.map((id) => state.configs!.history(id));

      const now = new Date('2026-10-01T12:00:00.000Z');
      const result = await pruneOrphans(state, { builtinIds: BUILTINS, registry: checkRegistry(registryDir), now });
      assert.equal(result.refused, undefined);
      assert.deepEqual(result.archived.sort(), [...ORPHANS].sort());
      assert.deepEqual(result.removed.sort(), [...ORPHANS].sort());
      assert.deepEqual(result.failed, []);

      // Policies: moved, byte for byte, never deleted.
      const archive = join(dir, 'policies-orphaned', archiveStamp(now));
      assert.equal(result.archivedTo, archive);
      assert.deepEqual(readdirSync(archive).sort(), ORPHANS.map((id) => `${id}.json`).sort());
      for (const id of ORPHANS) {
        assert.equal(readFileSync(join(archive, `${id}.json`), 'utf8'), ORPHAN_POLICY);
        assert.equal(existsSync(join(policiesDir, `${id}.json`)), false);
        assert.equal(state.policies.has(id), false);
      }
      assert.deepEqual(snapshot(policiesDir, [...REAL, '__global__']), realBefore, 'real agents and __global__ untouched');
      assert.deepEqual(new PolicyStore(policiesDir).ids().sort(), ['__global__', ...REAL].sort(), 'the store no longer loads them');

      // Configuration: orphans moved to _removed/<timestamp>/, real agents untouched.
      for (const id of ORPHANS) {
        assert.equal(existsSync(join(configDir, id)), false);
        const moved = join(configDir, '_removed', archiveStamp(now), id);
        assert.ok(existsSync(join(moved, '1.json')), 'the record is kept, not deleted');
        assert.equal(JSON.parse(readFileSync(join(moved, 'removed.json'), 'utf8')).removedBy, 'system:orphan-prune');
        assert.equal(state.configs.current(id), undefined);
      }
      assert.deepEqual(REAL.map((id) => state.configs!.history(id)), realConfigBefore);
      const reopened = await VersionedConfigStore.open(new FileConfigBackend(configDir));
      assert.deepEqual(reopened.agentIds(), [...REAL].sort());

      // Ledger: one row per archived policy and per removed record.
      const archivedRows = ledger.query().filter((e) => e.action === 'POLICY_ORPHAN_ARCHIVED');
      assert.deepEqual(archivedRows.map((e) => e.agentId).sort(), [...ORPHANS].sort());
      assert.ok(archivedRows.every((e) => e.actor === 'system:orphan-prune' && e.type === 'action'));
      const removedRows = ledger.query().filter((e) => e.action === 'CONFIG_REMOVED');
      assert.deepEqual(removedRows.map((e) => e.agentId).sort(), [...ORPHANS].sort());
      assert.ok(removedRows.every((e) => e.actor === 'system:orphan-prune' && e.payloadSha256 === configHash({ agentId: e.agentId, source: {}, skills: [], policy: JSON.parse(ORPHAN_POLICY) })));

      // Idempotent, in the same process and across a restart.
      const rows = ledger.query().length;
      assert.deepEqual(await pruneOrphans(state, { builtinIds: BUILTINS, registry: checkRegistry(registryDir) }), { archived: [], removed: [], failed: [] });
      const restarted = baseState(registryDir, ledger, new PolicyStore(policiesDir));
      restarted.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));
      assert.deepEqual(await pruneOrphans(restarted, { builtinIds: BUILTINS, registry: checkRegistry(registryDir) }), { archived: [], removed: [], failed: [] });
      assert.equal(ledger.query().length, rows, 'a second run ledgers nothing');
      assert.deepEqual(readdirSync(join(dir, 'policies-orphaned')), [archiveStamp(now)]);

      // Migration after the prune creates nothing for the orphans.
      assert.deepEqual(await migrateConfigs(restarted, [...ORPHANS, ...restarted.policies.ids()]), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a configuration record whose id still has a policy, and migration skips unknown ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-migrate-'));
    try {
      const { registryDir, policiesDir } = seed(dir);
      const ledger = new MemoryLedger();
      const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
      state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
      const created = await migrateConfigs(state, [...REAL, ...state.policies.ids()]);
      assert.deepEqual(created.map((r) => r.agentId).sort(), [...REAL].sort(), 'unknown ids get no record');
      assert.deepEqual(state.configs.agentIds(), [...REAL].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a purged agent leaves no policy or configuration record behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-purge-'));
    const { registryDir, policiesDir } = seed(dir);
    const ledger = new MemoryLedger();
    const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
    const configDir = join(dir, 'config');
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));
    await migrateConfigs(state, REAL);
    const server = createFactoryServer(state);
    const port = await listen(server);
    try {
      assert.equal((await call(port, '/api/v1/registry/agents/donna/purge', 'POST')).status, 200);
      assert.equal(state.policies.has('donna'), false);
      assert.equal(existsSync(join(policiesDir, 'donna.json')), false);
      const [stamp] = readdirSync(join(dir, 'policies-orphaned'));
      assert.ok(existsSync(join(dir, 'policies-orphaned', stamp, 'donna.json')), 'moved, not deleted');
      assert.equal(state.configs.current('donna'), undefined);
      assert.equal(existsSync(join(configDir, 'donna')), false);
      assert.ok(state.configs.current('archie'));
      assert.ok(existsSync(join(policiesDir, 'archie.json')));
      assert.deepEqual(
        ledger.query().filter((e) => e.action === 'POLICY_ORPHAN_ARCHIVED' || e.action === 'CONFIG_REMOVED').map((e) => [e.action, e.agentId, e.actor]),
        [['POLICY_ORPHAN_ARCHIVED', 'donna', 'token:admin'], ['CONFIG_REMOVED', 'donna', 'token:admin']],
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GAP-060 orphan prune on start (S3)', () => {
  function record(agentId: string): ConfigRecord {
    const c = { agentId, source: {}, skills: [], policy: JSON.parse(ORPHAN_POLICY) };
    return { ...c, version: 1, updatedAt: 't', updatedBy: 'migration', reason: 'm', hash: configHash(c) };
  }

  it('removes each orphan prefix with one recursive s3 rm and never touches real agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-s3-'));
    try {
      const { registryDir, policiesDir } = seed(dir);
      const calls: string[][] = [];
      const backend = new S3ConfigBackend('s3://factory-config/config', async (args) => {
        calls.push(args);
        if (args[1] === 'sync') {
          for (const id of [...REAL, ...ORPHANS]) {
            mkdirSync(join(args[3], id), { recursive: true });
            writeFileSync(join(args[3], id, '1.json'), JSON.stringify(record(id)));
          }
        }
        if (args[1] === 'rm' && args[2].includes(ORPHANS[2])) throw new Error('AccessDenied');
        return '';
      });
      const ledger = new MemoryLedger();
      const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
      state.configs = await VersionedConfigStore.open(backend);
      const result = await pruneOrphans(state, { builtinIds: BUILTINS, registry: checkRegistry(registryDir) });

      const rms = calls.filter((a) => a[1] === 'rm');
      assert.deepEqual(
        rms,
        ORPHANS.map((id) => ['s3', 'rm', `s3://factory-config/config/${id}/`, '--recursive', '--only-show-errors']),
      );
      assert.ok(!calls.some((a) => REAL.some((id) => a.join(' ').includes(`/${id}/`))), 'no command names a real agent');
      assert.deepEqual(result.removed, ORPHANS.slice(0, 2));
      assert.deepEqual(result.failed, [ORPHANS[2]], 'a failed removal is reported');
      assert.ok(state.configs.current(ORPHANS[2]), 'and its record stays');
      assert.equal(state.configs.current(ORPHANS[0]), undefined);
      assert.deepEqual(ledger.query().filter((e) => e.action === 'CONFIG_REMOVED').map((e) => e.agentId), ORPHANS.slice(0, 2));
      assert.equal(state.configs.current('archie')?.version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GAP-060 safety: never prune from an incomplete agent list', () => {
  async function refused(mutate: (d: { dir: string; registryDir: string; state: FactoryState }) => void, reason: RegExp) {
    const dir = mkdtempSync(join(tmpdir(), 'cp-orphan-safety-'));
    try {
      const { registryDir, policiesDir } = seed(dir);
      const configDir = join(dir, 'config');
      const ledger = new MemoryLedger();
      const state = baseState(registryDir, ledger, new PolicyStore(policiesDir));
      state.configs = await VersionedConfigStore.open(new FileConfigBackend(configDir));
      for (const id of ORPHANS) await state.configs.put({ agentId: id, source: {}, skills: [], policy: null }, { updatedBy: 'migration', reason: 'm' });
      const before = readdirSync(policiesDir).sort();
      mutate({ dir, registryDir, state });
      const result = await pruneOrphans(state, { builtinIds: BUILTINS, registry: checkRegistry(registryDir) });
      assert.match(result.refused ?? '', reason);
      assert.deepEqual(result.archived, []);
      assert.deepEqual(result.removed, []);
      assert.deepEqual(readdirSync(policiesDir).sort(), before, 'no policy file moved');
      assert.equal(existsSync(join(dir, 'policies-orphaned')), false);
      assert.deepEqual(readdirSync(configDir).sort(), [...ORPHANS].sort(), 'no configuration record removed');
      assert.deepEqual(state.configs.agentIds(), [...ORPHANS].sort());
      assert.equal(ledger.query().length, 0, 'nothing ledgered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('refuses when a registry record cannot be read', async () => {
    await refused(({ registryDir }) => writeFileSync(join(registryDir, 'archie.json'), '{ truncated'), /registry record archie\.json unreadable/);
  });

  it('refuses when a registry record names no agent', async () => {
    await refused(({ registryDir }) => writeFileSync(join(registryDir, 'odd.json'), '{}'), /names no agent/);
  });

  it('refuses when the registry directory cannot be read', async () => {
    await refused(({ registryDir }) => rmSync(registryDir, { recursive: true, force: true }), /registry .* unreadable/);
  });

  it('refuses when nothing beyond the built-ins is known (an empty or unmounted registry)', async () => {
    await refused(({ state }) => { for (const id of REAL) state.agents.delete(id); }, /beyond the built-ins/);
  });

  it('refuses when the known set is empty, smaller than the built-ins, or missing one', () => {
    const ok = { ok: true as const, records: 2 };
    assert.match(pruneRefusal(new Set(), BUILTINS, ok) ?? '', /no agents are known/);
    assert.match(pruneRefusal(new Set(['archie']), BUILTINS, ok) ?? '', /fewer than the/);
    const missing = new Set([...BUILTINS.slice(1), 'archie', 'donna']);
    assert.match(pruneRefusal(missing, BUILTINS, ok) ?? '', new RegExp(`missing from the known set: ${BUILTINS[0]}`));
    assert.equal(pruneRefusal(new Set([...BUILTINS, 'archie']), BUILTINS, ok), undefined);
    assert.match(pruneRefusal(new Set([...BUILTINS, 'archie']), BUILTINS, { ok: false, reason: 'registry gone' }) ?? '', /registry gone/);
  });
});
