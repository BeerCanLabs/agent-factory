import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkHold, checkToolApproval, findHeldSkillAction, matchSkillActionPath, type SkillActionHoldRule } from './index.js';

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

  it('matches skill action path templates and evaluates effective skill action holds (S23, #369)', () => {
    assert.equal(matchSkillActionPath('/gmail/v1/users/{userId}/messages/send', '/gmail/v1/users/me/messages/send'), true);
    assert.equal(matchSkillActionPath('/gmail/v1/users/{userId}/messages', '/gmail/v1/users/me/messages?q=invoice'), true);
    assert.equal(matchSkillActionPath('/gmail/v1/users/{userId}/messages/{id}:modify', '/gmail/v1/users/me/messages/18f:modify'), true);
    assert.equal(matchSkillActionPath('/gmail/v1/users/{userId}/messages/send', '/gmail/v1/users/me/messages'), false);

    const actions: SkillActionHoldRule[] = [
      { skillId: 'mail', actionId: 'send_email', route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/{userId}/messages/send', hold: true },
      { skillId: 'mail', actionId: 'search_mail', route: 'google-gmail', method: 'GET', path: '/gmail/v1/users/{userId}/messages', hold: false },
    ];

    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send' }),
      { held: true },
    );
    assert.equal(
      findHeldSkillAction({ skillActions: actions, route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send' })?.actionId,
      'send_email',
    );
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-gmail', method: 'GET', path: '/gmail/v1/users/me/messages?q=hello' }),
      { held: false },
    );

    // Tightening search_mail to hold: true holds GET /messages
    const tightened: SkillActionHoldRule[] = actions.map((a) => (a.actionId === 'search_mail' ? { ...a, hold: true } : a));
    assert.deepEqual(
      checkHold({ skillActions: tightened, route: 'google-gmail', method: 'GET', path: '/gmail/v1/users/me/messages?q=hello' }),
      { held: true },
    );
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
