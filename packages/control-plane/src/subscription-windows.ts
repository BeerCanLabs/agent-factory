/**
 * Subscription plan-limit windows (DESIGN_AUTHORITY.md §6.9 M5(7), (7a)).
 *
 * A window is per subscription CONNECTION, never per agent or per catalog entry. The gatekeeper-egress keeps no durable
 * state and may run as several instances, so the window is held here, by the factory's one writer (LG1), and every egress
 * instance reads it:
 *
 *   GET /api/v1/gatekeeper-egress/subscription-windows               the open windows (gatekeeper-egress only)
 *   PUT /api/v1/gatekeeper-egress/subscription-windows/:connection   (gatekeeper-egress only)
 *        {action:'open', kind, code, resetAt?}   open a window (idempotent: an open window stays as it is)
 *        {action:'close', by:'reset'|'probe'}    close it (a successful probe, or the vendor's reset time)
 *        {action:'probe'}                        claim the hourly probe slot: {granted:boolean}
 *
 * The state is rebuilt from `SUBSCRIPTION_LIMIT_REACHED`, `SUBSCRIPTION_LIMIT_RESET` and `SUBSCRIPTION_LIMIT_PROBE` ledger
 * rows, which this file writes itself, so the store and the ledger cannot disagree and a restart loses nothing. Nothing here
 * touches an agent's policy: no `POLICY_UPDATED`, no `currentModel` change.
 */
import http from 'node:http';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { getSubscriptions } from './subscriptions.js';

export type LimitWindowKind = 'plan-limit' | 'tier-refused';

export type LimitWindow = {
  connection: string;
  kind: LimitWindowKind;
  /** The vendor's own error code that opened it. */
  code: string;
  openedAt: string;
  /** The vendor's reset time. Absent: the window stays open until a probe succeeds. */
  resetAt?: string;
  /** When the probe slot was last handed out (survives a window closing and reopening). */
  lastProbeAt?: string;
};

type Ledger = FactoryState['ledger'];

export const PROBE_INTERVAL_MS = 60 * 60 * 1000;
/** A vendor reset time further out than this is not believed; the window then waits for a probe. */
const MAX_RESET_MS = 31 * 24 * 60 * 60 * 1000;
const ACTOR = 'factory:gatekeeper-egress';

export class SubscriptionWindows {
  private readonly windows = new Map<string, LimitWindow>();
  private readonly probes = new Map<string, string>();

  constructor(
    private readonly ledger: Ledger,
    private readonly now: () => number = Date.now,
  ) {
    this.rebuild();
  }

  /** Replay the ledger: the last row for a connection decides whether its window is open. */
  private rebuild(): void {
    const rows = this.ledger
      .query()
      .filter((r) => r.action === 'SUBSCRIPTION_LIMIT_REACHED' || r.action === 'SUBSCRIPTION_LIMIT_RESET' || r.action === 'SUBSCRIPTION_LIMIT_PROBE')
      .sort((a, b) => a.seq - b.seq);
    for (const r of rows) {
      const connection = typeof r.connection === 'string' ? r.connection : undefined;
      if (!connection) continue;
      if (r.action === 'SUBSCRIPTION_LIMIT_REACHED') {
        this.windows.set(connection, {
          connection,
          kind: r.limitKind === 'tier-refused' ? 'tier-refused' : 'plan-limit',
          code: typeof r.limitCode === 'string' ? r.limitCode : 'unknown',
          openedAt: r.timestamp,
          ...(typeof r.resetAt === 'string' ? { resetAt: r.resetAt } : {}),
          ...(this.probes.get(connection) ? { lastProbeAt: this.probes.get(connection) } : {}),
        });
      } else if (r.action === 'SUBSCRIPTION_LIMIT_RESET') {
        this.windows.delete(connection);
      } else {
        this.probes.set(connection, r.timestamp);
        const w = this.windows.get(connection);
        if (w) w.lastProbeAt = r.timestamp;
      }
    }
  }

  private row(action: string, connection: string, extra: Record<string, unknown> = {}): void {
    this.ledger.append({ timestamp: new Date(this.now()).toISOString(), agentId: 'factory', type: 'action', action, actor: ACTOR, connection, ...extra });
  }

  /** The open windows. A window whose reset time has passed closes here, once, and is ledgered. */
  list(): LimitWindow[] {
    for (const w of [...this.windows.values()]) {
      if (w.resetAt && Date.parse(w.resetAt) <= this.now()) this.close(w.connection, 'reset');
    }
    return [...this.windows.values()].map((w) => ({ ...w }));
  }

