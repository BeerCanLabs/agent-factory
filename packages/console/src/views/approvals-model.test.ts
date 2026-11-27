// #520: decision-hold card data, the cap default, and when Approve must stay off.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalItem } from '../api/types.js';
import {
  STORIES_NOT_FILED,
  approvalLabel,
  approveBlocked,
  approveConfirm,
  capInputFromNumber,
  decisionCard,
  decisionSubmit,
  defaultCapText,
  formatUsd,
  isDecisionHold,
  parseCapUsd,
  rejectConfirm,
  revisionLines,
} from './approvals-model.js';

const requestedAt = '2026-11-19T08:46:57.000Z';

function decision(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    approvalId: '5443d34c-aadd-4f3f-9ecc-5e38f2367c52',
    agentId: 'beercanlabs-conductor',
    runId: '2121516d-6817-402d-ad2a-9318445fcb7a',
    route: 'decision',
    tool: 'plan-budget: Budget for plan Add subtract(a, b)',
    argsSha256: 'abc123',
    state: 'pending',
    requestedAt,
    kind: 'decision',
    hold: {
      requestKey: 'plan-budget:getdraft/draftsman#371@16d3c4e7237c',
      kind: 'plan-budget',
      title: 'Budget for plan Add subtract(a, b) to the sandbox arithmetic utilities',
      summary: 'Plan plan-12, 1 epic, getdraft/draftsman. Nothing goes to the story-breaker until you approve.',
      link: 'https://github.com/getdraft/draftsman/pull/371',
      requiresCap: true,
      approvers: ['dsackr'],
      payload: {
        budget: {
          total_expected_usd: 12.5,
          total_p90_usd: 16.63,
          model_cost_usd: 11,
          infra_cost_usd: 1.5,
          by_agent: [{ stage: 'build', role: 'implementer', model: 'claude-sonnet', cost_usd: 9.25 }],
          effort_passes: 2,
          method: 'role rates',
          uncertainty: 'wide',
        },
        plan_id: 'plan-12',
      },
    },
    ...over,
  };
}

it('#520: a plan-budget hold exposes title, summary, link, agent, run, totals and the per-role row', () => {
  const card = decisionCard(decision());
  assert.ok(card);
  assert.equal(card.title, 'Budget for plan Add subtract(a, b) to the sandbox arithmetic utilities');
  assert.match(card.summary, /story-breaker/);
  assert.equal(card.link, 'https://github.com/getdraft/draftsman/pull/371');
  assert.equal(card.agentId, 'beercanlabs-conductor');
  assert.equal(card.runId, '2121516d-6817-402d-ad2a-9318445fcb7a');
  assert.deepEqual(card.approvers, ['dsackr']);
  assert.equal(card.requiresCap, true);
  assert.equal(card.budget?.expectedUsd, 12.5);
  assert.equal(card.budget?.p90Usd, 16.63);
  assert.equal(card.budget?.modelCostUsd, 11);
  assert.equal(card.budget?.infraCostUsd, 1.5);
  assert.equal(card.budget?.effortPasses, 2);
  assert.deepEqual(revisionLines(card.budget!), ['Effort passes: 2']);
  assert.deepEqual(revisionLines({ ...card.budget!, passesPerStory: 2.5, effortPasses: 10 }), ['Passes per story: 2.5', 'Effort passes: 10']);
  assert.deepEqual(card.budget?.byAgent, [{ stage: 'build', role: 'implementer', model: 'claude-sonnet', costUsd: 9.25 }]);
  assert.equal(card.storiesFiled, false);
  assert.equal(STORIES_NOT_FILED, 'stories not filed yet');
  assert.equal(defaultCapText(decision()), '16.63');
  assert.equal(formatUsd(12.5), '$12.50');
  assert.equal(formatUsd(16.63), '$16.63');
  assert.equal(approvalLabel(decision()), card.title);
});

