import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatekeeperEgressEnv } from './shim.js';

const shim = fileURLToPath(new URL('./shim.ts', import.meta.url));

describe('gatekeeperEgressEnv', () => {
  it('points stock SDKs at the gatekeeper-egress with the run token as their key', () => {
    const env = gatekeeperEgressEnv({ FACTORY_GATEKEEPER_EGRESS_URL: 'http://gw:8081/', FACTORY_RUN_TOKEN: 'run-tok' });
    assert.equal(env.HTTP_PROXY, 'http://run:run-tok@gw:8081');
    assert.equal(env.HTTPS_PROXY, 'http://run:run-tok@gw:8081');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://gw:8081/anthropic');
    assert.equal(env.OPENAI_BASE_URL, 'http://gw:8081/openai/v1');
    assert.equal(env.FACTORY_MODEL_BASE_URL, 'http://gw:8081/models/v1');
    assert.equal(env.DISCORD_BASE_URL, 'http://gw:8081/discord');
    assert.equal(env.DISCORD_API_BASE, 'http://gw:8081/discord');
    assert.equal(env.GOOGLE_CALENDAR_BASE_URL, 'http://gw:8081/google-calendar');
    assert.equal(env.GOOGLE_OAUTH_BASE_URL, 'http://gw:8081/google-oauth');
    assert.equal(env.GMAIL_BASE_URL, 'http://gw:8081/google-gmail');
    assert.equal(env.GOOGLE_DRIVE_BASE_URL, 'http://gw:8081/google-drive');
    assert.equal(env.GOOGLE_DRIVE_UPLOAD_BASE_URL, 'http://gw:8081/google-drive-upload');
    assert.equal(env.GOOGLE_HEALTH_BASE_URL, 'http://gw:8081/google-health');
    assert.equal(env.GOOGLE_STORAGE_BASE_URL, 'http://gw:8081/google-storage');
    assert.equal(env.NOTION_BASE_URL, 'http://gw:8081/notion');
    assert.equal(env.NOTION_API_KEY, undefined, 'agents never get the Notion key (S1)');
    assert.equal(env.ANTHROPIC_API_KEY, 'run-tok');
    assert.deepEqual(gatekeeperEgressEnv({ FACTORY_RUN_TOKEN: 'x' }), {});
    assert.equal(gatekeeperEgressEnv({ FACTORY_GATEKEEPER_EGRESS_URL: 'http://gw', FACTORY_RUN_TOKEN: 't', ANTHROPIC_BASE_URL: 'mine' }).ANTHROPIC_BASE_URL, undefined);
  });
});