  get(connection: string): LimitWindow | undefined {
    return this.list().find((w) => w.connection === connection);
  }

  /** Open a window. An already-open window is left as it is and nothing is written, so two instances reporting one limit open one window. */
  open(connection: string, p: { kind: LimitWindowKind; code: string; resetAt?: string }): { opened: boolean; window: LimitWindow } {
    const existing = this.get(connection);
    if (existing) return { opened: false, window: existing };
    let resetAt: string | undefined;
    if (p.resetAt) {
      const t = Date.parse(p.resetAt);
      if (Number.isFinite(t) && t > this.now() && t - this.now() <= MAX_RESET_MS) resetAt = new Date(t).toISOString();
    }
    const openedAt = new Date(this.now()).toISOString();
    const window: LimitWindow = {
      connection,
      kind: p.kind,
      code: p.code,
      openedAt,
      ...(resetAt ? { resetAt } : {}),
      ...(this.probes.get(connection) ? { lastProbeAt: this.probes.get(connection) } : {}),
    };
    this.windows.set(connection, window);
    this.row('SUBSCRIPTION_LIMIT_REACHED', connection, { limitKind: p.kind, limitCode: p.code, ...(resetAt ? { resetAt } : {}) });
    return { opened: true, window };
  }

  /** Close a window; ledgers `SUBSCRIPTION_LIMIT_RESET` when one was open. */
  close(connection: string, by: 'reset' | 'probe' | 'disconnect'): boolean {
    if (!this.windows.has(connection)) return false;
    this.windows.delete(connection);
    this.row('SUBSCRIPTION_LIMIT_RESET', connection, { closedBy: by });
    return true;
  }

  /** The probe slot: granted to one caller per connection per hour, and only while a window is open. */
  claimProbe(connection: string): boolean {
    const w = this.get(connection);
    if (!w) return false;
    const last = this.probes.get(connection);
    if (last && this.now() - Date.parse(last) < PROBE_INTERVAL_MS) return false;
    const at = new Date(this.now()).toISOString();
    this.probes.set(connection, at);
    w.lastProbeAt = at;
    this.row('SUBSCRIPTION_LIMIT_PROBE', connection);
    return true;
  }
}

const windowsOf = new WeakMap<FactoryState, SubscriptionWindows>();

export function getSubscriptionWindows(state: FactoryState): SubscriptionWindows {
  let w = windowsOf.get(state);
  if (!w) {
    w = new SubscriptionWindows(state.ledger);
    windowsOf.set(state, w);
  }
  return w;
}

/** Handles the window routes. Returns false when the path is not one of them. */
export async function handleSubscriptionWindows(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/gatekeeper-egress/subscription-windows' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'egress.subscription-windows.read'))) return true;
    json(res, 200, { windows: getSubscriptionWindows(state).list() });
    return true;
  }
  const one = path.match(/^\/api\/v1\/gatekeeper-egress\/subscription-windows\/([^/]+)$/);
  if (one && req.method === 'PUT') {
    if (!(await requirePrivilege(req, res, state, 'egress.subscription-windows.write'))) return true;
    const connection = decodeURIComponent(one[1]);
    if (!(await getSubscriptions(state).get(connection))) return json(res, 404, { error: 'unknown_connection' }), true;
    const b = await readJson(req);
    const windows = getSubscriptionWindows(state);
    if (b.action === 'open') {
      const kind = b.kind === 'tier-refused' ? 'tier-refused' : b.kind === 'plan-limit' ? 'plan-limit' : undefined;
      if (!kind || typeof b.code !== 'string' || !b.code || b.code.length > 100) return json(res, 400, { error: 'kind and code required' }), true;
      const r = windows.open(connection, { kind, code: b.code, ...(typeof b.resetAt === 'string' ? { resetAt: b.resetAt } : {}) });
      json(res, 200, { opened: r.opened, window: r.window });
      return true;
    }
    if (b.action === 'close') {
      const by = b.by === 'probe' ? 'probe' : 'reset';
      json(res, 200, { closed: windows.close(connection, by) });
      return true;
    }
    if (b.action === 'probe') {
      json(res, 200, { granted: windows.claimProbe(connection) });
      return true;
    }
    json(res, 400, { error: 'action must be open, close or probe' });
    return true;
  }
  return false;
}
