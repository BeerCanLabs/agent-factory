/**
 * Dynamic scheduled actions: an agent (or an operator) asks the factory to wake an agent on a cron with a stored
 * prompt. The Timekeeper (`@beercanlabs/factory-timekeeper`, started in `index.ts`) stores and fires them; this module serves `/api/v1/schedules`.
 *
 * Scoping (DESIGN_AUTHORITY.md GAP-061, TSK-058; E7, S1): a run token acts only for its own agent. It creates, lists
 * and deletes that agent's schedules and nothing else; another agent's schedule is indistinguishable from a missing
 * one. Operators keep fleet access. Creates and deletes are ledgered (SCHEDULE_CREATED, SCHEDULE_DELETED) with the
 * actor and the agent, never the prompt text.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Role } from '@beercanlabs/factory-auth';
import { authorize, authorizeIngress, type AuthenticatedCaller } from '@beercanlabs/factory-bouncer';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { DEFAULT_TIMEZONE, cronIssue, isTimeZone, type ScheduledAction, type ScheduleRequester } from '@beercanlabs/factory-timekeeper';
import { json, readJson, requirePrivilege, SYSTEM, type FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { isTerminal, type Run } from './runs.js';

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

/** Who is calling the schedules API: a live run (acting for its own agent only) or a verified principal. */
export type ScheduleCaller =
  | { kind: 'run'; actor: string; agentId: string; runId: string }
  | { kind: 'principal'; actor: string; operator: boolean; required: Role };

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * A live run token (the agent acts for itself) or a verified principal who can at least view. A run token whose run
 * has ended, or whose run belongs to another agent, is refused: it never falls back to a principal.
 */
export async function authenticateOperatorOrRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
): Promise<ScheduleCaller | null> {
  const claims = await state.runTokens.verify(bearer(req));
  if (claims) {
    const run = state.runs.get(claims.runId);
    if (!run || run.agentId !== claims.agentId || isTerminal(run.state)) {
      json(res, 401, { error: 'invalid_run_token' });
      return null;
    }
    return { kind: 'run', actor: `run:${claims.agentId}:${claims.runId}`, agentId: claims.agentId, runId: claims.runId };
  }
  const principal = await requirePrivilege(req, res, state, 'schedules.read');
  if (!principal) return null;
  const write = authorize({ principal, privilege: 'schedules.write' });
  return { kind: 'principal', actor: principal.actor, operator: write.allowed, required: write.allowed ? 'operator' : write.required };
}

/** Creating or deleting on behalf of the fleet needs the operator role; a run acts for itself. */
function canWrite(caller: ScheduleCaller, res: http.ServerResponse): boolean {
  if (caller.kind === 'run' || caller.operator) return true;
  json(res, 403, { error: 'forbidden', required: caller.required });
  return false;
}

/** What a schedule's ledger rows commit to: its id, agent, cron and time zone. Never the prompt text (E3). */
export function scheduleLedgerHash(s: Pick<ScheduledAction, 'id' | 'agentId' | 'cron' | 'timezone'>): string {
  return payloadHash({ scheduleId: s.id, agentId: s.agentId, cron: s.cron, timezone: s.timezone ?? null });
}

function ledgerSchedule(state: FactoryState, caller: ScheduleCaller, action: 'SCHEDULE_CREATED' | 'SCHEDULE_DELETED', s: ScheduledAction) {
  // Actor and agent, plus a hash of the schedule's identity (the ledger's row fields are a fixed allowlist).
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: s.agentId,
    ...(caller.kind === 'run' ? { runId: caller.runId } : {}),
    type: 'action',
    action,
    actor: caller.actor,
    payloadSha256: scheduleLedgerHash(s),
  });
}

// ---------------------------------------------------------------------------
// Whose authority a schedule carries (E12, GAP-131)
// ---------------------------------------------------------------------------

/**
 * Who a run is for, as the factory itself recorded it. Never what a request says: a run that creates a schedule is
 * read from the run's own record, so an agent cannot name its requester. `undefined` means the factory cannot tell,
 * and the caller refuses (fail closed).
 */
export function requesterOfRun(state: FactoryState, run: Run): ScheduleRequester | undefined {
  // The cartridge's own declared cron is the agent's own work.
  if (run.trigger === 'cron') return { kind: 'system' };
  // A scheduled run passes on its schedule's requester, so authority cannot grow through a chain of schedules. A
  // schedule that is gone, or malformed, leaves no one to pass on.
  if (run.trigger === 'schedule') {
    const id = (run.input as { scheduleId?: unknown } | undefined)?.scheduleId;
    const s = typeof id === 'string' ? state.schedules?.get(id) : undefined;
    if (!s) return undefined;
    return s.requestedBy === undefined ? { kind: 'system' } : readRequester(s.requestedBy);
  }
  if (run.requestedBy) return { kind: 'identity', provider: run.requestedBy.provider, id: run.requestedBy.id };
  // Started by an authenticated principal (a console or API wake); a factory actor names no person.
  return run.actor && !run.actor.startsWith('factory:') ? { kind: 'principal', actor: run.actor } : undefined;
}