it('#520: story and DoR rows, rates, passes per story and a FinOps link are shown when the payload has them', () => {
  const card = decisionCard(
    decision({
      hold: {
        ...decision().hold!,
        payload: {
          budget: {
            total_expected_usd: 8,
            total_p90_usd: 10.33,
            passes_per_story: 3,
            by_story: [{ title: 'subtract() costs', cost_usd: 2 }],
            model_rates: [{ model: 'claude-sonnet', input_per_mtok: 3, output_per_mtok: 15 }],
            finops_url: 'https://github.com/BeerCanLabs/sdlc-sandbox/pull/4#issuecomment-6999500063',
            by_stage: { build: 6, review: 2.33 },
          },
          epics: [{ title: 'Arithmetic', dor: 'ready', dod: 'open' }],
          stories: [{ title: 'Add subtract(a, b)', dor_status: 'ready', dod_status: 'not started', cost_usd: 4 }],
        },
      },
    }),
  );
  assert.ok(card);
  assert.equal(card.storiesFiled, true);
  assert.deepEqual(card.stories, [{ title: 'Add subtract(a, b)', dor: 'ready', dod: 'not started', costUsd: 4 }]);
  assert.deepEqual(card.epics, [{ title: 'Arithmetic', dor: 'ready', dod: 'open' }]);
  assert.equal(card.budget?.passesPerStory, 3);
  assert.equal(card.budget?.byStory[0]?.title, 'subtract() costs');
  assert.equal(card.budget?.rates[0]?.model, 'claude-sonnet');
  assert.equal(card.budget?.rates[0]?.inputPerMTok, 3);
  assert.equal(card.budget?.byStage.length, 2);
  assert.equal(card.finopsUrl, 'https://github.com/BeerCanLabs/sdlc-sandbox/pull/4#issuecomment-6999500063');
  assert.equal(defaultCapText(decision({ hold: { ...decision().hold!, payload: { budget: { total_p90_usd: 10.33 } } } })), '10.33');
});

it('#520: a decision hold with no budget payload still has its title and files no stories', () => {
  const item = decision({
    hold: {
      requestKey: 'plan-budget:BeerCanLabs/sdlc-sandbox#4@30355c1e26e4',
      kind: 'plan-budget',
      title: 'Budget for plan Add subtract(a, b)',
      summary: 'Nothing goes to the story-breaker until you approve.',
      link: 'https://github.com/BeerCanLabs/sdlc-sandbox/pull/4',
      requiresCap: true,
      approvers: ['dsackr'],
    },
  });
  const card = decisionCard(item);
  assert.ok(card);
  assert.equal(card.budget, undefined);
  assert.equal(card.storiesFiled, false);
  assert.equal(card.stories.length, 0);
  assert.equal(defaultCapText(item), '');
  assert.equal(approveBlocked(item, ''), true);
  assert.equal(approveBlocked(item, 'lots'), true);
  assert.equal(approveBlocked(item, '10.33'), false);
});

it('#520: a bare numeric budget is an estimate, not an expected/P90 pair, and stories stay unfiled', () => {
  const card = decisionCard(
    decision({
      hold: { ...decision().hold!, requiresCap: false, payload: { budget: 1800 } },
    }),
  );
  assert.equal(card?.budget?.amountOnly, 1800);
  assert.equal(card?.budget?.expectedUsd, undefined);
  assert.equal(card?.budget?.p90Usd, undefined);
  assert.equal(card?.storiesFiled, false);
  assert.equal(card?.requiresCap, false);
  const bare = decision({ hold: { ...decision().hold!, requiresCap: false, payload: { budget: 1800 } } });
  assert.equal(defaultCapText(bare), '');
  assert.equal(approveBlocked(bare, ''), false);
});

it('#520: Approve is blocked only when the hold requires a cap and the text is empty or not an amount', () => {
  const needs = decision();
  assert.equal(approveBlocked(needs, ''), true);
  assert.equal(approveBlocked(needs, '   '), true);
  assert.equal(approveBlocked(needs, 'lots'), true);
  assert.equal(approveBlocked(needs, '-1'), true);
  assert.equal(approveBlocked(needs, '16.63'), false);
  assert.equal(approveBlocked(needs, '$16.63'), false);
  assert.equal(approveBlocked(needs, '0'), false);
  const optional = decision({ hold: { ...decision().hold!, requiresCap: false } });
  assert.equal(approveBlocked(optional, ''), false);
  const tool: ApprovalItem = { ...decision(), kind: undefined, hold: undefined, route: 'mcp', tool: 'shell.exec' };
  assert.equal(isDecisionHold(tool), false);
  assert.equal(approveBlocked(tool, ''), false);
  assert.equal(decisionCard(tool), null);
  assert.equal(approvalLabel(tool), 'shell.exec');
});

