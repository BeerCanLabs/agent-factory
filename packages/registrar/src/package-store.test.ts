import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  LocalSkillPackageStore,
  MemorySkillPackageStore,
  S3SkillPackageStore,
  GcsSkillPackageStore,
  skillPackageStoreFromUri,
  type SkillPackageStore,
  type AwsCli,
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
    {
      name: 'S3SkillPackageStore',
      setup: () => {
        const s3Objects = new Map<string, { buf: Buffer; storedAt: string }>();
        const mockCli: AwsCli = async (args) => {
          const cmd = args[1];
          if (cmd === 'put-object') {
            const bucketIdx = args.indexOf('--bucket');
            const keyIdx = args.indexOf('--key');
            const bodyIdx = args.indexOf('--body');
            const key = args[keyIdx + 1];
            if (args.includes('--if-none-match') && s3Objects.has(key)) {
              throw new Error('PreconditionFailed: 412 At least one of the pre-conditions you specified did not hold');
            }
            const bodyFile = args[bodyIdx + 1];
            const buf = readFileSync(bodyFile);
            if (!s3Objects.has(key)) {
              s3Objects.set(key, { buf, storedAt: new Date().toISOString() });
            } else {
              s3Objects.set(key, { buf, storedAt: s3Objects.get(key)!.storedAt });
            }
            return JSON.stringify({ ETag: '"test-etag"' });
          }
          if (cmd === 'get-object') {
            const keyIdx = args.indexOf('--key');
            const key = args[keyIdx + 1];
            const destFile = args[args.length - 1];
            const item = s3Objects.get(key);
            if (!item) {
              const err = new Error('NoSuchKey: The specified key does not exist');
              throw err;
            }
            if (destFile === '/dev/stdout') {
              return item.buf.toString('utf8');
            }
            writeFileSync(destFile, item.buf);
            return '';
          }
          if (cmd === 'head-object') {
            const keyIdx = args.indexOf('--key');
            const key = args[keyIdx + 1];
            const item = s3Objects.get(key);
            if (!item) {
              const err = new Error('NotFound: 404');
              throw err;
            }
            return JSON.stringify({
              ContentLength: item.buf.length,
              LastModified: item.storedAt,
            });
          }
          if (cmd === 'delete-object') {
            const keyIdx = args.indexOf('--key');
            const key = args[keyIdx + 1];
            s3Objects.delete(key);
            return '';
          }
          throw new Error(`unhandled mock S3 command: ${args.join(' ')}`);
        };
        const store = new S3SkillPackageStore('s3://test-bucket/prefix', mockCli);
        return {
          store,
          cleanup: () => s3Objects.clear(),
          tamper: (sha256: string) => {
            const key = `prefix/packages/${sha256}.tar.gz`;
            const existing = s3Objects.get(key);
            s3Objects.set(key, { buf: Buffer.from('tampered S3 bytes'), storedAt: existing?.storedAt ?? new Date().toISOString() });
          },
        };
      },
    },
    {
      name: 'GcsSkillPackageStore',
      setup: () => {
        const gcsObjects = new Map<string, { buf: Buffer; storedAt: string }>();
        const mockFetch: typeof fetch = async (input, init) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
          const url = new URL(urlStr);
          const method = init?.method ?? 'GET';

          if (method === 'POST' && url.pathname.includes('/upload/storage/v1/b/test-bucket/o')) {
            const name = url.searchParams.get('name')!;
            const body = init?.body;
            let buf: Buffer;
            if (Buffer.isBuffer(body)) {
              buf = body;
            } else if (typeof body === 'string') {
              buf = Buffer.from(body);
            } else if (body instanceof Uint8Array) {
              buf = Buffer.from(body);
            } else {
              buf = Buffer.alloc(0);
            }
            if (url.searchParams.get('ifGenerationMatch') === '0' && gcsObjects.has(name)) {
              return new Response('Precondition Failed', { status: 412 });
            }
            if (!gcsObjects.has(name)) {
              gcsObjects.set(name, { buf, storedAt: new Date().toISOString() });
            }
            return new Response(JSON.stringify({ name, size: buf.length }), { status: 200 });
          }

          if (method === 'GET' && url.pathname.includes('/storage/v1/b/test-bucket/o/')) {
            const rawName = url.pathname.slice(url.pathname.indexOf('/o/') + 3);
            const name = decodeURIComponent(rawName);
            const item = gcsObjects.get(name);
            if (!item) {
              return new Response('Not Found', { status: 404 });
            }
            if (url.searchParams.get('alt') === 'media') {
              return new Response(item.buf, { status: 200 });
            }
            return new Response(
              JSON.stringify({
                name,
                size: item.buf.length,
                timeCreated: item.storedAt,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }

          if (method === 'DELETE' && url.pathname.includes('/storage/v1/b/test-bucket/o/')) {
            const rawName = url.pathname.slice(url.pathname.indexOf('/o/') + 3);
            const name = decodeURIComponent(rawName);
            const existed = gcsObjects.delete(name);
            return new Response(null, { status: existed ? 204 : 404 });
          }

          return new Response('Mock Not Found', { status: 404 });
        };

        const store = new GcsSkillPackageStore('gs://test-bucket/prefix', {
          fetch: mockFetch,
          getAccessToken: async () => 'test-token',
        });

        return {
          store,
          cleanup: () => gcsObjects.clear(),
          tamper: (sha256: string) => {
            const key = `prefix/packages/${sha256}.tar.gz`;
            const existing = gcsObjects.get(key);
            gcsObjects.set(key, { buf: Buffer.from('tampered GCS bytes'), storedAt: existing?.storedAt ?? new Date().toISOString() });
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

      it('concurrent put / 412 handling: verifies winner bytes on race condition', async () => {
        const { store, cleanup } = setup();
        try {
          const buf = Buffer.from('concurrent package content');
          const hash = sha256Of(buf);

          const [rec1, rec2] = await Promise.all([
            store.put(hash, buf),
            store.put(hash, buf),
          ]);

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

        const pkgDir = join(tmp, 'packages');
        const readdirSync = (await import('node:fs')).readdirSync;
        let remainingTemp = readdirSync(pkgDir).filter(f => f.startsWith('.tmp-'));
        assert.equal(remainingTemp.length, 0);

        // Inject failure: target path in a non-existent subdirectory causes renameSync to throw
        const buf2 = Buffer.from('another package');
        const hash2 = sha256Of(buf2);
        (store as any).packagePath = () => join(tmp, 'packages', 'nonexistent-dir', `${hash2}.tar.gz`);

        await assert.rejects(
          async () => store.put(hash2, buf2),
          /ENOENT/
        );

        // Verify that temporary file was unlinked and cleaned up
        remainingTemp = readdirSync(pkgDir).filter(f => f.startsWith('.tmp-'));
        assert.equal(remainingTemp.length, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('skillPackageStoreFromUri provider resolution', () => {
    it('creates S3SkillPackageStore for s3:// URIs', () => {
      const store = skillPackageStoreFromUri('s3://my-bucket/custom-prefix', {
        awsCli: async () => '',
      });
      assert.ok(store instanceof S3SkillPackageStore);
      assert.equal(store.description, 's3://my-bucket/custom-prefix/');
    });

    it('creates GcsSkillPackageStore for gs:// and gcs:// URIs', () => {
      const s1 = skillPackageStoreFromUri('gs://my-gcs-bucket/skills', {
        fetch: async () => new Response(''),
        getGcsAccessToken: async () => 'tok',
      });
      assert.ok(s1 instanceof GcsSkillPackageStore);
      assert.equal(s1.description, 'gs://my-gcs-bucket/skills/');

      const s2 = skillPackageStoreFromUri('gcs://my-gcs-bucket-2/skills', {
        fetch: async () => new Response(''),
        getGcsAccessToken: async () => 'tok',
      });
      assert.ok(s2 instanceof GcsSkillPackageStore);
      assert.equal(s2.description, 'gs://my-gcs-bucket-2/skills/');
    });

    it('creates LocalSkillPackageStore for file:// URIs and filesystem paths', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'pkg-from-uri-'));
      try {
        const s1 = skillPackageStoreFromUri(`file://${tmp}`);
        assert.ok(s1 instanceof LocalSkillPackageStore);

        const s2 = skillPackageStoreFromUri(tmp);
        assert.ok(s2 instanceof LocalSkillPackageStore);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
