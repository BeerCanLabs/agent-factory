import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LedgerEvent } from '@beercanlabs/factory-ledger';

export type ToolRule = { allow: string[] | '*'; requireApproval?: string[] };

/** Admin-set egress policy for one agent. Deny by default: no routes, no tools. */
export type AgentPolicy = {
  routes: string[];
  models?: string[];
  hosts?: string[];
  tools?: Record<string, ToolRule>;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  tokensPerMinute?: number;
};

const EMPTY: AgentPolicy = { routes: [] };

/** The factory-wide default policy (`PUT /api/v1/policies/budget`). Not an agent; never archived. */
export const GLOBAL_POLICY_ID = '__global__';

/** Ids starting `__` are the factory's own (`__global__`), never an agent's, so they are never orphans. */
export function isReservedPolicyId(id: string): boolean {
  return id.startsWith('__');
}

/** A filesystem-safe UTC timestamp for archive folders: `2026-10-01T12-00-00-000Z`. */
export function archiveStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Moves a file, falling back to copy-then-unlink across filesystems. Never deletes without a copy. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function validatePolicy(raw: unknown): { ok: true; policy: AgentPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'policy must be an object' };
  const r = raw as Record<string, unknown>;
  const allowed = new Set(['routes', 'models', 'hosts', 'tools', 'budgetUsd', 'tokensPerMinute']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, error: `unknown policy field ${k}` };
  if (!isStringArray(r.routes ?? [])) return { ok: false, error: 'routes must be an array of route ids' };
  if (r.models !== undefined && !isStringArray(r.models)) return { ok: false, error: 'models must be an array of model ids' };
  if (r.hosts !== undefined && !isStringArray(r.hosts)) return { ok: false, error: 'hosts must be an array of hostnames' };
  if (r.tokensPerMinute !== undefined && !positive(r.tokensPerMinute)) return { ok: false, error: 'tokensPerMinute must be >= 0' };
  if (r.budgetUsd !== undefined) {
    const b = r.budgetUsd as Record<string, unknown>;
    if (!b || typeof b !== 'object') return { ok: false, error: 'budgetUsd must be an object' };
    for (const [k, v] of Object.entries(b)) {
      if (!['perRun', 'perDay', 'perMonth'].includes(k)) return { ok: false, error: `unknown budget window ${k}` };
      if (!positive(v)) return { ok: false, error: `budgetUsd.${k} must be >= 0` };
    }
  }
  if (r.tools !== undefined) {
    if (!r.tools || typeof r.tools !== 'object') return { ok: false, error: 'tools must be an object keyed by route id' };
    for (const [route, rule] of Object.entries(r.tools as Record<string, unknown>)) {
      const t = rule as Record<string, unknown>;
      if (!t || (t.allow !== '*' && !isStringArray(t.allow))) return { ok: false, error: `tools.${route}.allow must be "*" or tool names` };
      if (t.requireApproval !== undefined && !isStringArray(t.requireApproval)) {
        return { ok: false, error: `tools.${route}.requireApproval must be tool names` };
      }
    }
  }
  return { ok: true, policy: { ...(r as AgentPolicy), routes: (r.routes as string[] | undefined) ?? [] } };
}

export class PolicyStore {
  private readonly policies = new Map<string, AgentPolicy>();

