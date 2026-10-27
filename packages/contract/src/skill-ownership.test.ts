import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTransferRecipient, validateAssignGroupInput } from './skill-ownership.js';

describe('skill ownership contract', () => {
  describe('validateTransferRecipient', () => {
    it('accepts valid canonical recipient identifier and normalizes case', () => {
      assert.equal(validateTransferRecipient('Cloudflare:Alice@Example.com'), 'cloudflare:alice@example.com');
      assert.equal(validateTransferRecipient('TOKEN:admin-token'), 'token:admin-token');
      assert.equal(validateTransferRecipient('oidc:user@company.com'), 'oidc:user@company.com');
    });

    it('rejects bare names and non-canonical recipients', () => {
      assert.throws(() => validateTransferRecipient('admin'), /must be in canonical form/);
      assert.throws(() => validateTransferRecipient('alice@example.com'), /must be in canonical form/);
      assert.throws(() => validateTransferRecipient('user:bob'), /must be in canonical form/);
    });

    it('rejects invalid recipient', () => {
      assert.throws(() => validateTransferRecipient(''), /must be a non-empty string/);
      assert.throws(() => validateTransferRecipient('   '), /must be a non-empty string/);
      assert.throws(() => validateTransferRecipient(null), /must be a non-empty string/);
      assert.throws(() => validateTransferRecipient(123), /must be a non-empty string/);
      assert.throws(() => validateTransferRecipient('a'.repeat(256)), /must be a non-empty string/);
    });
  });

  describe('validateAssignGroupInput', () => {
    it('accepts valid group id', () => {
      const res = validateAssignGroupInput({ groupId: 'core-team' });
      assert.equal(res.groupId, 'core-team');
    });

    it('rejects missing or invalid groupId', () => {
      assert.throws(() => validateAssignGroupInput(null), /assignment input must be an object/);
      assert.throws(() => validateAssignGroupInput({}), /group id undefined is invalid/);
      assert.throws(() => validateAssignGroupInput({ groupId: 'INVALID/NAME' }), /group id "INVALID\/NAME" is invalid/);
    });
  });
});
