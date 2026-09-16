import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KillSwitch } from './killswitch.js';
import { Ledger } from './ledger.js';
import { createProxyServer } from './proxy.js';
import { createControlServer } from './server.js';
import { garrisonFromEnv } from './garrison.js';
import { usageFromLlmJson } from './tokens.js';
import { payloadHash } from '@beercanlabs/factory-ledger';

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      resolve(addr.port);
    });
  });
}

function request(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: unknown = raw;
          try {
            json = JSON.parse(raw);
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('token parse', () => {
  it('reads OpenAI-style usage', () => {
    const usage = usageFromLlmJson({
      model: 'gpt-test',
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    assert.deepEqual(usage, { input: 11, output: 7, model: 'gpt-test' });
  });
});

describe('garrison adapter', () => {
  it('is disabled unless TELEMETRY_SINKS=garrison', () => {
    const off = garrisonFromEnv({ GARRISON_URL: 'http://localhost:3001' });
    assert.equal(off.enabled, false);
    const on = garrisonFromEnv({ TELEMETRY_SINKS: 'garrison', GARRISON_URL: 'http://localhost:3001' });
    assert.equal(on.enabled, true);
  });
});

describe('intercept proxy', { concurrency: false }, () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let control: http.Server;
  let proxyPort = 0;
  let controlPort = 0;
  const killSwitch = new KillSwitch(1000);
  const secret = 'sk-live-sidecar-secret';
  const ledger = new Ledger('echo', undefined, undefined, [secret]);

  before(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'gpt-test', usage: { prompt_tokens: 3, completion_tokens: 5 }, choices: [] }));
    });
    const upPort = await listen(upstream);
    proxy = createProxyServer({
      upstream: `http://127.0.0.1:${upPort}`,
      killSwitch,
      ledger,
    });
    control = createControlServer({
      agentId: 'echo',
      agentName: 'Echo',
      token: 'secret',
      killSwitch,
      ledger,
      version: 'test',
    });
    proxyPort = await listen(proxy);
    controlPort = await listen(control);
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((r) => upstream.close(() => r())),
      new Promise<void>((r) => proxy.close(() => r())),
      new Promise<void>((r) => control.close(() => r())),
    ]);
  });

  it('counts tokens without agent instrumentation', async () => {
    const body = { model: 'gpt-test', messages: [{ role: 'user', content: `hello ${secret}` }] };
    const res = await request(proxyPort, '/v1/chat/completions', { method: 'POST', body });
    assert.equal(res.status, 200);
    const llm = ledger.events.filter((e) => e.type === 'llm');
    assert.ok(llm.length >= 1);
    assert.equal(llm[0]?.inputTokens, 3);
    assert.equal(llm[0]?.outputTokens, 5);
    assert.equal(llm[0]?.payloadSha256, payloadHash(body));
    assert.equal(JSON.stringify(llm[0]).includes(secret), false);
    assert.equal('payload' in (llm[0] ?? {}), false);
  });

  it('isolate drops egress', async () => {
    const cmd = await request(controlPort, '/api/v1/command', {
      method: 'POST',
      body: { command: 'ISOLATE' },
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(cmd.status, 200);
    const blocked = await request(proxyPort, '/v1/chat/completions', { method: 'POST', body: {} });
    assert.equal(blocked.status, 403);
    await request(controlPort, '/api/v1/command', {
      method: 'POST',
      body: { command: 'RESUME' },
      headers: { authorization: 'Bearer secret' },
    });
  });

  it('control API requires the sidecar token', async () => {
    const res = await request(controlPort, '/api/v1/ledger');
    assert.equal(res.status, 401);
  });

  it('health does not require garrison', async () => {
    const res = await request(controlPort, '/healthz');
    assert.equal(res.status, 200);
    assert.equal((res.json as { status: string }).status, 'ok');
  });
});
