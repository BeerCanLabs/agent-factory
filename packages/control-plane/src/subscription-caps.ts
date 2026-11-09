/**
 * Per-agent daily subscription token caps and priced-fallback notifications
 * (DESIGN_AUTHORITY.md §6.9 M5(6), (7), (8), TSK-328).
 *
 * Held in the control plane (the single writer, LG1) and rebuilt from the ledger on startup so caps and once-per-episode
 * priced-fallback deduplication survive control-plane and gatekeeper-egress restarts:
 *   - Per-agent daily token cap on a connection resets at midnight UTC (`SUBSCRIPTION_CAP_REACHED`, `SUBSCRIPTION_CAP_RESET`),
 *     never opens or closes a connection-wide limit window, and never affects other agents.
 *   - Priced-fallback notifications fire once per window per agent (`subscription_limit_reached`, with `resetAt`), once per
 *     re-consent episode per agent (`subscription_needs_reconsent`), and once per UTC cap day per agent (`subscription_cap_reached`)
 *     when a `> $0` candidate serves (`SUBSCRIPTION_PRICED_FALLBACK_NOTIFIED`).
 */
import { isZeroPrice, type Price } from '@beercanlabs/factory-budget';
import type { SubscriptionView } from '@beercanlabs/factory-keymaster';
import type { FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { dispatchSubscriptionNotice, factoryAdmins, getCachedSubscriptionView } from './subscriptions.js';
import { getSubscriptionWindows } from './subscription-windows.js';

export type SubscriptionCapView = {
  connection: string;
  agentId: string;
  utcDay: string;
  resetAt: string;
  dailyTokenCap: number;
  tokensUsed: number;
};

export type SubscriptionSkipReason =
  | 'subscription_limit_reached'
  | 'subscription_needs_reconsent'
  | 'subscription_cap_reached';

const ACTOR = 'factory:subscription-caps';

export function utcDayOf(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safe).toISOString().slice(0, 10);
}

export function nextMidnightUtcIso(utcDay: string): string {
  const start = Date.parse(`${utcDay}T00:00:00.000Z`);
  return new Date((Number.isFinite(start) ? start : Date.now()) + 86_400_000).toISOString();
}

function dayKey(connection: string, agentId: string, utcDay: string): string {
  return `${connection}\u0000${agentId}\u0000${utcDay}`;
}

function pairKey(connection: string, agentId: string): string {
  return `${connection}\u0000${agentId}`;
}

export class SubscriptionCaps {
  /** Cumulative tokens `(input + output)` per `(connection, agentId, utcDay)`. */
  private readonly usageByDay = new Map<string, number>();
  /** Currently active per-agent caps keyed by `(connection, agentId)`. */
  private readonly openCaps = new Map<string, SubscriptionCapView>();
  /** Episode keys already notified for `SUBSCRIPTION_PRICED_FALLBACK_NOTIFIED`. */
  private readonly notifiedEpisodes = new Set<string>();

  constructor(
    private readonly state: FactoryState,
    private readonly now: () => number = Date.now,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    const rows = this.state.ledger.query().sort((a, b) => a.seq - b.seq);
    for (const r of rows) {
      if (r.type === 'llm' && typeof r.connection === 'string' && r.connection && typeof r.agentId === 'string' && r.agentId) {
        const day = typeof r.timestamp === 'string' && r.timestamp.length >= 10 ? r.timestamp.slice(0, 10) : utcDayOf(this.now());
        const k = dayKey(r.connection, r.agentId, day);
        const tokens = (typeof r.inputTokens === 'number' ? r.inputTokens : 0) + (typeof r.outputTokens === 'number' ? r.outputTokens : 0);
        if (tokens > 0) this.usageByDay.set(k, (this.usageByDay.get(k) ?? 0) + tokens);
        continue;
      }
      if (r.action === 'SUBSCRIPTION_CAP_REACHED' && typeof r.connection === 'string' && typeof r.agentId === 'string') {
        const utcDay = typeof r.utcDay === 'string' ? r.utcDay : utcDayOf(r.timestamp);
        const resetAt = typeof r.resetAt === 'string' ? r.resetAt : nextMidnightUtcIso(utcDay);
        const dailyTokenCap = typeof r.dailyTokenCap === 'number' ? r.dailyTokenCap : 0;
        const tokensUsed = typeof r.tokensUsed === 'number' ? r.tokensUsed : (this.usageByDay.get(dayKey(r.connection, r.agentId, utcDay)) ?? 0);
        this.openCaps.set(pairKey(r.connection, r.agentId), {
          connection: r.connection,
          agentId: r.agentId,
          utcDay,
          resetAt,
          dailyTokenCap,
          tokensUsed,
        });
        continue;
      }
      if (r.action === 'SUBSCRIPTION_CAP_RESET' && typeof r.connection === 'string' && typeof r.agentId === 'string') {
        this.openCaps.delete(pairKey(r.connection, r.agentId));
        continue;
      }
      if (r.action === 'SUBSCRIPTION_PRICED_FALLBACK_NOTIFIED' && typeof r.requestId === 'string' && r.requestId) {
        this.notifiedEpisodes.add(r.requestId);
      }
    }
  }

