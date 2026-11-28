import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseClosingIssueNumbers,
  isClaimComment,
  decideTargetStatus,
  shouldApplyMove,
  shouldHandleIssueComment,
  sprintWindow,
  phoenixParts,
  isSprintStatus,
  isNearBoundary,
  boundaryKey,
  decideBoundaryActions,
  parseLatchKeys,
  parseMode,
  isTrustedBoardPull,
  readCompletedBoundaryKeys,
  STATUS,
} from './board-sync.mjs';

test('phoenixParts is always UTC-7 (no DST)', () => {
  const d = new Date('2026-11-27T23:26:00Z');
  const p = phoenixParts(d);
  assert.equal(p.year, 2026);
  assert.equal(p.month, 11);
  assert.equal(p.day, 27);
  assert.equal(p.hour, 16);
});

test('sprintWindow and boundaryKey at 16:26, 19:58, and 20:00 MST', () => {
  const mid = new Date('2026-11-27T23:26:00Z'); // 16:26 MST
  assert.equal(sprintWindow(mid).currentName, '2026-11-27 16:00');
  assert.equal(boundaryKey(mid), '2026-11-27 16:00');
  assert.equal(isNearBoundary(mid), false);

  const justBefore = new Date('2026-11-28T02:58:00Z'); // 19:58 MST
  assert.equal(isNearBoundary(justBefore), true);
  assert.equal(boundaryKey(justBefore), '2026-11-27 20:00');

  const bell = new Date('2026-11-28T03:00:00Z'); // 20:00 MST
  assert.equal(isNearBoundary(bell), true);
  assert.equal(boundaryKey(bell), '2026-11-27 20:00');

  const tenAfter = new Date('2026-11-28T03:10:00Z'); // 20:10 MST
  assert.equal(isNearBoundary(tenAfter), true);
  const elevenAfter = new Date('2026-11-28T03:11:00Z');
  assert.equal(isNearBoundary(elevenAfter), false);
});

test('parseClosingIssueNumbers accepts Closes/Fixes/Resolves and same-repo refs', () => {
  assert.deepEqual(parseClosingIssueNumbers('Closes #628'), [628]);
  assert.deepEqual(parseClosingIssueNumbers('This fixes #10 and also Resolves #11.'), [10, 11]);
  assert.deepEqual(parseClosingIssueNumbers('Fixes BeerCanLabs/agent-factory#563'), [563]);
  assert.deepEqual(parseClosingIssueNumbers('Closes other-org/other-repo#9'), []);
  assert.deepEqual(parseClosingIssueNumbers('Mentions #99 but does not close it'), []);
  assert.deepEqual(parseClosingIssueNumbers('CLOSE #1\nFixed #2'), [1, 2]);
});

test('isClaimComment matches a **Claimed prefix, case-insensitive', () => {
  assert.equal(isClaimComment('**Claimed** by Grok-Flow'), true);
  assert.equal(isClaimComment('**claimed by AGY-Cody**'), true);
  assert.equal(isClaimComment('Still working on this'), false);
  assert.equal(isClaimComment(''), false);
});

test('claim / assignee / in-progress label → In Progress from Ready, Backlog, Current Sprint, or Next Sprint', () => {
  for (const current of ['Ready', 'Backlog', 'Current Sprint', 'Next Sprint', null]) {
    for (const ctx of [
      { labels: ['in-progress'], hasAssignee: false, commentBody: null },
      { labels: [], hasAssignee: true, commentBody: null },
      { labels: [], hasAssignee: false, commentBody: '**Claimed** by Grok-Flow at 16:01 MST' },
    ]) {
      const d = decideTargetStatus({
        kind: 'issue',
        state: 'open',
        labels: ctx.labels,
        hasAssignee: ctx.hasAssignee,
        hasOpenNonDraftClosingPr: false,
        currentStatus: current,
        commentBody: ctx.commentBody,
      });
      assert.equal(d.target, STATUS.InProgress, `${current} ${d.reason}`);
      assert.equal(shouldApplyMove({ currentStatus: current, target: d.target, reason: d.reason, itemIsOpen: true }), true);
    }
  }
});

test('open non-draft closing PR or in-review label → In Review from Current or Next Sprint', () => {
  const fromPr = decideTargetStatus({
    kind: 'issue',
    state: 'open',
    labels: ['in-progress'],
    hasAssignee: true,
    hasOpenNonDraftClosingPr: true,
    currentStatus: 'Current Sprint',
  });
  assert.equal(fromPr.target, STATUS.InReview);
  assert.equal(shouldApplyMove({ currentStatus: 'Current Sprint', target: fromPr.target, reason: fromPr.reason, itemIsOpen: true }), true);
  assert.equal(shouldApplyMove({ currentStatus: 'Next Sprint', target: 'In Review', reason: 'open-closing-pr', itemIsOpen: true }), true);
  assert.equal(shouldApplyMove({ currentStatus: 'In Progress', target: 'In Review', reason: 'open-closing-pr', itemIsOpen: true }), true);
});

