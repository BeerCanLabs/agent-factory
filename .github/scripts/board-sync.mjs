#!/usr/bin/env node
/**
 * Board 4 (Agent Factory Sprint Board) status sync.
 *
 * Looks up option IDs by name at runtime. Never checks out or evaluates
 * untrusted pull-request code; this file is loaded only from a trusted ref.
 *
 * This script never creates, edits, or deletes project views, and never
 * mutates the Status option list. Columns are fixed: Backlog, Ready,
 * Current Sprint, Next Sprint, In Progress, In Review, Done.
 */
export const PROJECT_ID = process.env.BOARD4_PROJECT_ID || "PVT_kwDOEz3Oo84BthuH";
export const STATUS_FIELD_ID =
  process.env.BOARD4_STATUS_FIELD_ID || "PVTSSF_lADOEz3Oo84BthuHzhrqyzA";

export const STATUS = Object.freeze({
  Backlog: "Backlog",
  Ready: "Ready",
  CurrentSprint: "Current Sprint",
  NextSprint: "Next Sprint",
  InProgress: "In Progress",
  InReview: "In Review",
  Done: "Done",
});

/** Known Board 4 Status option IDs (looked up by name at runtime). */
export const STATUS_OPTION_IDS = Object.freeze({
  [STATUS.Backlog]: "64c68335",
  [STATUS.Ready]: "c92c9402",
  [STATUS.CurrentSprint]: "85a021e4",
  [STATUS.NextSprint]: "4cb8cbef",
  [STATUS.InProgress]: "c0e46748",
  [STATUS.InReview]: "80d29416",
  [STATUS.Done]: "79d2d4c4",
});

