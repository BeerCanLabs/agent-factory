/**
 * The Treasurer's spend endpoints (DESIGN_AUTHORITY §6.15 Treasurer): AI, infrastructure and per-agent spend, the
 * cluster's compute allocation, and the factory budgets.
 *
 *   GET /api/v1/spend/report?period=current|last   the full report (`buildSpendReport`)
 *   GET /api/v1/spend/compute                       live allocation: house services and agent tasks
 *   GET /api/v1/spend/budgets                       factory budgets and their history
 *   PUT /api/v1/spend/budgets                       set them (`spend.budget.set`, admin)
 *
 * Reads use the access model of `GET /api/v1/spend`: a viewer (`spend.read`), or a live run whose admin-set policy
 * grants the `factory-spend` tool (E7: never implied). Every read and every change is ledgered. The cloud bill is read
 * through the Treasurer's `CloudCostSource`, never by an agent.
 */
import type http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  attributeCompute,
  budgetCrossings,
  buildSpendReport,
  HOURS_PER_MONTH,
  hourlyUsd,
  periodWindow,
  summarizeCloud,
  TtlCache,
  validateFactoryBudgets,
  type CloudCostSource,
  type CloudSummary,
  type ComputeSource,
  type FactoryBudgets,
  type Period,
  type RunInterval,
  type TaskSize,
} from '@beercanlabs/factory-budget';
import { bearerOf, json, readJson, requirePrivilege, routeEvents, SYSTEM, type FactoryState } from './app.js';
import { isTerminal } from './runs.js';

/** Agent tasks are registered at 0.25 vCPU / 0.5 GB (`aws/ecs.ts`). */
export const DEFAULT_AGENT_TASK_SIZE: TaskSize = { vcpu: 0.25, memoryGb: 0.5 };
/** A cloud bill read is cached this long: bills refresh a few times a day and each read can cost money. */
export const CLOUD_CACHE_MS = 60 * 60_000;
/** An agent task older than its warm-down plus this grace is reported as past its warm-down. */
const WARM_DOWN_GRACE_S = 900;

type BudgetVersion = { version: number; budgets: FactoryBudgets; setBy: string; setAt: string };
type BudgetFile = { history: BudgetVersion[]; alerted: Record<string, string[]> };

/** Factory budgets, versioned, written through to one JSON file. In memory when no path is given (tests). */
export class FactoryBudgetStore {
  private data: BudgetFile = { history: [], alerted: {} };
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8')) as BudgetFile;
    } catch {
      // No budgets set yet.
    }
  }
  current(): BudgetVersion | undefined {
    return this.data.history[this.data.history.length - 1];
  }
  history(): BudgetVersion[] {
    return [...this.data.history];
  }
  set(budgets: FactoryBudgets, setBy: string, at = new Date().toISOString()): BudgetVersion {
    const v: BudgetVersion = { version: (this.current()?.version ?? 0) + 1, budgets, setBy, setAt: at };
    this.data.history.push(v);
    this.save();
    return v;
  }
  alerted(month: string): string[] {
    return [...(this.data.alerted[month] ?? [])];
  }
  markAlerted(month: string, keys: string[]) {
    if (!keys.length) return;
    this.data.alerted[month] = [...new Set([...(this.data.alerted[month] ?? []), ...keys])];
    this.save();
  }
  private save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

/** The Treasurer's wiring: its landing-zone sources (absent on a zone with no adapter) and its budget store. */
export type Treasury = {
  cloud?: CloudCostSource;
  compute?: ComputeSource;
  budgets: FactoryBudgetStore;
  cache: TtlCache<CloudSummary>;
  agentTaskSize?: TaskSize;
};

export function createTreasury(opts: { cloud?: CloudCostSource; compute?: ComputeSource; budgetsPath?: string; cacheMs?: number } = {}): Treasury {
  return { cloud: opts.cloud, compute: opts.compute, budgets: new FactoryBudgetStore(opts.budgetsPath), cache: new TtlCache(opts.cacheMs ?? CLOUD_CACHE_MS) };
}

/**
 * Who may read spend: a live run whose admin-set policy grants `factory-spend`, or a principal with `spend.read`.
 * Answers the request itself (401/403) and returns undefined when the caller may not read.
 */
