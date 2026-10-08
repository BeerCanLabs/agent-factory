/**
 * Treasurer: the factory's cloud spend (DESIGN_AUTHORITY §6.15 Treasurer).
 *
 * Cloud-neutral rules over facts a landing-zone adapter supplies through two contracts: `CloudCostSource` (the cloud
 * bill, by record type, service and usage type) and `ComputeSource` (what compute is allocated now). The Treasurer
 * decides what is AI and what is infrastructure, gross vs credits vs net, the run-rate projection, each agent's
 * compute cost, and whether a factory budget has been crossed. No cloud SDK here; adapters live with their landing
 * zone (`control-plane/src/aws/treasurer.ts`).
 *
 * Budgets are judged on gross usage. Credits are reported but never counted against a budget: they mask the bill.
 */

/** One line of the cloud bill. `recordType` is the cloud's own (AWS: Usage, Credit, Refund, Tax, ...). */
export type CostLine = { recordType: string; service: string; usd: number };
/** Usage-type detail, gross usage only. */
export type UsageLine = { service: string; usageType: string; usd: number; quantity: number };

export type CloudCostSnapshot = { provider: string; start: string; end: string; lines: CostLine[]; usage: UsageLine[] };

/** The landing zone's cloud bill. `start` inclusive, `end` exclusive (YYYY-MM-DD). */
export interface CloudCostSource {
  readonly provider: string;
  costs(window: { start: string; end: string }): Promise<CloudCostSnapshot>;
}

export type ComputeService = {
  name: string;
  vcpu: number;
  memoryGb: number;
  spot: boolean;
  desired: number;
  running: number;
  pending: number;
  deployments: number;
  rollout: string[];
};
export type ComputeTask = {
  /** The service or task family the task belongs to (`service:<name>` / `family:<name>` already stripped). */
  group: string;
  status: string;
  vcpu: number;
  memoryGb: number;
  spot: boolean;
  startedAt?: string;
};
export type ComputeInventory = { provider: string; cluster: string; services: ComputeService[]; tasks: ComputeTask[] };

/** What compute the landing zone has allocated now. */
export interface ComputeSource {
  readonly provider: string;
  inventory(): Promise<ComputeInventory>;
}

/** Container compute prices, USD per vCPU-hour and per GB-hour. */
export type ComputePrice = { vcpuHour: number; gbHour: number; spotVcpuHour: number; spotGbHour: number };

/**
 * AWS Fargate, us-east-1, Linux/x86. Spot floats with capacity; the Spot figures are the effective rates billed to the
 * BeerCanLabs account in October 2026. Operations may pass their own.
 */
export const FARGATE_US_EAST_1: ComputePrice = { vcpuHour: 0.04048, gbHour: 0.004445, spotVcpuHour: 0.01292, spotGbHour: 0.00142 };

export const HOURS_PER_MONTH = 730;

/** Bill lines that reduce the bill rather than add to it. */
const CREDIT_TYPES = new Set(['Credit', 'Refund', 'Discount', 'BundledDiscount', 'SavingsPlanNegation', 'PrivateRateDiscount']);

/** Cloud services that are model inference: AI spend, already metered per agent by the model ledger. */
export const MODEL_SERVICE = /bedrock|vertex ai|gemini api|generative language/i;