/** Phoenix has no DST; offsets are always UTC-7. */
export const PHOENIX_OFFSET_MS = 7 * 60 * 60 * 1000;
export const SPRINT_HOURS = Object.freeze([0, 4, 8, 12, 16, 20]);
export const LATCH_MARKER_RE = /<!-- board-sync-boundary:([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:00) -->/;

export function phoenixParts(date) {
  const shifted = new Date(date.getTime() - PHOENIX_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function formatWindowKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:00`;
}

export function sprintWindow(date) {
  const parts = phoenixParts(date);
  const startHour = Math.floor(parts.hour / 4) * 4;
  const start = { year: parts.year, month: parts.month, day: parts.day, hour: startHour, minute: 0 };
  return {
    currentName: formatWindowKey(start),
    current: start,
    minutesInto: (parts.hour - startHour) * 60 + parts.minute,
  };
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/** Window key this boundary is for: the upcoming start if we are in the last few minutes, otherwise the current window start. */
export function boundaryKey(date, { beforeMinutes = 5 } = {}) {
  const w = sprintWindow(date);
  if (w.minutesInto >= 4 * 60 - beforeMinutes) {
    return formatWindowKey(phoenixParts(addMinutes(date, beforeMinutes)));
  }
  const start = { ...w.current, hour: w.current.hour };
  return formatWindowKey(start);
}

export function isNearBoundary(date, { afterMinutes = 10, beforeMinutes = 5 } = {}) {
  const into = sprintWindow(date).minutesInto;
  return into <= afterMinutes || into >= 4 * 60 - beforeMinutes;
}

export function isSprintStatus(name) {
  return name === STATUS.CurrentSprint || name === STATUS.NextSprint;
}

export function parseClosingIssueNumbers(text, { owner = "BeerCanLabs", repo = "agent-factory" } = {}) {
  if (!text) return [];
  const out = new Set();
  let m;
  const full = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(([\w.-]+\/[\w.-]+)?#(\d+))/gi;
  while ((m = full.exec(text))) {
    const repoPart = m[2];
    const num = Number(m[3]);
    if (!Number.isInteger(num) || num <= 0) continue;
    if (!repoPart || repoPart.toLowerCase() === `${owner}/${repo}`.toLowerCase()) {
      out.add(num);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function isClaimComment(body) {
  return /\*\*Claimed\b/i.test(body || "");
}

export function hasLabel(labels, name) {
  const want = name.toLowerCase();
  return (labels || []).some((l) => String(l).toLowerCase() === want);
}

/**
 * Decide the Board 4 column for one issue or pull request.
 * Returns { target, reason } where target is null for "do not move".
 */
export function decideTargetStatus(ctx) {
  const open = ctx.state === "open" || ctx.state === "OPEN";
  const closed = ctx.state === "closed" || ctx.state === "CLOSED";
  const reason = (ctx.stateReason || "").toLowerCase();
  const notPlanned = reason === "not_planned";
  const completed = reason === "completed" || reason === "";

  if (ctx.kind === "pull_request") {
    if (ctx.merged) {
      return { target: STATUS.Done, reason: "pr-merged" };
    }
    if (closed) {
      return { target: null, reason: "pr-closed-unmerged" };
    }
    if (open && !ctx.draft) {
      return { target: STATUS.InReview, reason: "pr-open" };
    }
    return { target: null, reason: "pr-draft-or-other" };
  }

  if (closed && notPlanned) {
    return { target: null, reason: "issue-closed-not-planned" };
  }
  if (closed && completed) {
    return { target: STATUS.Done, reason: "issue-closed-completed" };
  }
  if (open && (hasLabel(ctx.labels, "in-review") || ctx.hasOpenNonDraftClosingPr)) {
    return { target: STATUS.InReview, reason: ctx.hasOpenNonDraftClosingPr ? "open-closing-pr" : "in-review-label" };
  }
  if (
    open &&
    (hasLabel(ctx.labels, "in-progress") ||
      ctx.hasAssignee ||
      isClaimComment(ctx.commentBody))
  ) {
    return { target: STATUS.InProgress, reason: hasLabel(ctx.labels, "in-progress")
      ? "in-progress-label"
      : ctx.hasAssignee
        ? "assignee"
        : "claim-comment" };
  }
  return { target: null, reason: "no-signal" };
}

/**
 * Whether a status change should be applied.
 * Never moves backward from Done unless the item is open again (reopened).
 * The only other backward move is In Review → Ready when a linking PR closed unmerged.
 * Claim / PR / merge may leave Current Sprint or Next Sprint toward In Progress,
 * In Review, or Done. The boundary job may shift Next Sprint → Current Sprint.
 */
export function shouldApplyMove({ currentStatus, target, reason, itemIsOpen }) {
  if (!target) return false;
  if (currentStatus === target) return false;
  if (currentStatus === STATUS.Done && target !== STATUS.Done) {
    return Boolean(itemIsOpen);
  }
  const started = new Set([STATUS.InProgress, STATUS.InReview, STATUS.Done]);
  const backwardTargets = new Set([STATUS.Backlog, STATUS.Ready, STATUS.CurrentSprint, STATUS.NextSprint]);
  if (isSprintStatus(currentStatus)) {
    if (target === STATUS.InProgress || target === STATUS.InReview || target === STATUS.Done) {
      return true;
    }
    if (currentStatus === STATUS.NextSprint && target === STATUS.CurrentSprint && reason === "sprint-shift") {
      return true;
    }
    return false;
  }
  if (started.has(currentStatus) && backwardTargets.has(target)) {
    if (currentStatus === STATUS.InReview && target === STATUS.Ready && reason === "pr-closed-unmerged") {
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Boundary shift at a 4-hour bell. Does not create or delete columns.
 * Order: every Current Sprint card → In Progress, then every Next Sprint card → Current Sprint.
 * Mid-window runs no-op unless force is set, so a dispatch at 16:36 does not flush the current sprint.
 * A recorded window key makes a second run at the same bell a no-op (the 4-hour orchestrator is a backstop).
 */
export function decideBoundaryActions({
  now,
  items,
  alreadyCompletedKeys = [],
  force = false,
  afterMinutes = 10,
  beforeMinutes = 5,
} = {}) {
  const key = boundaryKey(now, { beforeMinutes });
  const near = isNearBoundary(now, { afterMinutes, beforeMinutes });
  const base = { key, near, movesToInProgress: [], movesToCurrent: [] };
  if (alreadyCompletedKeys.includes(key)) {
    return { ...base, skip: true, reason: "already-completed" };
  }
  if (!force && !near) {
    return { ...base, skip: true, reason: "not-near-boundary" };
  }
  const currentCards = (items || []).filter((it) => it.statusName === STATUS.CurrentSprint);
  const nextCards = (items || []).filter((it) => it.statusName === STATUS.NextSprint);
  return {
    ...base,
    skip: false,
    reason: "shift",
    movesToInProgress: currentCards.map((it) => ({
      itemId: it.itemId,
      number: it.number,
      title: it.title,
      from: STATUS.CurrentSprint,
      to: STATUS.InProgress,
    })),
    movesToCurrent: nextCards.map((it) => ({
      itemId: it.itemId,
      number: it.number,
      title: it.title,
      from: STATUS.NextSprint,
      to: STATUS.CurrentSprint,
    })),
  };
}

function latchCommentBody(actions) {
  return [
    `<!-- board-sync-boundary:${actions.key} -->`,
    `Board-sync boundary for ${actions.key} MST completed: `,
    `${actions.movesToInProgress.length} card(s) Current Sprint → In Progress, `,
    `${actions.movesToCurrent.length} card(s) Next Sprint → Current Sprint.`,
  ].join("");
}

export function parseLatchKeys(comments) {
  const keys = [];
  for (const c of comments || []) {
    const m = LATCH_MARKER_RE.exec(c.body || c);
    if (m) keys.push(m[1]);
  }
  return keys;
}

export async function readCompletedBoundaryKeys(token, latchIssue, { fetchImpl, log = console, owner = "BeerCanLabs", repo = "agent-factory" } = {}) {
  if (!latchIssue) return [];
  try {
    const data = await githubGraphql(
      token,
      `query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            comments(last: 40) { nodes { body } }
          }
        }
      }`,
      { owner, name: repo, number: Number(latchIssue) },
      { fetchImpl },
    );
    return parseLatchKeys(data.repository?.issue?.comments?.nodes || []);
  } catch (err) {
    log.warn?.(`Could not read boundary latch on #${latchIssue}: ${err.message}`);
    return [];
  }
}

