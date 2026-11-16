/**
 * GAP-258: GitHub webhooks into an agent's own `/hooks/:agentId`, for the event-driven SDLC fleet (no timer, no poll).
 *
 * - The delivery's `X-GitHub-Event` and `X-GitHub-Delivery` go into the run input (`githubEvent`, `githubDelivery`), only
 *   for a delivery signed with `X-Hub-Signature-256`; the legacy `x-factory-secret` header never carries them.
 * - An agent's own GitHub App signs with the app's webhook secret, which the manifest flow stored
 *   (`GITHUB_APP_<AGENT>_WEBHOOK_SECRET`). It is tried first, so an agent with or without a cartridge webhook trigger
 *   gets its app's deliveries. An app delivery must carry `X-GitHub-Delivery` (400 otherwise).
 * - An agent that adopted the `sdlc-conductor` skill gets each GitHub event mapped to one conductor event (the
 *   agentic-sdlc `sdlc-on-event` names, docs/INTAKE.md "Event table"), only from its own app, and only when its app slug
 *   is stored (`GITHUB_APP_<AGENT>_SLUG`): without it the conductor cannot tell its own labels and comments, so nothing
 *   is mapped (fail closed). An event with no mapping starts no run. The conductor re-reads live state for every
 *   event, so the mapping only says which handler to wake, never what is true.
 * - #483: an agent that adopted the `sdlc-ops` skill gets a completed `workflow_run` from its own app (slug stored,
 *   as above) mapped to one `workflow-completed` event for `sdlc-ops-deploy`, so the ops leader dispatches a deploy,
 *   exits, and is woken by its completion. It re-reads that workflow run from GitHub once before acting.
 * - Each delivery id starts at most one run per agent: a redelivery answers with the first run and starts nothing.
 *   GitHub signs the body, not the id, so an app delivery is also deduplicated on the body's sha256 (same window).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The skill whose agents receive mapped conductor events. */
export const CONDUCTOR_SKILL = 'sdlc-conductor';
export const PLAN_LABEL = 'sdlc:plan';
export const PLAN_BRANCH_PREFIX = 'sdlc/plan-';
const REVIEW_LABELS = new Set(['ready-to-merge', 'needs-split', 'review-error']);
const READY_LABEL = 'ready';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
/** A GitHub delivery id (a GUID) or another sender's id: short, plain. */
export const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
export const GITHUB_EVENT = /^[a-z_]{1,64}$/;

export type ConductorEvent = { type: string; [k: string]: unknown };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const labelsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((l) => str(obj(l).name)).filter(Boolean) : []);

/**
 * The conductor event for one GitHub delivery, or a reason it maps to nothing. `self` is the agent's own app login
 * (`<slug>[bot]`): its own labels and comments never wake it again (they would only loop), but its merges and the
 * PRs it opens still do, because the next step hangs on them.
 */
