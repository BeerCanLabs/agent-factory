/**
 * GAP-260: the fleet's one go/stop state, the resource a fleet's `SDLC_GLOBAL_STATE_URL` points at.
 *
 * `GET /api/v1/fleet/state` answers any live run of any agent (its run token; the state is not secret) or a person with
 * `agents.read`: `{status, coder_app_ready, reason, ...}`. `PUT` (and MCP `set_fleet_state`) is an admin's alone
 * (`fleet.state.set`); a refused change is a 400, and an MCP error (`isError`) over MCP.
 * Until an admin sets it, it reads `paused`: the fleet's skills fail closed, and so does the factory.
 * Nothing here polls or schedules: a skill reads it when an event wakes it.
 */
import type http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';
import { isTerminal } from '@beercanlabs/factory-property-manager';
import type { Principal } from '@beercanlabs/factory-auth';
import { bearerOf, json, readJson, requirePrivilege, type FactoryState } from './app.js';

/** The states agentic-sdlc skills know (`GLOBAL_STATES`); anything else reads as paused there. */
export const FLEET_STATUSES = ['running', 'deploy-freeze', 'deploying', 'prod-testing', 'rolled-back', 'paused'] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export type FleetState = {
  status: FleetStatus;
  coder_app_ready: boolean;
  reason: string | null;
  updatedBy?: string;
  updatedAt?: string;
  /** Other flags a fleet's operator keeps beside the status (e.g. `pin_merged`): scalars only. */
  [flag: string]: unknown;
};

const UNSET: FleetState = { status: 'paused', coder_app_ready: false, reason: 'The fleet state has not been set: treated as paused.' };
const FLAG = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(['status', 'coder_app_ready', 'reason', 'updatedBy', 'updatedAt', 'source']);
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
  return { status: 200, body: next };
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
    return json(res, 200, storeOf(state).get()), true;
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
export function fleetStateOf(state: FactoryState): FleetState {
  return storeOf(state).get();
}
