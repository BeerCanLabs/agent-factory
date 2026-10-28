import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTEBOOK_ROTATION, notebookEnv, pullMind, pullVolume, pushMind, staleSidecars } from './index.js';
import { main, serveVolumeRequests } from './shim.js';
import { existsSync } from 'node:fs';

describe('hydrate', () => {
  it('rehydrates after ephemeral disk is destroyed', () => {
    const root = mkdtempSync(join(tmpdir(), 'mind-'));
    const store = { root: join(root, 'object') };
    const ephemeral = join(root, 'ephemeral');
    mkdirSync(ephemeral, { recursive: true });
    writeFileSync(join(ephemeral, 'note.md'), 'remembered');
    pushMind(store, 'echo-agent', ephemeral);
    rmSync(ephemeral, { recursive: true, force: true });
    pullMind(store, 'echo-agent', ephemeral);
    assert.equal(readFileSync(join(ephemeral, 'note.md'), 'utf8'), 'remembered');
    rmSync(root, { recursive: true });
  });

  it('invokes gcloud storage rsync for gcs:// and gs:// stores', () => {
    const executed: Array<{ cmd: string; args: string[] }> = [];
    const syncMock = (cmd: string, args: string[]) => {
      executed.push({ cmd, args });
    };

    const gcsStore = { root: '/tmp', uri: 'gcs://my-bucket' };
    pullMind(gcsStore, 'test-agent', '/tmp/dest', syncMock);
    assert.deepEqual(executed[0], {
      cmd: 'gcloud',
      args: ['storage', 'rsync', '-r', '-x', '^(volumes|.volume-requests)/', 'gs://my-bucket/test-agent', '/tmp/dest'],
    });

    const root = mkdtempSync(join(tmpdir(), 'gcs-push-'));
    writeFileSync(join(root, 'state.json'), '{}');
    pushMind(gcsStore, 'test-agent', root, syncMock);
    assert.deepEqual(executed[1], {
      cmd: 'gcloud',
      args: ['storage', 'rsync', '-r', root, 'gs://my-bucket/test-agent'],
    });
    rmSync(root, { recursive: true });
  });

  it('pushes and pulls mind over native GCS JSON API without gcloud binary', async () => {
    const { Worker } = await import('node:worker_threads');
    const workerScript = `
      const http = require('node:http');
      const { parentPort } = require('node:worker_threads');
      const objects = new Map();

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'POST' && url.pathname === '/upload/storage/v1/b/mind-bucket/o') {
          const name = url.searchParams.get('name') ?? '';
          const chunks = [];
          req.on('data', (c) => chunks.push(Buffer.from(c)));
          req.on('end', () => {
            objects.set(name, Buffer.concat(chunks));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name }));
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/storage/v1/b/mind-bucket/o') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const items = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items }));
          return;
        }
        const dlMatch = url.pathname.match(/^\\/storage\\/v1\\/b\\/mind-bucket\\/o\\/(.+)$/);
        if (req.method === 'DELETE' && dlMatch) {
          const existed = objects.delete(decodeURIComponent(dlMatch[1]));
          res.writeHead(existed ? 204 : 404);
          res.end();
          return;
        }
        if (req.method === 'GET' && dlMatch && url.searchParams.get('alt') === 'media') {
          const name = decodeURIComponent(dlMatch[1]);
          const data = objects.get(name);
          if (!data) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(data);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.listen(0, '127.0.0.1', () => {
        parentPort.postMessage({ type: 'ready', port: server.address().port });
      });

      parentPort.on('message', (msg) => {
        if (msg.type === 'has') {
          parentPort.postMessage({ type: 'hasResult', key: msg.key, result: objects.has(msg.key) });
        } else if (msg.type === 'stop') {
          server.close(() => process.exit(0));
        }
      });
    `;

    const worker = new Worker(workerScript, { eval: true });
    const port = await new Promise<number>((resolve) => {
      worker.on('message', function onReady(msg: any) {
        if (msg?.type === 'ready') {
          worker.off('message', onReady);
          resolve(msg.port);
        }
      });
    });

    const checkHas = (key: string) =>
      new Promise<boolean>((resolve) => {
        const handler = (msg: any) => {
          if (msg?.type === 'hasResult' && msg.key === key) {
            worker.off('message', handler);
            resolve(msg.result);
          }
        };
        worker.on('message', handler);
        worker.postMessage({ type: 'has', key });
      });

    const savedEndpoint = process.env.GCS_API_ENDPOINT;
    const savedToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    process.env.GCS_API_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'test-gcs-token';
    const root = mkdtempSync(join(tmpdir(), 'gcs-native-'));
    try {
      const srcDir = join(root, 'src');
      const dstDir = join(root, 'dst');
      mkdirSync(join(srcDir, 'sub'), { recursive: true });
      writeFileSync(join(srcDir, 'sub', 'memory.db'), 'sqlite-bytes');
      const store = { root: '', uri: 'gcs://mind-bucket' };
      pushMind(store, 'agent-1', srcDir);
      assert.equal(await checkHas('agent-1/sub/memory.db'), true);
      pullMind(store, 'agent-1', dstDir);
      assert.equal(readFileSync(join(dstDir, 'sub', 'memory.db'), 'utf8'), 'sqlite-bytes');

      // A database's write-ahead log leaves the store once the run no longer has it (a clean close removes it).
      writeFileSync(join(srcDir, 'notes.db'), SQLITE_HEADER);
      writeFileSync(join(srcDir, 'notes.db-wal'), 'frames');
      pushMind(store, 'agent-1', srcDir);
      assert.equal(await checkHas('agent-1/notes.db-wal'), true);
      rmSync(join(srcDir, 'notes.db-wal'));
      pushMind(store, 'agent-1', srcDir);
      assert.equal(await checkHas('agent-1/notes.db-wal'), false);
      assert.equal(await checkHas('agent-1/notes.db'), true);
      assert.equal(await checkHas('agent-1/sub/memory.db'), true);
    } finally {
      if (savedEndpoint === undefined) delete process.env.GCS_API_ENDPOINT;
      else process.env.GCS_API_ENDPOINT = savedEndpoint;
      if (savedToken === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
      else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = savedToken;
      worker.postMessage({ type: 'stop' });
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  });
});


const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(84)]);

