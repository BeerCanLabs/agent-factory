/**
 * GAP-260: the fleet's one go/stop state, the resource a fleet's `SDLC_GLOBAL_STATE_URL` points at.
 *
 * `GET /api/v1/fleet/state` answers any live run of any agent (its run token; the state is not secret) or a person with
 * `agents.read`: `{status, coder_app_ready, reason, ...}`. `PUT` (and MCP `set_fleet_state`) is an admin's alone
 * (`fleet.state.set`); a refused change is a 400, and an MCP error (`isError`) over MCP.
 * Until an admin sets it, it reads `paused`: the fleet's skills fail closed, and so does the factory.
 *
 * GAP-268: an agent an admin lists in `opsAgents` (the fleet's ops leader) reports deploy states with its live run token,
 * `PUT /api/v1/fleet/state/ops` (and run MCP `set_fleet_ops_state`): `{state: idle|deploying|prod-testing|rolled-back,
 * reason?}`, kept apart as `ops: {state, by, at, reason}`. It never sets or clears the admin `status`, and never clears
 * `rolled-back` (409 `rolled_back_requires_admin`): only an admin does, through the admin `set_fleet_state` path (`ops`).
 * A read always carries `ops` (idle, by and at null, until reported) and adds `effective`, the one state the fleet acts
 * on; `status` reads as before.
 * Nothing here polls or schedules: a skill reads it when an event wakes it.
 */
import type http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';
import { isTerminal } from '@beercanlabs/factory-property-manager';
import type { Principal } from '@beercanlabs/factory-auth';
import { bearerOf, identify, json, readJson, requirePrivilege, type FactoryState } from './app.js';

/** The states agentic-sdlc skills know (`GLOBAL_STATES`); anything else reads as paused there. */
export const FLEET_STATUSES = ['running', 'deploy-freeze', 'deploying', 'prod-testing', 'rolled-back', 'paused'] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
/** The deploy states the ops leader reports (GAP-268). */
export const OPS_STATES = ['idle', 'deploying', 'prod-testing', 'rolled-back'] as const;
export type OpsState = (typeof OPS_STATES)[number];
export type OpsRecord = { state: OpsState; by: string | null; at: string | null; reason: string | null };
/** What a read shows before anyone has reported. */
const NO_OPS: OpsRecord = { state: 'idle', by: null, at: null, reason: null };
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

const UNSET: FleetState = { status: 'paused', coder_app_ready: false, reason: 'The fleet state has not been set: treated as paused.' };
const FLAG = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(['status', 'coder_app_ready', 'reason', 'updatedBy', 'updatedAt', 'source', 'opsAgents', 'ops', 'effective']);
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OPS_AGENTS = 20;
const MAX_FLAGS = 20;
const MAX_REASON = 500;

/** One small JSON document, written whole and renamed into place. In memory when no file is given. */
export class FleetStateStore {
  private current: FleetState | undefined;
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as FleetState;
      if (raw && FLEET_STATUSES.includes(raw.status)) this.current = raw;
    } catch {
      this.current = undefined;
    }
  }

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

/**
 * An admin's change. `status` is required; `coder_app_ready` and flags not given keep their value; a flag set to null
 * is removed; `reason` not given is cleared when the status changes.
 */
