/**
 * GAP-260: the fleet's one go/stop state, the resource a fleet's `SDLC_GLOBAL_STATE_URL` points at.
 *
 * `GET /api/v1/fleet/state` answers any live run of any agent (its run token; the state is not secret) or a person with
 * `agents.read`: `{status, coder_app_ready, reason, ops, effective, ...}`. `PUT` (and MCP `set_fleet_state`) is an
 * admin's alone (`fleet.state.set`); `status` is running, paused or deploy-freeze; a refused change is a 400, and an MCP
 * error (`isError`) over MCP. Until an admin sets it, it reads `paused`: the fleet's skills fail closed, and so does the
 * factory.
 *
 * GAP-268: a listed ops agent's run reports `ops` (`PUT /api/v1/fleet/state/ops`); its `deploying` 200 is the deploy lock
 * (`opsStep`). The lock is atomic only because the one control-plane process reads and writes it with no `await` in
 * between; a second control-plane writer would need a compare-and-set store.
 * Nothing here polls or schedules: a skill reads it when an event wakes it.
 */
import type http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';
import { isTerminal } from '@beercanlabs/factory-property-manager';
import { authorize } from '@beercanlabs/factory-bouncer';
import type { Principal } from '@beercanlabs/factory-auth';
import { bearerOf, identify, json, readJson, requirePrivilege, type FactoryState } from './app.js';

/** The admin's statuses. A stored value from before GAP-268 that is not one of these reads as paused. */
export const FLEET_STATUSES = ['running', 'paused', 'deploy-freeze'] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
/** The deploy states the ops leader reports (GAP-268). */
export const OPS_STATES = ['idle', 'deploying', 'prod-testing', 'rolled-back'] as const;
export type OpsState = (typeof OPS_STATES)[number];
/** `runId`: the run holding the deploy (set by `deploying`, kept through `rolled-back`, cleared by `idle` and by an admin). */
export type OpsRecord = { state: OpsState; by: string | null; at: string | null; reason: string | null; runId?: string | null };
const NO_OPS: OpsRecord = { state: 'idle', by: null, at: null, reason: null, runId: null };
export type EffectiveState = 'running' | 'paused' | 'deploy-freeze' | 'deploying' | 'prod-testing';
export type FleetState = {
  status: FleetStatus;
  /** Agents whose live runs may report `ops` (admin-managed). */
  opsAgents?: string[];
  ops?: OpsRecord;
  coder_app_ready: boolean;
  reason: string | null;
  updatedBy?: string;
  updatedAt?: string;
  /** Other flags a fleet's operator keeps beside the status (e.g. `pin_merged`): scalars only. */
  [flag: string]: unknown;
};
type Out = { status: number; body: unknown };

const UNSET: FleetState = { status: 'paused', coder_app_ready: false, reason: 'The fleet state has not been set: treated as paused.' };
const FLAG = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(['status', 'coder_app_ready', 'reason', 'updatedBy', 'updatedAt', 'source', 'opsAgents', 'ops', 'effective', 'force']);
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OPS_AGENTS = 20;
const MAX_FLAGS = 20;
/** A reason is kept to this many code points after cleaning; longer raw text than MAX_REASON_INPUT is refused. */
const MAX_REASON = 500;
const MAX_REASON_INPUT = 8000;

/**
 * A stored admin status from before GAP-268 (deploying, prod-testing, rolled-back) or any other value that is not an
 * admin status loads as paused, so `status` and `effective` agree; the next admin write stores it.
 */
function normalized(raw: FleetState): FleetState {
  if ((FLEET_STATUSES as readonly string[]).includes(raw.status)) return raw;
  // Every part goes through the one reason cleaner: the file is outside the API's checks, and every run reads `reason`.
  const was = sanitizeReason(String(raw.status).slice(0, 40)) ?? '(blank)';
  const prior = typeof raw.reason === 'string' ? sanitizeReason(raw.reason) : null;
  const freeze = was === 'rolled-back' ? ' A rollback freeze was recorded.' : '';
  console.warn(`[control-plane] fleet state: stored status "${was}" is not running, paused or deploy-freeze; it reads as paused.${freeze}`);
  const reason = sanitizeReason(`The stored status "${was}" is no longer an admin status: treated as paused.${freeze}${prior ? ` (was: ${prior})` : ''}`);
  return { ...raw, status: 'paused', reason };
}

/**
 * The stored `ops` record is outside the API's checks. An unknown state, or a deploy open with no holding run (a lock
 * nobody can release but an admin), loads as `rolled-back`: effective `deploy-freeze` until an admin clears it. The
 * file is not rewritten on load. Mutates `fs`; returns what was wrong.
 */
