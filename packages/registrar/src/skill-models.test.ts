// Story #370 ([S24] Factory-side per-skill model binding, Epic #349): D31.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillModelBindingStore, isValidSkillModelName } from './skill-models.js';

describe('SkillModelBindingStore (S24, D31)', () => {
  it('binds, swaps (reporting the previous model), clears, and persists atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-models-'));
    try {
      const path = join(dir, 'nested', 'skill-models.json');
      const store = new SkillModelBindingStore(path);
      assert.equal(store.get('summarize-doc'), undefined);
      const first = store.set('Summarize-Doc', 'claude-sonnet', 'user:alice', '2026-11-02T00:00:00.000Z');
      assert.deepEqual(first, { binding: { skillId: 'summarize-doc', model: 'claude-sonnet', setBy: 'user:alice', setAt: '2026-11-02T00:00:00.000Z' } });
      const swap = store.set('summarize-doc', 'claude-haiku', 'user:admin');
      assert.equal(swap.previous, 'claude-sonnet');
      assert.equal(new SkillModelBindingStore(path).get('summarize-doc')?.model, 'claude-haiku');
      assert.equal(store.clear('summarize-doc'), 'claude-haiku');
      assert.equal(store.clear('summarize-doc'), undefined);
      assert.equal(new SkillModelBindingStore(path).get('summarize-doc'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses invalid skill ids and model names without changing state', () => {
    const store = new SkillModelBindingStore();
    assert.throws(() => store.set('../etc', 'm', 'user:a'));
    assert.throws(() => store.set('ok-skill', 'bad model name', 'user:a'));
    assert.deepEqual(store.list(), []);
    assert.equal(isValidSkillModelName('us.anthropic.claude-sonnet-4-5:0'), true);
    assert.equal(isValidSkillModelName(''), false);
    assert.equal(isValidSkillModelName(null), false);
  });

  it('skips invalid or unreadable file content with a warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-models-'));
    try {
      const path = join(dir, 'skill-models.json');
      writeFileSync(path, JSON.stringify({ bindings: [{ skillId: 'good', model: 'm1', setBy: 'u', setAt: 't' }, { skillId: 'BAD ID', model: 'm' }] }));
      const warnings: string[] = [];
      const store = new SkillModelBindingStore(path, (m) => warnings.push(m));
      assert.deepEqual(store.list().map((b) => b.skillId), ['good']);
      assert.equal(warnings.length, 1);
      writeFileSync(path, '{not json');
      const broken = new SkillModelBindingStore(path, (m) => warnings.push(m));
      assert.deepEqual(broken.list(), []);
      assert.equal(warnings.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