export function setFleetState(state: FactoryState, body: Record<string, unknown>, principal: Principal): { status: number; body: unknown } {
  const prior = storeOf(state).get();
  if (typeof body.status !== 'string' || !FLEET_STATUSES.includes(body.status as FleetStatus)) {
    return { status: 400, body: { error: `status must be one of ${FLEET_STATUSES.join(', ')}` } };
  }
  if (body.coder_app_ready !== undefined && typeof body.coder_app_ready !== 'boolean') return { status: 400, body: { error: 'coder_app_ready must be true or false' } };
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.length > MAX_REASON)) {
    return { status: 400, body: { error: `reason must be text, at most ${MAX_REASON} characters` } };
  }
  const opsAgents = parseOpsAgents(body.opsAgents, prior.opsAgents);
  if (typeof opsAgents === 'string') return { status: 400, body: { error: opsAgents } };
  const ops = parseAdminOps(body.ops, prior.ops, principal.actor);
  if (typeof ops === 'string') return { status: 400, body: { error: ops } };
  const flags: Record<string, unknown> = Object.fromEntries(Object.entries(prior).filter(([k]) => !RESERVED.has(k)));
  for (const [k, v] of Object.entries(body)) {
    if (RESERVED.has(k)) continue;
    if (!FLAG.test(k)) return { status: 400, body: { error: `flag ${JSON.stringify(k.slice(0, 40))} is not a lowercase name` } };
    if (v === null) delete flags[k];
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) flags[k] = v;
    else return { status: 400, body: { error: `flag ${k} must be true, false, a number or short text` } };
  }
  if (Object.keys(flags).length > MAX_FLAGS) return { status: 400, body: { error: `at most ${MAX_FLAGS} flags` } };
  const status = body.status as FleetStatus;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : body.reason === undefined && status === prior.status ? prior.reason : null;
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
  if (JSON.stringify(prior.opsAgents ?? []) !== JSON.stringify(opsAgents)) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'factory', type: 'action', action: 'FLEET_OPS_AGENTS_SET', actor: principal.actor, mcpName: `fleet-ops-agents:${opsAgents.join(',') || '-'}` });
  }
  if (body.ops !== undefined && (prior.ops?.state ?? 'idle') + (prior.ops?.reason ?? '') !== (ops?.state ?? 'idle') + (ops?.reason ?? '')) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'factory', type: 'action', action: 'FLEET_OPS_STATE_SET', actor: principal.actor, mcpName: `fleet-ops:${prior.ops?.state ?? 'idle'}->${ops?.state ?? 'idle'}` });
  }
  return { status: 200, body: viewOf(next) };
}

/** `opsAgents` from an admin: not given keeps it, null or [] clears it; otherwise agent ids, deduplicated and sorted. */
function parseOpsAgents(raw: unknown, prior: string[] | undefined): string[] | string {
  if (raw === undefined) return prior ?? [];
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OPS_AGENTS || !raw.every((a) => typeof a === 'string' && AGENT_ID.test(a))) {
    return `opsAgents must be a list of at most ${MAX_OPS_AGENTS} agent ids`;
  }
  return [...new Set(raw as string[])].sort();
}

