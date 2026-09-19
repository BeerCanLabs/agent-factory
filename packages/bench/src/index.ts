import { isDeepStrictEqual } from 'node:util';
import type { Bench, BenchCase } from '@beercanlabs/factory-contract';

export type RunView = { runId: string; state: string; result?: unknown; error?: string; startedAt?: string; updatedAt: string; createdAt: string };

/** The slice of the factory API the harness needs. */
export type FactoryClient = {
  createRun(agentId: string, body: { input?: unknown; model: string }): Promise<{ status: number; run?: RunView; error?: string }>;
  getRun(runId: string): Promise<RunView>;
  costOf(agentId: string, runId: string): Promise<number>;
  getPolicy(agentId: string): Promise<Record<string, unknown>>;
  putPolicy(agentId: string, policy: Record<string, unknown>): Promise<number>;
};

export type CaseResult = {
  caseId: string;
  model: string;
  pass: boolean;
  reason?: string;
  runId?: string;
  state?: string;
  costUsd: number;
  seconds: number;
};

export type ModelSummary = {
  model: string;
  cases: number;
  passed: number;
  passRate: number;
  costUsd: number;
  avgCostUsd: number;
  maxCostUsd: number;
  avgSeconds: number;
};

const TERMINAL = new Set(['DONE', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'PRE_FLIGHT_MISSING_SECRET']);
const BLOCKED = new Set(['BLOCKED_BUDGET_EXCEEDED', 'BLOCKED_FOR_HUMAN', 'BLOCKED_UNHEALTHY']);

function asText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}

/** Deterministic grading only: status, deep equality, substrings, regex. */
export function grade(c: BenchCase, run: RunView): { pass: boolean; reason?: string } {
  const want = c.expect?.status ?? 'DONE';
  if (run.state !== want) return { pass: false, reason: `state ${run.state}${run.error ? `: ${run.error}` : ''}, expected ${want}` };
  const e = c.expect ?? { status: 'DONE' };
  if (e.equals !== undefined && !isDeepStrictEqual(run.result, e.equals)) return { pass: false, reason: 'output not equal to expected' };
  const text = asText(run.result);
  for (const s of e.contains ?? []) if (!text.toLowerCase().includes(s.toLowerCase())) return { pass: false, reason: `output missing "${s}"` };
  if (e.matches !== undefined && !new RegExp(e.matches, 's').test(text)) return { pass: false, reason: `output does not match /${e.matches}/` };
  return { pass: true };
}

export async function runCase(
  client: FactoryClient,
  agentId: string,
  model: string,
  c: BenchCase,
  opts: { pollMs?: number; now?: () => number } = {},
): Promise<CaseResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const created = await client.createRun(agentId, { input: c.input, model });
  if (!created.run || (created.status !== 202 && created.status !== 200)) {
    return { caseId: c.id, model, pass: false, reason: `run not started (${created.status}${created.error ? `: ${created.error}` : ''})`, costUsd: 0, seconds: 0 };
  }
  let run = created.run;
  const deadline = started + (c.timeoutSeconds ?? 300) * 1000;
  while (!TERMINAL.has(run.state) && !BLOCKED.has(run.state) && now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    run = await client.getRun(run.runId);
  }
  const costUsd = await client.costOf(agentId, run.runId);
  const seconds = (now() - started) / 1000;
  if (!TERMINAL.has(run.state)) {
    return { caseId: c.id, model, pass: false, reason: BLOCKED.has(run.state) ? run.state : 'timed out', runId: run.runId, state: run.state, costUsd, seconds };
  }
  return { caseId: c.id, model, runId: run.runId, state: run.state, costUsd, seconds, ...grade(c, run) };
}

export async function runBench(
  client: FactoryClient,
  agentId: string,
  suite: Bench,
  models: string[],
  opts: { pollMs?: number; onCase?: (r: CaseResult) => void } = {},
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const model of models) {
    for (const c of suite.cases) {
      const r = await runCase(client, agentId, model, c, opts);
      opts.onCase?.(r);
      results.push(r);
    }
  }
  return results;
}