function checkedOps(fs: FleetState): string | undefined {
  const o = fs.ops as unknown;
  if (o === undefined || o === null) return undefined;
  const rec = typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  const st = rec.state;
  const runId = typeof rec.runId === 'string' && rec.runId ? rec.runId : null;
  let issue: string | undefined;
  if (typeof st !== 'string' || !OPS_STATES.includes(st as OpsState)) issue = 'unknown-state';
  else if ((st === 'deploying' || st === 'prod-testing') && !runId) issue = 'no-run';
  if (!issue) return undefined;
  const was = sanitizeReason(String(st ?? o).slice(0, 40)) ?? '(blank)';
  const why = issue === 'no-run' ? `stored ops state "${was}" has no holding run` : `stored ops state "${was}" is not an ops state`;
  console.warn(`[control-plane] fleet state: ${why}; it reads as rolled-back (effective deploy-freeze) until an admin clears it`);
  fs.ops = { state: 'rolled-back', by: 'system:fleet-state-load', at: now(), reason: sanitizeReason(`The ${why}: treated as rolled-back.`), runId };
  return issue;
}

/** Called once at start, after the ledger is open: an `ops` record repaired on load is audited. */
export function auditFleetStateLoad(state: FactoryState): void {
  const issue = state.fleetState?.opsIssue;
  if (!issue) return;
  state.ledger.append({ timestamp: now(), agentId: 'factory', type: 'action', action: 'FLEET_OPS_STATE_INVALID', actor: 'system:fleet-state-load', mcpName: `fleet-ops:invalid:${issue}->rolled-back` });
}

/** One small JSON document, written whole and renamed into place. In memory when no file is given. */
export class FleetStateStore {
  private current: FleetState | undefined;
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as FleetState;
      if (raw && typeof raw.status === 'string') this.current = normalized(raw);
    } catch {
      this.current = undefined;
    }
    this.opsIssue = this.current ? checkedOps(this.current) : undefined;
  }

  /** Why the stored `ops` record was not trusted on load (audited once by `auditFleetStateLoad`). */
  opsIssue: string | undefined;

  get(): FleetState {
    return structuredClone(this.current ?? UNSET);
  }

  set(next: FleetState): FleetState {
    this.current = structuredClone(next);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current), 'utf8');
      renameSync(tmp, this.file);
    }
    return this.get();
  }
}

const storeOf = (state: FactoryState): FleetStateStore => (state.fleetState ??= new FleetStateStore());
const now = () => new Date().toISOString();

/** GAP-268: the one cleaner for every reason. Every run reads it, and it may carry output a PR author shaped. */
export function sanitizeReason(raw: string): string | null {
  // A lone surrogate becomes U+FFFD (String.prototype.toWellFormed, Node 20+).
  const whole = typeof (raw as { toWellFormed?: () => string }).toWellFormed === 'function' ? (raw as unknown as { toWellFormed: () => string }).toWellFormed() : raw;
  const cleaned = whole
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]{0,512}(?:\u0007|\u001b\\|\u009c)?/g, '')
    .replace(/\u001b[ -/]*[0-~]?/g, '')
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Format characters (\p{Cf}: bidi, zero-width, tag characters, soft hyphen, ...) and variation selectors can carry
    // text a person cannot see but a model reads. U+200D also splits joined emoji, and U+FE0F plain-text emoji.
    .replace(/[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  const capped = points.length > MAX_REASON ? points.slice(0, MAX_REASON).join('').trimEnd() : cleaned;
  return capped || null;
}

/** undefined: not given; null: cleared (or nothing left after cleaning); a string: the cleaned text. */
function reasonIn(raw: unknown): string | null | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > MAX_REASON_INPUT) return { error: `reason must be text, at most ${MAX_REASON_INPUT} characters (kept to ${MAX_REASON})` };
  return sanitizeReason(raw);
}
const isErr = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

/** R0: an ops agent is a registered agent, not a helper (ephemeral) and not retired or purged. */
function opsAgentOk(state: FactoryState, id: string): boolean {
  const a = state.agents.get(id) as { ephemeral?: unknown; state?: string } | undefined;
  return !!a && !a.ephemeral && a.state !== 'RETIRED_PENDING_PURGE' && a.state !== 'PURGED';
}

const runLive = (state: FactoryState, runId: string | null | undefined): boolean => {
  const r = runId ? state.runs.get(runId) : undefined;
  return !!r && !isTerminal(r.state);
};

