import type { LedgerEvent } from '@beercanlabs/factory-ledger';
import type { Spend } from './index.js';

export type SpendDetail = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  credentialMode?: 'api-key' | 'subscription';
  scope?: 'factory' | 'personal';
  connection?: string;
};
type SpendCounts = { usd: number; calls: number; inputTokens: number; outputTokens: number };
export type SpendWindow = SpendCounts & { byModel: Record<string, SpendCounts> };

export type SubscriptionTokenTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type SubscriptionConnectionWindow = SubscriptionTokenTotals & {
  byModel: Record<string, SubscriptionTokenTotals>;
  byAgent: Record<string, SubscriptionTokenTotals>;
};

export type SubscriptionAgentWindow = SubscriptionTokenTotals & {
  byModel: Record<string, SubscriptionTokenTotals>;
  byConnection: Record<string, SubscriptionTokenTotals>;
};

export type SubscriptionSpendFilter = {
  connections?: ReadonlySet<string>;
  agents?: ReadonlySet<string>;
};

export type SubscriptionSpendReport = {
  day: string;
  month: string;
  connections: Record<string, { scope?: 'factory' | 'personal'; day: SubscriptionConnectionWindow; month: SubscriptionConnectionWindow }>;
  agents: Record<string, { day: SubscriptionAgentWindow; month: SubscriptionAgentWindow }>;
};

function emptyWindow(): SpendWindow {
  return { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
}

function emptySubTotals(): SubscriptionTokenTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function emptySubConnectionWindow(): SubscriptionConnectionWindow {
  return { ...emptySubTotals(), byModel: {}, byAgent: {} };
}

function emptySubAgentWindow(): SubscriptionAgentWindow {
  return { ...emptySubTotals(), byModel: {}, byConnection: {} };
}

function addSubTotals(dst: SubscriptionTokenTotals, inT: number, outT: number): void {
  dst.calls += 1;
  dst.inputTokens += inT;
  dst.outputTokens += outT;
  dst.totalTokens += inT + outT;
}

function isSubscriptionRow(r: SpendDetail): boolean {
  return r.credentialMode === 'subscription' || Boolean(r.connection);
}

/** The metered fields of a gatekeeper-egress `llm` ledger row. */
export function spendDetail(e: {
  model?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  credentialMode?: unknown;
  scope?: unknown;
  connection?: unknown;
}): SpendDetail {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    ...(typeof e.model === 'string' && e.model ? { model: e.model } : {}),
    ...(num(e.inputTokens) !== undefined ? { inputTokens: num(e.inputTokens) } : {}),
    ...(num(e.outputTokens) !== undefined ? { outputTokens: num(e.outputTokens) } : {}),
    ...(e.credentialMode === 'api-key' || e.credentialMode === 'subscription' ? { credentialMode: e.credentialMode } : {}),
    ...(e.scope === 'factory' || e.scope === 'personal' ? { scope: e.scope } : {}),
    ...(typeof e.connection === 'string' && e.connection ? { connection: e.connection } : {}),
  };
}

/** USD spend per agent and subscription token usage per connection/agent, derived from gatekeeper-egress-attested `llm` ledger rows. */
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

  /**
   * Per-agent priced model spend for the current UTC day and month (`GET /api/v1/spend`).
   * M5(8): `$0` subscription rows are reported apart from priced spend via `subscriptionReport()`; if an admin prices a
   * `factory` subscription `> $0`, its USD spend still appears here while its tokens also appear in `subscriptionReport()`.
   */
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
      if (isSubscriptionRow(r) && r.usd === 0) continue;
      const a = (agents[r.agentId] ??= { day: emptyWindow(), month: emptyWindow() });
      bump(a.month, r);
      if (r.ts.startsWith(day)) bump(a.day, r);
    }
    return { day, month, agents };
  }

  /**
   * M5(8): Subscription token totals per connection and per agent, separate from priced spend.
   * When `filter` is provided (for `ownerPrincipalId`), `connections` includes only `filter.connections` and `agents`
   * includes only `filter.agents` (counting only calls on `filter.connections` when `filter.connections` is also supplied,
   * or any subscription call on `filter.agents` — wait: an owned agent may call either a factory subscription or the owner's
   * personal subscription! For an owner's owned agent, `byConnection` should only name connections visible to that owner or
   * anonymize/keep connection id? Wait: let's check M5(8): "`ownerPrincipalId` may read subscription token totals on their own
   * `personal` connections and owned agents, and Factory Admins read fleet-wide totals"!).
   */
  subscriptionReport(now = new Date(), filter?: SubscriptionSpendFilter): SubscriptionSpendReport {
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const connections: SubscriptionSpendReport['connections'] = {};
    const agents: SubscriptionSpendReport['agents'] = {};

    const bumpConn = (w: SubscriptionConnectionWindow, r: (typeof this.rows)[number]) => {
      const inT = r.inputTokens ?? 0;
      const outT = r.outputTokens ?? 0;
      addSubTotals(w, inT, outT);
      addSubTotals((w.byModel[r.model ?? 'unknown'] ??= emptySubTotals()), inT, outT);
      addSubTotals((w.byAgent[r.agentId] ??= emptySubTotals()), inT, outT);
    };
    const bumpAgent = (w: SubscriptionAgentWindow, r: (typeof this.rows)[number], connKey: string) => {
      const inT = r.inputTokens ?? 0;
      const outT = r.outputTokens ?? 0;
      addSubTotals(w, inT, outT);
      addSubTotals((w.byModel[r.model ?? 'unknown'] ??= emptySubTotals()), inT, outT);
      addSubTotals((w.byConnection[connKey] ??= emptySubTotals()), inT, outT);
    };

    for (const r of this.rows) {
      if (!r.ts.startsWith(month) || !isSubscriptionRow(r)) continue;
      const connId = r.connection ?? 'unknown';
      const allowConn = !filter?.connections || filter.connections.has(connId);
      const allowAgent = !filter?.agents || filter.agents.has(r.agentId);
      if (allowConn) {
        const c = (connections[connId] ??= {
          ...(r.scope ? { scope: r.scope } : {}),
          day: emptySubConnectionWindow(),
          month: emptySubConnectionWindow(),
        });
        if (r.scope && !c.scope) c.scope = r.scope;
        bumpConn(c.month, r);
        if (r.ts.startsWith(day)) bumpConn(c.day, r);
      }
      if (allowAgent && (!filter?.connections || allowConn || r.scope === 'factory')) {
        const a = (agents[r.agentId] ??= {
          day: emptySubAgentWindow(),
          month: emptySubAgentWindow(),
        });
        bumpAgent(a.month, r, connId);
        if (r.ts.startsWith(day)) bumpAgent(a.day, r, connId);
      }
    }
    return { day, month, connections, agents };
  }

  /** Total tokens (`inputTokens + outputTokens`) used by `agentId` on subscription `connection` during `utcDay` (`YYYY-MM-DD`). */
  connectionAgentDayTokens(connection: string, agentId: string, utcDay = new Date().toISOString().slice(0, 10)): number {
    let total = 0;
    for (const r of this.rows) {
      if (r.connection !== connection || r.agentId !== agentId || !r.ts.startsWith(utcDay)) continue;
      total += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    }
    return total;
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
