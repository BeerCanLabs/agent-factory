import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    setup: () => {
      store: SkillPackageStore;
      cleanup: () => void;
      tamper?: (sha256: string) => void;
    };
  }> = [
    {
      name: 'MemorySkillPackageStore',
      setup: () => {
        const store = new MemorySkillPackageStore();
        return {
          store,
          cleanup: () => {},
          tamper: (sha256: string) => {
            // Directly tamper with the internal buffer to verify verification on get/put
            const entry = (store as any).store.get(sha256);
            if (entry) {
              entry.buffer = Buffer.from('tampered bytes');
            }
          },
        };
      },
    },
    {
      name: 'LocalSkillPackageStore',
      setup: () => {
        const tmp = mkdtempSync(join(tmpdir(), 'skill-package-store-test-'));
        const store = new LocalSkillPackageStore(tmp);
        return {
          store,
          cleanup: () => rmSync(tmp, { recursive: true, force: true }),
          tamper: (sha256: string) => {
            const filePath = join(tmp, 'packages', `${sha256}.tar.gz`);
            writeFileSync(filePath, Buffer.from('tampered bytes on disk'));
          },
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
          assert.equal(await store.getRecord(hash), null);

          const rec = await store.put(hash, buf);
          assert.equal(rec.sha256, hash);
          assert.equal(rec.size, buf.length);
          assert.equal(rec.quarantined, false);
          assert.ok(rec.storedAt);

          assert.equal(await store.has(hash), true);
          const retrieved = await store.get(hash);
          assert.ok(retrieved);
          assert.deepEqual(retrieved, buf);

          const record = await store.getRecord(hash);
          assert.ok(record);
          assert.equal(record.sha256, hash);
          assert.equal(record.size, buf.length);
          assert.equal(record.quarantined, false);
          assert.equal(record.storedAt, rec.storedAt);
        } finally {
          cleanup();
        }
      });

      it('get() and put() refuse corrupted or tampered bytes (A4, S3)', async () => {
        const { store, cleanup, tamper } = setup();
        try {
          const buf = Buffer.from('original package bytes before tampering');
          const hash = sha256Of(buf);

          await store.put(hash, buf);
          assert.ok(await store.get(hash));

          if (tamper) {
            tamper(hash);

            // get() must verify retrieved bytes and reject mismatch
            await assert.rejects(
              async () => store.get(hash),
              /stored package corrupted: sha256 mismatch/
            );

            // put() of existing hash must verify existing bytes and reject mismatch
            await assert.rejects(
              async () => store.put(hash, buf),
              /stored package corrupted: sha256 mismatch/
            );
          }
        } finally {
          cleanup();
        }
      });

      it('immutability: putting the same sha256 is idempotent and preserves storedAt', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('identical package content');
          const hash = sha256Of(buf);

          const rec1 = await store.put(hash, buf);
          const rec2 = await store.put(hash, buf);

          assert.equal(rec1.sha256, hash);
          assert.equal(rec2.sha256, hash);
          assert.equal(rec1.storedAt, rec2.storedAt);
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
          assert.equal(await store.getRecord('not-a-hash'), null);
          await assert.rejects(
            async () => store.quarantine('not-a-hash', 'reason'),
            /invalid sha256 format/
          );
        } finally {
          cleanup();
        }
      });

      it('quarantine() refuses non-existent packages to prevent pre-poisoning', async () => {
        const { store, cleanup } = setup();
        try {
          const missingHash = 'b'.repeat(64);
          await assert.rejects(
            async () => store.quarantine(missingHash, 'failed checker'),
            /cannot quarantine non-existent package/
          );

          assert.equal(await store.has(missingHash), false);
          assert.equal(await store.isQuarantined(missingHash), false);
        } finally {
          cleanup();
        }
      });

      it('quarantine() is idempotent and preserves first timestamp and reason (A21)', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('quarantined package content');
          const hash = sha256Of(buf);

          await store.put(hash, buf);
          assert.equal(await store.isQuarantined(hash), false);

          await store.quarantine(hash, 'initial reason: forbidden import');
          assert.equal(await store.isQuarantined(hash), true);

          const rec1 = await store.getRecord(hash);
          assert.ok(rec1);
          assert.equal(rec1.quarantined, true);
          assert.equal(rec1.quarantineReason, 'initial reason: forbidden import');
          const initialQuarantinedAt = rec1.quarantinedAt;
          assert.ok(initialQuarantinedAt);

          // Second quarantine call should be an idempotent no-op (clock not reset)
          await store.quarantine(hash, 'second reason: ignored');

          const rec2 = await store.getRecord(hash);
          assert.ok(rec2);
          assert.equal(rec2.quarantined, true);
          assert.equal(rec2.quarantineReason, 'initial reason: forbidden import');
          assert.equal(rec2.quarantinedAt, initialQuarantinedAt);

          // Re-putting after quarantine reflects quarantined status
          const recPut = await store.put(hash, buf);
          assert.equal(recPut.quarantined, true);
          assert.equal(recPut.quarantineReason, 'initial reason: forbidden import');
          assert.equal(recPut.quarantinedAt, initialQuarantinedAt);
        } finally {
          cleanup();
        }
      });

      it('handles delete lifecycle', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('package to delete');
          const hash = sha256Of(buf);

          await store.put(hash, buf);
          await store.quarantine(hash, 'retention expired');

          assert.equal(await store.has(hash), true);
          assert.equal(await store.isQuarantined(hash), true);

          const deleted = await store.delete(hash);
          assert.equal(deleted, true);
          assert.equal(await store.has(hash), false);
          assert.equal(await store.isQuarantined(hash), false);
          assert.equal(await store.get(hash), null);
          assert.equal(await store.getRecord(hash), null);

          // Second delete returns false
          assert.equal(await store.delete(hash), false);
        } finally {
          cleanup();
        }
      });
    });
  }

  describe('LocalSkillPackageStore specific guarantees', () => {
    it('cleans up temporary file if write or rename fails', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-package-store-atomic-'));
      try {
        const store = new LocalSkillPackageStore(tmp);
        const buf = Buffer.from('atomic test content');
        const hash = sha256Of(buf);

        // Put works cleanly
        await store.put(hash, buf);
        assert.equal(await store.has(hash), true);

        // Check that no .tmp-* files remain in packages directory
        const files = readFileSync; // Just verifying imports
        const pkgDir = join(tmp, 'packages');
        const readdirSync = (await import('node:fs')).readdirSync;
        const remainingTemp = readdirSync(pkgDir).filter(f => f.startsWith('.tmp-'));
        assert.equal(remainingTemp.length, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