export async function recordBoundaryCompleted(token, actions, latchIssue, { fetchImpl, log = console, owner = "BeerCanLabs", repo = "agent-factory" } = {}) {
  if (!latchIssue) return;
  try {
    const data = await githubGraphql(
      token,
      `query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) { id } }
      }`,
      { owner, name: repo, number: Number(latchIssue) },
      { fetchImpl },
    );
    const id = data.repository?.issue?.id;
    if (!id) return;
    await githubGraphql(
      token,
      `mutation ($id: ID!, $body: String!) {
        addComment(input: { subjectId: $id, body: $body }) { comment { id } }
      }`,
      { id, body: latchCommentBody(actions) },
      { fetchImpl },
    );
  } catch (err) {
    log.warn?.(`Could not record boundary latch on #${latchIssue}: ${err.message}`);
  }
}

export function shouldHandleIssueComment(event) {
  if (event?.action !== "created") return false;
  return isClaimComment(event.comment?.body);
}

export function labelsFrom(entity) {
  const labels = entity?.labels || [];
  if (Array.isArray(labels)) {
    return labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  }
  if (Array.isArray(labels.nodes)) {
    return labels.nodes.map((l) => l.name).filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// GitHub GraphQL I/O (used by the workflow; unit tests inject a fake client)
// ---------------------------------------------------------------------------

const GQL_OPTIONS = `
  query ($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        id
        field(name: "Status") {
          ... on ProjectV2SingleSelectField {
            id
            options { id name color description }
          }
        }
      }
    }
  }
`;

const GQL_ITEMS = `
  query ($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
            content {
              __typename
              ... on Issue {
                id number title state stateReason url
                labels(first: 40) { nodes { name } }
                assignees(first: 10) { nodes { login } }
                repository { nameWithOwner }
              }
              ... on PullRequest {
                id number title state url isDraft merged
                labels(first: 40) { nodes { name } }
                body
                repository { nameWithOwner }
                closingIssuesReferences(first: 20) { nodes { number id } }
              }
              ... on DraftIssue { id title }
            }
          }
        }
      }
    }
  }
`;

export function normalizeItem(node) {
  const content = node.content || {};
  const status = node.fieldValueByName || {};
  return {
    itemId: node.id,
    statusName: status.name || null,
    statusOptionId: status.optionId || null,
    contentId: content.id || null,
    kind: content.__typename === "PullRequest" ? "pull_request"
      : content.__typename === "Issue" ? "issue"
      : content.__typename || "unknown",
    number: content.number ?? null,
    title: content.title || "",
    state: content.state || null,
    stateReason: content.stateReason || null,
    url: content.url || null,
    repo: content.repository?.nameWithOwner || null,
    draft: Boolean(content.isDraft),
    merged: Boolean(content.merged),
    labels: labelsFrom(content),
    hasAssignee: Boolean(content.assignees?.nodes?.length),
    closingIssueNumbers: (content.closingIssuesReferences?.nodes || []).map((n) => n.number),
  };
}

export async function githubGraphql(token, query, variables, { fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "beercanlabs-board-sync",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GraphQL non-JSON (${res.status}): ${text.slice(0, 400)}`);
  }
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors || body, null, 2).slice(0, 2000)}`);
  }
  return body.data;
}

export async function loadProjectState(token, { fetchImpl, projectId = PROJECT_ID } = {}) {
  const data = await githubGraphql(token, GQL_OPTIONS, { id: projectId }, { fetchImpl });
  const field = data.node?.field;
  if (!field?.id) throw new Error("Board 4 Status field not found");
  const items = [];
  let cursor = null;
  for (;;) {
    const page = await githubGraphql(token, GQL_ITEMS, { id: projectId, cursor }, { fetchImpl });
    const conn = page.node.items;
    for (const n of conn.nodes) items.push(normalizeItem(n));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { fieldId: field.id, options: field.options, items };
}

function optionIdByName(options, name) {
  const o = (options || []).find((x) => x.name === name);
  return o ? o.id : null;
}

export async function addItemToProject(token, contentId, { fetchImpl, projectId = PROJECT_ID } = {}) {
  const data = await githubGraphql(
    token,
    `mutation ($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId, contentId },
    { fetchImpl },
  );
  return data.addProjectV2ItemById.item.id;
}

export async function setItemStatus(token, itemId, optionId, { fetchImpl, projectId = PROJECT_ID, fieldId = STATUS_FIELD_ID } = {}) {
  await githubGraphql(
    token,
    `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, optionId },
    { fetchImpl },
  );
}

/**
 * Replace the Status option list. Callers must pass a payload produced by
 * buildStatusOptionPayload (every kept option has its existing id).
 * Re-reads items before and after; restores status if any card lost its value.
 */
export async function ensureItemOnProject(token, contentId, state, { fetchImpl, projectId = PROJECT_ID } = {}) {
  const found = state.items.find((it) => it.contentId === contentId);
  if (found) return { item: found, state };
  const itemId = await addItemToProject(token, contentId, { fetchImpl, projectId });
  const refreshed = await loadProjectState(token, { fetchImpl, projectId });
  const item = refreshed.items.find((it) => it.itemId === itemId) || {
    itemId,
    contentId,
    statusName: null,
  };
  return { item, state: refreshed };
}

export async function moveItem(token, item, target, state, { fetchImpl, projectId = PROJECT_ID, log = console, dryRun = false } = {}) {
  const optionId = optionIdByName(state.options, target);
  if (!optionId) throw new Error(`No Status option named ${target}`);
  if (item.statusName === target) {
    log.info?.(`Already ${target}: ${item.kind} #${item.number}`);
    return state;
  }
  if (dryRun) {
    log.info?.(`dry-run: would move ${item.kind} #${item.number} ${item.statusName} → ${target}`);
    return state;
  }
  await setItemStatus(token, item.itemId, optionId, { fetchImpl, projectId, fieldId: state.fieldId });
  log.info?.(`Moved ${item.kind} #${item.number} ${item.statusName} → ${target}`);
  item.statusName = target;
  return state;
}

async function fetchOpenClosingPrs(token, issueNumber, { fetchImpl, owner = "BeerCanLabs", repo = "agent-factory" } = {}) {
  // One page of open PRs is enough for this repo; also parse bodies.
  const data = await githubGraphql(
    token,
    `query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 50, states: OPEN) {
          nodes {
            number isDraft title body
            closingIssuesReferences(first: 20) { nodes { number } }
          }
        }
      }
    }`,
    { owner, name: repo },
    { fetchImpl },
  );
  const prs = data.repository.pullRequests.nodes || [];
  return prs.filter((pr) => {
    if (pr.isDraft) return false;
    const fromRefs = (pr.closingIssuesReferences?.nodes || []).some((n) => n.number === issueNumber);
    const fromText = parseClosingIssueNumbers(`${pr.title}\n${pr.body || ""}`).includes(issueNumber);
    return fromRefs || fromText;
  });
}

export function contextFromIssue(issue, extra = {}) {
  return {
    kind: "issue",
    state: issue.state,
    stateReason: issue.state_reason || issue.stateReason || null,
    merged: false,
    draft: false,
    labels: labelsFrom(issue),
    hasAssignee: Array.isArray(issue.assignees) ? issue.assignees.length > 0 : Boolean(issue.hasAssignee),
    hasOpenNonDraftClosingPr: Boolean(extra.hasOpenNonDraftClosingPr),
    currentStatus: extra.currentStatus || null,
    commentBody: extra.commentBody || null,
  };
}

export function contextFromPull(pr, extra = {}) {
  return {
    kind: "pull_request",
    state: pr.state,
    stateReason: null,
    merged: Boolean(pr.merged || pr.merged_at),
    draft: Boolean(pr.draft),
    labels: labelsFrom(pr),
    hasAssignee: false,
    hasOpenNonDraftClosingPr: false,
    currentStatus: extra.currentStatus || null,
  };
}

export async function syncFromEvent(token, event, eventName, { fetchImpl, log = console, dryRun = false, projectId = PROJECT_ID } = {}) {
  let state = await loadProjectState(token, { fetchImpl, projectId });
  const reports = [];

  const apply = async (contentId, ctx, meta) => {
    const decided = decideTargetStatus(ctx);
    const move = shouldApplyMove({
      currentStatus: ctx.currentStatus,
      target: decided.target,
      reason: decided.reason,
      itemIsOpen: ctx.state === "open" || ctx.state === "OPEN",
    });
    const rec = { ...meta, ...decided, currentStatus: ctx.currentStatus, applied: move };
    if (!move) {
      reports.push(rec);
      return;
    }
    const ensured = await ensureItemOnProject(token, contentId, state, { fetchImpl, projectId });
    state = ensured.state;
    rec.itemId = ensured.item.itemId;
    await moveItem(token, { ...ensured.item }, decided.target, state, { fetchImpl, projectId, log, dryRun });
    reports.push(rec);
  };

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pr = event.pull_request;
    const contentId = pr.node_id;
    const prItem = state.items.find((it) => it.contentId === contentId);
    const prCtx = contextFromPull(pr, { currentStatus: prItem?.statusName || null });
    const decidedPr = decideTargetStatus(prCtx);

    if (decidedPr.reason === "pr-closed-unmerged") {
      // Move linked issues that were In Review back to Ready (if no other In Review signal).
      const linked = new Set([
        ...parseClosingIssueNumbers(`${pr.title}\n${pr.body || ""}`),
        ...(prItem?.closingIssueNumbers || []),
      ]);
      // Also query closing refs if we have them on the payload only via body.
      for (const it of state.items) {
        if (it.kind !== "issue") continue;
        if (!linked.has(it.number)) continue;
        if (it.statusName !== STATUS.InReview) continue;
        const still = (await fetchOpenClosingPrs(token, it.number, { fetchImpl })).length > 0
          || hasLabel(it.labels, "in-review");
        if (still) continue;
        const move = shouldApplyMove({
          currentStatus: it.statusName,
          target: STATUS.Ready,
          reason: "pr-closed-unmerged",
          itemIsOpen: it.state === "OPEN" || it.state === "open",
        });
        if (move) {
          await moveItem(token, it, STATUS.Ready, state, { fetchImpl, projectId, log, dryRun });
          reports.push({ kind: "issue", number: it.number, target: STATUS.Ready, reason: "pr-closed-unmerged", applied: true });
        }
      }
      reports.push({ kind: "pull_request", number: pr.number, target: null, reason: "pr-closed-unmerged", applied: false });
      return reports;
    }

    await apply(contentId, prCtx, { kind: "pull_request", number: pr.number });

    const linkedNums = new Set(parseClosingIssueNumbers(`${pr.title}\n${pr.body || ""}`));
    // Prefer GraphQL closingIssueReferences when the PR is already on the board or via a fetch.
    const liveRefs = state.items.find((it) => it.contentId === contentId)?.closingIssueNumbers || [];
    for (const n of liveRefs) linkedNums.add(n);

    if (decidedPr.target === STATUS.Done || decidedPr.target === STATUS.InReview) {
      for (const it of state.items) {
        if (it.kind === "issue" && linkedNums.has(it.number)) {
          const issueCtx = {
            kind: "issue",
            state: decidedPr.target === STATUS.Done && !((it.state === "OPEN") || it.state === "open") ? "closed" : (it.state || "open"),
            stateReason: decidedPr.target === STATUS.Done ? "completed" : it.stateReason,
            merged: false,
            draft: false,
            labels: it.labels,
            hasAssignee: it.hasAssignee,
            hasOpenNonDraftClosingPr: decidedPr.target === STATUS.InReview,
            currentStatus: it.statusName,
          };
          // For a merge, force Done on closing issues (GitHub will close them as completed).
          if (decidedPr.target === STATUS.Done) {
            issueCtx.state = "closed";
            issueCtx.stateReason = "completed";
          }
          if (!it.contentId) continue;
          await apply(it.contentId, issueCtx, { kind: "issue", number: it.number });
        }
      }
      // Linked issues might not be on the board yet — parse numbers only; we need node IDs.
      // Reconcile / a later event will pick them up if they are missing here without IDs.
    }
    return reports;
  }

  if (eventName === "issues" || eventName === "issue_comment") {
    if (eventName === "issue_comment" && !shouldHandleIssueComment(event)) {
      return [{ reason: "ignored-comment", applied: false }];
    }
    const issue = event.issue;
    if (issue.pull_request) {
      // Comments on PRs arrive as issue_comment; skip unless we also want claim-on-PR.
      return [{ reason: "comment-on-pr", applied: false, number: issue.number }];
    }
    const contentId = issue.node_id;
    const existing = state.items.find((it) => it.contentId === contentId);
    const openPrs = await fetchOpenClosingPrs(token, issue.number, { fetchImpl });
    const ctx = contextFromIssue(issue, {
      currentStatus: existing?.statusName || null,
      hasOpenNonDraftClosingPr: openPrs.length > 0,
      commentBody: event.comment?.body || null,
    });
    await apply(contentId, ctx, { kind: "issue", number: issue.number });
    return reports;
  }

  log.info?.(`No sync action for event ${eventName}`);
  return reports;
}