export async function spendReader(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse): Promise<{ actor: string; agentId: string } | undefined> {
  const claims = await state.runTokens.verify(bearerOf(req));
  if (claims) {
    const run = state.runs.get(claims.runId);
    if (!run || run.agentId !== claims.agentId || isTerminal(run.state)) {
      json(res, 401, { error: 'invalid_run_token' });
      return undefined;
    }
    // Only a policy an admin set for this agent counts; the factory fallback policy never grants it.
    const granted = state.policies.has(claims.agentId) && Object.prototype.hasOwnProperty.call(state.policies.get(claims.agentId).tools ?? {}, 'factory-spend');
    if (!granted) {
      json(res, 403, { error: 'forbidden', required: 'policy.tools.factory-spend' });
      return undefined;
    }
    return { actor: `run:${claims.agentId}:${claims.runId}`, agentId: claims.agentId };
  }
  const principal = await requirePrivilege(req, res, state, 'spend.read');
  if (!principal) return undefined;
  return { actor: principal.actor, agentId: 'factory' };
}

function runIntervals(state: FactoryState): RunInterval[] {
  // Only runs that started compute (a task handle); a pre-flight refusal never ran a task.
  return state.runs
    .list({})
    .filter((r) => r.taskHandle)
    .map((r) => ({ agentId: r.agentId, start: r.startedAt ?? r.createdAt, ...(isTerminal(r.state) ? { end: r.updatedAt } : {}) }));
}

/** The Treasurer's report for a period. Infrastructure is `unavailable` (never an error) without a cloud adapter. */
export async function spendReport(state: FactoryState, period: Period, now = new Date()) {
  const t = state.treasury;
  const window = periodWindow(now, period);
  let cloud: CloudSummary | { unavailable: string };
  if (!t?.cloud) {
    cloud = { unavailable: 'no cloud cost source on this landing zone' };
  } else {
    const source = t.cloud;
    try {
      cloud = await t.cache.get(`${source.provider}:${window.start}:${window.end}`, async () => summarizeCloud(await source.costs({ start: window.start, end: window.end })));
    } catch (err) {
      console.error(`[treasurer] cloud cost read failed: ${err instanceof Error ? err.message : String(err)}`);
      cloud = { unavailable: 'the cloud cost source did not answer' };
    }
  }
  const size = t?.agentTaskSize ?? DEFAULT_AGENT_TASK_SIZE;
  return buildSpendReport({
    window,
    aiByAgent: state.spend.monthByAgent(window.month),
    cloud,
    computeByAgent: attributeCompute(runIntervals(state), window, () => size, now),
    budgets: t?.budgets.current()?.budgets ?? {},
    asOf: now.toISOString(),
  });
}

/**
 * Raise a `budget.alert` for every factory budget threshold newly crossed this month (once each), judged on actual
 * gross spend. Called after each current-period report and on the composition root's hourly timer.
 */
export async function checkFactoryBudgets(state: FactoryState, now = new Date()): Promise<string[]> {
  const t = state.treasury;
  const budgets = t?.budgets.current()?.budgets;
  if (!t || !budgets) return [];
  const report = await spendReport(state, 'current', now);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const infra = num(report.totals.infraGrossUsd);
  const spent = { ai: report.totals.aiUsd, infra: infra ?? 0, total: report.totals.aiUsd + (infra ?? 0) };
  const scoped = infra === undefined ? { ...budgets, infraMonthUsd: undefined, totalMonthUsd: undefined } : budgets;
  const month = report.period.month;
  const crossings = budgetCrossings(scoped, spent, t.budgets.alerted(month));
  for (const c of crossings) {
    const alert = state.ledger.append({
      timestamp: now.toISOString(),
      agentId: 'factory',
      type: 'budget.alert',
      action: `FACTORY_BUDGET_${c.scope.toUpperCase()}_${Math.round(c.threshold * 100)}PCT`,
      actor: SYSTEM.policy,
    });
    await routeEvents(state, alert);
  }
  t.budgets.markAlerted(month, crossings.map((c) => c.key));
  return crossings.map((c) => c.key);
}

