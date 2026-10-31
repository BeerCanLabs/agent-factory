// E1.1 (#292): helper definitions are prompt-only, keep nothing, and reach github read-only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubagent } from './subagent.js';

describe('validateSubagent (E1.1)', () => {
  it('accepts a prompt-only helper and defaults github egress to read-only with no model list', () => {
    const v = validateSubagent({ id: 'juror', prompt: 'Vote on each finding.' });
    assert.ok(v.ok);
    assert.deepEqual(v.value.egress, { github: { readOnly: true } });
    assert.equal('models' in v.value, false);
    assert.equal('model' in v.value, false);
  });

  for (const field of ['memory', 'persistence', 'tools', 'skills', 'routes', 'model', 'models', 'approvedModels', 'requestedModels', 'secrets', 'triggers']) {
    it(`rejects a helper declaring ${field} with a field error`, () => {
      const v = validateSubagent({ id: 'juror', prompt: 'p', [field]: field === 'memory' ? { enabled: true } : ['x'] });
      assert.equal(v.ok, false);
      assert.ok(!v.ok && v.errors.some((e) => e.field === field));
    });
  }

  it('rejects github egress that is not read-only', () => {
    const v = validateSubagent({ id: 'juror', prompt: 'p', egress: { github: { readOnly: false } } });
    assert.ok(!v.ok && v.errors.some((e) => e.field === 'egress.github.readOnly'));
  });

  it('rejects any other egress route', () => {
    const v = validateSubagent({ id: 'juror', prompt: 'p', egress: { slack: {} } });
    assert.ok(!v.ok && v.errors.some((e) => e.field === 'egress.slack'));
  });

  it('rejects a missing prompt, a bad id and a non-object', () => {
    assert.ok(!validateSubagent({ id: 'juror' }).ok);
    assert.ok(!validateSubagent({ id: 'Bad Id', prompt: 'p' }).ok);
    assert.ok(!validateSubagent(['x']).ok);
    const v = validateSubagent({ id: 'juror', prompt: '   ' });
    assert.ok(!v.ok && v.errors.some((e) => e.field === 'prompt'));
  });
});