test('merged PR and completed issue → Done, including from a sprint column', () => {
  assert.equal(decideTargetStatus({
    kind: 'pull_request', state: 'closed', merged: true, draft: false, labels: [],
  }).target, STATUS.Done);
  assert.equal(decideTargetStatus({
    kind: 'issue', state: 'closed', stateReason: 'completed', labels: [],
  }).target, STATUS.Done);
  assert.equal(shouldApplyMove({ currentStatus: 'Next Sprint', target: 'Done', reason: 'pr-merged', itemIsOpen: false }), true);
});

test('not_planned close leaves the card alone', () => {
  const d = decideTargetStatus({
    kind: 'issue', state: 'closed', stateReason: 'not_planned', labels: [], currentStatus: 'Ready',
  });
  assert.equal(d.target, null);
  assert.equal(d.reason, 'issue-closed-not-planned');
});

test('unmerged PR close does not Done the PR card; In Review issues may return to Ready', () => {
  const d = decideTargetStatus({
    kind: 'pull_request', state: 'closed', merged: false, draft: false, labels: [],
  });
  assert.equal(d.target, null);
  assert.equal(d.reason, 'pr-closed-unmerged');
  assert.equal(shouldApplyMove({
    currentStatus: 'In Review', target: 'Ready', reason: 'pr-closed-unmerged', itemIsOpen: true,
  }), true);
  assert.equal(shouldApplyMove({
    currentStatus: 'In Progress', target: 'Ready', reason: 'pr-closed-unmerged', itemIsOpen: true,
  }), false);
});

test('never move backward from Done unless the item is open again', () => {
  assert.equal(shouldApplyMove({
    currentStatus: 'Done', target: 'In Progress', reason: 'in-progress-label', itemIsOpen: false,
  }), false);
  assert.equal(shouldApplyMove({
    currentStatus: 'Done', target: 'In Progress', reason: 'in-progress-label', itemIsOpen: true,
  }), true);
  assert.equal(shouldApplyMove({
    currentStatus: 'Done', target: 'Done', reason: 'issue-closed-completed', itemIsOpen: false,
  }), false);
});

test('idempotent: already in the target column is a no-op', () => {
  assert.equal(shouldApplyMove({
    currentStatus: 'In Progress', target: 'In Progress', reason: 'in-progress-label', itemIsOpen: true,
  }), false);
});

test('no claim/PR signal leaves Backlog, Ready, Current Sprint, and Next Sprint alone', () => {
  for (const current of ['Backlog', 'Ready', 'Current Sprint', 'Next Sprint']) {
    const d = decideTargetStatus({
      kind: 'issue', state: 'open', labels: [], hasAssignee: false, hasOpenNonDraftClosingPr: false, currentStatus: current,
    });
    assert.equal(d.target, null);
    assert.equal(d.reason, 'no-signal');
  }
});

test('open draft PR is not In Review', () => {
  const d = decideTargetStatus({
    kind: 'pull_request', state: 'open', merged: false, draft: true, labels: [],
  });
  assert.equal(d.target, null);
});

test('shouldHandleIssueComment only fires on **Claimed', () => {
  assert.equal(shouldHandleIssueComment({ action: 'created', comment: { body: '**Claimed by Grok-Cody**' } }), true);
  assert.equal(shouldHandleIssueComment({ action: 'created', comment: { body: 'looks good' } }), false);
  assert.equal(shouldHandleIssueComment({ action: 'edited', comment: { body: '**Claimed**' } }), false);
});

test('isSprintStatus is only Current Sprint and Next Sprint', () => {
  assert.equal(isSprintStatus('Current Sprint'), true);
  assert.equal(isSprintStatus('Next Sprint'), true);
  assert.equal(isSprintStatus('In Progress'), false);
  assert.equal(isSprintStatus('Sprint 2026-11-27 16:00'), false);
});

const ITEMS = [
  { itemId: 'i505', number: 505, title: 'secret timeout', statusName: 'Current Sprint' },
  { itemId: 'i564', number: 564, title: 'sessions', statusName: 'Current Sprint' },
  { itemId: 'i999', number: 999, title: 'next work', statusName: 'Next Sprint' },
  { itemId: 'i563', number: 563, title: 'JWT', statusName: 'In Review' },
  { itemId: 'i628', number: 628, title: 'board-sync', statusName: 'In Progress' },
];

test('boundary mid-window (16:26 MST) is a no-op so Current Sprint is not flushed', () => {
  const now = new Date('2026-11-27T23:26:00Z');
  const actions = decideBoundaryActions({ now, items: ITEMS });
  assert.equal(actions.skip, true);
  assert.equal(actions.reason, 'not-near-boundary');
  assert.equal(actions.key, '2026-11-27 16:00');
  assert.equal(actions.movesToInProgress.length, 0);
  assert.equal(actions.movesToCurrent.length, 0);
});