export type Period = 'current' | 'last';
export type PeriodWindow = { period: Period; label: string; month: string; start: string; end: string; partial: boolean; elapsedFraction: number };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** `current`: the UTC month to date (end = tomorrow, exclusive). `last`: the whole previous UTC month. */
export function periodWindow(now: Date, period: Period = 'current'): PeriodWindow {
  const firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const name = (d: Date) => d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (period === 'last') {
    const firstPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { period, label: name(firstPrev), month: ymd(firstPrev).slice(0, 7), start: ymd(firstPrev), end: ymd(firstThis), partial: false, elapsedFraction: 1 };
  }
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const elapsed = (now.getTime() - firstThis.getTime()) / (firstNext.getTime() - firstThis.getTime());
  return {
    period,
    label: `${name(firstThis)} month-to-date`,
    month: ymd(firstThis).slice(0, 7),
    start: ymd(firstThis),
    end: ymd(tomorrow),
    partial: true,
    elapsedFraction: Math.min(1, Math.max(0, elapsed)),
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const r4 = (n: number) => Math.round(n * 10000) / 10000 + 0;

export type CloudSummary = {
  provider: string;
  grossUsd: number;
  creditsUsd: number;
  netUsd: number;
  /** What the cloud billed for model inference. Compare with the model ledger; never add the two. */
  aiBilledByCloudUsd: number;
  infraGrossUsd: number;
  infraByService: Array<{ service: string; usd: number }>;
  topInfraUsageTypes: UsageLine[];
};

/** Gross vs credits vs net, and the split of the bill into model inference and infrastructure. */
export function summarizeCloud(s: CloudCostSnapshot, top = 10): CloudSummary {
  let gross = 0;
  let credits = 0;
  let ai = 0;
  const infra = new Map<string, number>();
  for (const l of s.lines) {
    if (!Number.isFinite(l.usd)) continue;
    if (CREDIT_TYPES.has(l.recordType) || l.usd < 0) {
      credits += l.usd;
      continue;
    }
    gross += l.usd;
    if (MODEL_SERVICE.test(l.service)) ai += l.usd;
    else infra.set(l.service, (infra.get(l.service) ?? 0) + l.usd);
  }
  const infraByService = [...infra.entries()]
    .map(([service, usd]) => ({ service, usd: r4(usd) }))
    .filter((x) => x.usd >= 0.005)
    .sort((a, b) => b.usd - a.usd);
  const topInfraUsageTypes = s.usage
    .filter((u) => u.usd >= 0.01 && !MODEL_SERVICE.test(u.service))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, top)
    .map((u) => ({ ...u, usd: r4(u.usd), quantity: r4(u.quantity) }));
  return {
    provider: s.provider,
    grossUsd: r4(gross),
    creditsUsd: r4(credits),
    netUsd: r4(gross + credits),
    aiBilledByCloudUsd: r4(ai),
    infraGrossUsd: r4(gross - ai),
    infraByService,
    topInfraUsageTypes,
  };
}

export function hourlyUsd(vcpu: number, memoryGb: number, spot: boolean, price: ComputePrice = FARGATE_US_EAST_1): number {
  return spot ? vcpu * price.spotVcpuHour + memoryGb * price.spotGbHour : vcpu * price.vcpuHour + memoryGb * price.gbHour;
}

/** One agent run as compute: when its task started and stopped (open = still running). */
export type RunInterval = { agentId: string; start: string; end?: string };
export type TaskSize = { vcpu: number; memoryGb: number; spot?: boolean };

/**
 * Each agent's compute cost in a window: run task-hours, clipped to the window, priced by size. Report-only: it never
 * counts against an agent's `budgetUsd` (Dale, 2026-10-08).
 */
export function attributeCompute(
  runs: RunInterval[],
  window: { start: string; end: string },
  sizeOf: (agentId: string) => TaskSize,
  now: Date = new Date(),
  price: ComputePrice = FARGATE_US_EAST_1,
): Record<string, { hours: number; usd: number }> {
  const ws = Date.parse(`${window.start}T00:00:00Z`);
  const we = Math.min(Date.parse(`${window.end}T00:00:00Z`), now.getTime());
  const out: Record<string, { hours: number; usd: number }> = {};
  for (const r of runs) {
    const s = Date.parse(r.start);
    const e = r.end ? Date.parse(r.end) : now.getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const ms = Math.min(e, we) - Math.max(s, ws);
    if (ms <= 0) continue;
    const hours = ms / 3_600_000;
    const size = sizeOf(r.agentId);
    const a = (out[r.agentId] ??= { hours: 0, usd: 0 });
    a.hours += hours;
    a.usd += hours * hourlyUsd(size.vcpu, size.memoryGb, size.spot === true, price);
  }
  for (const a of Object.values(out)) {
    a.hours = r4(a.hours);
    a.usd = r4(a.usd);
  }
  return out;
}

// ---- factory budgets ---------------------------------------------------------------------------------------------

/** Factory-level monthly budgets, judged on gross usage. Each is optional; an unset budget is not evaluated. */
export type FactoryBudgets = { aiMonthUsd?: number; infraMonthUsd?: number; totalMonthUsd?: number; alertAt?: number[] };
export type FactoryBudgetScope = 'ai' | 'infra' | 'total';
export const DEFAULT_ALERT_AT = [0.8, 1];

export function validateFactoryBudgets(raw: unknown): { ok: true; budgets: FactoryBudgets } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'budgets must be an object' };
  const out: FactoryBudgets = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'aiMonthUsd' || k === 'infraMonthUsd' || k === 'totalMonthUsd') {
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, error: `${k} must be a number >= 0` };
      out[k] = v;
    } else if (k === 'alertAt') {
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'number' || !(x > 0) || x > 10)) {
        return { ok: false, error: 'alertAt must be a non-empty list of fractions (e.g. [0.8, 1])' };
      }
      out.alertAt = [...new Set(v as number[])].sort((a, b) => a - b);
    } else {
      return { ok: false, error: `unknown budget field ${k}` };
    }
  }
  return { ok: true, budgets: out };
}

