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

    assert.throws(() => validateGroupId(''), /invalid/);
    assert.throws(() => validateGroupId('UPPER'), /invalid/);
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
    assert.deepEqual(validateGroupRoles(['skill-owner', 'custom-role']), ['custom-role', 'skill-owner']);
    assert.deepEqual(validateGroupRoles(undefined), []);

    assert.throws(() => validateGroupRoles(['admin']), /admin role forbidden/);
    assert.throws(() => validateGroupRoles(['skill-owner', 'admin']), /admin role forbidden/);
    assert.throws(() => validateGroupRoles('not-array'), /array/);
    assert.throws(() => validateGroupRoles([123]), /non-empty string/);
  });
});