  tokensUsedToday(connection: string, agentId: string, nowMs = this.now()): number {
    return this.usageByDay.get(dayKey(connection, agentId, utcDayOf(nowMs))) ?? 0;
  }

  /** Sweep expired or superseded caps and return all currently active per-agent caps. */
  listActive(): SubscriptionCapView[] {
    const nowMs = this.now();
    const today = utcDayOf(nowMs);
    for (const [pk, cap] of [...this.openCaps.entries()]) {
      if (Date.parse(cap.resetAt) <= nowMs || cap.utcDay !== today) {
        this.openCaps.delete(pk);
        this.state.ledger.append({
          timestamp: new Date(nowMs).toISOString(),
          agentId: cap.agentId,
          type: 'action',
          action: 'SUBSCRIPTION_CAP_RESET',
          actor: ACTOR,
          connection: cap.connection,
          utcDay: cap.utcDay,
          closedBy: 'reset',
        });
        continue;
      }
      const view = getCachedSubscriptionView(this.state, cap.connection);
      if (view) {
        const used = this.usageByDay.get(dayKey(cap.connection, cap.agentId, today)) ?? cap.tokensUsed;
        if (view.dailyTokenCap === undefined || used < view.dailyTokenCap) {
          this.openCaps.delete(pk);
          this.state.ledger.append({
            timestamp: new Date(nowMs).toISOString(),
            agentId: cap.agentId,
            type: 'action',
            action: 'SUBSCRIPTION_CAP_RESET',
            actor: ACTOR,
            connection: cap.connection,
            utcDay: cap.utcDay,
            closedBy: 'cap_updated',
          });
        } else {
          cap.dailyTokenCap = view.dailyTokenCap;
          cap.tokensUsed = used;
        }
      }
    }
    return [...this.openCaps.values()].map((c) => ({ ...c }));
  }

  getForAgent(connection: string, agentId: string): SubscriptionCapView | undefined {
    return this.listActive().find((c) => c.connection === connection && c.agentId === agentId);
  }

  /** Record metered subscription LLM tokens and open a per-agent cap if the connection's `dailyTokenCap` is reached. */
  recordLlmUsage(row: {
    connection: string;
    agentId: string;
    inputTokens?: number;
    outputTokens?: number;
    timestamp?: string;
  }): SubscriptionCapView | undefined {
    const tokens = (typeof row.inputTokens === 'number' ? row.inputTokens : 0) + (typeof row.outputTokens === 'number' ? row.outputTokens : 0);
    const ts = row.timestamp ?? new Date(this.now()).toISOString();
    const day = utcDayOf(ts);
    const dk = dayKey(row.connection, row.agentId, day);
    const total = (this.usageByDay.get(dk) ?? 0) + Math.max(0, tokens);
    this.usageByDay.set(dk, total);
    return this.evaluateAgentOnConnection(row.connection, row.agentId, day, total);
  }

