import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FileSkillPackageStore, MemorySkillPackageStore } from './package-store.js';

describe('SkillPackageStore provider abstraction (A21)', () => {
  it('MemorySkillPackageStore stores, retrieves, checks existence, and deletes', async () => {
    const store = new MemorySkillPackageStore();
    const hash = 'a'.repeat(64);
    const content = Buffer.from('package bytes');

    assert.equal(await store.has(hash), false);
    assert.equal(await store.get(hash), null);

    await store.put(hash, content);
    assert.equal(await store.has(hash), true);
    assert.deepEqual(await store.get(hash), content);

    await store.delete(hash);
    assert.equal(await store.has(hash), false);
    assert.equal(await store.get(hash), null);
  });

  it('FileSkillPackageStore persists to disk, reads back, and handles removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-store-test-'));
    try {
      const store = new FileSkillPackageStore(dir);
      const hash = 'b'.repeat(64);
      const content = Buffer.from('gzipped package content');

      assert.equal(await store.has(hash), false);
      await store.put(hash, content);

      assert.equal(await store.has(hash), true);
      const retrieved = await store.get(hash);
      assert.deepEqual(retrieved, content);

      // Reopening another instance on the same directory sees the file
      const store2 = new FileSkillPackageStore(dir);
      assert.equal(await store2.has(hash), true);
      assert.deepEqual(await store2.get(hash), content);

      await store2.delete(hash);
      assert.equal(await store2.has(hash), false);
      assert.equal(await store.has(hash), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
