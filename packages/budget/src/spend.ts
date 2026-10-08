import type { LedgerEvent } from '@beercanlabs/factory-ledger';
import type { Spend } from './index.js';

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

  /** Model spend per agent for one UTC month (`YYYY-MM`), e.g. the previous month for the spend report. */
  monthByAgent(month: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows) if (r.ts.startsWith(month)) out[r.agentId] = (out[r.agentId] ?? 0) + r.usd;
    return out;
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
