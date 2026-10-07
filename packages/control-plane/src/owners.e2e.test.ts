// TSK-103 (§6.14 SK3, GAP-088): every agent can name its owners, on its configuration record. An admin sets them; each
// change is a new, ledgered version; a registration, a policy change and a deploy never drop them; the hash of a record
// without owners is what it was before owners existed.
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
import type { DeployProvider } from './aws/deploy.js';
import { FileConfigBackend, VersionedConfigStore, configHash, type ConfigBackend } from '@beercanlabs/factory-registrar';
import { ownersOf } from './config-store.js';

const ADMIN = 'admin-owners-token';
const OPERATOR = 'operator-owners-token';
const VIEWER = 'viewer-owners-token';
const SHA = '1'.repeat(40);
const SHA2 = '2'.repeat(40);

// Pinned on main before owners existed (TSK-103): the hash of a record without owners must never change.
const PIN_FULL = '1c64d12c3c2a68dd0920f2a6044e4ac3db18b703ee884c6a48e79896f78265b6';
const PIN_EMPTY = 'a94a8c50fe90db77b4d57df77277ae1b4b2b0894e73dbae8cb55c91c3f25355d';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function baseState(dir: string, ledger: MemoryLedger): FactoryState {
  return {
    agents: new Map(),
    registryDir: join(dir, 'registry'),
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
    resolveCommit: async () => SHA,
    secretValues: new Set(),
    idleMs: 0,
    idleTimers: new Map(),
  } as unknown as FactoryState;
}