describe('shim process', () => {
  let server: http.Server;
  let port = 0;
  const calls: Array<{ path: string; auth?: string; body: any }> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        calls.push({ path: req.url ?? '', auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('no port');
    port = a.port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  async function run(workerCode: string, extraEnv: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'shim-'));
    const store = join(root, 'store');
    mkdirSync(join(store, 'agent-x'), { recursive: true });
    writeFileSync(join(store, 'agent-x', 'remembered.md'), 'from last run');
    const worker = join(root, 'worker.mjs');
    writeFileSync(worker, workerCode);
    const child = spawn(process.execPath, ['--import', 'tsx', shim, '--', process.execPath, worker], {
      env: {
        PATH: process.env.PATH,
        MEMORY_DIR: join(root, 'mind'),
        MEMORY_STORE_DIR: store,
        MEMORY_PREFIX: 'agent-x',
        FACTORY_URL: `http://127.0.0.1:${port}`,
        FACTORY_RUN_ID: 'run-9',
        FACTORY_RUN_TOKEN: 'run-token-9',
        FACTORY_GATEKEEPER_EGRESS_URL: 'http://gw.internal:8081',
        FACTORY_HEARTBEAT_SECONDS: '0.05',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const status: number | null = await new Promise((r) => child.on('exit', (c) => r(c)));
    const out = { status, stderr };
    return { out, root, store };
  }

  it('hydrates, heartbeats, exposes gatekeeper-egress env, and replicates mind on exit', async () => {
    const { out, store } = await run(`
      import { readFileSync, writeFileSync } from 'node:fs';
      const dir = process.env.MEMORY_DIR;
      const prior = readFileSync(dir + '/remembered.md', 'utf8');
      writeFileSync(dir + '/new.md', prior + ' + ' + process.env.ANTHROPIC_BASE_URL + ' + ' + process.env.ANTHROPIC_API_KEY);
      await new Promise((r) => setTimeout(r, 200));
    `);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFileSync(join(store, 'agent-x', 'new.md'), 'utf8'), 'from last run + http://gw.internal:8081/anthropic + run-token-9');
    const beats = calls.filter((c) => c.path === '/api/v1/runs/run-9/heartbeat');
    assert.ok(beats.length >= 2, `beats=${beats.length}`);
    assert.equal(beats[0].auth, 'Bearer run-token-9');
    assert.equal(calls.some((c) => c.path.endsWith('/result')), false, 'a clean exit leaves reporting to the agent');
  });

  it('propagates a crash exit code and reports the failure', async () => {
    calls.length = 0;
    const { out } = await run(`process.exit(7)`);
    assert.equal(out.status, 7);
    const result = calls.find((c) => c.path === '/api/v1/runs/run-9/result');
    assert.deepEqual(result?.body, { status: 'failed', error: 'worker exited 7' });
  });

  it('bridges input and automatically posts result for decoupled worker', async () => {
    calls.length = 0;
    const { out } = await run(
      `
      import { readFileSync, writeFileSync } from 'node:fs';
      const input = process.env.FACTORY_INPUT;
      const resultFile = process.env.FACTORY_RESULT_FILE;
      writeFileSync(resultFile, JSON.stringify({ status: 'succeeded', output: { echo: input } }));
      `,
      { FACTORY_INPUT: 'hello-from-test' }
    );
    assert.equal(out.status, 0, out.stderr);
    const result = calls.find((c) => c.path === '/api/v1/runs/run-9/result');
    assert.ok(result, 'result should have been automatically posted by shim');
    assert.deepEqual(result.body, { status: 'succeeded', output: { echo: 'hello-from-test' } });
  });

  it('a stalled final mind push is bounded, heartbeats continue, and the result still lands (#339)', async () => {
    calls.length = 0;
    const bin = mkdtempSync(join(tmpdir(), 'fake-aws-'));
    // pull (s3 -> local) answers at once; push (local -> s3) hangs, as the stalled upload did in production.
    writeFileSync(join(bin, 'aws'), '#!/bin/sh\ncase "$3" in s3://*) exit 0;; esac\nexec sleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const { out } = await run(
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.FACTORY_RESULT_FILE, JSON.stringify({ status: 'succeeded', output: { reply: 'pong' } }));
      `,
      { PATH: `${bin}:${process.env.PATH}`, MEMORY_STORE_URI: 's3://bucket/minds', MEMORY_STORE_DIR: '', FACTORY_FINAL_SYNC_SECONDS: '1' }
    );
    assert.equal(out.status, 0, out.stderr);
    assert.ok(Date.now() - started < 15_000, 'the push must not hold the shim for its full duration');
    assert.match(out.stderr, /final mind push timed_out/);
    const resultAt = calls.findIndex((c) => c.path === '/api/v1/runs/run-9/result');
    assert.ok(resultAt >= 0, 'result posted');
    assert.deepEqual(calls[resultAt].body, { status: 'succeeded', output: { reply: 'pong' } });
    assert.ok(calls.slice(0, resultAt).filter((c) => c.path.endsWith('/heartbeat')).length >= 5, 'heartbeats kept flowing during the push');
  });

  it('refuses to start without MEMORY_DIR', () => {
    const out = spawnSync(process.execPath, ['--import', 'tsx', shim, '--', 'true'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.equal(existsSync('/nonexistent'), false);
  });
});

