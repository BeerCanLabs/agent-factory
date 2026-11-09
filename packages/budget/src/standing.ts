import { exceededWindow, type BudgetLimits, type BudgetWindow, type Spend } from './index.js';

/** Default `$0` USD ceiling for unallocated `kind: 'personal'` agents (M5(8), D25; never `undefined`, which means unlimited). */
export const ZERO_BUDGET_LIMITS: BudgetLimits = Object.freeze({ perDay: 0, perMonth: 0 });

/** What a caller asks the Treasurer. `pendingUsd` is spend metered but not yet on the ledger; it counts in every window. */
export type StandingRequest = {
  limits: BudgetLimits | undefined;
  spend: Spend;
  pendingUsd?: number;
  /** M5(8), D25: when the active/selected model entry is `$0`-priced, standing succeeds even at `{ perDay: 0, perMonth: 0 }`. */
  selectedModelIsZeroPrice?: boolean;
};

export type StandingOk = { inGoodStanding: true };
export type StandingDenied = { inGoodStanding: false; window: BudgetWindow };
export type StandingResult = StandingOk | StandingDenied;

/** In good standing, or the first window (`perRun`, `perDay`, `perMonth`) that is at or over its limit. Never a `'blocked'` window. */
export function checkStanding(request: StandingRequest): StandingResult {
  if (request.selectedModelIsZeroPrice) return { inGoodStanding: true };
  const pending = request.pendingUsd ?? 0;
  const window = exceededWindow(request.limits, {
    run: request.spend.run + pending,
    day: request.spend.day + pending,
    month: request.spend.month + pending,
  });
  if (window) return { inGoodStanding: false, window };
  return { inGoodStanding: true };
}
