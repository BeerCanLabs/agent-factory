// TSK-125 (GAP-098): the agent registry's records on disk, exactly as the control plane wrote them before the move.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './registry.js';
import { loadDynamicRegistry, type AgentRecord } from './catalog.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'registrar-registry-'));
}

const SHA = 'b'.repeat(40);
const agent = (over: Partial<AgentRecord> = {}): AgentRecord =>
  ({
    id: 'ada',
    name: 'Ada',
    category: 'user',
    state: 'SLEEPING',
    repo: 'https://github.com/x/ada',
    commit: SHA,
    triggers: [],
    ...over,
  }) as unknown as AgentRecord;

describe('agent registry store', () => {
  it('writes <id>.json as two-space JSON with no trailing newline, creating the directory', () => {
    const root = tmp();
    try {
      const dir = join(root, 'registry', 'nested');
      const record = agent();
      new AgentRegistry(dir).save(record);
      assert.equal(readFileSync(join(dir, 'ada.json'), 'utf8'), JSON.stringify(record, null, 2));
      assert.equal(readFileSync(join(dir, 'ada.json'), 'utf8').endsWith('\n'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads back through loadDynamicRegistry, and a second save replaces the record', () => {
    const dir = tmp();
    try {
      const registry = new AgentRegistry(dir);
      registry.save(agent());
      registry.save(agent({ state: 'PAUSED' }));
      const loaded = loadDynamicRegistry(dir);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, 'ada');
      assert.equal(loaded[0].state, 'PAUSED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update rewrites an existing record and never creates one', () => {
    const dir = tmp();
    try {
      const registry = new AgentRegistry(dir);
      registry.update(agent());
      assert.deepEqual(readdirSync(dir), [], 'a built-in or static agent has no file, so a state change writes none');
      registry.save(agent());
      registry.update(agent({ state: 'ISOLATED' }));
      assert.equal(readFileSync(join(dir, 'ada.json'), 'utf8'), JSON.stringify(agent({ state: 'ISOLATED' }), null, 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove deletes the record and is quiet when there is none', () => {
    const dir = tmp();
    const warnings: string[] = [];
    try {
      const registry = new AgentRegistry(dir, (message) => warnings.push(message));
      registry.save(agent());
      registry.remove('ada');
      assert.equal(existsSync(join(dir, 'ada.json')), false);
      registry.remove('ada');
      registry.remove('never-registered');
      assert.deepEqual(warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no directory every method does nothing', () => {
    const registry = new AgentRegistry(undefined, () => assert.fail('no write was attempted, so nothing can fail'));
    registry.save(agent());
    registry.update(agent());
    registry.remove('ada');
  });

  it('a failed write is reported with the message the control plane logged, and does not throw', () => {
    const root = tmp();
    const warnings: Array<[string, unknown]> = [];
    try {
      const notADir = join(root, 'file');
      writeFileSync(notADir, 'x');
      const registry = new AgentRegistry(notADir, (message, err) => warnings.push([message, err]));
      registry.save(agent());
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'failed to persist dynamic agent ada:');
      assert.ok(warnings[0][1] instanceof Error);

      writeFileSync(join(root, 'dir.json'), 'x');
      const blocked = new AgentRegistry(join(root, 'dir.json', 'x'), (message) => warnings.push([message, undefined]));
      blocked.remove('ada');
      blocked.update(agent());
      assert.equal(warnings.length, 1, 'a missing record is not a failure');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
