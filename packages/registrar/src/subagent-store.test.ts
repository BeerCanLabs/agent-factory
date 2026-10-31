import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from './subagent-store.js';

describe('SubagentStore (E1.1)', () => {
  it('saves and reloads helpers, skipping records that no longer validate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-store-'));
    try {
      const store = new SubagentStore(dir, () => {});
      store.save({ id: 'juror', prompt: 'p', egress: { github: { readOnly: true } }, kind: 'subagent', registeredBy: 'a', registeredAt: 't' });
      writeFileSync(join(dir, 'subagents', 'bad.json'), JSON.stringify({ id: 'bad', prompt: 'p', memory: {}, registeredBy: 'a', registeredAt: 't' }));
      const loaded = new SubagentStore(dir, () => {}).load();
      assert.deepEqual([...loaded.keys()], ['juror']);
      assert.equal(loaded.get('juror')?.egress.github.readOnly, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does nothing without a directory', () => {
    const store = new SubagentStore(undefined);
    store.save({ id: 'x', prompt: 'p', egress: { github: { readOnly: true } }, kind: 'subagent', registeredBy: 'a', registeredAt: 't' });
    assert.equal(store.load().size, 0);
  });
});
