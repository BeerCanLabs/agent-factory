import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateBudgetLimits } from '@beercanlabs/factory-budget';
import { archiveStamp } from '@beercanlabs/factory-registrar';
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
    const budget = validateBudgetLimits(r.budgetUsd);
    if (!budget.ok) return budget;
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
