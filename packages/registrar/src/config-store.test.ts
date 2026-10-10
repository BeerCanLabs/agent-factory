// TSK-052 (§6.14 SK3, §6.13 R1): the deployment configuration store's backends and versioning.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileConfigBackend,
  S3ConfigBackend,
  VersionedConfigStore,
  canonicalJson,
  configBackendFromEnv,
  adoptionProvenance,
  configHash,
  type ConfigContent,
  type ConfigRecord,
} from './config-store.js';

const SHA = 'a'.repeat(40);
const meta = { updatedBy: 'admin', reason: 'test' };

function content(over: Partial<ConfigContent> = {}): ConfigContent {
  return { agentId: 'ada', source: { repo: 'https://github.com/x/ada', commit: SHA }, skills: [], policy: { routes: ['models'] }, ...over };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'config-store-unit-'));
}

describe('configuration content hash', () => {
  it('is the sha256 of the canonical JSON of the content, independent of key order and metadata', () => {
    const a = configHash(content({ policy: { routes: ['models'], budgetUsd: { perDay: 1, perMonth: 9 } } }));
    const b = configHash({ policy: { budgetUsd: { perMonth: 9, perDay: 1 }, routes: ['models'] }, skills: [], source: { commit: SHA, repo: 'https://github.com/x/ada' }, agentId: 'ada' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    const withMeta = { ...content(), version: 7, updatedAt: 'x', updatedBy: 'y', reason: 'z', hash: 'h' } as ConfigRecord;
    assert.equal(configHash(withMeta), configHash(content()));
    assert.notEqual(configHash(content({ policy: null })), configHash(content()));
    assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } }), '{"a":{"c":[2,1]},"b":1}');
  });
});