export function conductorEventFor(event: string, payload: unknown, self?: string): { event: ConductorEvent } | { ignored: string } {
  const p = obj(payload);
  const action = str(p.action);
  const repo = str(obj(p.repository).full_name);
  if (event === 'ping') return { ignored: 'ping' };
  if (!REPO.test(repo)) return { ignored: 'no repository' };
  const sender = str(obj(p.sender).login).toLowerCase();
  const bySelf = Boolean(self) && sender === self!.toLowerCase();
  const added = str(obj(p.label).name);

  if (event === 'issues') {
    const issue = obj(p.issue);
    const n = num(issue.number);
    if (!n || issue.pull_request) return { ignored: 'not an issue' };
    if (bySelf && (action === 'labeled' || action === 'unlabeled' || action === 'edited')) return { ignored: 'the agent\'s own change' };
    const isPlan = labelsOf(issue.labels).includes(PLAN_LABEL);
    if (isPlan && ['opened', 'edited', 'reopened'].includes(action)) return { event: { type: 'plan-submitted', repo, issue: n } };
    if (action === 'labeled' && added === PLAN_LABEL) return { event: { type: 'plan-submitted', repo, issue: n } };
    if (action === 'labeled' && added.startsWith('triage:')) return { event: { type: 'triage-result', repo, issue: n } };
    if (action === 'labeled' && added === READY_LABEL) return { event: { type: 'story-ready', repo } };
    if (action === 'opened' && !isPlan) return { event: { type: 'issue-opened', repo, issue: n } };
    return { ignored: `issues.${action || 'unknown'}` };
  }

  if (event === 'issue_comment') {
    if (action !== 'created') return { ignored: `issue_comment.${action || 'unknown'}` };
    if (bySelf) return { ignored: 'the agent\'s own comment' };
    const issue = obj(p.issue);
    const comment = obj(p.comment);
    const n = num(issue.number);
    const id = num(comment.id);
    const body = str(comment.body);
    if (!n || !id) return { ignored: 'no issue or comment' };
    if (/^\s*\/(approve|reject)\b/i.test(body)) return { event: { type: 'approval-signal', repo, number: n, comment_id: id } };
    if (issue.pull_request && body.includes('<!-- sdlc-review:')) return { event: { type: 'review-outcome', repo, pr: n } };
    if (!issue.pull_request && body.includes('<!-- sdlc-triage:')) return { event: { type: 'triage-result', repo, issue: n } };
    return { ignored: 'a comment with no fleet marker' };
  }

  if (event === 'pull_request') {
    const pr = obj(p.pull_request);
    const n = num(pr.number) ?? num(p.number);
    if (!n) return { ignored: 'no pull request' };
    if (['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action)) return { event: { type: 'pr-updated', repo, pr: n } };
    if (action === 'closed') {
      if (pr.merged === true) return { event: { type: str(obj(pr.head).ref).startsWith(PLAN_BRANCH_PREFIX) ? 'plan-merged' : 'pr-merged', repo, pr: n } };
      // A reviewer's close (third send-back) is a review outcome; the conductor reads the reviewer's own marker.
      return { event: { type: 'review-outcome', repo, pr: n } };
    }
    if (action === 'labeled' && !bySelf && REVIEW_LABELS.has(added)) return { event: { type: 'review-outcome', repo, pr: n } };
    return { ignored: `pull_request.${action || 'unknown'}` };
  }

  if (event === 'check_suite') {
    const sha = str(obj(p.check_suite).head_sha);
    if (action === 'completed' && SHA.test(sha)) return { event: { type: 'check-completed', repo, sha } };
    return { ignored: `check_suite.${action || 'unknown'}` };
  }

  if (event === 'status') {
    const sha = str(p.sha);
    if (['success', 'failure', 'error'].includes(str(p.state)) && SHA.test(sha)) return { event: { type: 'check-completed', repo, sha } };
    return { ignored: 'status pending' };
  }

  // check_run: its check suite completes too, and that one event is enough (one wake per CI result, not per job).
  return { ignored: `${event} is not mapped` };
}

/** #483: the skill whose agents receive `workflow_run` completions. */
export const OPS_SKILL = 'sdlc-ops';
const WORKFLOW_PATH = /^[A-Za-z0-9_.@/-]{1,255}$/;
const CONCLUSION = /^[a-z_]{1,32}$/;

/** #483: the ops leader's event for one delivery: only a completed workflow run, with every field checked. */
export function opsEventFor(event: string, payload: unknown): { event: ConductorEvent } | { ignored: string } {
  const p = obj(payload);
  const action = str(p.action);
  if (event === 'ping') return { ignored: 'ping' };
  if (event !== 'workflow_run') return { ignored: `${event} is not mapped for the ops agent` };
  if (action !== 'completed') return { ignored: `workflow_run.${action || 'unknown'}` };
  const repo = str(obj(p.repository).full_name);
  const w = obj(p.workflow_run);
  const runId = num(w.id);
  const sha = str(w.head_sha);
  if (!REPO.test(repo)) return { ignored: 'no repository' };
  if (!runId) return { ignored: 'no workflow run id' };
  if (!SHA.test(sha)) return { ignored: 'no head sha' };
  const workflowId = num(w.workflow_id);
  const path = str(w.path);
  const trigger = str(w.event);
  const conclusion = str(w.conclusion);
  if (!workflowId || !WORKFLOW_PATH.test(path) || !GITHUB_EVENT.test(trigger) || !CONCLUSION.test(conclusion)) return { ignored: 'workflow run fields are missing or malformed' };
  return {
    event: { type: 'workflow-completed', repo, run_id: runId, workflow_id: workflowId, workflow_path: path, head_sha: sha, event: trigger, conclusion, run_attempt: num(w.run_attempt) ?? 1 },
  };
}

/** The run input for a mapped event: the event itself and the instruction the conductor's runtime turn follows. */
export function conductorInput(ev: ConductorEvent, githubEvent: string, githubDelivery: string | undefined, tool = 'sdlc-on-event'): Record<string, unknown> {
  const args = { event: ev };
  return {
    ...args,
    githubEvent,
    ...(githubDelivery ? { githubDelivery } : {}),
    message: `GitHub sent a ${githubEvent} webhook${githubDelivery ? ` (delivery ${githubDelivery})` : ''}.\nCall ${tool} with exactly these arguments, then report its outcome.\n${JSON.stringify(args)}`,
  };
}

type Seen = { runId?: string; at: number };
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 5000;

/**
 * Delivery ids already handled, per agent. On disk beside the registry when there is one (a restart must not run a
 * redelivered event twice), else in memory. A delivery is claimed before its run is created and released if that fails,
 * so two copies arriving at once start one run, and a failed one can be redelivered.
 */
export class DeliveryLog {
  private readonly agents = new Map<string, Map<string, Seen>>();
  constructor(private readonly dir?: string) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private load(agentId: string): Map<string, Seen> {
    let m = this.agents.get(agentId);
    if (m) return m;
    m = new Map();
    if (this.dir) {
      try {
        const saved = JSON.parse(readFileSync(join(this.dir, `${agentId}.json`), 'utf8')) as Record<string, Seen>;
        for (const [k, v] of Object.entries(saved)) if (DELIVERY_ID.test(k) && typeof v?.at === 'number') m.set(k, v);
      } catch {
        /* none yet, or unreadable: start empty */
      }
    }
    this.agents.set(agentId, m);
    return m;
  }

  private save(agentId: string, m: Map<string, Seen>) {
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
    while (m.size > KEEP_MAX) m.delete(m.keys().next().value as string);
    if (!this.dir) return;
    const path = join(this.dir, `${agentId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
    renameSync(tmp, path);
  }

  /** Claims the delivery; undefined when it was new, else what the first one did. */
  claim(agentId: string, delivery: string): Seen | undefined {
    const m = this.load(agentId);
    const prior = m.get(delivery);
    if (prior) return prior;
    m.set(delivery, { at: Date.now() });
    this.save(agentId, m);
    return undefined;
  }

  done(agentId: string, delivery: string, runId: string | undefined) {
    const m = this.load(agentId);
    m.set(delivery, { at: Date.now(), ...(runId ? { runId } : {}) });
    this.save(agentId, m);
  }

  release(agentId: string, delivery: string) {
    const m = this.load(agentId);
    if (m.delete(delivery)) this.save(agentId, m);
  }
}