/**
 * An admin's change. `status` is required; `coder_app_ready` and flags not given keep their value; a flag set to null
 * is removed; `reason` not given is cleared when the status changes. An `ops` write (R7) clears the holding run, and
 * needs `force: true` while that run is live (409 `deploy_run_live`).
 */
export function setFleetState(state: FactoryState, body: Record<string, unknown>, principal: Principal): Out {
  const prior = storeOf(state).get();
  if (typeof body.status !== 'string' || !FLEET_STATUSES.includes(body.status as FleetStatus)) {
    return { status: 400, body: { error: `status must be one of ${FLEET_STATUSES.join(', ')}` } };
  }
  if (body.coder_app_ready !== undefined && typeof body.coder_app_ready !== 'boolean') return { status: 400, body: { error: 'coder_app_ready must be true or false' } };
  const r = reasonIn(body.reason);
  if (isErr(r)) return { status: 400, body: r };
  const opsAgents = parseOpsAgents(state, body.opsAgents, prior.opsAgents);
  if (isErr(opsAgents)) return { status: 400, body: opsAgents };
  const ops = parseAdminOps(body.ops, prior.ops, principal.actor);
  if (isErr(ops)) return { status: 400, body: ops };
  const flags: Record<string, unknown> = Object.fromEntries(Object.entries(prior).filter(([k]) => !RESERVED.has(k)));
  for (const [k, v] of Object.entries(body)) {
    if (RESERVED.has(k)) continue;
    if (!FLAG.test(k)) return { status: 400, body: { error: `flag ${JSON.stringify(k.slice(0, 40))} is not a lowercase name` } };
    if (v === null) delete flags[k];
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) flags[k] = v;
    else return { status: 400, body: { error: `flag ${k} must be true, false, a number or short text` } };
  }
  if (Object.keys(flags).length > MAX_FLAGS) return { status: 400, body: { error: `at most ${MAX_FLAGS} flags` } };
  const forced = body.ops !== undefined && runLive(state, prior.ops?.runId);
  if (forced && body.force !== true) {
    return { status: 409, body: { error: 'deploy_run_live', runId: prior.ops?.runId, message: 'A live run holds the deploy: send force: true to clear it' } };
  }
  const status = body.status as FleetStatus;
  const reason = r !== undefined ? r : status === prior.status ? prior.reason : null;
  const next = storeOf(state).set({
    ...flags,
    ...(opsAgents.length ? { opsAgents } : {}),
    ...(ops ? { ops } : {}),
    status,
    coder_app_ready: typeof body.coder_app_ready === 'boolean' ? body.coder_app_ready : prior.coder_app_ready,
    reason,
    updatedBy: principal.actor,
    updatedAt: new Date().toISOString(),
  });
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'factory',
    type: 'action',
    action: 'FLEET_STATE_SET',
    actor: principal.actor,
    mcpName: `fleet-state:${prior.status}->${status}${next.coder_app_ready ? ':coder-ready' : ''}`,
  });
  const audit = (action: string, mcpName: string) => state.ledger.append({ timestamp: now(), agentId: 'factory', type: 'action', action, actor: principal.actor, mcpName });
  if (JSON.stringify(prior.opsAgents ?? []) !== JSON.stringify(opsAgents)) audit('FLEET_OPS_AGENTS_SET', `fleet-ops-agents:${opsAgents.join(',') || '-'}`);
  if (body.ops !== undefined) audit('FLEET_OPS_STATE_SET', `fleet-ops:${prior.ops?.state ?? 'idle'}->${ops?.state ?? 'idle'}:admin${forced ? ':forced' : ''}`);
  return { status: 200, body: viewOf(state, next, 'admin') };
}

/** `opsAgents` from an admin: not given keeps it, null or [] clears it; otherwise registered agents (R0), sorted. */
function parseOpsAgents(state: FactoryState, raw: unknown, prior: string[] | undefined): string[] | { error: string; agent?: string } {
  if (raw === undefined) return prior ?? [];
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OPS_AGENTS || !raw.every((a) => typeof a === 'string' && AGENT_ID.test(a))) {
    return { error: `opsAgents must be a list of at most ${MAX_OPS_AGENTS} agent ids` };
  }
  const unknown = (raw as string[]).find((a) => !opsAgentOk(state, a));
  if (unknown) return { error: 'unknown_agent', agent: unknown };
  return [...new Set(raw as string[])].sort();
}