/** A stored requester that is well formed, or `undefined`. Stored data is read as untrusted: a bad one is never `system`. */
function readRequester(v: unknown): ScheduleRequester | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256;
  if (r.kind === 'system') return { kind: 'system' };
  if (r.kind === 'principal' && text(r.actor)) return { kind: 'principal', actor: r.actor };
  if (r.kind === 'identity' && text(r.provider) && text(r.id)) return { kind: 'identity', provider: r.provider, id: r.id };
  return undefined;
}

const SCHEDULER_BADGE = (scheduleName: string): AuthenticatedCaller => ({
  actor: SYSTEM.scheduler,
  name: 'Scheduler',
  role: 'system',
  roles: [],
  isOwner: false,
  source: 'schedule',
  scheduleName,
});

/**
 * What to start a schedule's run with: a verified badge carrying the requester's CURRENT authority, never more, by the
 * rule a person's own message meets (`agents.wake` on that agent). `system` is the agent's own authority. A requester
 * who no longer holds a role, or whose record is malformed, has the fire skipped and ledgered, and `undefined` is
 * returned. A schedule saved before this was recorded has no requester and is `system`.
 */
export function scheduleRunOptions(
  state: FactoryState,
  sched: ScheduledAction,
): { caller: AuthenticatedCaller; requestedBy?: { provider: string; id: string } } | undefined {
  const requester = sched.requestedBy === undefined ? ({ kind: 'system' } as const) : readRequester(sched.requestedBy);
  const skip = (why: string) => {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: sched.agentId,
      type: 'action',
      action: 'SCHEDULE_SKIPPED_UNAUTHORIZED',
      actor: SYSTEM.scheduler,
      payloadSha256: scheduleLedgerHash(sched),
    });
    console.warn(`[scheduler] Skipping "${sched.name}" (${sched.id}): ${why}`);
    return undefined;
  };
  if (!requester) return skip('its requester is not readable');
  if (requester.kind === 'system') return { caller: SCHEDULER_BADGE(sched.name) };

  const adminEmails = (process.env.FACTORY_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const owners = ownersOf(state, sched.agentId);
  // The person's own link where there is one; for a principal, any link of theirs, then their bare principal (an admin
  // by e-mail needs no link). Whoever is first allowed is the requester.
  const candidates =
    requester.kind === 'identity'
      ? [{ requestedBy: { provider: requester.provider, id: requester.id }, link: state.identityLinks?.resolveLink(requester.provider, requester.id) }]
      : [
          ...(state.identityLinks?.list() ?? [])
            .filter((l) => l.actor.toLowerCase() === requester.actor.toLowerCase())
            .map((l) => ({ requestedBy: { provider: l.provider, id: l.id }, link: l })),
          { requestedBy: { provider: 'principal', id: requester.actor }, link: { actor: requester.actor } },
        ];
  for (const c of candidates) {
    const auth = authorizeIngress({ requestedBy: c.requestedBy, agentId: sched.agentId, privilege: 'agents.wake', owners, link: c.link, adminEmails, isIngressCaller: true });
    if (auth.allowed && auth.caller) {
      return { caller: { ...auth.caller, source: 'schedule', scheduleName: sched.name }, ...(requester.kind === 'identity' ? { requestedBy: c.requestedBy } : {}) };
    }
  }
  return skip('its requester no longer holds a role on this agent');
}

