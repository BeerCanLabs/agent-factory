// loadSkills must honor FACTORY_SKILL_PACKAGES_URI, and leftover local packages are copied into that store.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillManifest } from '@beercanlabs/factory-contract';
import {
  LocalSkillPackageStore,
  S3SkillPackageStore,
  type SkillVersionRecord,
} from '@beercanlabs/factory-registrar';
import {
  backfillMissingSkillPackages,
  ensurePackageInStore,
  loadSkills,
  skillPackageStore,
  skillRegistry,
} from './skills.js';
import type { FactoryState } from './app.js';

const savedUri = process.env.FACTORY_SKILL_PACKAGES_URI;

afterEach(() => {
  if (savedUri === undefined) delete process.env.FACTORY_SKILL_PACKAGES_URI;
  else process.env.FACTORY_SKILL_PACKAGES_URI = savedUri;
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'skill-pkg-uri-'));
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const manifest = (id: string, version: string): SkillManifest =>
  ({
    id,
    version,
    name: id,
    description: 'Test skill package.',
    language: 'node',
    entry: 'src/index.ts',
    requires: { routes: [], connections: [], credentials: [], models: [] },
  }) as unknown as SkillManifest;

function versionRecord(id: string, version: string, packageHash: string): SkillVersionRecord {
  return {
    id,
    version,
    repo: '',
    path: '.',
    commit: packageHash,
    packageHash,
    manifest: manifest(id, version),
    status: 'pending',
    tests: 'pending-build',
    registeredBy: 'user:dale.sackrider',
    registeredAt: '2026-11-17T21:06:00.000Z',
  };
}

describe('skill package store follows FACTORY_SKILL_PACKAGES_URI', () => {
  it('loadSkills uses the S3 store when the URI is set, not the local volume', () => {
    const root = tmpRoot();
    try {
      process.env.FACTORY_SKILL_PACKAGES_URI = 's3://agent-factory-packages-prod-test/packages';
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      const store = skillPackageStore(state);
      assert.equal(store instanceof S3SkillPackageStore, true);
      assert.equal(store instanceof LocalSkillPackageStore, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loadSkills uses the local volume when no URI is set', () => {
    const root = tmpRoot();
    const prev = process.env.FACTORY_SKILL_PACKAGES_URI;
    try {
      delete process.env.FACTORY_SKILL_PACKAGES_URI;
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      const store = skillPackageStore(state);
      assert.equal(store instanceof LocalSkillPackageStore, true);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_SKILL_PACKAGES_URI;
      else process.env.FACTORY_SKILL_PACKAGES_URI = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a put after loadSkills lands in the URI store, not only the leftover local dir', async () => {
    const root = tmpRoot();
    const remoteDir = join(root, 'remote');
    const localDir = join(root, 'skill-packages');
    try {
      process.env.FACTORY_SKILL_PACKAGES_URI = remoteDir;
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      const buf = Buffer.from('pack-bytes-for-uri-put');
      const hash = shaOf(buf);
      await skillPackageStore(state).put(hash, buf);
      assert.equal(await skillPackageStore(state).has(hash), true);
      assert.equal(await new LocalSkillPackageStore(localDir).has(hash), false);
      assert.deepEqual(await skillPackageStore(state).get(hash), buf);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfill copies a registered package from the local volume into the URI store', async () => {
    const root = tmpRoot();
    const remoteDir = join(root, 'remote');
    const localDir = join(root, 'skill-packages');
    try {
      const buf = Buffer.from('leftover-package-on-efs');
      const hash = shaOf(buf);
      await new LocalSkillPackageStore(localDir).put(hash, buf);

      process.env.FACTORY_SKILL_PACKAGES_URI = remoteDir;
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      skillRegistry(state).save(versionRecord('cloud-billing', '1.1.0', hash));

      assert.equal(await skillPackageStore(state).has(hash), false);
      assert.equal(await backfillMissingSkillPackages(state), 1);
      assert.equal(await skillPackageStore(state).has(hash), true);
      assert.deepEqual(await skillPackageStore(state).get(hash), buf);
      // A second pass is a no-op.
      assert.equal(await backfillMissingSkillPackages(state), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensurePackageInStore copies one leftover hash and leaves others alone', async () => {
    const root = tmpRoot();
    const remoteDir = join(root, 'remote');
    const localDir = join(root, 'skill-packages');
    try {
      const keep = Buffer.from('already-on-remote');
      const keepHash = shaOf(keep);
      const missing = Buffer.from('only-on-local');
      const missingHash = shaOf(missing);
      await new LocalSkillPackageStore(localDir).put(keepHash, keep);
      await new LocalSkillPackageStore(localDir).put(missingHash, missing);

      process.env.FACTORY_SKILL_PACKAGES_URI = remoteDir;
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      await skillPackageStore(state).put(keepHash, keep);

      assert.equal(await ensurePackageInStore(state, keepHash), false);
      assert.equal(await ensurePackageInStore(state, missingHash), true);
      assert.deepEqual(await skillPackageStore(state).get(missingHash), missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfill is a no-op when FACTORY_SKILL_PACKAGES_URI is unset', async () => {
    const root = tmpRoot();
    const prev = process.env.FACTORY_SKILL_PACKAGES_URI;
    try {
      delete process.env.FACTORY_SKILL_PACKAGES_URI;
      const state = {} as FactoryState;
      loadSkills(state, join(root, 'skills'));
      assert.equal(await backfillMissingSkillPackages(state), 0);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_SKILL_PACKAGES_URI;
      else process.env.FACTORY_SKILL_PACKAGES_URI = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
