/**
 * GAP-259: a decision an agent asks a person for, published as a generic approval.
 *
 * An agent with a live run puts a hold under its own key (`PUT /api/v1/agents/:agentId/holds/:requestKey`); asking again
 * returns the same approval. Nothing waits: the run goes on, and the decision reaches the agent through the existing
 * decision path when a person makes it (REST `POST /api/v1/approvals/:id` or MCP `decide_approval`, optionally with a cap).
 * The hold names its `approvers` (GitHub logins) and whether approving needs a cap (`requiresCap`); both are fixed when
 * it is asked. Only a person whose single linked, non-bot GitHub login is on the list may decide it (403 otherwise), and a
 * hold that needs a cap is never approved without one (400). The agent can read it back at any time with `GET` on the same
 * path, shaped `{state, cap_usd, by, comment}`: `by` is the GitHub login recorded when the decision was made, else null.
 * The console, channels and anything else that lists approvals show it because it is one; nothing is specific to a UI.
 */
import type http from 'node:http';
import { payloadHash, redactSecrets } from '@beercanlabs/factory-ledger';
import type { Approval, DecisionHold } from '@beercanlabs/factory-bouncer';
import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';
import { isTerminal } from '@beercanlabs/factory-property-manager';
import { bearerOf, json, readJson, requirePrivilege, visibleApprovals, type FactoryState } from './app.js';

/** The agent's own key: identifier characters plus what a GitHub reference needs (`plan-budget:owner/repo#12@sha`). */
export const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,199}$/;
const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_LINK = 2000;
const MAX_PAYLOAD = 32 * 1024;
/** Keys of the body that are the hold itself; anything else an agent sends is its payload. */
const OWN = new Set(['id', 'kind', 'title', 'summary', 'link', 'payload', 'approvers', 'requiresCap']);
/** A person's GitHub login (never an app's `[bot]` login, which cannot decide). */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_APPROVERS = 20;
/** `2500`, `2500.5`, `$2,500.00`: the amounts a person types; anything else is not a cap. */
const CAP_TEXT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/;

/** A cap in USD, from a number or the text a person types; `null` when it is not one. */
export function parseCapUsd(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(CAP_TEXT);
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, '')}${m[2] ?? ''}`);
  return Number.isFinite(n) && n <= 1e9 ? n : null;
}

/** The GitHub login a person linked (`github:<login>`), when exactly one is; a fleet checks approvers by login. */
export function githubLoginOf(state: FactoryState, actor: string | undefined): string | undefined {
  if (!actor) return undefined;
  const mine = (state.identityLinks?.list() ?? []).filter((l) => l.provider === 'github' && l.actor.toLowerCase() === actor.toLowerCase());
  return mine.length === 1 ? mine[0].id : undefined;
}

/**
 * GAP-259: may this person decide this hold? Only with exactly one linked GitHub login, not a `[bot]` login, that is on
 * the hold's approvers (case-insensitive). The login is the one recorded with the decision.
 */
export function holdDecider(state: FactoryState, a: Approval, actor: string): { ok: true; login: string } | { ok: false; error: string } {
  const login = githubLoginOf(state, actor);
  if (!login) return { ok: false, error: 'a decision hold is decided by a person with exactly one linked GitHub login' };
  if (/\[bot\]$/i.test(login)) return { ok: false, error: 'a bot login never decides a hold' };
  const approvers = (a.hold?.approvers ?? []).map((x) => x.toLowerCase());
  if (!approvers.includes(login.toLowerCase())) return { ok: false, error: 'your GitHub login is not one of this hold\'s approvers' };
  return { ok: true, login };
}

/** What the agent reads back. `by` is the GitHub login recorded when the decision was made, else null. */
export function holdView(state: FactoryState, a: Approval): Record<string, unknown> {
  const h = a.hold!;
  const decided = a.state !== 'pending';
  return {
    requestKey: h.requestKey,
    approvalId: a.approvalId,
    agentId: a.agentId,
    kind: h.kind,
    title: h.title,
    summary: h.summary,
    ...(h.link ? { link: h.link } : {}),
    ...(h.payload ? { payload: h.payload } : {}),
    // A decision is never spent; `consumed` is not a state a decision reaches, but read it as approved if it ever did.
    state: a.state === 'consumed' ? 'approved' : a.state,
    cap_usd: a.capUsd ?? null,
    by: decided ? (a.decidedGithubLogin ?? null) : null,
    approvers: h.approvers ?? [],
    requiresCap: Boolean(h.requiresCap),
    comment: a.notes ?? null,
    requestedAt: a.requestedAt,
    ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
    ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}),
  };
}

/** What a decision adds to the delivery the agent receives: its own key, the cap, and the event it handles. */
export function decisionDelivery(a: Approval): Record<string, unknown> {
  const h = a.hold!;
  return {
    requestKey: h.requestKey,
    holdKind: h.kind,
    ...(a.capUsd !== undefined ? { capUsd: a.capUsd } : {}),
    event: { type: 'approval-decided', request_id: h.requestKey },
    message: `The decision "${h.requestKey}" was made (${a.state}). Handle the event: {"type":"approval-decided","request_id":${JSON.stringify(h.requestKey)}}.`,
  };
}

type Parsed = { ok: true; hold: DecisionHold } | { ok: false; error: string };

function parseHold(requestKey: string, body: Record<string, unknown>, clean: (s: string) => string): Parsed {
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? clean(v.trim()) : undefined);
  const kind = body.kind === undefined ? 'decision' : typeof body.kind === 'string' && KIND.test(body.kind) ? body.kind : undefined;
  if (!kind) return { ok: false, error: 'kind must be a short lowercase name' };
  const title = text(body.title, MAX_TITLE);
  if (!title) return { ok: false, error: `title is required, at most ${MAX_TITLE} characters` };
  const summary = text(body.summary, MAX_SUMMARY);
  if (!summary) return { ok: false, error: `summary is required, at most ${MAX_SUMMARY} characters` };
  let link: string | undefined;
  if (body.link !== undefined && body.link !== null && body.link !== '') {
    let u: URL | undefined;
    try {
      u = typeof body.link === 'string' && body.link.length <= MAX_LINK ? new URL(body.link) : undefined;
    } catch {
      u = undefined;
    }
    if (!u || u.protocol !== 'https:' || u.username || u.password) return { ok: false, error: 'link must be an https URL' };
    link = u.toString();
  }
  const approvers = body.approvers;
  if (!Array.isArray(approvers) || !approvers.length || approvers.length > MAX_APPROVERS || !approvers.every((x) => typeof x === 'string' && GITHUB_LOGIN.test(x))) {
    return { ok: false, error: `approvers must list 1 to ${MAX_APPROVERS} people's GitHub logins (no [bot] logins)` };
  }
  if (body.requiresCap !== undefined && typeof body.requiresCap !== 'boolean') return { ok: false, error: 'requiresCap must be true or false' };
  let payload: Record<string, unknown> | undefined;
  if (body.payload !== undefined) {
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return { ok: false, error: 'payload must be a JSON object' };
    payload = body.payload as Record<string, unknown>;
  } else {
    const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !OWN.has(k)));
    if (Object.keys(rest).length) payload = rest;
  }
  if (payload) {
    const raw = JSON.stringify(payload);
    if (Buffer.byteLength(raw) > MAX_PAYLOAD) return { ok: false, error: `payload is at most ${MAX_PAYLOAD} bytes` };
    payload = JSON.parse(clean(raw)) as Record<string, unknown>;
  }
  return {
    ok: true,
    hold: { requestKey, kind, title, summary, ...(link ? { link } : {}), ...(payload ? { payload } : {}), approvers: [...new Set(approvers as string[])], ...(body.requiresCap ? { requiresCap: true } : {}) },
  };
}