  /** Re-evaluate today's usage on `connection` when `dailyTokenCap` is set, raised, lowered, or cleared. */
  evaluateConnection(connection: string, view?: SubscriptionView): void {
    this.listActive();
    const resolved = view ?? getCachedSubscriptionView(this.state, connection);
    if (!resolved || resolved.dailyTokenCap === undefined) return;
    const today = utcDayOf(this.now());
    const prefix = `${connection}\u0000`;
    const suffix = `\u0000${today}`;
    for (const [k, used] of this.usageByDay.entries()) {
      if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
      const agentId = k.slice(prefix.length, k.length - suffix.length);
      if (agentId) this.evaluateAgentOnConnection(connection, agentId, today, used, resolved);
    }
  }

  closeConnection(connection: string, by: 'disconnect' = 'disconnect'): void {
    const nowIso = new Date(this.now()).toISOString();
    for (const [pk, cap] of [...this.openCaps.entries()]) {
      if (cap.connection !== connection) continue;
      this.openCaps.delete(pk);
      this.state.ledger.append({
        timestamp: nowIso,
        agentId: cap.agentId,
        type: 'action',
        action: 'SUBSCRIPTION_CAP_RESET',
        actor: ACTOR,
        connection: cap.connection,
        utcDay: cap.utcDay,
        closedBy: by,
      });
    }
  }

  private evaluateAgentOnConnection(
    connection: string,
    agentId: string,
    utcDay: string,
    tokensUsed: number,
    explicitView?: SubscriptionView,
  ): SubscriptionCapView | undefined {
    this.listActive();
    const today = utcDayOf(this.now());
    if (utcDay !== today) return undefined;
    const view = explicitView ?? getCachedSubscriptionView(this.state, connection);
    const capLimit = view?.dailyTokenCap;
    if (capLimit === undefined || capLimit <= 0 || tokensUsed < capLimit) return undefined;

    const pk = pairKey(connection, agentId);
    const existing = this.openCaps.get(pk);
    if (existing && existing.utcDay === utcDay) {
      existing.tokensUsed = tokensUsed;
      existing.dailyTokenCap = capLimit;
      return { ...existing };
    }

    const resetAt = nextMidnightUtcIso(utcDay);
    const cap: SubscriptionCapView = {
      connection,
      agentId,
      utcDay,
      resetAt,
      dailyTokenCap: capLimit,
      tokensUsed,
    };
    this.openCaps.set(pk, cap);
    this.state.ledger.append({
      timestamp: new Date(this.now()).toISOString(),
      agentId,
      type: 'action',
      action: 'SUBSCRIPTION_CAP_REACHED',
      actor: ACTOR,
      connection,
      ...(view?.name ? { connectionName: view.name } : {}),
      ...(view?.scope ? { scope: view.scope } : {}),
      ...(view?.ownerPrincipalId ? { ownerPrincipalId: view.ownerPrincipalId } : {}),
      dailyTokenCap: capLimit,
      tokensUsed,
      utcDay,
      resetAt,
    });
    return { ...cap };
  }

