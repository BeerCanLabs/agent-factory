import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DefaultSkillsStore } from './default-skills.js';

describe('DefaultSkillsStore', () => {
  it('operates in-memory when no file path is provided', () => {
    const store = new DefaultSkillsStore();
    assert.deepEqual(store.get(), { skills: [] });

    const saved = store.set(
      [
        { id: 'action-scheduling', version: '1.0.0' },
        { id: 'web-search', version: '0.2.0' },
      ],
      'admin@example.com',
      '2026-10-30T12:00:00.000Z',
    );

    assert.deepEqual(saved, {
      skills: [
        { id: 'action-scheduling', version: '1.0.0' },
        { id: 'web-search', version: '0.2.0' },
      ],
      updatedAt: '2026-10-30T12:00:00.000Z',
      updatedBy: 'admin@example.com',
    });

    // Defensive copy check
    const copy = store.get();
    copy.skills.push({ id: 'injected', version: '1.0.0' });
    assert.equal(store.get().skills.length, 2);

    // removeSkill
    assert.equal(store.removeSkill('nonexistent', 'admin@example.com'), false);
    assert.equal(store.removeSkill('action-scheduling', 'admin@example.com', '9.9.9'), false);
    assert.equal(store.removeSkill('action-scheduling', 'admin@example.com', '1.0.0'), true);
    assert.deepEqual(store.get().skills, [{ id: 'web-search', version: '0.2.0' }]);

    assert.equal(store.removeSkill('web-search', 'admin@example.com'), true);
    assert.deepEqual(store.get().skills, []);
  });

  it('deduplicates by skill id and validates entries', () => {
    const store = new DefaultSkillsStore();

    // Deduplication in set()
    store.set(
      [
        { id: 'my-skill', version: '1.0.0' },
        { id: 'my-skill', version: '2.0.0' },
      ],
      'admin',
    );
    assert.deepEqual(store.get().skills, [{ id: 'my-skill', version: '1.0.0' }]);

    // Invalid id or version throws
    assert.throws(() => store.set([{ id: 'Invalid_ID', version: '1.0.0' }], 'admin'), /invalid default skill/);
    assert.throws(() => store.set([{ id: 'valid-id', version: 'bad-version' }], 'admin'), /invalid default skill/);
  });

  it('persists state atomically to disk and recovers state on reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'default-skills-test-'));
    const filePath = join(dir, 'skill-defaults.json');

    try {
      const store1 = new DefaultSkillsStore(filePath);
      assert.deepEqual(store1.get(), { skills: [] });

      store1.set(
        [
          { id: 'action-scheduling', version: '1.2.0' },
          { id: 'knowledge-retrieval', version: '2.0.1' },
        ],
        'admin@test.com',
        '2026-10-30T15:00:00.000Z',
      );

      // Verify file on disk
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.deepEqual(raw, {
        skills: [
          { id: 'action-scheduling', version: '1.2.0' },
          { id: 'knowledge-retrieval', version: '2.0.1' },
        ],
        updatedAt: '2026-10-30T15:00:00.000Z',
        updatedBy: 'admin@test.com',
      });

      // Reload with store2
      const store2 = new DefaultSkillsStore(filePath);
      assert.deepEqual(store2.get(), {
        skills: [
          { id: 'action-scheduling', version: '1.2.0' },
          { id: 'knowledge-retrieval', version: '2.0.1' },
        ],
        updatedAt: '2026-10-30T15:00:00.000Z',
        updatedBy: 'admin@test.com',
      });

      // Remove skill in store2
      assert.equal(store2.removeSkill('action-scheduling', 'admin@test.com'), true);
      assert.deepEqual(store2.get().skills, [{ id: 'knowledge-retrieval', version: '2.0.1' }]);

      // Reload with store3
      const store3 = new DefaultSkillsStore(filePath);
      assert.deepEqual(store3.get().skills, [{ id: 'knowledge-retrieval', version: '2.0.1' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips invalid entries when loading from corrupted or malformed file with warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'default-skills-malformed-'));
    const filePath = join(dir, 'skill-defaults.json');

    try {
      writeFileSync(
        filePath,
        JSON.stringify({
          skills: [
            { id: 'valid-skill', version: '1.0.0' },
            { id: 'BAD_SKILL', version: '1.0.0' },
            { id: 'valid-skill', version: '2.0.0' }, // duplicate id
            { id: 'another-valid', version: 'not-semver' },
            null,
          ],
          updatedAt: '2026-10-30T00:00:00.000Z',
          updatedBy: 'creator',
        }),
        'utf8',
      );

      const warnings: string[] = [];
      const store = new DefaultSkillsStore(filePath, (msg) => warnings.push(msg));
      assert.deepEqual(store.get(), {
        skills: [{ id: 'valid-skill', version: '1.0.0' }],
        updatedAt: '2026-10-30T00:00:00.000Z',
        updatedBy: 'creator',
      });
      assert.ok(warnings.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
