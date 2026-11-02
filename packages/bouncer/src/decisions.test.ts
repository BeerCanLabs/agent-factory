import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { canonicalizeRouteRequest, checkHold, checkToolApproval, findHeldSkillAction, matchSkillActionPath, type SkillActionHoldRule } from './index.js';

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

  it('canonicalizes unnormalized paths so dot-segments, backslashes, matrix params, percent-encoding, and encoded separators cannot bypass holds (F1, #369)', () => {
    const actions: SkillActionHoldRule[] = [
      { skillId: 'mail', actionId: 'send_email', route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/{userId}/messages/send', hold: true },
      { skillId: 'mail', actionId: 'modify_msg', route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/{userId}/messages/{id}:modify', hold: true },
      { skillId: 'mail', actionId: 'get_msg', route: 'google-gmail', method: 'GET', path: '/gmail/v1/users/{userId}/messages/{id}', hold: false },
    ];

    const bypassAttempts = [
      '/gmail/v1/users/me/messages/./send',
      '/gmail/v1/users/me/drafts/../messages/send',
      '/gmail/v1/users/me/%2e/messages/send',
      '/gmail/v1/users/me/drafts/%2e%2e/messages/send',
      '/gmail/v1/users/me/messages\\send',
      '//gmail///v1//users/me//messages//send/',
      '/gmail/v1/users/me/messages/%73end',
      '/gmail/v1/users/me/messages;v=1/send;foo=bar',
      '/gmail/v1/users/me/drafts/..;/messages/send',
      '/gmail/v1/users/me/messages%2fsend',
      '/gmail/v1/users/me/messages%5csend',
      '/gmail/v1/users/me/drafts%2f..%2fmessages%2fsend',
    ];
    for (const attempt of bypassAttempts) {
      assert.equal(matchSkillActionPath('/gmail/v1/users/{userId}/messages/send', attempt), true, `expected match for ${attempt}`);
      assert.deepEqual(
        checkHold({ skillActions: actions, route: 'google-gmail', method: 'POST', path: attempt }),
        { held: true },
        `expected hold for ${attempt}`,
      );
    }

    // Percent-encoded `:modify` suffix (`%3Amodify`) matches `{id}:modify`
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/me/messages/18f%3Amodify' }),
      { held: true },
    );

    // Legitimate `%2f` inside `{param}` on an unheld path remains unheld
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-gmail', method: 'GET', path: '/gmail/v1/users/me/messages/folder%2fmsg-1' }),
      { held: false },
    );
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-calendar', method: 'GET', path: '/a%2fb' }),
      { held: false },
    );

    // Malformed `%` encoding fails closed on a route with held skill actions, but does not hold routes without held skill actions
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-gmail', method: 'POST', path: '/gmail/v1/users/me/messages/%E0%A4%A' }),
      { held: true },
    );
    assert.deepEqual(
      checkHold({ skillActions: actions, route: 'google-calendar', method: 'GET', path: '/calendars/%E0%A4%A' }),
      { held: false },
    );

    // Round 2 F1: canonicalizeRouteRequest normalizes `;` matrix params and `%2f`/`%5c` BEFORE upstream prefix containment & slicing
    const matrixClimb = canonicalizeRouteRequest('/gmail/v1', '/..;/v1/users/me/messages/send');
    assert.equal(matrixClimb.ok, true);
    if (matrixClimb.ok) {
      assert.deepEqual(
        checkHold({
          skillActions: [{ skillId: 'mail', actionId: 'prefixed_send', route: 'gmail-prefixed', method: 'POST', path: '/users/{userId}/messages/send', hold: true }],
          route: 'gmail-prefixed',
          method: 'POST',
          suffixCandidates: matrixClimb.suffixCandidates,
          malformedPath: matrixClimb.malformed,
        }),
        { held: true },
      );
    }

    const encodedClimb = canonicalizeRouteRequest('/gmail/v1', '/%2e%2e%2fv1/users/me/messages/send');
    assert.equal(encodedClimb.ok, true);
    if (encodedClimb.ok) {
      assert.deepEqual(
        checkHold({
          skillActions: [{ skillId: 'mail', actionId: 'prefixed_send', route: 'gmail-prefixed', method: 'POST', path: '/users/{userId}/messages/send', hold: true }],
          route: 'gmail-prefixed',
          method: 'POST',
          suffixCandidates: encodedClimb.suffixCandidates,
          malformedPath: encodedClimb.malformed,
        }),
        { held: true },
      );
    }

    // Escaping prefix via `..;` or `%2e%2e%2f` is rejected (`ok: false`)
    assert.deepEqual(canonicalizeRouteRequest('/gmail/v1', '/..;/..;/other/admin'), { ok: false });
    assert.deepEqual(canonicalizeRouteRequest('/gmail/v1', '/..;/other/admin'), { ok: false });
    assert.deepEqual(canonicalizeRouteRequest('/gmail/v1', '/%2e%2e%2fother/admin'), { ok: false });
    assert.deepEqual(canonicalizeRouteRequest('/gmail/v1', '/..%5cother/admin'), { ok: false });

    // Legitimate `%2f` inside `{param}` on a prefixed route stays inside `/cal`
    const calParam = canonicalizeRouteRequest('/cal', '/a%2fb');
    assert.equal(calParam.ok, true);
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
