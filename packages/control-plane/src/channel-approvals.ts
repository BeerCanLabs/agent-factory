/**
 * Approving where the person is (DESIGN_AUTHORITY.md §6.18 CF4, E9). The factory asks in the channel a person is already
 * on, records the answer and only then lets the held action or the elevated configuration change go ahead.
 *
 *   POST /api/v1/ingress/approval-prompts          `{ agentId }`: the questions the ingress should post for this agent
 *   POST /api/v1/ingress/approvals/:id/asked       `{ provider, channelId }`: the ingress posted it there
 *   POST /api/v1/ingress/approvals/decision        `{ code, decision, provider, identity, channelId }`: a reply to a question
 *
 * All three are the gatekeeper-ingress's alone (`approvals.channel`, exclusive): it is the one party that sees who wrote a
 * reply, so it alone may say who did, exactly as it alone says who asked (`runs.attest-requester`). The agent carries
 * nothing: the ingress consumes the reply before the agent sees it, and no agent credential reaches these routes.
 *
 * The factory renders the question from its own stored copy of the request (the agent's description is not trusted,
 * GAP-161), asks only where a person who may decide it has spoken, and a reply decides it only when it comes from that
 * channel, from a person the identity link resolves, whom the same rule as the console allows to decide it: the
 * run's verified requester, or an owner when the run has no requesting user, and, for a configuration change, an owner.
 * Anyone else's reply changes nothing. A question is decided once and expires after a day.
 */
import type http from 'node:http';
import { CHANNEL_ASK_TTL_MS, type Approval } from '@beercanlabs/factory-bouncer';
import { requirePrivilege, json, readJson, decideApproval, mayDecide, type FactoryState } from './app.js';

const PROMPTS = '/api/v1/ingress/approval-prompts';
const DECISION = '/api/v1/ingress/approvals/decision';
const ASKED = /^\/api\/v1\/ingress\/approvals\/([^/]+)\/asked$/;
const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CHANNEL_ID = /^[A-Za-z0-9._-]{1,128}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODE = /^[A-Za-z0-9]{4,12}$/;
const MAX_PROMPTS = 10;
const BODY_PREVIEW = 400;

/** Channel text is shown to people: no markup that could pass as the factory's own words or ping anyone. */
function plain(value: string, max: number): string {
  return value.replace(/[`<>@]/g, "'").replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** The question, rendered from the factory's stored copy of the request. */
export function renderQuestion(a: Approval, code: string): string {
  const lines: string[] = [];
  if (a.kind === 'change' && a.change) {
    const roles = a.change.roles.length ? a.change.roles.map((r) => plain(r, 64)).join(', ') : 'no roles (removes them)';
    lines.push(`**Approval needed.** Give ${plain(a.change.provider, 32)}:${plain(a.change.identity, 128)} ${roles} on ${plain(a.agentId, 128)}.`);
  } else if (a.request) {
    lines.push(`**Approval needed.** ${plain(a.agentId, 128)} wants to send this on route ${plain(a.route, 64)}:`);
    lines.push(`\`${plain(a.request.method, 12)} ${plain(a.request.path, 200)}\``);
    if (a.request.bodyEncoding === 'utf8' && a.request.body) lines.push(`\`\`\`\n${plain(a.request.body.replace(/\n/g, ' '), BODY_PREVIEW)}\n\`\`\``);
    else if (a.request.body) lines.push('(a binary body; open the console to see its size)');
  } else {
    lines.push(`**Approval needed** for ${plain(a.agentId, 128)}.`);
  }
  lines.push(`Reply \`approve ${code}\` or \`reject ${code}\` (mention me when you are in a server channel). Only the person it was asked of can decide it; it expires in 24 hours.`);
  return lines.join('\n');
}

/** Who may decide this approval by a reply: every linked Discord identity the console's own rule would let decide it. */
function decidersOf(state: FactoryState, a: Approval): string[] {
  const out: string[] = [];
  for (const link of state.identityLinks?.list() ?? []) {
    if (link.provider !== 'discord') continue;
    // A reply carries no factory role: the person decides as the requester or an owner, never by a global role (CF4).
    if (mayDecide(state, { actor: link.actor, roles: [] }, a.approvalId).ok) out.push(link.id);
  }
  return out;
}

function askable(state: FactoryState, a: Approval): boolean {
  if (a.state !== 'pending' || a.agentId.startsWith('__')) return false;
  if (a.kind === 'change') return !!a.expiresAt && Date.parse(a.expiresAt) > Date.now();
  if (a.kind === 'held') return !!state.runs.get(a.runId);
  return false;
}