async function computeReport(state: FactoryState, now = new Date()) {
  const source = state.treasury?.compute;
  if (!source) return { unavailable: 'no compute source on this landing zone', asOf: now.toISOString() };
  const inv = await source.inventory();
  const services = inv.services.map((s) => {
    const hourly = hourlyUsd(s.vcpu, s.memoryGb, s.spot);
    return { ...s, hourlyUsd: Number(hourly.toFixed(5)), estMonthlyUsd: Number((hourly * HOURS_PER_MONTH * Math.max(1, s.running)).toFixed(2)) };
  });
  const serviceNames = new Set(inv.services.map((s) => s.name));
  const agentTasks = inv.tasks
    .filter((t) => !serviceNames.has(t.group))
    .map((t) => {
      const agentId = t.group.replace(/^agent-/, '');
      const record = state.agents.get(agentId);
      const warmDownSeconds = record?.warmDownSeconds;
      const ageSeconds = t.startedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(t.startedAt)) / 1000)) : undefined;
      const live = state.runs.list({ agentId, active: true });
      return {
        agentId,
        group: t.group,
        status: t.status,
        vcpu: t.vcpu,
        memoryGb: t.memoryGb,
        spot: t.spot,
        startedAt: t.startedAt,
        ageSeconds,
        hourlyUsd: Number(hourlyUsd(t.vcpu, t.memoryGb, t.spot).toFixed(5)),
        warmDownSeconds,
        pastWarmDown: ageSeconds !== undefined && ageSeconds > (warmDownSeconds ?? 0) + WARM_DOWN_GRACE_S,
        // A task with no live run is compute the factory no longer accounts for: an orphan.
        runState: live[live.length - 1]?.state ?? null,
        orphan: !record || live.length === 0,
      };
    });
  return {
    provider: inv.provider,
    cluster: inv.cluster,
    services,
    houseMonthlyUsd: Number(services.reduce((n, s) => n + s.estMonthlyUsd, 0).toFixed(2)),
    agentTasks,
    notes: ['Allocation only: CPU and memory utilization are not read.'],
    asOf: now.toISOString(),
  };
}

export async function handleSpend(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/spend/report' && req.method === 'GET') {
    const reader = await spendReader(state, req, res);
    if (!reader) return true;
    const p = new URL(req.url ?? '/', 'http://x').searchParams.get('period') ?? 'current';
    if (p !== 'current' && p !== 'last') {
      json(res, 400, { error: 'period must be current or last' });
      return true;
    }
    const report = await spendReport(state, p);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: reader.agentId, type: 'action', action: 'SPEND_REPORT_READ', actor: reader.actor });
    if (p === 'current') void checkFactoryBudgets(state).catch((e) => console.error(`[treasurer] budget check: ${e instanceof Error ? e.message : String(e)}`));
    json(res, 200, report);
    return true;
  }
  if (path === '/api/v1/spend/compute' && req.method === 'GET') {
    const reader = await spendReader(state, req, res);
    if (!reader) return true;
    let body: unknown;
    try {
      body = await computeReport(state);
    } catch (err) {
      console.error(`[treasurer] compute read failed: ${err instanceof Error ? err.message : String(err)}`);
      body = { unavailable: 'the compute source did not answer', asOf: new Date().toISOString() };
    }
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: reader.agentId, type: 'action', action: 'SPEND_COMPUTE_READ', actor: reader.actor });
    json(res, 200, body);
    return true;
  }
  if (path === '/api/v1/spend/budgets' && req.method === 'GET') {
    const reader = await spendReader(state, req, res);
    if (!reader) return true;
    const store = state.treasury?.budgets;
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: reader.agentId, type: 'action', action: 'SPEND_BUDGETS_READ', actor: reader.actor });
    json(res, 200, { current: store?.current() ?? null, history: store?.history() ?? [] });
    return true;
  }
  if (path === '/api/v1/spend/budgets' && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'spend.budget.set');
    if (!principal) return true;
    if (!state.treasury) {
      json(res, 501, { error: 'treasury_unavailable' });
      return true;
    }
    const v = validateFactoryBudgets(await readJson(req));
    if (!v.ok) {
      json(res, 400, { error: v.error });
      return true;
    }
    const saved = state.treasury.budgets.set(v.budgets, principal.actor);
    state.ledger.append({ timestamp: saved.setAt, agentId: 'factory', type: 'action', action: 'FACTORY_BUDGET_SET', actor: principal.actor });
    json(res, 200, saved);
    void checkFactoryBudgets(state).catch((e) => console.error(`[treasurer] budget check: ${e instanceof Error ? e.message : String(e)}`));
    return true;
  }
  return false;
}
