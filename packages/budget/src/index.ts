/** USD ceilings for one agent. Each window is optional; an unset window is not enforced. */
export type BudgetLimits = { perRun?: number; perDay?: number; perMonth?: number };

/** USD already spent in the three windows the rule compares. */
export type Spend = { run: number; day: number; month: number };

/** The windows, in the order `exceededWindow` checks them. */
export type BudgetWindow = 'perRun' | 'perDay' | 'perMonth';

/**
 * The first budget window that is at or over its limit, if any.
 * `limits` is the agent's `budgetUsd` (or undefined when the agent has none).
 */
export function exceededWindow(limits: BudgetLimits | undefined, spend: Spend): BudgetWindow | undefined {
  const b = limits;
  if (!b) return undefined;
  if (b.perRun !== undefined && spend.run >= b.perRun) return 'perRun';
  if (b.perDay !== undefined && spend.day >= b.perDay) return 'perDay';
  if (b.perMonth !== undefined && spend.month >= b.perMonth) return 'perMonth';
  return undefined;
}

export type { SpendDetail, SpendWindow } from './spend.js';
export { spendDetail, SpendTracker } from './spend.js';
export type { Price, TokenUsage } from './pricing.js';
export { costUsd, priceFor } from './pricing.js';
export { validateBudgetLimits } from './limits.js';
export type { StandingDenied, StandingOk, StandingRequest, StandingResult } from './standing.js';
export { checkStanding } from './standing.js';
