import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkHold, checkToolApproval } from './index.js';

describe('checkHold', () => {
  it('matches methods ignoring case', () => {
    assert.deepEqual(checkHold({ hold: { methods: ['post', 'PUT'] }, method: 'POST' }), { held: true });
    assert.deepEqual(checkHold({ hold: { methods: ['post', 'PUT'] }, method: 'put' }), { held: true });
  });

  it('does not hold with an absent rule, an empty method list or an unlisted method', () => {
    assert.deepEqual(checkHold({ method: 'POST' }), { held: false });
    assert.deepEqual(checkHold({ hold: { methods: [] }, method: 'POST' }), { held: false });
    assert.deepEqual(checkHold({ hold: { methods: ['POST'] }, method: 'GET' }), { held: false });
  });
});

describe('checkToolApproval', () => {
  it('requires approval for a listed tool and not for an unlisted one', () => {
    assert.deepEqual(checkToolApproval({ requireApproval: ['deploy'], tool: 'deploy' }), { approvalRequired: true });
    assert.deepEqual(checkToolApproval({ requireApproval: ['deploy'], tool: 'read' }), { approvalRequired: false });
  });

  it('needs none when requireApproval is absent', () => {
    assert.deepEqual(checkToolApproval({ tool: 'deploy' }), { approvalRequired: false });
  });
});
