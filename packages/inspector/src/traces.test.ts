import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneTraces, traceConfigFromEnv, writeTrace } from './traces.js';

describe('prompt traces: off by default, redacted, pruned', () => {
  it('is disabled unless FACTORY_TRACE_PROMPTS is truthy and a directory is known', () => {
    assert.equal(traceConfigFromEnv({}).enabled, false);
    assert.equal(traceConfigFromEnv({ FACTORY_TRACE_PROMPTS: 'true' }).enabled, false, 'no directory');
    const cfg = traceConfigFromEnv({ FACTORY_TRACE_PROMPTS: 'on', FACTORY_TRACE_DIR: '/data', FACTORY_TRACE_TTL_SECONDS: '60' });
    assert.deepEqual(cfg, { enabled: true, ttlMs: 60_000, dir: join('/data', 'traces') });
  });

  it('writes nothing when disabled', () => {
    const cfg = { enabled: false, ttlMs: 1000, dir: join(tmpdir(), 'never-created') };
    assert.equal(writeTrace(cfg, { timestamp: '2026-10-08T00:00:00.000Z', requestId: 'r1', kind: 'llm' }), null);
  });

  it('S1 redacts the secrets it is given and keeps the request id out of the path traversal', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'trace-')), 'traces');
    const path = writeTrace(
      { enabled: true, ttlMs: 0, dir },
      { timestamp: '2026-10-08T00:00:00.000Z', requestId: '../../evil/r1', kind: 'llm', request: { key: 'sk-secret-value' } },
      ['sk-secret-value'],
    );
    assert.ok(path && path.startsWith(dir), path ?? 'no path');
    assert.ok(!readFileSync(path, 'utf8').includes('sk-secret-value'));
    assert.deepEqual(readdirSync(dir).length, 1);
  });

  it('prunes files older than the ttl and leaves newer ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const old = join(dir, 'old.json');
    const fresh = join(dir, 'fresh.json');
    writeFileSync(old, '{}');
    writeFileSync(fresh, '{}');
    const now = Date.now();
    utimesSync(old, new Date(now - 10_000), new Date(now - 10_000));
    assert.equal(pruneTraces(dir, 5_000, now), 1);
    assert.deepEqual(readdirSync(dir), ['fresh.json']);
    assert.equal(pruneTraces(dir, 0, now), 0, 'a zero ttl never prunes');
  });
});