it('#520: parseCapUsd accepts the amounts a person types and nothing else', () => {
  assert.equal(parseCapUsd(2500), 2500);
  assert.equal(parseCapUsd('2500'), 2500);
  assert.equal(parseCapUsd('$2,500.50'), 2500.5);
  assert.equal(parseCapUsd('$ 40'), 40);
  assert.equal(parseCapUsd(0), 0);
  for (const bad of [-1, Number.NaN, '2,50', '1e3', '$', 'ten', '2500.123', true, '']) assert.equal(parseCapUsd(bad), null, String(bad));
  assert.equal(capInputFromNumber(16.63), '16.63');
  assert.equal(capInputFromNumber(16.625), '16.63');
  assert.equal(capInputFromNumber(10), '10');
  assert.equal(capInputFromNumber(-1), '');
});

it('#520: approving a requiresCap hold sends capUsd; reject and egress approvals do not', () => {
  const needs = decision();
  const approved = decisionSubmit(needs, 'approve', ' go ', '16.63');
  assert.deepEqual(approved, { blocked: false, notes: 'go', capUsd: 16.63 });
  assert.equal(decisionSubmit(needs, 'approve', '', '').blocked, true);
  assert.equal(decisionSubmit(needs, 'approve', '', 'lots').blocked, true);
  const rejected = decisionSubmit(needs, 'reject', ' too much ', '16.63');
  assert.deepEqual(rejected, { blocked: false, notes: 'too much', capUsd: undefined });
  const optional = decision({ hold: { ...needs.hold!, requiresCap: false } });
  assert.deepEqual(decisionSubmit(optional, 'approve', '', '99'), { blocked: false, notes: undefined, capUsd: undefined });
  const tool: ApprovalItem = { ...needs, kind: undefined, hold: undefined, route: 'mcp', tool: 'shell.exec' };
  assert.deepEqual(decisionSubmit(tool, 'reject', 'nope', ''), { blocked: false, notes: undefined, capUsd: undefined });
  assert.deepEqual(decisionSubmit(tool, 'approve', 'ok', ''), { blocked: false, notes: 'ok', capUsd: undefined });
  assert.match(approveConfirm(needs, { capUsd: 16.63 }), /The run is not paused/);
  assert.match(approveConfirm(needs, { capUsd: 16.63 }), /Nothing is sent/);
  assert.match(approveConfirm(needs, { capUsd: 16.63 }), /\$16\.63/);
  assert.equal(approveConfirm(needs, { capUsd: 16.63 }).includes('paused until'), false);
  assert.equal(approveConfirm(needs).includes('tool call'), false);
  assert.match(approveConfirm(tool), /The run continues and makes this tool call once/);
  const held: ApprovalItem = { ...tool, kind: 'held', agentId: 'castle' };
  assert.match(approveConfirm(held, { linkedIn: true }), /goes live on your LinkedIn profile/);
  assert.match(rejectConfirm(needs, 'too much'), /with your notes/);
  assert.match(rejectConfirm(needs, ''), /told it was rejected/);
  assert.equal(rejectConfirm(needs, '').includes('revised version'), false);
  assert.match(rejectConfirm(held, 'change the hook'), /revised version/);
});

it('#520: a non-https link is not turned into an anchor', () => {
  const card = decisionCard(decision({ hold: { ...decision().hold!, link: 'javascript:alert(1)' } }));
  assert.equal(card?.link, undefined);
});

it('#520: a held LinkedIn post keeps its label', () => {
  const held: ApprovalItem = {
    approvalId: 'h',
    agentId: 'castle',
    runId: 'r',
    route: 'linkedin',
    tool: 'POST /rest/posts',
    argsSha256: 'h',
    state: 'pending',
    requestedAt,
    kind: 'held',
    request: { method: 'POST', path: '/rest/posts', headers: {}, body: '{}', bodyEncoding: 'utf8', preview: 'linkedin-post' },
  };
  assert.equal(approvalLabel(held), 'LinkedIn post');
  assert.equal(isDecisionHold(held), false);
});