describe('a stale SQLite journal never outlives its database in the store', () => {
  it('names only the missing journals of SQLite databases, outside closed volumes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecars-'));
    try {
      writeFileSync(join(dir, 'state.db'), SQLITE_HEADER);
      writeFileSync(join(dir, 'open.db'), SQLITE_HEADER);
      writeFileSync(join(dir, 'open.db-wal'), 'frames');
      writeFileSync(join(dir, 'open.db-shm'), 'index');
      writeFileSync(join(dir, 'notes.md'), 'not a database');
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'nested', 'inner.sqlite'), SQLITE_HEADER);
      mkdirSync(join(dir, 'volumes', 'v1'), { recursive: true });
      writeFileSync(join(dir, 'volumes', 'v1', 'state.db'), SQLITE_HEADER);
      assert.deepEqual(staleSidecars(join(dir, 'absent')), []);
      assert.deepEqual(staleSidecars(dir).sort(), [
        'nested/inner.sqlite-journal', 'nested/inner.sqlite-shm', 'nested/inner.sqlite-wal',
        'open.db-journal',
        'state.db-journal', 'state.db-shm', 'state.db-wal',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S3 and GCS pushes delete exactly the stale journals, before uploading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecars-push-'));
    try {
      writeFileSync(join(dir, 'state.db'), SQLITE_HEADER);
      writeFileSync(join(dir, 'state.db-wal'), 'frames');
      const executed: Array<{ cmd: string; args: string[] }> = [];
      const sync = (cmd: string, args: string[]) => void executed.push({ cmd, args });
      pushMind({ root: '', uri: 's3://bucket' }, 'agent', dir, sync);
      pushMind({ root: '', uri: 'gcs://bucket' }, 'agent', dir, sync);
      // Deleted before the upload: a newer database is never in the store beside a stale journal.
      assert.deepEqual(executed, [
        { cmd: 'aws', args: ['s3', 'sync', dir, 's3://bucket/agent', '--delete', '--exclude', '*', '--include', 'state.db-shm', '--include', 'state.db-journal'] },
        { cmd: 'aws', args: ['s3', 'sync', dir, 's3://bucket/agent'] },
        { cmd: 'gcloud', args: ['storage', 'rm', '--continue-on-error', 'gs://bucket/agent/state.db-shm', 'gs://bucket/agent/state.db-journal'] },
        { cmd: 'gcloud', args: ['storage', 'rsync', '-r', dir, 'gs://bucket/agent'] },
      ]);
      // A failed delete stops the push before the upload.
      const failing = (cmd: string, args: string[]) => {
        if (args.includes('--delete')) throw new Error('denied');
        executed.push({ cmd, args });
      };
      executed.length = 0;
      assert.throws(() => pushMind({ root: '', uri: 's3://bucket' }, 'agent', dir, failing), /denied/);
      assert.equal(executed.length, 0);
      // S3 filters are globs: a file name's glob characters match only themselves.
      executed.length = 0;
      writeFileSync(join(dir, 'a[1]*.db'), SQLITE_HEADER);
      writeFileSync(join(dir, 'a[1]*.db-shm'), 'index');
      writeFileSync(join(dir, 'a[1]*.db-journal'), 'journal');
      pushMind({ root: '', uri: 's3://bucket' }, 'agent', dir, sync);
      assert.ok(executed[0].args.includes('a[[]1][*].db-wal'));
      for (const f of ['a[1]*.db', 'a[1]*.db-shm', 'a[1]*.db-journal']) rmSync(join(dir, f));
      // Without SQLite databases nothing is deleted.
      executed.length = 0;
      rmSync(join(dir, 'state.db'));
      pushMind({ root: '', uri: 's3://bucket' }, 'agent', dir, sync);
      assert.equal(executed.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('platformEnv (mind sync is platform traffic, E6)', () => {
  it('drops proxy variables and keeps everything else', async () => {
    const { platformEnv } = await import('./index.js');
    const env = platformEnv({ HTTPS_PROXY: 'http://run:t@gw', http_proxy: 'x', ALL_PROXY: 'y', AWS_REGION: 'us-east-1', MEMORY_DIR: '/m' });
    assert.deepEqual(env, { AWS_REGION: 'us-east-1', MEMORY_DIR: '/m' });
  });
});

describe('AM3 notebooks rotate; closed volumes are cold storage', () => {
  const file = (root: string, rel: string, body = 'x') => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it('AM3 the rotation policy is factory-wide: 10 MB or 90 days, told to every run', () => {
    assert.deepEqual(NOTEBOOK_ROTATION, { maxBytes: 10 * 1024 * 1024, maxDays: 90 });
    const env = notebookEnv();
    assert.equal(env.FACTORY_NOTEBOOK_MAX_BYTES, String(10 * 1024 * 1024));
    assert.equal(env.FACTORY_NOTEBOOK_MAX_DAYS, '90');
    assert.equal(env.FACTORY_NOTEBOOK_VOLUMES_DIR, 'volumes');
  });

  it('AM3 a wake hydrates the current notebook only; a push keeps the closed volumes in the store', () => {
    const store = mkdtempSync(join(tmpdir(), 'am3-store-'));
    const work = mkdtempSync(join(tmpdir(), 'am3-work-'));
    try {
      file(store, 'agent/notebook.db', 'current');
      file(store, 'agent/volumes/2026-07/notebook.db', 'old');
      file(store, 'agent/.volume-requests/2026-07.done', '');
      pullMind({ root: store }, 'agent', work);
      assert.equal(existsSync(join(work, '.volume-requests')), false, 'request markers are not hydrated');
      assert.equal(readFileSync(join(work, 'notebook.db'), 'utf8'), 'current');
      assert.equal(existsSync(join(work, 'volumes')), false, 'closed volumes are not hydrated');

      file(work, 'notebook.db', 'updated');
      file(work, 'volumes/2026-10/notebook.db', 'just closed');
      pushMind({ root: store }, 'agent', work);
      assert.equal(readFileSync(join(store, 'agent/notebook.db'), 'utf8'), 'updated');
      assert.equal(readFileSync(join(store, 'agent/volumes/2026-07/notebook.db'), 'utf8'), 'old', 'an older volume survives a push');
      assert.equal(readFileSync(join(store, 'agent/volumes/2026-10/notebook.db'), 'utf8'), 'just closed', 'a newly closed volume is archived');
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('AM3 object stores exclude volumes on pull and fetch one volume on request', () => {
    const dest = mkdtempSync(join(tmpdir(), 'am3-dest-'));
    const calls: string[][] = [];
    // A sync that "copies" a volume when the prefix exists, and nothing (successfully) when it does not, like `s3 sync`.
    const sync = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[2]?.endsWith('/volumes/2026-07')) file(args[3], 'notebook.db', 'old');
    };
    try {
      pullMind({ root: '', uri: 's3://bucket' }, 'agent', dest, sync);
      pullVolume({ root: '', uri: 's3://bucket' }, 'agent', '2026-07', dest, sync);
      assert.deepEqual(calls[0], ['aws', 's3', 'sync', 's3://bucket/agent', dest, '--exclude', 'volumes/*', '--exclude', '.volume-requests/*']);
      assert.deepEqual(calls[1], ['aws', 's3', 'sync', 's3://bucket/agent/volumes/2026-07', join(dest, 'volumes/2026-07')]);
      assert.throws(() => pullVolume({ root: '', uri: 's3://bucket' }, 'agent', 'never-closed', dest, sync), /no volume never-closed/, 'an empty sync is a missing volume, not a fetched one');
      assert.equal(existsSync(join(dest, 'volumes/never-closed')), false, 'and leaves nothing behind');
      assert.throws(() => pullVolume({ root: '', uri: 's3://bucket' }, 'agent', '../other-agent', dest, sync), /invalid volume name/);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('AM3 the shim answers a volume request with .done, and a bad one with .error', () => {
    const store = mkdtempSync(join(tmpdir(), 'am3-store-'));
    const work = mkdtempSync(join(tmpdir(), 'am3-work-'));
    try {
      file(store, 'agent/volumes/2026-07/notebook.db', 'old');
      file(work, '.volume-requests/2026-07', '');
      file(work, '.volume-requests/2026-07.error', 'stale from an earlier request');
      file(work, '.volume-requests/missing', '');
      serveVolumeRequests({ root: store }, 'agent', work);
      assert.equal(existsSync(join(work, '.volume-requests/2026-07.error')), false, 'an old answer is cleared');
      assert.equal(readFileSync(join(work, 'volumes/2026-07/notebook.db'), 'utf8'), 'old');
      assert.ok(existsSync(join(work, '.volume-requests/2026-07.done')));
      assert.match(readFileSync(join(work, '.volume-requests/missing.error'), 'utf8'), /no volume/);
      assert.equal(existsSync(join(work, '.volume-requests/2026-07')), false, 'the request is consumed');
      // Whatever the agent puts there, the shim keeps running.
      rmSync(join(work, '.volume-requests'), { recursive: true, force: true });
      writeFileSync(join(work, '.volume-requests'), 'not a folder');
      assert.doesNotThrow(() => serveVolumeRequests({ root: store }, 'agent', work));
      rmSync(join(work, '.volume-requests'), { force: true });
      mkdirSync(join(work, '.volume-requests/odd-dir'), { recursive: true });
      assert.doesNotThrow(() => serveVolumeRequests({ root: store }, 'agent', work));
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('AM1 main() with FACTORY_MEMORY_ARCHETYPE=purpose-built skips mind pull/push but serves volume requests', async () => {
    const store = mkdtempSync(join(tmpdir(), 'shim-pb-store-'));
    const work = mkdtempSync(join(tmpdir(), 'shim-pb-work-'));
    const savedEnv = { ...process.env };
    try {
      file(store, 'agent/volumes/2026-07/notebook.db', 'volume data');
      file(store, 'agent/store_only.txt', 'do not pull');

      process.env.MEMORY_DIR = work;
      process.env.MEMORY_STORE_DIR = store;
      process.env.MEMORY_PREFIX = 'agent';
      process.env.FACTORY_MEMORY_ARCHETYPE = 'purpose-built';
      delete process.env.FACTORY_URL;

      const workerCode = `
        const fs = require('node:fs');
        const path = require('node:path');
        const dir = process.env.MEMORY_DIR;
        if (fs.existsSync(path.join(dir, 'store_only.txt'))) {
          process.exit(10);
        }
        fs.writeFileSync(path.join(dir, 'local_scratch.txt'), 'do not push');
        fs.mkdirSync(path.join(dir, '.volume-requests'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.volume-requests', '2026-07'), '');
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (fs.existsSync(path.join(dir, '.volume-requests', '2026-07.done'))) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        if (!fs.existsSync(path.join(dir, '.volume-requests', '2026-07.done'))) {
          process.exit(11);
        }
      `;

      const code = await main(['--', process.execPath, '-e', workerCode]);
      assert.equal(code, 0, 'worker should succeed');

      // Mind store should NOT have local_scratch.txt (safePush skipped)
      assert.equal(existsSync(join(store, 'agent/local_scratch.txt')), false, 'local files not pushed to store');
      // Mind dir should have received the requested volume
      assert.equal(readFileSync(join(work, 'volumes/2026-07/notebook.db'), 'utf8'), 'volume data');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, savedEnv);
      rmSync(store, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('AM1 main() with FACTORY_MEMORY_ARCHETYPE=personal-assistant pulls and pushes mind', async () => {
    const store = mkdtempSync(join(tmpdir(), 'shim-pa-store-'));
    const work = mkdtempSync(join(tmpdir(), 'shim-pa-work-'));
    const savedEnv = { ...process.env };
    try {
      file(store, 'agent/remembered.md', 'prior memory');

      process.env.MEMORY_DIR = work;
      process.env.MEMORY_STORE_DIR = store;
      process.env.MEMORY_PREFIX = 'agent';
      process.env.FACTORY_MEMORY_ARCHETYPE = 'personal-assistant';
      delete process.env.FACTORY_URL;

      const workerCode = `
        const fs = require('node:fs');
        const path = require('node:path');
        const dir = process.env.MEMORY_DIR;
        const prior = fs.readFileSync(path.join(dir, 'remembered.md'), 'utf8');
        fs.writeFileSync(path.join(dir, 'new.md'), prior + ' + updated');
      `;

      const code = await main(['--', process.execPath, '-e', workerCode]);
      assert.equal(code, 0, 'worker should succeed');

      assert.equal(readFileSync(join(store, 'agent/new.md'), 'utf8'), 'prior memory + updated');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, savedEnv);
      rmSync(store, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