const optionalString = (v: unknown): v is string | undefined | null => v === undefined || v === null || typeof v === 'string';
const SCHEDULE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/schedules`, `POST /api/v1/schedules`, `DELETE /api/v1/schedules/:id`. Returns false for other paths.
 *
 * - A run lists only its own agent's schedules, whatever filter it sends (`agent=` or the legacy `agentId=`).
 * - A run creates only for its own agent: an `agentId` naming another agent is 403. It never chooses the id.
 * - A run deletes only its own agent's schedules: another agent's id gets the same 404 as a missing one.
 * - An operator keeps fleet access: the `agent` filter, any `agentId` in the body, any id to delete. A viewer lists.
 *
 * Responses keep the shapes the agents already read: `{ schedules }`, `{ ok, schedule }`, `{ ok, deleted }`.
 */
export async function handleSchedules(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const one = path.match(/^\/api\/v1\/schedules\/([^/]+)$/);
  if (path !== '/api/v1/schedules' && !one) return false;
  if (path === '/api/v1/schedules' && req.method !== 'GET' && req.method !== 'POST') return false;
  if (one && req.method !== 'DELETE') return false;

  const caller = await authenticateOperatorOrRun(req, res, state);
  if (!caller) return true;
  const store = state.schedules;

  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const agentId = caller.kind === 'run' ? caller.agentId : url.searchParams.get('agent') || undefined;
    json(res, 200, { schedules: store?.list(agentId ? { agentId } : undefined) ?? [] });
    return true;
  }

  if (req.method === 'POST') {
    if (!canWrite(caller, res)) return true;
    const body = await readJson(req);
    if (!optionalString(body.agentId)) {
      json(res, 400, { error: 'invalid_agent' });
      return true;
    }
    let agentId: string | undefined;
    if (caller.kind === 'run') {
      if (body.agentId && body.agentId !== caller.agentId) {
        json(res, 403, { error: 'forbidden', reason: 'a run schedules only for its own agent' });
        return true;
      }
      agentId = caller.agentId;
    } else {
      agentId = body.agentId || undefined;
    }
    if (!agentId || !state.agents.has(agentId)) {
      json(res, 400, { error: 'invalid_or_missing_agent' });
      return true;
    }
    if (typeof body.cron !== 'string' || !body.cron.trim()) {
      json(res, 400, { error: 'missing_cron' });
      return true;
    }
    const cronProblem = cronIssue(body.cron);
    if (cronProblem) {
      json(res, 400, { error: 'invalid_cron', reason: cronProblem });
      return true;
    }
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      json(res, 400, { error: 'missing_prompt' });
      return true;
    }
    for (const k of ['name', 'timezone', 'channelId', 'channel_id', 'id'] as const) {
      if (!optionalString(body[k])) {
        json(res, 400, { error: 'invalid_field', field: k });
        return true;
      }
    }
    const timezone = (body.timezone as string | undefined) || DEFAULT_TIMEZONE;
    if (!isTimeZone(timezone)) {
      json(res, 400, { error: 'invalid_timezone', timezone });
      return true;
    }
    // Only an operator may choose the id: a run must never be able to overwrite another agent's schedule by id.
    let id = `sched-${randomUUID()}`;
    if (caller.kind === 'principal' && body.id) {
      if (!SCHEDULE_ID.test(body.id as string)) {
        json(res, 400, { error: 'invalid_field', field: 'id' });
        return true;
      }
      id = body.id as string;
    }
    // E12, GAP-131: whose authority this schedule's runs will carry. The factory decides; the request body never can.
    let requestedBy: ScheduleRequester | undefined;
    if (caller.kind === 'run') {
      const run = state.runs.get(caller.runId);
      requestedBy = run ? requesterOfRun(state, run) : undefined;
      if (!requestedBy) {
        json(res, 403, { error: 'forbidden', reason: 'the factory cannot tell whose authority this schedule would carry' });
        return true;
      }
    } else {
      requestedBy = { kind: 'principal', actor: caller.actor };
    }
    const channelId = (body.channelId as string | undefined) || (body.channel_id as string | undefined) || undefined;
    const schedule: ScheduledAction = {
      id,
      agentId,
      name: (body.name as string | undefined) || `Scheduled action for ${agentId}`,
      cron: body.cron.trim().split(/\s+/).join(' '),
      timezone,
      ...(channelId ? { channelId } : {}),
      prompt: body.prompt,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
      createdVia: caller.kind === 'run' ? 'agent' : 'api',
      requestedBy,
    };
    if (!store) {
      json(res, 503, { error: 'schedules_unavailable' });
      return true;
    }
    store.save(schedule);
    ledgerSchedule(state, caller, 'SCHEDULE_CREATED', schedule);
    json(res, 200, { ok: true, schedule });
    return true;
  }

  // DELETE
  if (!canWrite(caller, res)) return true;
  const id = decodeURIComponent(one![1]);
  const existing = store?.get(id);
  if (caller.kind === 'run' && (!existing || existing.agentId !== caller.agentId)) {
    // Another agent's schedule looks exactly like a missing one: a run never learns which ids exist.
    json(res, 404, { error: 'not_found' });
    return true;
  }
  const deleted = existing ? Boolean(store?.delete(id)) : false;
  if (deleted && existing) ledgerSchedule(state, caller, 'SCHEDULE_DELETED', existing);
  json(res, 200, { ok: true, deleted });
  return true;
}