/** `ops` from an admin: not given keeps it; null is idle; `{state, reason?}` sets any ops state. The holding run is cleared. */
function parseAdminOps(raw: unknown, prior: OpsRecord | undefined, actor: string): OpsRecord | undefined | { error: string } {
  if (raw === undefined) return prior;
  if (raw === null) return { state: 'idle', by: actor, at: now(), reason: null, runId: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'ops must be null or {state, reason?}' };
  const o = raw as Record<string, unknown>;
  const bad = opsBodyError(o);
  if (bad) return { error: bad };
  const r = reasonIn(o.reason);
  if (isErr(r)) return r;
  return { state: o.state as OpsState, by: actor, at: now(), reason: r ?? null, runId: null };
}

function opsBodyError(o: Record<string, unknown>): string | undefined {
  if (typeof o.state !== 'string' || !OPS_STATES.includes(o.state as OpsState)) return `state must be one of ${OPS_STATES.join(', ')}`;
  const extra = Object.keys(o).find((k) => k !== 'state' && k !== 'reason');
  return extra ? `unknown field ${JSON.stringify(extra.slice(0, 40))}` : undefined;
}

/** GAP-268: the one state the fleet acts on. The admin's status first, then what the ops leader reports. */
export function effectiveOf(fs: Pick<FleetState, 'status' | 'ops'>): EffectiveState {
  if (fs.status === 'deploy-freeze') return 'deploy-freeze';
  if (fs.status !== 'running') return 'paused';
  const ops = fs.ops?.state;
  if (ops === 'rolled-back') return 'deploy-freeze';
  if (ops === 'deploying' || ops === 'prod-testing') return ops;
  return 'running';
}

/** A read. Only admins see the holding run (and whether it is live); runs do not see `opsAgents`. */
function viewOf(state: FactoryState, fs: FleetState, who: 'admin' | 'reader' | 'run') {
  const { runId, ...ops } = { ...NO_OPS, ...fs.ops };
  const out: Record<string, unknown> = { ...fs, ops: who === 'admin' ? { ...ops, runId: runId ?? null, runLive: runLive(state, runId) } : ops, effective: effectiveOf(fs) };
  if (who === 'run') delete out.opsAgents;
  return out;
}

type Step = { ok: true; ops?: OpsRecord; kept?: true } | { ok: false; error: string };

/** GAP-268 R1 to R6 (DESIGN_AUTHORITY.md), against the stored record. A deploy is open in deploying and prod-testing, held by `ops.runId`. */
export function opsStep(prior: FleetState, t: OpsState, runId: string, agentId: string, reason: string | null | undefined): Step {
  const o = { ...NO_OPS, ...prior.ops };
  const mine = !!o.runId && o.runId === runId;
  const rec = (st: OpsState, holder: string | null): OpsRecord => ({ state: st, by: agentId, at: now(), reason: reason ?? null, runId: holder });
  const fail = (error: string): Step => ({ ok: false, error });
  if (o.state === 'rolled-back') return t === 'rolled-back' && mine ? { ok: true, kept: true } : fail('rolled_back_requires_admin');
  if (t === 'idle' && o.state === 'idle') return { ok: true };
  if (t === o.state && mine) return reason === undefined || reason === o.reason ? { ok: true } : { ok: true, ops: { ...o, reason, at: now() } };
  if (t === 'deploying') {
    if (prior.status !== 'running') return fail('fleet_not_running');
    if (o.state === 'idle') return { ok: true, ops: rec('deploying', runId) };
    return fail(mine ? 'invalid_transition' : 'deploy_in_progress');
  }
  if (o.state === 'idle') return fail('invalid_transition');
  if (!mine) return fail('not_the_deploying_run');
  if (t === 'prod-testing') return { ok: true, ops: rec('prod-testing', runId) };
  return { ok: true, ops: rec(t, t === 'idle' ? null : runId) };
}