/** `ops` from an admin: not given keeps it; null is idle; `{state, reason?}` sets any ops state, `rolled-back` cleared included. */
function parseAdminOps(raw: unknown, prior: OpsRecord | undefined, actor: string): OpsRecord | undefined | string {
  if (raw === undefined) return prior;
  if (raw === null) return { state: 'idle', by: actor, at: new Date().toISOString(), reason: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'ops must be null or {state, reason?}';
  const o = raw as Record<string, unknown>;
  const bad = opsBodyError(o);
  if (bad) return bad;
  const st = o.state as OpsState;
  return { state: st, by: actor, at: new Date().toISOString(), reason: reasonOf(o.reason) };
}

function opsBodyError(o: Record<string, unknown>): string | undefined {
  if (typeof o.state !== 'string' || !OPS_STATES.includes(o.state as OpsState)) return `state must be one of ${OPS_STATES.join(', ')}`;
  if (o.reason !== undefined && o.reason !== null && (typeof o.reason !== 'string' || o.reason.length > MAX_REASON)) return `reason must be text, at most ${MAX_REASON} characters`;
  const extra = Object.keys(o).find((k) => k !== 'state' && k !== 'reason');
  return extra ? `unknown field ${JSON.stringify(extra.slice(0, 40))}` : undefined;
}

const reasonOf = (r: unknown): string | null => (typeof r === 'string' && r.trim() ? r.trim() : null);

/** GAP-268: the one state the fleet acts on. The admin's status first, then what the ops leader reports. */
export function effectiveOf(fs: Pick<FleetState, 'status' | 'ops'>): EffectiveState {
  if (fs.status !== 'running') return 'paused';
  const ops = fs.ops?.state;
  if (ops === 'rolled-back') return 'deploy-freeze';
  if (ops === 'deploying' || ops === 'prod-testing') return ops;
  return 'running';
}

/** A read: the stored record, `ops` always present (idle until reported), and `effective`. */
const viewOf = (fs: FleetState): FleetState & { ops: OpsRecord; effective: EffectiveState } => ({ ...fs, ops: fs.ops ?? NO_OPS, effective: effectiveOf(fs) });

/**
 * GAP-268: the ops leader's report, from a live run of an agent in `opsAgents`. 403 for any other agent and for an admin
 * status or field; 409 `rolled_back_requires_admin` for leaving `rolled-back` (only an admin writes idle then); 400 for
 * a malformed body. The same state and reason again changes
 * nothing and writes no audit row.
 */
export function setFleetOpsState(state: FactoryState, body: Record<string, unknown>, run: { runId: string; agentId: string; actor?: string }): { status: number; body: unknown } {
  const prior = storeOf(state).get();
  const audit = (action: string, mcpName: string) =>
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: run.agentId, runId: run.runId, type: 'action', action, actor: run.actor ?? `agent:${run.agentId}`, mcpName });
  if (!(prior.opsAgents ?? []).includes(run.agentId)) {
    audit('FLEET_OPS_STATE_DENIED', 'fleet-ops:not_an_ops_agent');
    return { status: 403, body: { error: 'not_an_ops_agent', message: 'This agent is not in the fleet state opsAgents list' } };
  }
  const adminField = 'status' in body || (typeof body.state === 'string' && (FLEET_STATUSES as readonly string[]).includes(body.state) && !OPS_STATES.includes(body.state as OpsState));
  if (adminField) {
    audit('FLEET_OPS_STATE_DENIED', 'fleet-ops:admin_state');
    return { status: 403, body: { error: 'admin_state', message: 'Only an admin sets the fleet status (running, paused, deploy-freeze)' } };
  }
  const bad = opsBodyError(body);
  if (bad) return { status: 400, body: { error: bad } };
  const st = body.state as OpsState;
  const was = prior.ops?.state ?? 'idle';
  if (was === 'rolled-back' && st !== 'rolled-back') {
    audit('FLEET_OPS_STATE_DENIED', 'fleet-ops:rolled_back_requires_admin');
    return { status: 409, body: { error: 'rolled_back_requires_admin', message: 'The fleet is rolled back: only an admin sets idle, through the admin fleet state' } };
  }
  const reason = reasonOf(body.reason);
  if (was === st && (prior.ops?.reason ?? null) === reason) return { status: 200, body: viewOf(prior) };
  const next = storeOf(state).set({ ...prior, ops: { state: st, by: run.agentId, at: new Date().toISOString(), reason } });
  audit('FLEET_OPS_STATE_SET', `fleet-ops:${was}->${st}`);
  return { status: 200, body: viewOf(next) };
}

/** Handles `GET` and `PUT /api/v1/fleet/state`; false for any other path. */
export async function handleFleetState(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/fleet/state' && req.method === 'GET') {
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind === 'refused') return json(res, 401, { error: 'invalid_run_token' }), true;
    if (verdict.kind !== 'ok') {
      const reader = await requirePrivilege(req, res, state, 'agents.read');
      if (!reader) return true;
    }
    return json(res, 200, viewOf(storeOf(state).get())), true;
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
    const out = setFleetOpsState(state, body && typeof body === 'object' && !Array.isArray(body) ? body : {}, verdict.run);
    return json(res, out.status, out.body), true;
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
  return false;
}

/** MCP: read the state (any reader). */
export function fleetStateOf(state: FactoryState): FleetState & { effective: EffectiveState } {
  return viewOf(storeOf(state).get());
}

/** Run MCP: whether this agent is an ops agent (lists `set_fleet_ops_state`). */
export const isOpsAgent = (state: FactoryState, agentId: string): boolean => (storeOf(state).get().opsAgents ?? []).includes(agentId);