/** The agent and its key from a hold path; undefined when either is not one. */
function holdOf(m: RegExpMatchArray): { agentId: string; requestKey: string } | undefined {
  try {
    const agentId = decodeURIComponent(m[1]);
    const requestKey = decodeURIComponent(m[2]);
    return REQUEST_KEY.test(requestKey) ? { agentId, requestKey } : undefined;
  } catch {
    return undefined;
  }
}

/** Handles the hold routes and `GET /api/v1/approvals/:id`; false when the path is neither. */
export async function handleDecisionHolds(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const one = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
  if (one && req.method === 'GET') {
    const reader = await requirePrivilege(req, res, state, 'approvals.read');
    if (!reader) return true;
    const a = state.approvals.get(decodeURIComponent(one[1]));
    if (!a) return json(res, 404, { error: 'not_found' }), true;
    return json(res, 200, visibleApprovals(state, reader, [a])[0]), true;
  }

  const read = path.match(/^\/api\/v1\/agents\/([^/]+)\/holds\/([^/]+)$/);
  if (read && req.method === 'GET') {
    const h = holdOf(read);
    if (!h) return json(res, 400, { error: 'invalid_request_key' }), true;
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind === 'refused') return json(res, 401, { error: 'invalid_run_token' }), true;
    if (verdict.kind === 'ok') {
      // An agent reads only its own holds.
      if (verdict.claims.agentId !== h.agentId) return json(res, 403, { error: 'not_your_agent' }), true;
    } else {
      // A person reads a hold as the approval it is.
      const reader = await requirePrivilege(req, res, state, 'approvals.read');
      if (!reader) return true;
    }
    const a = state.approvals.decisionByKey(h.agentId, h.requestKey);
    if (!a) return json(res, 404, { error: 'not_found' }), true;
    return json(res, 200, holdView(state, a)), true;
  }

  const put = path.match(/^\/api\/v1\/agents\/([^/]+)\/holds\/([^/]+)$/);
  if (put && req.method === 'PUT') {
    // Only the agent asks, under its own name, from a live run that is not a helper's.
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind !== 'ok') return json(res, 401, { error: verdict.kind === 'refused' ? 'invalid_run_token' : 'run_token_required' }), true;
    const h = holdOf(put);
    if (!h) return json(res, 400, { error: 'invalid_request_key' }), true;
    if (verdict.claims.agentId !== h.agentId) return json(res, 403, { error: 'not_your_agent' }), true;
    if (verdict.run.parentRunId) return json(res, 403, { error: 'helper_runs_do_not_ask' }), true;
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'invalid_json' }), true;
    }
    if (body.id !== undefined && body.id !== h.requestKey) return json(res, 400, { error: 'id does not match the request key' }), true;
    const parsed = parseHold(h.requestKey, body, (v) => redactSecrets(v, state.secretValues));
    if (!parsed.ok) return json(res, 400, { error: parsed.error }), true;
    const runId = verdict.run.runId;
    const { approval, created } = state.approvals.holdDecision({ runId, agentId: h.agentId, argsSha256: payloadHash(parsed.hold), hold: parsed.hold });
    if (created) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: h.agentId,
        runId,
        type: 'action',
        action: 'DECISION_REQUESTED',
        actor: `run:${h.agentId}:${runId}`,
        approvalId: approval.approvalId,
        mcpName: approval.tool,
        route: approval.route,
        requestId: h.requestKey,
        payloadSha256: approval.argsSha256,
      });
    }
    return json(res, created ? 201 : 200, holdView(state, approval)), true;
  }
  return false;
}