/** GAP-268: the ops leader's report (R0 re-checked). Synchronous from the read to the write: this is the deploy lock. */
export function setFleetOpsState(state: FactoryState, body: Record<string, unknown>, run: { runId: string; agentId: string; actor?: string }): Out {
  const prior = storeOf(state).get();
  const audit = (action: string, mcpName: string) =>
    state.ledger.append({ timestamp: now(), agentId: run.agentId, runId: run.runId, type: 'action', action, actor: run.actor ?? `agent:${run.agentId}`, mcpName });
  const deny = (status: number, error: string, message?: string): Out => (audit('FLEET_OPS_STATE_DENIED', `fleet-ops:${error}`), { status, body: { error, ...(message ? { message } : {}) } });
  if (!(prior.opsAgents ?? []).includes(run.agentId) || !opsAgentOk(state, run.agentId)) {
    return deny(403, 'not_an_ops_agent', 'This agent is not a current agent in the fleet state opsAgents list');
  }
  if ('status' in body || (typeof body.state === 'string' && (FLEET_STATUSES as readonly string[]).includes(body.state))) {
    return deny(403, 'admin_state', 'Only an admin sets the fleet status (running, paused, deploy-freeze)');
  }
  const bad = opsBodyError(body);
  const r = reasonIn(body.reason);
  if (bad || isErr(r)) {
    audit('FLEET_OPS_STATE_DENIED', 'fleet-ops:bad_request');
    return { status: 400, body: { error: bad ?? (r as { error: string }).error } };
  }
  const t = body.state as OpsState;
  const step = opsStep(prior, t, run.runId, run.agentId, r);
  const was = prior.ops?.state ?? 'idle';
  if (!step.ok) return deny(409, step.error);
  let next = prior;
  if (step.kept) audit('FLEET_OPS_STATE_RETRY', 'fleet-ops:rolled-back:reason-kept');
  else if (step.ops) {
    next = storeOf(state).set({ ...prior, ops: step.ops });
    audit('FLEET_OPS_STATE_SET', `fleet-ops:${was}->${t}`);
  }
  const view = viewOf(state, next, 'run');
  return { status: 200, body: { ...view, ops: { ...(view.ops as OpsRecord), runId: next.ops?.runId ?? null } } };
}

/** R0: retiring or purging an agent takes it off `opsAgents` (audited); reinstating it does not put it back. */
export function dropOpsAgent(state: FactoryState, agentId: string, actor: string, why: 'retired' | 'purged'): void {
  const prior = storeOf(state).get();
  if (!(prior.opsAgents ?? []).includes(agentId)) return;
  const { opsAgents: _old, ...rest } = prior;
  const left = (prior.opsAgents ?? []).filter((a) => a !== agentId);
  storeOf(state).set({ ...rest, ...(left.length ? { opsAgents: left } : {}) });
  state.ledger.append({ timestamp: now(), agentId: 'factory', type: 'action', action: 'FLEET_OPS_AGENTS_SET', actor, mcpName: `fleet-ops-agents:-${agentId}:${why}` });
}

const isAdmin = (p: Principal): boolean => authorize({ principal: p, privilege: 'fleet.state.set' }).allowed;

/** Handles `GET`/`PUT /api/v1/fleet/state` and `PUT /api/v1/fleet/state/ops`; false for any other path. */
export async function handleFleetState(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/fleet/state' && req.method === 'GET') {
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind === 'refused') return json(res, 401, { error: 'invalid_run_token' }), true;
    if (verdict.kind === 'ok') return json(res, 200, viewOf(state, storeOf(state).get(), 'run')), true;
    const reader = await requirePrivilege(req, res, state, 'agents.read');
    if (!reader) return true;
    return json(res, 200, viewOf(state, storeOf(state).get(), isAdmin(reader) ? 'admin' : 'reader')), true;
  }
  if (path === '/api/v1/fleet/state' && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'fleet.state.set');
    if (!principal) return true;
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'invalid_json' }), true;
    }
    const out = setFleetState(state, body, principal);
    return json(res, out.status, out.body), true;
  }
  if (path === '/api/v1/fleet/state/ops' && req.method === 'PUT') {
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind === 'refused') return json(res, 401, { error: 'invalid_run_token' }), true;
    if (verdict.kind !== 'ok') {
      // A person (any role, admin included) is refused: an admin changes the fleet state through PUT /api/v1/fleet/state.
      const who = await identify(req, state);
      return who.ok ? json(res, 403, { error: 'run_token_required', message: 'Only an ops agent run reports ops state; admins use PUT /api/v1/fleet/state' }) : json(res, 401, { error: 'unauthorized' }), true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'invalid_json' }), true;
    }
    // The run id is the token's, never the body's.
    const out = setFleetOpsState(state, body && typeof body === 'object' && !Array.isArray(body) ? body : {}, verdict.run);
    return json(res, out.status, out.body), true;
  }
  return false;
}

/** MCP: read the state (any reader; the holding run's id to an admin only). */
export function fleetStateOf(state: FactoryState, principal?: Principal) {
  return viewOf(state, storeOf(state).get(), principal && isAdmin(principal) ? 'admin' : 'reader');
}

/** Run MCP: whether this agent is a current ops agent (lists `set_fleet_ops_state`). */
export const isOpsAgent = (state: FactoryState, agentId: string): boolean => (storeOf(state).get().opsAgents ?? []).includes(agentId) && opsAgentOk(state, agentId);