  constructor(
    private readonly dir?: string,
    private readonly fallback: AgentPolicy = EMPTY,
  ) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      this.policies.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), 'utf8')) as AgentPolicy);
    }
  }

  get(agentId: string): AgentPolicy {
    return structuredClone(this.policies.get(agentId) ?? this.fallback);
  }

  /** True only for a policy set for this agent (not the fallback). */
  has(agentId: string): boolean {
    return this.policies.has(agentId);
  }

  /** Every id with a policy set (including `__global__`). */
  ids(): string[] {
    return [...this.policies.keys()];
  }

  /**
   * GAP-060: moves these ids' policy files to `<parent of the policy dir>/policies-orphaned/<timestamp>/` (moved, never
   * deleted) and stops serving them. Reserved ids (`__global__`) and ids without a policy are skipped. Returns the ids
   * archived and where; a file that cannot be moved stays where it is and keeps being served.
   */
  archive(ids: Iterable<string>, now = new Date()): { archived: string[]; to?: string } {
    const archived: string[] = [];
    let to: string | undefined;
    for (const id of new Set(ids)) {
      if (isReservedPolicyId(id) || !this.policies.has(id)) continue;
      if (this.dir) {
        const from = join(this.dir, `${id}.json`);
        if (existsSync(from)) {
          to ??= join(dirname(this.dir), 'policies-orphaned', archiveStamp(now));
          try {
            mkdirSync(to, { recursive: true });
            moveFile(from, join(to, `${id}.json`));
          } catch (err) {
            console.error(`[control-plane] policy ${id} not archived: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
      }
      this.policies.delete(id);
      archived.push(id);
    }
    return { archived, ...(to && archived.length ? { to } : {}) };
  }

  set(agentId: string, policy: AgentPolicy): void {
    this.policies.set(agentId, policy);
    if (!this.dir) return;
    const path = join(this.dir, `${agentId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(policy, null, 2));
    renameSync(tmp, path);
  }
}

export type Spend = { run: number; day: number; month: number };

export type SpendDetail = { model?: string; inputTokens?: number; outputTokens?: number };
type SpendCounts = { usd: number; calls: number; inputTokens: number; outputTokens: number };
export type SpendWindow = SpendCounts & { byModel: Record<string, SpendCounts> };

function emptyWindow(): SpendWindow {
  return { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
}

/** The metered fields of a gatekeeper-egress `llm` ledger row. */
export function spendDetail(e: { model?: unknown; inputTokens?: unknown; outputTokens?: unknown }): SpendDetail {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    ...(typeof e.model === 'string' && e.model ? { model: e.model } : {}),
    ...(num(e.inputTokens) !== undefined ? { inputTokens: num(e.inputTokens) } : {}),
    ...(num(e.outputTokens) !== undefined ? { outputTokens: num(e.outputTokens) } : {}),
  };
}

/** USD spend per agent, derived from gatekeeper-egress-attested `llm` ledger rows. */
export class SpendTracker {
  private readonly rows: Array<{ agentId: string; runId?: string; ts: string; usd: number } & SpendDetail> = [];

  static fromLedger(events: LedgerEvent[], trusted: (e: LedgerEvent) => boolean): SpendTracker {
    const t = new SpendTracker();
    for (const e of events) if (e.type === 'llm' && typeof e.costUsd === 'number' && trusted(e)) t.add(e.agentId, e.runId, e.costUsd, e.timestamp, spendDetail(e));
    return t;
  }

  add(agentId: string, runId: string | undefined, usd: number, ts = new Date().toISOString(), detail: SpendDetail = {}) {
    this.rows.push({ agentId, runId, ts, usd, ...detail });
  }

  /** Per-agent model spend for the current UTC day and month (`GET /api/v1/spend`). Counts only; no bodies. */
  report(now = new Date()): { day: string; month: string; agents: Record<string, { day: SpendWindow; month: SpendWindow }> } {
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const agents: Record<string, { day: SpendWindow; month: SpendWindow }> = {};
    const bump = (w: SpendWindow, r: (typeof this.rows)[number]) => {
      const inT = r.inputTokens ?? 0;
      const outT = r.outputTokens ?? 0;
      w.usd += r.usd;
      w.calls += 1;
      w.inputTokens += inT;
      w.outputTokens += outT;
      const m = (w.byModel[r.model ?? 'unknown'] ??= { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
      m.usd += r.usd;
      m.calls += 1;
      m.inputTokens += inT;
      m.outputTokens += outT;
    };
    for (const r of this.rows) {
      if (!r.ts.startsWith(month)) continue;
      const a = (agents[r.agentId] ??= { day: emptyWindow(), month: emptyWindow() });
      bump(a.month, r);
      if (r.ts.startsWith(day)) bump(a.day, r);
    }
    return { day, month, agents };
  }

  get(agentId: string, runId: string | undefined, now = new Date()): Spend {
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const out: Spend = { run: 0, day: 0, month: 0 };
    for (const r of this.rows) {
      if (r.agentId !== agentId) continue;
      if (runId && r.runId === runId) out.run += r.usd;
      if (r.ts.startsWith(month)) out.month += r.usd;
      if (r.ts.startsWith(day)) out.day += r.usd;
    }
    return out;
  }
}

/** The first budget window that is at or over its limit, if any. */
export function exceededWindow(policy: AgentPolicy, spend: Spend): 'perRun' | 'perDay' | 'perMonth' | undefined {
  const b = policy.budgetUsd;
  if (!b) return undefined;
  if (b.perRun !== undefined && spend.run >= b.perRun) return 'perRun';
  if (b.perDay !== undefined && spend.day >= b.perDay) return 'perDay';
  if (b.perMonth !== undefined && spend.month >= b.perMonth) return 'perMonth';
  return undefined;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'consumed';

/**
 * E9: the reviewable copy of a held request: exactly what the gatekeeper-egress will send on release, minus the
 * credential it injects then. `body` is UTF-8 text, or base64 when `bodyEncoding` says so.
 */
export type HeldRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** How the console renders it (e.g. `linkedin-post`); absent: the raw request. */
  preview?: string;
};

export type Approval = {
  approvalId: string;
  runId: string;
  agentId: string;
  route: string;
  tool: string;
  argsSha256: string;
  state: ApprovalState;
  requestedAt: string;
  /** `held`: a request in a person's name (E9), bound to the agent rather than the run. Absent: an MCP tool call. */
  kind?: 'held';
  request?: HeldRequest;
  decidedBy?: string;
  decidedAt?: string;
  /** The approver's notes, delivered to the agent with the decision (e.g. what to change). */
  notes?: string;
};

/** Human-in-the-loop holds for tool calls marked requireApproval and held requests (E9). One approval releases one call. */
export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(private readonly dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const a = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Approval;
      this.items.set(a.approvalId, a);
    }
  }

  /** Idempotent: the same run/route/tool/args returns the open (pending or approved) request. */
  request(k: Pick<Approval, 'runId' | 'agentId' | 'route' | 'tool' | 'argsSha256'>): { approval: Approval; created: boolean } {
    for (const a of this.items.values()) {
      if (a.kind !== 'held' && a.runId === k.runId && a.route === k.route && a.tool === k.tool && a.argsSha256 === k.argsSha256) {
        if (a.state === 'pending' || a.state === 'approved') return { approval: { ...a }, created: false };
      }
    }
    const a: Approval = { ...k, approvalId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString() };
    this.save(a);
    return { approval: { ...a }, created: true };
  }

  /**
   * E9: the hold for this agent's identical request (same route and hash). An open one (pending or approved) is
   * returned as is; a rejected one is returned so the identical request is refused, not asked again; otherwise (none,
   * or the last one was used) a new pending hold is created.
   */
  hold(k: Pick<Approval, 'runId' | 'agentId' | 'route' | 'tool' | 'argsSha256'> & { request: HeldRequest }): { approval: Approval; created: boolean } {
    let rejected: Approval | undefined;
    for (const a of this.items.values()) {
      if (a.kind !== 'held' || a.agentId !== k.agentId || a.route !== k.route || a.argsSha256 !== k.argsSha256) continue;
      if (a.state === 'pending' || a.state === 'approved') return { approval: { ...a }, created: false };
      if (a.state === 'rejected' && (!rejected || a.requestedAt > rejected.requestedAt)) rejected = a;
    }
    if (rejected) return { approval: { ...rejected }, created: false };
    const a: Approval = { ...k, kind: 'held', approvalId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString() };
    this.save(a);
    return { approval: { ...a }, created: true };
  }

  get(id: string): Approval | undefined {
    const a = this.items.get(id);
    return a ? { ...a } : undefined;
  }

  list(filter: { state?: ApprovalState; runId?: string } = {}): Approval[] {
    return [...this.items.values()].filter((a) => (!filter.state || a.state === filter.state) && (!filter.runId || a.runId === filter.runId));
  }

  decide(id: string, decision: 'approved' | 'rejected', actor: string, notes?: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.state !== 'pending') return undefined;
    const next = { ...a, state: decision, decidedBy: actor, decidedAt: new Date().toISOString(), ...(notes ? { notes } : {}) };
    this.save(next);
    return { ...next };
  }

  consume(id: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.state !== 'approved') return undefined;
    const next = { ...a, state: 'consumed' as const };
    this.save(next);
    return { ...next };
  }

  private save(a: Approval) {
    this.items.set(a.approvalId, a);
    if (!this.dir) return;
    const path = join(this.dir, `${a.approvalId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(a));
    renameSync(tmp, path);
  }
}
