import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayEnv } from './shim.js';

const shim = fileURLToPath(new URL('./shim.ts', import.meta.url));

describe('gatewayEnv', () => {
  it('points stock SDKs at the gateway with the run token as their key', () => {
    const env = gatewayEnv({ FACTORY_GATEWAY_URL: 'http://gw:8081/', FACTORY_RUN_TOKEN: 'run-tok' });
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://gw:8081/anthropic');
    assert.equal(env.OPENAI_BASE_URL, 'http://gw:8081/openai/v1');
    assert.equal(env.ANTHROPIC_API_KEY, 'run-tok');
    assert.deepEqual(gatewayEnv({ FACTORY_RUN_TOKEN: 'x' }), {});
    assert.equal(gatewayEnv({ FACTORY_GATEWAY_URL: 'http://gw', FACTORY_RUN_TOKEN: 't', ANTHROPIC_BASE_URL: 'mine' }).ANTHROPIC_BASE_URL, undefined);
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
        FACTORY_GATEWAY_URL: 'http://gw.internal:8081',
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

  it('hydrates, heartbeats, exposes gateway env, and replicates mind on exit', async () => {
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

  it('refuses to start without MEMORY_DIR', () => {
    const out = spawnSync(process.execPath, ['--import', 'tsx', shim, '--', 'true'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.equal(existsSync('/nonexistent'), false);
  });
});