export type BudgetStatus = { monthUsd: number; spentUsd: number; pct: number; projectedUsd?: number; projectedPct?: number };

export function budgetStatus(budgets: FactoryBudgets, spent: Record<FactoryBudgetScope, number>, projected?: Record<FactoryBudgetScope, number>) {
  const out: Partial<Record<FactoryBudgetScope, BudgetStatus>> = {};
  const caps: Record<FactoryBudgetScope, number | undefined> = { ai: budgets.aiMonthUsd, infra: budgets.infraMonthUsd, total: budgets.totalMonthUsd };
  for (const scope of ['ai', 'infra', 'total'] as const) {
    const cap = caps[scope];
    if (cap === undefined) continue;
    const s: BudgetStatus = { monthUsd: cap, spentUsd: r2(spent[scope]), pct: cap > 0 ? r4(spent[scope] / cap) : spent[scope] > 0 ? Infinity : 0 };
    if (projected) {
      s.projectedUsd = r2(projected[scope]);
      s.projectedPct = cap > 0 ? r4(projected[scope] / cap) : 0;
    }
    out[scope] = s;
  }
  return out;
}

/**
 * Thresholds newly crossed this month, each reported once: `alerted` holds keys already sent (`<scope>:<fraction>`).
 * Judged on actual gross spend, not the projection, so an alert is a fact and never a forecast.
 */
export function budgetCrossings(budgets: FactoryBudgets, spent: Record<FactoryBudgetScope, number>, alerted: Iterable<string>) {
  const sent = new Set(alerted);
  const out: Array<{ scope: FactoryBudgetScope; threshold: number; key: string; spentUsd: number; monthUsd: number }> = [];
  const caps: Record<FactoryBudgetScope, number | undefined> = { ai: budgets.aiMonthUsd, infra: budgets.infraMonthUsd, total: budgets.totalMonthUsd };
  for (const scope of ['ai', 'infra', 'total'] as const) {
    const cap = caps[scope];
    if (cap === undefined) continue;
    for (const t of budgets.alertAt ?? DEFAULT_ALERT_AT) {
      const key = `${scope}:${t}`;
      if (!sent.has(key) && spent[scope] >= cap * t) out.push({ scope, threshold: t, key, spentUsd: r2(spent[scope]), monthUsd: cap });
    }
  }
  return out;
}

// ---- the report ---------------------------------------------------------------------------------------------------

export type SpendReportInput = {
  window: PeriodWindow;
  /** Model-ledger spend for the window's month, per agent (USD). */
  aiByAgent: Record<string, number>;
  /** The cloud bill summary, or why it is unavailable. */
  cloud: CloudSummary | { unavailable: string };
  computeByAgent: Record<string, { hours: number; usd: number }>;
  budgets: FactoryBudgets;
  asOf: string;
};