export async function reconcileBoard(token, { fetchImpl, log = console, dryRun = false, projectId = PROJECT_ID } = {}) {
  let state = await loadProjectState(token, { fetchImpl, projectId });
  const reports = [];
  for (const it of state.items) {
    if (it.kind !== "issue" && it.kind !== "pull_request") continue;
    let ctx;
    if (it.kind === "pull_request") {
      ctx = {
        kind: "pull_request",
        state: it.merged ? "closed" : it.state,
        merged: it.merged,
        draft: it.draft,
        labels: it.labels,
        currentStatus: it.statusName,
      };
    } else {
      const openPrs = (it.state === "OPEN" || it.state === "open")
        ? await fetchOpenClosingPrs(token, it.number, { fetchImpl })
        : [];
      ctx = {
        kind: "issue",
        state: it.state,
        stateReason: it.stateReason,
        labels: it.labels,
        hasAssignee: it.hasAssignee,
        hasOpenNonDraftClosingPr: openPrs.length > 0,
        currentStatus: it.statusName,
      };
    }
    const decided = decideTargetStatus(ctx);
    const move = shouldApplyMove({
      currentStatus: it.statusName,
      target: decided.target,
      reason: decided.reason,
      itemIsOpen: it.state === "OPEN" || it.state === "open",
    });
    reports.push({ kind: it.kind, number: it.number, title: it.title, currentStatus: it.statusName, ...decided, applied: move });
    if (move) {
      await moveItem(token, it, decided.target, state, { fetchImpl, projectId, log, dryRun });
    }
  }
  return reports;
}

