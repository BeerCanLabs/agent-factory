import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePublishRequestInput,
  validatePublishDecisionInput,
  validateUnpublishInput,
  validateRetireInput,
} from './skill-publishing.js';

describe('skill-publishing validators', () => {
  it('validates publish request input', () => {
    assert.deepEqual(validatePublishRequestInput(undefined), {});
    assert.deepEqual(validatePublishRequestInput({}), {});
    assert.deepEqual(validatePublishRequestInput({ notes: 'Ready for general use' }), { notes: 'Ready for general use' });
    assert.throws(() => validatePublishRequestInput('invalid'), /publish request body must be an object/);
    assert.throws(() => validatePublishRequestInput({ notes: 'a'.repeat(2001) }), /notes must be a string up to 2000 characters/);
  });

  it('validates publish decision input', () => {
    assert.deepEqual(validatePublishDecisionInput({ decision: 'approve' }), { decision: 'approve' });
    assert.deepEqual(validatePublishDecisionInput({ decision: 'reject', reason: 'Needs review' }), { decision: 'reject', reason: 'Needs review' });
    assert.throws(() => validatePublishDecisionInput(null), /publish decision body must be an object/);
    assert.throws(() => validatePublishDecisionInput({ decision: 'other' }), /decision must be "approve" or "reject"/);
    assert.throws(() => validatePublishDecisionInput({ decision: 'approve', reason: 'a'.repeat(2001) }), /reason must be a string up to 2000 characters/);
  });

  it('validates unpublish input', () => {
    assert.deepEqual(validateUnpublishInput(undefined), {});
    assert.deepEqual(validateUnpublishInput({}), {});
    assert.deepEqual(validateUnpublishInput({ reason: 'Security deprecation' }), { reason: 'Security deprecation' });
    assert.throws(() => validateUnpublishInput('bad'), /unpublish body must be an object/);
    assert.throws(() => validateUnpublishInput({ reason: 'a'.repeat(2001) }), /reason must be a string up to 2000 characters/);
  });

  it('validates retire input', () => {
    assert.deepEqual(validateRetireInput(undefined), {});
    assert.deepEqual(validateRetireInput({}), {});
    assert.deepEqual(validateRetireInput({ reason: 'End of life', force: true }), { reason: 'End of life', force: true });
    assert.throws(() => validateRetireInput('bad'), /retire body must be an object/);
    assert.throws(() => validateRetireInput({ force: 'yes' }), /force must be a boolean/);
    assert.throws(() => validateRetireInput({ reason: 'a'.repeat(2001) }), /reason must be a string up to 2000 characters/);
  });
});
