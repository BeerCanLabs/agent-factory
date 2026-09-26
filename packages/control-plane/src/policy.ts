import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** USD spend per agent, derived from gateway-attested `llm` ledger rows. */
export class SpendTracker {
  private readonly rows: Array<{ agentId: string; runId?: string; ts: string; usd: number }> = [];

  static fromLedger(events: LedgerEvent[], trusted: (e: LedgerEvent) => boolean): SpendTracker {
    const t = new SpendTracker();
    for (const e of events) if (e.type === 'llm' && typeof e.costUsd === 'number' && trusted(e)) t.add(e.agentId, e.runId, e.costUsd, e.timestamp);
    return t;
  }

  add(agentId: string, runId: string | undefined, usd: number, ts = new Date().toISOString()) {
    this.rows.push({ agentId, runId, ts, usd });
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

export type Approval = {
  approvalId: string;
  runId: string;
  agentId: string;
  route: string;
  tool: string;
  argsSha256: string;
  state: ApprovalState;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
};

/** Human-in-the-loop holds for tool calls marked requireApproval. One approval releases one call. */
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
      if (a.runId === k.runId && a.route === k.route && a.tool === k.tool && a.argsSha256 === k.argsSha256) {
        if (a.state === 'pending' || a.state === 'approved') return { approval: { ...a }, created: false };
      }
    }
    const a: Approval = { ...k, approvalId: randomUUID(), state: 'pending', requestedAt: new Date().toISOString() };
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

  decide(id: string, decision: 'approved' | 'rejected', actor: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a || a.state !== 'pending') return undefined;
    const next = { ...a, state: decision, decidedBy: actor, decidedAt: new Date().toISOString() };
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
