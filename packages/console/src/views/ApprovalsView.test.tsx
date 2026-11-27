// #520: the Approvals page renders a decision hold (with and without a budget) and leaves egress cards alone.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalItem, HeldRequestCopy } from '../api/types.js';
import { DECISION_PAGE_INTRO, EGRESS_PAGE_INTRO, STORIES_NOT_FILED } from './approvals-model.js';
import { ApprovalsPanel, ApprovalsView } from './ApprovalsView.js';

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
      summary: 'Nothing goes to the story-breaker until you approve.',
      link: 'https://github.com/getdraft/draftsman/pull/371',
      requiresCap: true,
      approvers: ['dsackr'],
      payload: {
        budget: {
          total_expected_usd: 12.5,
          total_p90_usd: 16.63,
          by_agent: [{ stage: 'build', role: 'implementer', model: 'claude-sonnet', cost_usd: 9.25 }],
        },
      },
    },
    ...over,
  };
}

const linkedinBody = JSON.stringify({
  commentary: 'Hello team',
  visibility: 'PUBLIC',
  lifecycleState: 'PUBLISHED',
});

const heldRequest: HeldRequestCopy = {
  method: 'POST',
  path: '/rest/posts',
  headers: { 'content-type': 'application/json' },
  body: linkedinBody,
  bodyEncoding: 'utf8',
  preview: 'linkedin-post',
};

const linkedin: ApprovalItem = {
  approvalId: 'held-1',
  agentId: 'castle',
  runId: 'run-held',
  route: 'linkedin',
  tool: 'POST /rest/posts',
  argsSha256: 'deadbeef',
  state: 'pending',
  requestedAt,
  kind: 'held',
  request: heldRequest,
};

const toolCall: ApprovalItem = {
  approvalId: 'tool-1',
  agentId: 'echo',
  runId: 'run-tool',
  route: 'mcp',
  tool: 'shell.exec',
  argsSha256: 'abc123',
  state: 'pending',
  requestedAt,
};

function html(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function buttons(markup: string): string[] {
  return markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

function buttonLabeled(markup: string, label: string): string {
  const found = buttons(markup).find((b) => b.endsWith(`${label}</button>`));
  assert.ok(found, `no button labeled ${label}`);
  return found;
}

function isDisabled(button: string): boolean {
  const open = button.slice(0, button.indexOf('>'));
  return /(?:\s)disabled(?:[\s=/>]|$)/.test(open);
}

function capValue(markup: string): string | undefined {
  const tag = markup.match(/<input\b[^>]*id="approval-cap"[^>]*>/);
  if (!tag) return undefined;
  const value = tag[0].match(/\bvalue="([^"]*)"/);
  return value ? value[1] : '';
}

it('#520: a plan-budget hold shows the estimate, the role table, and a cap defaulting to P90', () => {
  const markup = html(<ApprovalsPanel approvals={[decision()]} onRefresh={() => {}} canDecide />);
  assert.match(markup, new RegExp(DECISION_PAGE_INTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(markup.includes(EGRESS_PAGE_INTRO), false);
  assert.match(markup, /Budget for plan Add subtract\(a, b\)/);
  assert.match(markup, /story-breaker until you approve/);
  assert.match(markup, /href="https:\/\/github.com\/getdraft\/draftsman\/pull\/371"/);
  assert.match(markup, /Plan pull request/);
  assert.match(markup, /beercanlabs-conductor/);
  assert.match(markup, /2121516d-6817-402d-ad2a-9318445fcb7a/);
  assert.match(markup, /The run is not paused/);
  assert.match(markup, /Expected/);
  assert.match(markup, /\$12\.50/);
  assert.match(markup, /P90/);
  assert.match(markup, /\$16\.63/);
  assert.match(markup, /implementer/);
  assert.match(markup, /claude-sonnet/);
  assert.match(markup, /\$9\.25/);
  assert.match(markup, /Approvers: dsackr/);
  assert.match(markup, new RegExp(STORIES_NOT_FILED));
  assert.equal(capValue(markup), '16.63');
  assert.match(markup, /Defaults to the P90 estimate/);
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), false);
  assert.equal(isDisabled(buttonLabeled(markup, 'Reject')), false);
  assert.equal(markup.includes('Tool call'), false);
  assert.equal(markup.includes('paused until you decide'), false);
  assert.equal(markup.includes('arguments sha256'), false);
  assert.equal(markup.includes('Approving sends exactly what you see'), false);
});

it('#520: without a budget payload the card still names the plan and blocks Approve until a cap is entered', () => {
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
  const markup = html(<ApprovalsPanel approvals={[item]} onRefresh={() => {}} canDecide />);
  assert.match(markup, /Budget for plan Add subtract\(a, b\)/);
  assert.match(markup, /href="https:\/\/github.com\/BeerCanLabs\/sdlc-sandbox\/pull\/4"/);
  assert.match(markup, /beercanlabs-conductor/);
  assert.match(markup, /asked in run/);
  assert.match(markup, new RegExp(STORIES_NOT_FILED));
  assert.equal(markup.includes('Expected'), false);
  assert.equal(markup.includes('P90'), false);
  assert.equal(capValue(markup), '');
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), true);
  assert.equal(isDisabled(buttonLabeled(markup, 'Reject')), false);
  assert.match(markup, /Enter a dollar amount/);
});

