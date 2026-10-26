import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  LocalSkillPackageStore,
  MemorySkillPackageStore,
  type SkillPackageStore,
} from './package-store.js';

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('SkillPackageStore Provider Abstraction & Immutability (A4, A21, S3)', () => {
  const implementations: Array<{
    name: string;
    setup: () => { store: SkillPackageStore; cleanup: () => void };
  }> = [
    {
      name: 'MemorySkillPackageStore',
      setup: () => ({ store: new MemorySkillPackageStore(), cleanup: () => {} }),
    },
    {
      name: 'LocalSkillPackageStore',
      setup: () => {
        const tmp = mkdtempSync(join(tmpdir(), 'skill-package-store-test-'));
        const store = new LocalSkillPackageStore(tmp);
        return {
          store,
          cleanup: () => rmSync(tmp, { recursive: true, force: true }),
        };
      },
    },
  ];

  for (const { name, setup } of implementations) {
    describe(name, () => {
      it('stores a package by its sha256 and retrieves identical bytes', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('test package content 123');
          const hash = sha256Of(buf);

          assert.equal(await store.has(hash), false);
          assert.equal(await store.get(hash), null);

          const rec = await store.put(hash, buf);
          assert.equal(rec.sha256, hash);
          assert.equal(rec.size, buf.length);
          assert.equal(rec.quarantined, false);

          assert.equal(await store.has(hash), true);
          const retrieved = await store.get(hash);
          assert.ok(retrieved);
          assert.deepEqual(retrieved, buf);
        } finally {
          cleanup();
        }
      });

      it('immutability: putting the same sha256 is idempotent', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('identical package content');
          const hash = sha256Of(buf);

          const rec1 = await store.put(hash, buf);
          const rec2 = await store.put(hash, buf);

          assert.equal(rec1.sha256, hash);
          assert.equal(rec2.sha256, hash);
          assert.equal(await store.has(hash), true);
        } finally {
          cleanup();
        }
      });

      it('enforces content addressing: rejects buffer when sha256 does not match', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('actual content');
          const wrongHash = 'a'.repeat(64);

          await assert.rejects(
            async () => store.put(wrongHash, buf),
            /package buffer sha256 mismatch/
          );
        } finally {
          cleanup();
        }
      });

      it('rejects malformed sha256 format', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('content');
          await assert.rejects(
            async () => store.put('not-a-hash', buf),
            /invalid sha256 format/
          );

          assert.equal(await store.get('not-a-hash'), null);
          assert.equal(await store.has('not-a-hash'), false);
        } finally {
          cleanup();
        }
      });

      it('handles quarantine lifecycle (A21)', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('quarantined package content');
          const hash = sha256Of(buf);

          await store.put(hash, buf);
          assert.equal(await store.isQuarantined(hash), false);

          await store.quarantine(hash, 'secrets check failed');
          assert.equal(await store.isQuarantined(hash), true);

          // Package buffer is still retrievable by checker/admin (A21)
          const retrieved = await store.get(hash);
          assert.ok(retrieved);
          assert.deepEqual(retrieved, buf);

          // Delete package after retention expires
          const deleted = await store.delete(hash);
          assert.equal(deleted, true);
          assert.equal(await store.has(hash), false);
          assert.equal(await store.isQuarantined(hash), false);
        } finally {
          cleanup();
        }
      });
    });
  }
});