export function summarize(results: CaseResult[]): ModelSummary[] {
  const byModel = new Map<string, CaseResult[]>();
  for (const r of results) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel.entries()].map(([model, rs]) => {
    const passed = rs.filter((r) => r.pass).length;
    const cost = rs.reduce((s, r) => s + r.costUsd, 0);
    return {
      model,
      cases: rs.length,
      passed,
      passRate: rs.length ? passed / rs.length : 0,
      costUsd: cost,
      avgCostUsd: rs.length ? cost / rs.length : 0,
      maxCostUsd: rs.reduce((m, r) => Math.max(m, r.costUsd), 0),
      avgSeconds: rs.length ? rs.reduce((s, r) => s + r.seconds, 0) / rs.length : 0,
    };
  });
}

function usd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/** The Cost vs Quality Matrix: one row per model, projected to a monthly run volume. */
export function matrix(summaries: ModelSummary[], runsPerMonth: number): string {
  const rows = [...summaries].sort((a, b) => b.passRate - a.passRate || a.avgCostUsd - b.avgCostUsd);
  const lines = [
    `| Model | Pass rate | Avg cost / run | Projected / month (${runsPerMonth.toLocaleString('en-US')} runs) | Avg latency |`,
    '|---|---|---|---|---|',
    ...rows.map(
      (s) =>
        `| ${s.model} | ${(s.passRate * 100).toFixed(0)}% (${s.passed}/${s.cases}) | ${usd(s.avgCostUsd)} | ${usd(s.avgCostUsd * runsPerMonth)} | ${s.avgSeconds.toFixed(1)}s |`,
    ),
  ];
  return lines.join('\n');
}

/**
 * Cheapest model meeting the pass bar, with a per-run budget at `headroom` × the most expensive case.
 * The human decides; this is the policy they would apply.
 */
export function recommend(
  summaries: ModelSummary[],
  opts: { minPassRate: number; headroom?: number },
): { model: string; policyPatch: { models: string[]; budgetUsd: { perRun: number } } } | null {
  const ok = summaries.filter((s) => s.passRate >= opts.minPassRate).sort((a, b) => a.avgCostUsd - b.avgCostUsd);
  if (!ok.length) return null;
  const best = ok[0];
  const perRun = Math.max(0.0001, Math.ceil(best.maxCostUsd * (opts.headroom ?? 2) * 10_000) / 10_000);
  return { model: best.model, policyPatch: { models: [best.model], budgetUsd: { perRun } } };
}

/** HTTP client against a factory control plane. Needs operator + viewer (or admin to --apply). */
export function httpClient(baseUrl: string, token: string): FactoryClient {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return {
    async createRun(agentId, body) {
      const r = await call('POST', `/api/v1/agents/${encodeURIComponent(agentId)}/runs`, body);
      return r.status === 202 ? { status: r.status, run: r.body as unknown as RunView } : { status: r.status, error: String(r.body.error ?? '') };
    },
    async getRun(runId) {
      return (await call('GET', `/api/v1/runs/${encodeURIComponent(runId)}`)).body as unknown as RunView;
    },
    async costOf(agentId, runId) {
      const rows = (await call('GET', `/api/v1/ledger?agent=${encodeURIComponent(agentId)}`)).body as unknown as Array<{ runId?: string; costUsd?: number }>;
      return rows.filter((r) => r.runId === runId && typeof r.costUsd === 'number').reduce((s, r) => s + (r.costUsd ?? 0), 0);
    },
    async getPolicy(agentId) {
      return (await call('GET', `/api/v1/agents/${encodeURIComponent(agentId)}/policy`)).body;
    },
    async putPolicy(agentId, policy) {
      return (await call('PUT', `/api/v1/agents/${encodeURIComponent(agentId)}/policy`, policy)).status;
    },
  };
}