  /**
   * M5(6), (7), (8): notify the affected agent's owners (and Factory Admins when factory budget is spent) once per
   * limit window, once per re-consent episode, or once per UTC cap day when a priced (`> $0`) candidate serves.
   */
  notifyPricedFallbackIfNeeded(row: {
    agentId: string;
    model?: string;
    requestedModel?: string;
    connection?: string;
    failoverReason?: string;
    resetAt?: string;
  }): void {
    const reason = row.failoverReason;
    if (
      reason !== 'subscription_limit_reached' &&
      reason !== 'subscription_needs_reconsent' &&
      reason !== 'subscription_cap_reached'
    ) {
      return;
    }
    const toModel = row.model;
    if (!toModel || !row.agentId) return;

    const catalog = this.state.modelStore?.toEgressCatalog() ?? this.state.modelCatalog ?? {};
    const toPrice: Price | undefined = catalog[toModel]?.price;
    if (!toPrice || isZeroPrice(toPrice)) return;

    const fromEntry = row.requestedModel ? catalog[row.requestedModel] : undefined;
    const connection = row.connection ?? (fromEntry?.credentialMode === 'subscription' ? fromEntry.connection : undefined);
    if (!connection) return;

    const connView = getCachedSubscriptionView(this.state, connection);
    const win = reason === 'subscription_limit_reached' ? getSubscriptionWindows(this.state).get(connection) : undefined;
    const today = utcDayOf(this.now());

    let episodeStamp: string;
    let resetAt: string | undefined = row.resetAt;
    if (reason === 'subscription_limit_reached') {
      episodeStamp = win?.openedAt ?? row.resetAt ?? today;
      resetAt ??= win?.resetAt;
    } else if (reason === 'subscription_needs_reconsent') {
      episodeStamp = connView?.statusAt ?? 'needs_reconsent';
    } else {
      episodeStamp = today;
      resetAt ??= nextMidnightUtcIso(today);
    }

    const episodeKey = `pf:${reason}:${connection}:${episodeStamp}:${row.agentId}`;
    if (this.notifiedEpisodes.has(episodeKey)) return;
    this.notifiedEpisodes.add(episodeKey);

    const recipients = pricedFallbackRecipients(this.state, row.agentId);
    const nowIso = new Date(this.now()).toISOString();
    const subjects = recipients.length > 0 ? recipients : [undefined];
    for (const subject of subjects) {
      this.state.ledger.append({
        timestamp: nowIso,
        agentId: row.agentId,
        type: 'action',
        action: 'SUBSCRIPTION_PRICED_FALLBACK_NOTIFIED',
        actor: ACTOR,
        requestId: episodeKey,
        connection,
        ...(connView?.name ? { connectionName: connView.name } : {}),
        ...(connView?.scope ? { scope: connView.scope } : {}),
        ...(connView?.ownerPrincipalId ? { ownerPrincipalId: connView.ownerPrincipalId } : {}),
        model: toModel,
        ...(row.requestedModel ? { requestedModel: row.requestedModel } : {}),
        failoverReason: reason,
        ...(resetAt ? { resetAt } : {}),
        ...(subject ? { subject } : {}),
      });
    }

    void Promise.resolve(
      dispatchSubscriptionNotice(this.state, {
        kind: 'priced_fallback',
        agentId: row.agentId,
        connection,
        ...(connView?.name ? { connectionName: connView.name } : {}),
        fallbackModel: toModel,
        reason,
        ...(resetAt ? { resetAt } : {}),
        recipients,
      }),
    ).catch((err) => {
      console.error(`[control-plane] subscription priced-fallback notifier failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function pricedFallbackRecipients(state: FactoryState, agentId: string): string[] {
  const out = new Set<string>();
  const agent = state.agents.get(agentId);
  if (state.grants) {
    try {
      const grants = state.grants.list({ scopeKind: 'agent', scopeId: agentId });
      for (const g of grants) {
        if (g.state !== 'active') continue;
        if (g.role === 'content-owner' || g.role === 'accountable-lead') {
          out.add(g.subject);
        }
      }
    } catch {
      // fall back to config owners below
    }
  }
  if (agent?.accountableLead) out.add(agent.accountableLead);
  for (const owner of ownersOf(state, agentId)) {
    // Exclude D15 pending-revoked owners when GrantStore tracks the agent
    if (state.grants) {
      const pendingRevoked = state.grants
        .list({ scopeKind: 'agent', scopeId: agentId })
        .some((g) => g.role === 'content-owner' && g.state === 'pending-revoked' && g.subject === owner);
      if (pendingRevoked) continue;
    }
    out.add(owner);
  }
  // Priced (> $0) fallback spends factory budget: notify Factory Admins as well (M5(7), (8)).
  for (const admin of factoryAdmins(state)) out.add(admin);
  return [...out].sort();
}

const capsOf = new WeakMap<FactoryState, SubscriptionCaps>();

export function getSubscriptionCaps(state: FactoryState): SubscriptionCaps {
  let c = capsOf.get(state);
  if (!c) {
    c = new SubscriptionCaps(state, state.subscriptionNow);
    capsOf.set(state, c);
  }
  return c;
}

export function setSubscriptionCaps(state: FactoryState, caps: SubscriptionCaps): void {
  capsOf.set(state, caps);
}
