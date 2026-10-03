import { exceededWindow, type BudgetLimits, type BudgetWindow, type Spend } from './index.js';

/** What a caller asks the Treasurer. `pendingUsd` is spend metered but not yet on the ledger; it counts in every window. */
export type StandingRequest = {
  limits: BudgetLimits | undefined;
  spend: Spend;
  pendingUsd?: number;
};

export type StandingOk = { inGoodStanding: true };
export type StandingDenied = { inGoodStanding: false; window: BudgetWindow };
export type StandingResult = StandingOk | StandingDenied;

/** In good standing, or the first window (`perRun`, `perDay`, `perMonth`) that is at or over its limit. Never a `'blocked'` window. */
export function checkStanding(request: StandingRequest): StandingResult {
  const pending = request.pendingUsd ?? 0;
  const window = exceededWindow(request.limits, {
    run: request.spend.run + pending,
    day: request.spend.day + pending,
    month: request.spend.month + pending,
  });
  if (window) return { inGoodStanding: false, window };
  return { inGoodStanding: true };
}