it('#520: story and DoR rows replace the not-filed line', () => {
  const item = decision({
    hold: {
      ...decision().hold!,
      payload: {
        stories: [{ title: 'Add subtract(a, b)', dor_status: 'ready', dod_status: 'not started' }],
        budget: { total_expected_usd: 8, total_p90_usd: 10.33 },
      },
    },
  });
  const markup = html(<ApprovalsPanel approvals={[item]} onRefresh={() => {}} canDecide />);
  assert.match(markup, /Add subtract\(a, b\)/);
  assert.match(markup, />ready</);
  assert.match(markup, /not started/);
  assert.equal(markup.includes(STORIES_NOT_FILED), false);
  assert.equal(capValue(markup), '10.33');
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), false);
});

it('#520: an empty or invalid cap blocks Approve and leaves Reject available', () => {
  const empty = html(<ApprovalsPanel approvals={[decision()]} onRefresh={() => {}} canDecide initialCap="" />);
  assert.equal(capValue(empty), '');
  assert.equal(isDisabled(buttonLabeled(empty, 'Approve')), true);
  assert.equal(isDisabled(buttonLabeled(empty, 'Reject')), false);

  const invalid = html(<ApprovalsPanel approvals={[decision()]} onRefresh={() => {}} canDecide initialCap="lots" />);
  assert.equal(capValue(invalid), 'lots');
  assert.equal(isDisabled(buttonLabeled(invalid, 'Approve')), true);
  assert.match(invalid, /Enter a dollar amount/);
});

it('#520: a decision that does not require a cap has no cap field', () => {
  const item = decision({ hold: { ...decision().hold!, requiresCap: false } });
  const markup = html(<ApprovalsPanel approvals={[item]} onRefresh={() => {}} canDecide />);
  assert.equal(capValue(markup), undefined);
  assert.equal(markup.includes('Spending cap'), false);
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), false);
  assert.match(markup, /The run is not paused/);
  assert.equal(markup.includes(EGRESS_PAGE_INTRO), false);
});

it('#520: a held LinkedIn post still renders the egress card', () => {
  const markup = html(<ApprovalsPanel approvals={[linkedin]} onRefresh={() => {}} canDecide />);
  assert.match(markup, new RegExp(EGRESS_PAGE_INTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /Your LinkedIn profile/);
  assert.match(markup, /Hello team/);
  assert.match(markup, /Drafted by/);
  assert.match(markup, /castle/);
  assert.match(markup, /Publishes when approved/);
  assert.equal(buttonLabeled(markup, 'Approve and post').includes('Approve and post'), true);
  assert.match(markup, /Send back with notes/);
  assert.match(markup, /Show exact request/);
  assert.equal(markup.includes(STORIES_NOT_FILED), false);
  assert.equal(markup.includes('Spending cap'), false);
  assert.equal(markup.includes('The run is not paused'), false);
  assert.equal(markup.includes(DECISION_PAGE_INTRO), false);
  assert.equal(markup.includes('paused until you decide'), false);
});

it('#520: a tool-call approval still says the run is paused and shows the arguments hash', () => {
  const markup = html(<ApprovalsPanel approvals={[toolCall]} onRefresh={() => {}} canDecide />);
  assert.match(markup, new RegExp(EGRESS_PAGE_INTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /Tool call/);
  assert.match(markup, /shell\.exec/);
  assert.match(markup, /Its run is paused until you decide/);
  assert.match(markup, /arguments sha256 abc123/);
  assert.match(markup, /echo via route/);
  assert.match(markup, /run-tool/);
  assert.equal(capValue(markup), undefined);
  assert.equal(markup.includes(STORIES_NOT_FILED), false);
  assert.equal(markup.includes('The run is not paused'), false);
  assert.equal(markup.includes('Spending cap'), false);
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), false);
});

it('#520: the signed-out Approvals view still shows the decision and keeps Approve off', () => {
  const markup = html(<ApprovalsView approvals={[decision()]} onRefresh={() => {}} />);
  assert.match(markup, /\$16\.63/);
  assert.match(markup, /Deciding needs the approver role/);
  assert.equal(isDisabled(buttonLabeled(markup, 'Approve')), true);
});

it('#520: an empty queue keeps the egress empty state', () => {
  const markup = html(<ApprovalsPanel approvals={[]} onRefresh={() => {}} canDecide />);
  assert.match(markup, /Nothing waiting for you/);
  assert.match(markup, /Posts and other actions an agent takes in your name/);
  assert.match(markup, new RegExp(EGRESS_PAGE_INTRO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
