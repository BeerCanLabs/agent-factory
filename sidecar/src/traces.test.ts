import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneTraces, traceConfigFromEnv, writeTrace } from './traces.js';

describe('traceConfigFromEnv', () => {
  it('is off unless FACTORY_TRACE_PROMPTS is on and a mind dir is set', () => {
    assert.equal(traceConfigFromEnv({}).enabled, false);
    assert.equal(traceConfigFromEnv({ FACTORY_TRACE_PROMPTS: '1' }).enabled, false);
    const on = traceConfigFromEnv({ FACTORY_TRACE_PROMPTS: 'true', MEMORY_DIR: '/tmp/mind' });
    assert.equal(on.enabled, true);
    assert.equal(on.ttlMs, 86_400_000);
    assert.ok(on.dir.endsWith('traces'));
  });

  it('honors FACTORY_TRACE_TTL_SECONDS including 0 (no expiry)', () => {
    const cfg = traceConfigFromEnv({
      FACTORY_TRACE_PROMPTS: 'on',
      MEMORY_DIR: '/m',
      FACTORY_TRACE_TTL_SECONDS: '60',
    });
    assert.equal(cfg.ttlMs, 60_000);
    const forever = traceConfigFromEnv({
      FACTORY_TRACE_PROMPTS: '1',
      MEMORY_DIR: '/m',
      FACTORY_TRACE_TTL_SECONDS: '0',
    });
    assert.equal(forever.ttlMs, 0);
  });
});

describe('writeTrace', () => {
  it('writes a redacted prompt file under mind/traces', () => {
    const root = mkdtempSync(join(tmpdir(), 'mind-'));
    const cfg = { enabled: true, ttlMs: 86_400_000, dir: join(root, 'traces') };
    const secret = 'sk-live-trace-secret';
    const path = writeTrace(
      cfg,
      {
        timestamp: '2026-09-16T00:00:00.000Z',
        requestId: 'req-1',
        kind: 'llm',
        request: { messages: [{ content: `hello ${secret}` }] },
        response: { choices: [] },
      },
      [secret],
    );
    assert.ok(path);
    const disk = readFileSync(path!, 'utf8');
    assert.equal(disk.includes(secret), false);
    assert.equal(disk.includes('hello ***'), true);
  });

  it('does nothing when disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'mind-'));
    const path = writeTrace({ enabled: false, ttlMs: 1000, dir: join(root, 'traces') }, {
      timestamp: '2026-09-16T00:00:00.000Z',
      requestId: 'x',
      kind: 'llm',
    });
    assert.equal(path, null);
    assert.equal(readdirSync(root).length, 0);
  });
});

describe('pruneTraces', () => {
  it('deletes files older than ttl and keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-'));
    const oldFile = join(dir, 'old.json');
    const newFile = join(dir, 'new.json');
    writeFileSync(oldFile, '{}');
    writeFileSync(newFile, '{}');
    const old = new Date(Date.now() - 120_000);
    utimesSync(oldFile, old, old);
    const removed = pruneTraces(dir, 60_000);
    assert.equal(removed, 1);
    assert.deepEqual(readdirSync(dir), ['new.json']);
  });

  it('skips pruning when ttl is 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.json'), '{}');
    assert.equal(pruneTraces(dir, 0), 0);
    assert.deepEqual(readdirSync(dir), ['keep.json']);
  });
});