export async function runBoundary(token, { now = new Date(), fetchImpl, log = console, dryRun = false, projectId = PROJECT_ID, force = false, latchIssue, alreadyCompletedKeys } = {}) {
  const state = await loadProjectState(token, { fetchImpl, projectId });
  const completed = alreadyCompletedKeys ?? await readCompletedBoundaryKeys(token, latchIssue, { fetchImpl, log });
  const actions = decideBoundaryActions({ now, items: state.items, alreadyCompletedKeys: completed, force });
  if (actions.skip) {
    log.info?.(`Boundary skipped (${actions.reason}) for window ${actions.key}`);
    return actions;
  }
  log.info?.(`Boundary ${actions.key}: ${actions.movesToInProgress.length} Current Sprint → In Progress, then ${actions.movesToCurrent.length} Next Sprint → Current Sprint`);
  // Order matters: Current Sprint must empty into In Progress before Next Sprint shifts into it.
  for (const mv of actions.movesToInProgress) {
    const item = state.items.find((it) => it.itemId === mv.itemId);
    if (!item) continue;
    const move = shouldApplyMove({
      currentStatus: item.statusName,
      target: STATUS.InProgress,
      reason: "sprint-shift",
      itemIsOpen: true,
    });
    if (!move) {
      log.info?.(`Skipping ${item.kind} #${item.number}: will not move ${item.statusName} → In Progress`);
      continue;
    }
    await moveItem(token, item, STATUS.InProgress, state, { fetchImpl, projectId, log, dryRun });
  }
  for (const mv of actions.movesToCurrent) {
    const item = state.items.find((it) => it.itemId === mv.itemId);
    if (!item) continue;
    const move = shouldApplyMove({
      currentStatus: item.statusName,
      target: STATUS.CurrentSprint,
      reason: "sprint-shift",
      itemIsOpen: true,
    });
    if (!move) {
      log.info?.(`Skipping ${item.kind} #${item.number}: will not move ${item.statusName} → Current Sprint`);
      continue;
    }
    await moveItem(token, item, STATUS.CurrentSprint, state, { fetchImpl, projectId, log, dryRun });
  }
  if (!dryRun) {
    await recordBoundaryCompleted(token, actions, latchIssue, { fetchImpl, log });
  }
  return actions;
}