function expired(a: Approval): boolean {
  if (a.kind === 'change' && (!a.expiresAt || Date.parse(a.expiresAt) <= Date.now())) return true;
  return !a.ask?.askedAt || Date.parse(a.ask.askedAt) + CHANNEL_ASK_TTL_MS <= Date.now();
}

export async function handleChannelApprovals(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const asked = path.match(ASKED);
  if (path !== PROMPTS && path !== DECISION && !asked) return false;
  const ingress = await requirePrivilege(req, res, state, 'approvals.channel');
  if (!ingress) return true;
  const body = await readJson(req);
  const str = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);

  if (path === PROMPTS) {
    const agentId = str(body.agentId, AGENT_ID);
    if (!agentId) return json(res, 400, { error: 'invalid_agent' }), true;
    const prompts: Array<{ approvalId: string; code: string; deciders: string[]; text: string }> = [];
    for (const a of state.approvals.list({ state: 'pending' })) {
      if (a.agentId !== agentId || a.ask?.channelId || !askable(state, a)) continue;
      const deciders = decidersOf(state, a);
      if (!deciders.length) continue;
      const withCode = state.approvals.issueChannelCode(a.approvalId);
      if (!withCode?.ask) continue;
      prompts.push({ approvalId: a.approvalId, code: withCode.ask.code, deciders, text: renderQuestion(withCode, withCode.ask.code) });
      if (prompts.length >= MAX_PROMPTS) break;
    }
    return json(res, 200, { prompts }), true;
  }

  if (asked) {
    const provider = str(body.provider, /^discord$/);
    const channelId = str(body.channelId, CHANNEL_ID);
    if (!provider || !channelId) return json(res, 400, { error: 'invalid_channel' }), true;
    const id = decodeURIComponent(asked[1]);
    const current = state.approvals.get(id);
    if (!current || !askable(state, current) || !current.ask) return json(res, 404, { error: 'not_found' }), true;
    const marked = state.approvals.markAsked(id, provider, channelId);
    if (!marked) return json(res, 404, { error: 'not_found' }), true;
    if (marked.ask?.channelId === channelId && marked.ask.askedAt && !current.ask.channelId) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: marked.agentId,
        runId: marked.runId,
        type: 'action',
        action: 'APPROVAL_ASKED_IN_CHANNEL',
        actor: ingress.actor,
        approvalId: marked.approvalId,
        requestId: `${provider}:${channelId}`,
      });
    }
    return json(res, 200, { approvalId: id, asked: true }), true;
  }

  // A reply. The ingress read the author from Discord; nothing the agent or the message says is an identity.
  const code = str(body.code, CODE);
  const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : undefined;
  const provider = str(body.provider, /^discord$/);
  const identity = str(body.identity, EXTERNAL_ID);
  const channelId = str(body.channelId, CHANNEL_ID);
  if (!code || !decision || !provider || !identity || !channelId) return json(res, 400, { error: 'invalid_reply' }), true;
  const a = state.approvals.byCode(code);
  // A code that is not pending, or was asked somewhere else, is just a message: the ingress passes it on as one.
  if (!a || a.ask?.provider !== provider || a.ask.channelId !== channelId) return json(res, 404, { error: 'unknown_code' }), true;
  const refuse = (status: number, error: string, text: string, who: string) => {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: a.agentId,
      runId: a.runId,
      type: 'action',
      action: `APPROVAL_CHANNEL_REFUSED:${error}`,
      actor: who,
      approvalId: a.approvalId,
      requestId: `${provider}:${channelId}`,
    });
    return json(res, status, { error, text }), true;
  };
  if (expired(a)) return refuse(410, 'expired', 'That question has expired. Ask the agent again.', `${provider}:${identity}`);
  const actor = state.identityLinks?.resolve(provider, identity);
  if (!actor) return refuse(403, 'not_linked', 'I do not know who you are, so I cannot take your answer.', `${provider}:${identity}`);
  if (!mayDecide(state, { actor, roles: [] }, a.approvalId).ok) return refuse(403, 'not_permitted', 'That one is not yours to decide.', actor);
  const out = await decideApproval(state, a.approvalId, decision, { actor, roles: [] }, undefined, { provider, channelId });
  if (out.status !== 200) return json(res, out.status, { ...(out.body as object), text: 'That question can no longer be decided.' }), true;
  return json(res, 200, { approvalId: a.approvalId, decision, text: decision === 'approve' ? 'Approved. It will go ahead.' : 'Rejected. It will not go ahead.' }), true;
}