/**
 * The Treasurer's spend report: AI, infrastructure and per-agent spend, and the factory budgets. AI is the model
 * ledger (exact, per agent); infrastructure is the cloud bill's gross usage less model inference, so AI is never
 * counted twice. Per-agent compute is part of infrastructure; the rest of infrastructure is shared factory overhead.
 */
export function buildSpendReport(i: SpendReportInput) {
  const w = i.window;
  const aiUsd = Object.values(i.aiByAgent).reduce((n, v) => n + v, 0);
  const computeUsd = Object.values(i.computeByAgent).reduce((n, v) => n + v.usd, 0);
  const cloud = 'unavailable' in i.cloud ? undefined : i.cloud;
  const infra = cloud?.infraGrossUsd;
  const project = (n: number) => (w.partial && w.elapsedFraction > 0.02 ? n / w.elapsedFraction : n);

  const ids = new Set([...Object.keys(i.aiByAgent), ...Object.keys(i.computeByAgent)]);
  const agents = [...ids]
    .map((agentId) => {
      const ai = i.aiByAgent[agentId] ?? 0;
      const c = i.computeByAgent[agentId];
      return { agentId, aiUsd: r4(ai), computeUsd: r4(c?.usd ?? 0), computeHours: c?.hours ?? 0, totalUsd: r4(ai + (c?.usd ?? 0)) };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const spent = { ai: aiUsd, infra: infra ?? 0, total: aiUsd + (infra ?? 0) };
  const projected = { ai: project(spent.ai), infra: project(spent.infra), total: project(spent.total) };
  const budgets = budgetStatus(i.budgets, spent, w.partial ? projected : undefined);
  if (!cloud) {
    // Without the cloud bill only the AI budget can be judged.
    delete budgets.infra;
    delete budgets.total;
  }

  return {
    period: { period: w.period, label: w.label, month: w.month, start: w.start, end: w.end, partial: w.partial },
    currency: 'USD',
    totals: {
      aiUsd: r4(aiUsd),
      infraGrossUsd: infra === undefined ? 'unavailable' : r4(infra),
      grossUsd: infra === undefined ? 'unavailable' : r4(aiUsd + infra),
      creditsUsd: cloud ? cloud.creditsUsd : 'unavailable',
      netUsd: cloud ? r4(aiUsd + infra! + cloud.creditsUsd) : 'unavailable',
      ...(w.partial ? { projectedMonthGrossUsd: infra === undefined ? 'unavailable' : r2(projected.total), projectedMonthAiUsd: r2(projected.ai) } : {}),
    },
    budgets,
    agents,
    infra: cloud
      ? {
          provider: cloud.provider,
          agentComputeUsd: r4(computeUsd),
          overheadUsd: r4(Math.max(0, cloud.infraGrossUsd - computeUsd)),
          byService: cloud.infraByService,
          topUsageTypes: cloud.topInfraUsageTypes,
        }
      : { unavailable: (i.cloud as { unavailable: string }).unavailable, agentComputeUsd: r4(computeUsd) },
    reconciliation: cloud ? { aiLedgerUsd: r4(aiUsd), aiBilledByCloudUsd: cloud.aiBilledByCloudUsd } : undefined,
    notes: [
      'Budgets are judged on gross usage; credits are reported but never counted against a budget.',
      'Per-agent compute is estimated from run task-hours and is report-only.',
    ],
    asOf: i.asOf,
  };
}

/** A small TTL cache for cloud bill reads (each call to a billing API can cost money; bills refresh a few times a day). */
export class TtlCache<V> {
  private readonly m = new Map<string, { at: number; v: Promise<V> }>();
  constructor(private readonly ttlMs: number, private readonly clock: () => number = Date.now) {}
  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.m.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.v;
    const v = load();
    this.m.set(key, { at: this.clock(), v });
    // A failed read is not cached.
    v.catch(() => this.m.delete(key));
    return v;
  }
}