export function parseMode(event, eventName, inputs = {}) {
  if (inputs.mode && inputs.mode !== "auto") return inputs.mode;
  if (eventName === "schedule") return "boundary";
  if (eventName === "workflow_dispatch") return inputs.mode || "boundary";
  return "sync";
}

export async function main(env = process.env, { fetchImpl, log = console, readFile, argv } = {}) {
  const fs = await import("node:fs/promises");
  const read = readFile || ((p) => fs.readFile(p, "utf8"));
  const eventPath = env.GITHUB_EVENT_PATH;
  const eventName = env.GITHUB_EVENT_NAME || "";
  const event = eventPath ? JSON.parse(await read(eventPath)) : {};
  const inputs = event.inputs || {};
  const dryRun = inputs.dry_run === "true" || env.BOARD_SYNC_DRY_RUN === "1";
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || env.BOARD_SYNC_TOKEN;
  if (!token) throw new Error("GH_TOKEN (Grok-Flow app token) is required");
  const mode = parseMode(event, eventName, inputs);
  log.info?.(`board-sync mode=${mode} event=${eventName} dryRun=${dryRun}`);
  const force = inputs.force === "true" || env.BOARD_SYNC_FORCE === "1";
  const latchIssue = Number(env.BOARD_SYNC_LATCH_ISSUE || 628);
  if (mode === "boundary") {
    return runBoundary(token, { fetchImpl, log, dryRun, force, latchIssue });
  }
  if (mode === "reconcile") {
    return reconcileBoard(token, { fetchImpl, log, dryRun });
  }
  return syncFromEvent(token, event, eventName, { fetchImpl, log, dryRun });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
