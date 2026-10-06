/**
 * Dynamic scheduled actions: an agent (or an operator) asks the factory to wake an agent on a cron with a stored
 * prompt. The scheduler in `index.ts` fires them; this module stores them and serves `/api/v1/schedules`.
 *
 * Scoping (DESIGN_AUTHORITY.md GAP-061, TSK-058; E7, S1): a run token acts only for its own agent. It creates, lists
 * and deletes that agent's schedules and nothing else; another agent's schedule is indistinguishable from a missing
 * one. Operators keep fleet access. Creates and deletes are ledgered (SCHEDULE_CREATED, SCHEDULE_DELETED) with the
 * actor and the agent, never the prompt text.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Role } from '@beercanlabs/factory-auth';
import { authorize } from '@beercanlabs/factory-bouncer';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { DEFAULT_TIMEZONE, cronIssue, cronMatches, getZonedTimeParts, isTimeZone } from '@beercanlabs/factory-timekeeper';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { isTerminal } from './runs.js';

export type ScheduledAction = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  timezone?: string; // Default: 'America/Los_Angeles'
  channelId?: string; // Discord channel ID for delivery
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunMinute?: string;
};

export class ScheduleStore {
  private schedules: Map<string, ScheduledAction> = new Map();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load();
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const items = JSON.parse(raw) as ScheduledAction[];
      for (const item of items) {
        if (item && item.id) {
          this.schedules.set(item.id, item);
        }
      }
    } catch (err) {
      console.warn('[schedules] Failed to load schedules from disk:', err);
    }
  }

  private persist() {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.schedules.values()], null, 2), 'utf8');
    } catch (err) {
      console.warn('[schedules] Failed to persist schedules to disk:', err);
    }
  }

  list(filter?: { agentId?: string }): ScheduledAction[] {
    const all = [...this.schedules.values()];
    if (filter?.agentId) {
      return all.filter((s) => s.agentId === filter.agentId);
    }
    return all;
  }

  get(id: string): ScheduledAction | undefined {
    return this.schedules.get(id);
  }

  save(action: ScheduledAction): void {
    this.schedules.set(action.id, action);
    this.persist();
  }

  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  checkDue(date = new Date()): ScheduledAction[] {
    const due: ScheduledAction[] = [];
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      const tz = schedule.timezone || 'America/Los_Angeles';
      const zoned = getZonedTimeParts(date, tz);
      const minuteKey = `${zoned.year}-${zoned.month}-${zoned.day} ${zoned.hour}:${zoned.minute}`;

      if (schedule.lastRunMinute === minuteKey) {
        continue; // Already ran this minute
      }

      if (cronMatches(schedule.cron, zoned)) {
        schedule.lastRunMinute = minuteKey;
        schedule.lastRunAt = date.toISOString();
        due.push(schedule);
      }
    }
    if (due.length > 0) {
      this.persist();
    }
    return due;
  }
}

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
