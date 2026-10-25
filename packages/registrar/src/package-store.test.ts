import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FileSkillPackageStore, MemorySkillPackageStore } from './package-store.js';

describe('SkillPackageStore provider abstraction (A21, A4)', () => {
  it('MemorySkillPackageStore stores, retrieves, checks existence, and deletes', async () => {
    const store = new MemorySkillPackageStore();
    const content = Buffer.from('package bytes');
    const hash = createHash('sha256').update(content).digest('hex');

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
      const content = Buffer.from('gzipped package content');
      const hash = createHash('sha256').update(content).digest('hex');

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

  it('refuses invalid hash formats (A4)', async () => {
    const store = new MemorySkillPackageStore();
    const content = Buffer.from('hello');

    // Not 64 hex characters
    await assert.rejects(async () => {
      await store.put('short-hash', content);
    }, /invalid package hash/);

    await assert.rejects(async () => {
      await store.get('not-hex-'.repeat(8));
    }, /invalid package hash/);
  });

  it('refuses hash mismatch on put (A4, A21)', async () => {
    const store = new MemorySkillPackageStore();
    const content = Buffer.from('hello');
    const wrongHash = 'f'.repeat(64);

    await assert.rejects(async () => {
      await store.put(wrongHash, content);
    }, /package hash mismatch/);
  });

  it('enforces immutability: write-once without overwriting (A4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-store-immutability-'));
    try {
      const store = new FileSkillPackageStore(dir);
      const content = Buffer.from('original package');
      const hash = createHash('sha256').update(content).digest('hex');

      await store.put(hash, content);
      assert.equal(await store.has(hash), true);

      // Idempotent re-put of identical content
      await store.put(hash, content);
      assert.deepEqual(await store.get(hash), content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