describe('filesystem configuration store', () => {
  it('writes each version once, keeps a current pointer and reloads every version', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      const v1 = await store.put(content({ policy: null }), meta);
      const v2 = await store.put(content(), { updatedBy: 'root', reason: 'grant models' });
      assert.equal(v1.created, true);
      assert.equal(v1.record.version, 1);
      assert.equal(v2.record.version, 2);
      assert.equal(v2.record.updatedBy, 'root');
      assert.equal(v2.record.reason, 'grant models');
      assert.equal(v2.record.hash, configHash(content()));

      const same = await store.put(content(), meta);
      assert.equal(same.created, false, 'unchanged content is not a new version');
      assert.equal(same.record.version, 2);

      assert.ok(existsSync(join(dir, 'ada', '1.json')));
      assert.ok(existsSync(join(dir, 'ada', '2.json')));
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ada', 'current.json'), 'utf8')), { agentId: 'ada', version: 2, hash: v2.record.hash });

      const reopened = await VersionedConfigStore.open(new FileConfigBackend(dir));
      assert.deepEqual(reopened.history('ada'), [v1.record, v2.record]);
      assert.deepEqual(reopened.current('ada'), v2.record);
      assert.deepEqual(reopened.version('ada', 1), v1.record);
      assert.equal(reopened.version('ada', 3), undefined);
      const exported = reopened.exportAll();
      assert.equal(exported.store, `file://${dir}`);
      assert.deepEqual(exported.agents, [{ agentId: 'ada', current: 2, versions: [v1.record, v2.record] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing version', async () => {
    const dir = tmp();
    try {
      const backend = new FileConfigBackend(dir);
      const record: ConfigRecord = { ...content(), version: 1, updatedAt: 'now', updatedBy: 'a', reason: 'r', hash: configHash(content()) };
      await backend.write(record);
      await assert.rejects(backend.write({ ...record, reason: 'rewrite' }), /EEXIST/);
      assert.equal(JSON.parse(readFileSync(join(dir, 'ada', '1.json'), 'utf8')).reason, 'r');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assigns versions in order under concurrent writes', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      const out = await Promise.all([1, 2, 3].map((n) => store.put(content({ policy: { routes: [`r${n}`] } }), meta)));
      assert.deepEqual(out.map((o) => o.record.version), [1, 2, 3]);
      assert.deepEqual(store.history('ada').map((r) => r.policy?.routes[0]), ['r1', 'r2', 'r3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an agent id that cannot name a record, and a failed write leaves memory unchanged', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      await assert.rejects(store.put(content({ agentId: '../escape' }), meta), /cannot name a configuration record/);
      const failing = await VersionedConfigStore.open({ description: 'broken', loadAll: async () => [], write: async () => { throw new Error('disk full'); }, remove: async () => undefined });
      await assert.rejects(failing.put(content(), meta), /disk full/);
      assert.equal(failing.current('ada'), undefined);
      await assert.rejects(failing.put(content(), meta), /disk full/, 'a failed write does not wedge the queue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S3 configuration store (AWS CLI, no SDK)', () => {
  it('puts each version with a conditional write, then the current pointer', async () => {
    const calls: string[][] = [];
    const bodies: string[] = [];
    const backend = new S3ConfigBackend('s3://factory-config/config/', async (args) => {
      calls.push(args);
      const i = args.indexOf('--body');
      if (i >= 0) bodies.push(readFileSync(args[i + 1], 'utf8'));
      return '';
    });
    const store = await VersionedConfigStore.open({ description: backend.description, loadAll: async () => [], write: (r) => backend.write(r), remove: (id, m) => backend.remove(id, m) });
    const { record } = await store.put(content(), meta);

    assert.equal(calls.length, 2);
    const bodyArg = (args: string[]) => args.map((a, i) => (args[i - 1] === '--body' ? '<file>' : a));
    assert.deepEqual(bodyArg(calls[0]), [
      's3api', 'put-object',
      '--bucket', 'factory-config',
      '--key', 'config/ada/1.json',
      '--body', '<file>',
      '--content-type', 'application/json',
      '--checksum-algorithm', 'SHA256',
      '--if-none-match', '*',
    ]);
    assert.deepEqual(bodyArg(calls[1]), [
      's3api', 'put-object',
      '--bucket', 'factory-config',
      '--key', 'config/ada/current.json',
      '--body', '<file>',
      '--content-type', 'application/json',
      '--checksum-algorithm', 'SHA256',
    ]);
    assert.deepEqual(JSON.parse(bodies[0]), record);
    assert.deepEqual(JSON.parse(bodies[1]), { agentId: 'ada', version: 1, hash: record.hash });
    assert.equal(backend.description, 's3://factory-config/config/');
  });

  it('loads every version with one sync of the prefix', async () => {
    const calls: string[][] = [];
    const v1: ConfigRecord = { ...content({ policy: null }), version: 1, updatedAt: 't1', updatedBy: 'migration', reason: 'm', hash: configHash(content({ policy: null })) };
    const v2: ConfigRecord = { ...content(), version: 2, updatedAt: 't2', updatedBy: 'admin', reason: 'p', hash: configHash(content()) };
    let dest = '';
    const backend = new S3ConfigBackend('s3://factory-config', async (args) => {
      calls.push(args);
      dest = args[3];
      mkdirSync(join(dest, 'ada'), { recursive: true });
      writeFileSync(join(dest, 'ada', '1.json'), JSON.stringify(v1));
      writeFileSync(join(dest, 'ada', '2.json'), JSON.stringify(v2));
      writeFileSync(join(dest, 'ada', 'current.json'), JSON.stringify({ agentId: 'ada', version: 2, hash: v2.hash }));
      return '';
    });
    const store = await VersionedConfigStore.open(backend);
    assert.deepEqual(calls, [['s3', 'sync', 's3://factory-config/', dest, '--only-show-errors', '--no-progress']]);
    assert.deepEqual(store.history('ada'), [v1, v2]);
    assert.equal(existsSync(dest), false, 'the scratch copy is removed');
  });

  it('a failed put is raised and the version is not recorded', async () => {
    const backend = new S3ConfigBackend('s3://factory-config/config', async (args) => {
      if (args.includes('--if-none-match')) throw new Error('PreconditionFailed');
      return '';
    });
    const store = await VersionedConfigStore.open({ description: backend.description, loadAll: async () => [], write: (r) => backend.write(r), remove: (id, m) => backend.remove(id, m) });
    await assert.rejects(store.put(content(), meta), /PreconditionFailed/);
    assert.equal(store.current('ada'), undefined);
  });
});

describe('FACTORY_CONFIG_STORE_URI', () => {
  it('selects S3, a file URI, a path, or the default directory', () => {
    assert.ok(configBackendFromEnv('s3://b/p', '/d') instanceof S3ConfigBackend);
    assert.equal(configBackendFromEnv('file:///data/config', '/d').description, 'file:///data/config');
    assert.equal(configBackendFromEnv('/data/config', '/d').description, 'file:///data/config');
    assert.equal(configBackendFromEnv(undefined, '/d').description, 'file:///d');
    assert.equal(configBackendFromEnv('  ', '/d').description, 'file:///d');
    assert.throws(() => configBackendFromEnv('gs://b/p', '/d'), /must be s3:\/\/, file:\/\/ or a path/);
  });
});

// TSK-157 (§6.14 SK3): adoption provenance sits beside the version and outside the content hash.
describe('adoption provenance', () => {
  const adopt = { id: 'tavily-search', version: '0.1.0' };
  const prov = { id: 'tavily-search', version: '0.1.0', requestedBy: 'token:ops', requestedAt: '2026-10-10T01:00:00.000Z', approvedBy: 'cloudflare:dale@example.com', approvedAt: '2026-10-10T02:00:00.000Z' };

  // Computed from `configHash` before this change; a record that exists on main must keep hashing to the same bytes.
  it('does not change the hash of any configuration: pinned vectors', () => {
    assert.equal(configHash(content()), '77b2d0c39432d64a2a8d6e9428ddf05ab507839cefb8c593ea2949636b0fbc24');
    assert.equal(configHash(content({ skills: [adopt] })), 'a9f2a5df1ed989014b3e8b2fe6259c744e89228930f2b542374772d7adc2758c');
    assert.equal(configHash(content({ skills: [adopt], owners: ['cloudflare:dale@example.com'] })), '198333ca69d8940f3310371028db474c9b8da23a4da079eccac267273c353cdb');
    const withProvenance = { ...content({ skills: [adopt] }), version: 2, updatedAt: 'x', updatedBy: 'y', reason: 'z', skillAdoptions: [prov], hash: 'h' } as ConfigRecord;
    assert.equal(configHash(withProvenance), configHash(content({ skills: [adopt] })));
  });

  it('is stored beside the version, survives a reload and gives the same hash with or without it', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      await store.put(content(), meta);
      const v2 = await store.put(content({ skills: [adopt] }), { ...meta, skillAdoptions: [prov] });
      assert.equal(v2.created, true);
      assert.deepEqual(v2.record.skillAdoptions, [prov]);
      assert.equal(v2.record.hash, configHash(content({ skills: [adopt] })));
      const again = await VersionedConfigStore.open(new FileConfigBackend(dir));
      assert.deepEqual(again.current('ada')!.skillAdoptions, [prov]);
      assert.equal(again.history('ada')[0].skillAdoptions, undefined);
      assert.deepEqual(adoptionProvenance(again, 'ada', 'tavily-search'), prov);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses provenance for an adoption the configuration does not carry', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      await assert.rejects(store.put(content(), { ...meta, skillAdoptions: [prov] }), /does not adopt it/);
      await assert.rejects(store.put(content({ skills: [{ id: 'tavily-search', version: '0.2.0' }] }), { ...meta, skillAdoptions: [prov] }), /does not adopt it/);
      assert.equal(store.current('ada'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the provenance of the version now adopted, through later versions that changed something else', async () => {
    const dir = tmp();
    try {
      const store = await VersionedConfigStore.open(new FileConfigBackend(dir));
      assert.equal(adoptionProvenance(store, 'ada', 'tavily-search'), undefined);
      await store.put(content({ skills: [adopt] }), { ...meta, skillAdoptions: [prov] });
      await store.put(content({ skills: [adopt], policy: { routes: ['models', 'tavily'] } }), meta);
      assert.deepEqual(adoptionProvenance(store, 'ada', 'tavily-search'), prov);
      const up = { id: 'tavily-search', version: '0.2.0' };
      await store.put(content({ skills: [up], policy: { routes: ['models', 'tavily'] } }), meta);
      assert.equal(adoptionProvenance(store, 'ada', 'tavily-search'), undefined, 'adopted before provenance was recorded for this version');
      assert.equal(adoptionProvenance(store, 'ada', 'other'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
