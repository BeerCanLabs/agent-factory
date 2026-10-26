import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateGroupId, validateMemberId, validateGroupRoles } from './groups.js';

describe('groups contract (H6, A10, A17)', () => {
  it('validates group IDs', () => {
    assert.equal(validateGroupId('engineering'), 'engineering');
    assert.equal(validateGroupId('team-alpha'), 'team-alpha');
    assert.equal(validateGroupId('sec.ops'), 'sec.ops');
    assert.equal(validateGroupId('dev_1'), 'dev_1');
    assert.equal(validateGroupId('a'), 'a');
    // Normalizes uppercase and whitespace
    assert.equal(validateGroupId('UPPER'), 'upper');
    assert.equal(validateGroupId('  team-bravo  '), 'team-bravo');

    assert.throws(() => validateGroupId(''), /invalid/);
    assert.throws(() => validateGroupId('-starts-dash'), /invalid/);
    assert.throws(() => validateGroupId('ends-dash-'), /invalid/);
    assert.throws(() => validateGroupId('with space'), /invalid/);
    assert.throws(() => validateGroupId('a'.repeat(65)), /invalid/);
  });

  it('validates member IDs', () => {
    assert.equal(validateMemberId('alice@example.com'), 'alice@example.com');
    assert.equal(validateMemberId('  Bob@Example.COM  '), 'bob@example.com');
    assert.equal(validateMemberId('user-123'), 'user-123');

    assert.throws(() => validateMemberId(''), /invalid/);
    assert.throws(() => validateMemberId('   '), /invalid/);
    assert.throws(() => validateMemberId(null), /invalid/);
    assert.throws(() => validateMemberId('a'.repeat(256)), /invalid/);
  });

  it('validates group roles and rejects forbidden roles (A17)', () => {
    assert.deepEqual(validateGroupRoles(['skill-owner']), ['skill-owner']);
    assert.deepEqual(validateGroupRoles(['skills.register', 'skill-owner']), ['skill-owner', 'skills.register']);
    assert.deepEqual(validateGroupRoles(undefined), []);

    // Built-in factory roles rejected (A17)
    assert.throws(() => validateGroupRoles(['admin']), /built-in factory role forbidden/);
    assert.throws(() => validateGroupRoles(['operator']), /built-in factory role forbidden/);
    assert.throws(() => validateGroupRoles(['approver']), /built-in factory role forbidden/);
    assert.throws(() => validateGroupRoles(['viewer']), /built-in factory role forbidden/);

    // Unknown roles rejected (A17 allowlist)
    assert.throws(() => validateGroupRoles(['unknown-role']), /allowed roles are skill-owner, skills.register/);

    assert.throws(() => validateGroupRoles('not-array'), /array/);
    assert.throws(() => validateGroupRoles([123]), /non-empty string/);
  });
});