test('boundary at the 20:00 MST bell moves Current → In Progress, then Next → Current', () => {
  const now = new Date('2026-11-28T03:00:00Z');
  const actions = decideBoundaryActions({ now, items: ITEMS });
  assert.equal(actions.skip, false);
  assert.equal(actions.key, '2026-11-27 20:00');
  assert.deepEqual(actions.movesToInProgress.map((m) => m.number), [505, 564]);
  assert.deepEqual(actions.movesToCurrent.map((m) => m.number), [999]);
  assert.ok(actions.movesToInProgress.every((m) => m.from === 'Current Sprint' && m.to === 'In Progress'));
  assert.ok(actions.movesToCurrent.every((m) => m.from === 'Next Sprint' && m.to === 'Current Sprint'));
  // A second run for the same window is a no-op even at the bell.
  const again = decideBoundaryActions({ now, items: ITEMS, alreadyCompletedKeys: [actions.key] });
  assert.equal(again.skip, true);
  assert.equal(again.reason, 'already-completed');
  assert.equal(again.movesToInProgress.length, 0);
});

test('boundary 2 minutes before the bell uses the upcoming window key', () => {
  const now = new Date('2026-11-28T02:58:00Z'); // 19:58 MST
  const actions = decideBoundaryActions({ now, items: ITEMS });
  assert.equal(actions.skip, false);
  assert.equal(actions.key, '2026-11-27 20:00');
  assert.equal(actions.movesToInProgress.length, 2);
});

test('force mid-window still shifts, and In Review / In Progress cards are left alone', () => {
  const now = new Date('2026-11-27T23:26:00Z');
  const actions = decideBoundaryActions({ now, items: ITEMS, force: true });
  assert.equal(actions.skip, false);
  assert.deepEqual(actions.movesToInProgress.map((m) => m.number), [505, 564]);
  assert.deepEqual(actions.movesToCurrent.map((m) => m.number), [999]);
  assert.equal(actions.movesToInProgress.some((m) => m.number === 563 || m.number === 628), false);
});

test('shouldApplyMove allows Next Sprint → Current Sprint only as a sprint-shift', () => {
  assert.equal(shouldApplyMove({
    currentStatus: 'Next Sprint', target: 'Current Sprint', reason: 'sprint-shift', itemIsOpen: true,
  }), true);
  assert.equal(shouldApplyMove({
    currentStatus: 'Next Sprint', target: 'Current Sprint', reason: 'in-progress-label', itemIsOpen: true,
  }), false);
  assert.equal(shouldApplyMove({
    currentStatus: 'In Progress', target: 'Current Sprint', reason: 'sprint-shift', itemIsOpen: true,
  }), false);
  assert.equal(shouldApplyMove({
    currentStatus: 'In Review', target: 'Current Sprint', reason: 'sprint-shift', itemIsOpen: true,
  }), false);
});

test('parseLatchKeys reads the hidden boundary marker', () => {
  const keys = parseLatchKeys([
    { body: 'hello' },
    { body: '<!-- board-sync-boundary:2026-11-27 20:00 -->\nBoard-sync boundary for 2026-11-27 20:00 MST completed: 2 card(s)...' },
  ]);
  assert.deepEqual(keys, ['2026-11-27 20:00']);
});

test('parseMode: schedule is boundary; issue events are sync; dispatch honors input', () => {
  assert.equal(parseMode({}, 'schedule', {}), 'boundary');
  assert.equal(parseMode({ inputs: {} }, 'workflow_dispatch', {}), 'boundary');
  assert.equal(parseMode({ inputs: { mode: 'reconcile' } }, 'workflow_dispatch', { mode: 'reconcile' }), 'reconcile');
  assert.equal(parseMode({}, 'issues', {}), 'sync');
  assert.equal(parseMode({}, 'pull_request_target', {}), 'sync');
});

test('isTrustedBoardPull accepts same-repo PRs and rejects forks', () => {
  const sameWebhook = {
    number: 1,
    head: { repo: { full_name: 'BeerCanLabs/agent-factory' } },
    base: { repo: { full_name: 'BeerCanLabs/agent-factory' } },
  };
  const sameGraphql = {
    number: 2,
    isCrossRepository: false,
    headRepository: { nameWithOwner: 'BeerCanLabs/agent-factory' },
  };
  const forkWebhook = {
    number: 3,
    head: { repo: { full_name: 'attacker/agent-factory' } },
    base: { repo: { full_name: 'BeerCanLabs/agent-factory' } },
  };
  const forkGraphql = {
    number: 4,
    isCrossRepository: true,
    headRepository: { nameWithOwner: 'attacker/agent-factory' },
  };
  const deletedFork = { number: 5, head: { repo: null }, base: { repo: { full_name: 'BeerCanLabs/agent-factory' } } };
  assert.equal(isTrustedBoardPull(sameWebhook), true);
  assert.equal(isTrustedBoardPull(sameGraphql), true);
  assert.equal(isTrustedBoardPull(forkWebhook), false);
  assert.equal(isTrustedBoardPull(forkGraphql), false);
  assert.equal(isTrustedBoardPull(deletedFork), false);
  assert.equal(isTrustedBoardPull(null), false);
});

test('readCompletedBoundaryKeys fails closed when the latch cannot be read', async () => {
  await assert.rejects(
    () => readCompletedBoundaryKeys('token', 628, {
      log: { warn() {} },
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
    /network down/,
  );
});