function call(port: number) {
  return async (path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const fakeDeploy: DeployProvider = {
  async buildImage(agentId, source) {
    return `registry.example/${agentId}:${source.commit}`;
  },
  async provisionIdentity(agentId) {
    return { identity: `role/${agentId}` };
  },
  async registerCompute() {},
} as DeployProvider;

describe('agent owners on the configuration record (TSK-103)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let api: ReturnType<typeof call>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-owners-'));
    ledger = new MemoryLedger();
    state = baseState(dir, ledger);
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    state.deployProvider = fakeDeploy;
    cp = createFactoryServer(state);
    port = await listen(cp);
    api = call(port);
    const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA, cartridge: { id: 'ada', name: 'Ada' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the pinned hash of a record without owners is unchanged', () => {
    const full = configHash({ agentId: 'ada', source: { repo: 'https://github.com/x/ada', commit: 'a'.repeat(40) }, skills: [{ id: 's', version: '1' }], policy: { routes: ['models'] } });
    assert.equal(full, PIN_FULL);
    assert.equal(configHash({ agentId: 'ada', source: {}, skills: [], policy: null }), PIN_EMPTY);
    assert.equal(configHash({ agentId: 'ada', source: {}, skills: [], policy: null, owners: undefined }), PIN_EMPTY);
    assert.notEqual(configHash({ agentId: 'ada', source: {}, skills: [], policy: null, owners: ['token:a'] }), PIN_EMPTY);
  });

  it('a new agent has no owners (the record carries none, never [])', async () => {
    assert.deepEqual(ownersOf(state, 'ada'), []);
    assert.deepEqual(ownersOf(state, 'nobody'), []);
    const cfg = await api('/api/v1/agents/ada/config', 'GET', VIEWER);
    assert.equal(cfg.status, 200);
    assert.equal('owners' in cfg.body, false);
  });

  it('an admin sets owners: lower-cased, sorted, unique; a new version, ledgered, returned by the config route', async () => {
    const before = (await api('/api/v1/agents/ada/config', 'GET', VIEWER)).body.version as number;
    const put = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['Cloudflare:Bob@Example.com', 'cloudflare:alice@example.com', 'cloudflare:alice@example.com'] }, { 'x-change-reason': 'bob and alice own ada' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.owners, ['cloudflare:alice@example.com', 'cloudflare:bob@example.com']);
    assert.equal(put.body.version, before + 1);
    assert.equal(put.body.updatedBy, 'token:admin');
    assert.equal(put.body.reason, 'bob and alice own ada');
    const cfg = await api('/api/v1/agents/ada/config', 'GET', VIEWER);
    assert.deepEqual(cfg.body.owners, ['cloudflare:alice@example.com', 'cloudflare:bob@example.com']);
    assert.deepEqual(ownersOf(state, 'ada'), ['cloudflare:alice@example.com', 'cloudflare:bob@example.com']);
    const row = ledger.query({ agent: 'ada' }).filter((e) => e.action === 'CONFIG_VERSIONED').pop();
    assert.equal(row?.requestId, `config:ada:v${before + 1}`);
    assert.equal(row?.payloadSha256, put.body.hash);
    assert.equal(row?.actor, 'token:admin');
    assert.equal(JSON.stringify(row).includes('alice'), false, 'the ledger row holds the hash, not the owners');
  });

  it('replace, same list again (no new version), and clear with []', async () => {
    const v = (await api('/api/v1/agents/ada/config', 'GET', VIEWER)).body.version as number;
    const replaced = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['oidc:carol'] });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.version, v + 1);
    const again = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['oidc:carol'] });
    assert.equal(again.status, 200);
    assert.equal(again.body.version, v + 1, 'an unchanged list is not a new version');
    const cleared = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: [] });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.version, v + 2);
    assert.equal('owners' in cleared.body, false, 'cleared means absent, never []');
    assert.deepEqual(ownersOf(state, 'ada'), []);
    const history = (await api('/api/v1/agents/ada/config/history', 'GET', VIEWER)).body.versions as Array<{ owners?: string[] }>;
    assert.deepEqual(history.at(-2)?.owners, ['oidc:carol']);
  });

  it('owners survive a re-registration, a policy update and a deploy', async () => {
    const owners = ['cloudflare:alice@example.com', 'token:ci'];
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners })).status, 200);
    const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA2, cartridge: { id: 'ada', name: 'Ada' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.deepEqual(ownersOf(state, 'ada'), owners);
    assert.equal((await api('/api/v1/agents/ada/policy', 'PUT', ADMIN, { routes: ['models'] })).status, 200);
    assert.deepEqual(ownersOf(state, 'ada'), owners);
    const deploy = await api('/api/v1/registry/agents/ada/deploy', 'POST', ADMIN, {});
    assert.equal(deploy.status, 202, JSON.stringify(deploy.body));
    assert.deepEqual(ownersOf(state, 'ada'), owners);
    assert.deepEqual((await api('/api/v1/agents/ada/config', 'GET', VIEWER)).body.owners, owners);
    for (let i = 0; i < 100 && state.agents.get('ada')!.state === 'DEPLOYING'; i++) await new Promise((r) => setTimeout(r, 10));
  });

  it('only an admin sets owners: 401 without a credential, 403 for an operator and a viewer', async () => {
    const owners = ['token:x'];
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', undefined, { owners })).status, 401);
    for (const t of [OPERATOR, VIEWER]) {
      const r = await api('/api/v1/agents/ada/owners', 'PUT', t, { owners });
      assert.equal(r.status, 403);
      assert.equal(r.body.required, 'admin');
    }
    assert.notDeepEqual(ownersOf(state, 'ada'), owners);
  });

  it('an invalid list is 400, an unknown agent 404, a reserved id refused', async () => {
    const bad: unknown[] = ['cloudflare:a', [''], ['alice'], ['cloudflare:'], ['mail:alice@example.com'], [1], ['token:a b'], Array.from({ length: 11 }, (_, i) => `token:t${i}`)];
    const before = ownersOf(state, 'ada');
    for (const owners of bad) {
      const r = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners });
      assert.equal(r.status, 400, JSON.stringify(owners));
    }
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, {})).status, 400);
    assert.deepEqual(ownersOf(state, 'ada'), before);
    assert.equal((await api('/api/v1/agents/nope/owners', 'PUT', ADMIN, { owners: ['token:a'] })).status, 404);
    assert.equal((await api('/api/v1/agents/__global__/owners', 'PUT', ADMIN, { owners: ['token:a'] })).status, 400);
    const ten = Array.from({ length: 10 }, (_, i) => `token:t${i}`);
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ten })).status, 200, 'ten owners are allowed');
  });

  it('with no store the route is 503 and ownersOf is empty (fails closed)', async () => {
    const saved = state.configs;
    state.configs = undefined;
    try {
      const r = await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['token:a'] });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'config_store_unavailable');
      assert.deepEqual(ownersOf(state, 'ada'), []);
    } finally {
      state.configs = saved;
    }
  });

  it('a backend that fails is a 500 and the owners are not changed (it must not look stored)', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'cp-owners-fail-'));
    try {
      const inner = new FileConfigBackend(join(dir2, 'config'));
      let failing = false;
      const backend: ConfigBackend = {
        description: inner.description,
        loadAll: () => inner.loadAll(),
        write: (r) => (failing ? Promise.reject(new Error('disk full')) : inner.write(r)),
        remove: (id, m) => inner.remove(id, m),
      };
      const s2 = baseState(dir2, new MemoryLedger());
      s2.configs = await VersionedConfigStore.open(backend);
      const server = createFactoryServer(s2);
      const api2 = call(await listen(server));
      try {
        assert.equal((await api2('/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA, cartridge: { id: 'ada', name: 'Ada' } })).status, 201);
        failing = true;
        const r = await api2('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['token:a'] });
        assert.equal(r.status, 500);
        assert.deepEqual(ownersOf(s2, 'ada'), []);
        assert.equal(s2.ledger.query({ agent: 'ada' }).some((e) => e.action === 'CONFIG_VERSION_FAILED'), false);
      } finally {
        server.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
