import type { BudgetLimits } from './index.js';

/** Same predicate as the control plane's local `positive()` helper: a finite number at or above zero. */
function nonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function validateBudgetLimits(raw: unknown): { ok: true; limits: BudgetLimits } | { ok: false; error: string } {
  const b = raw as Record<string, unknown>;
  if (!b || typeof b !== 'object') return { ok: false, error: 'budgetUsd must be an object' };
  const limits: BudgetLimits = {};
  for (const [k, v] of Object.entries(b)) {
    if (!['perRun', 'perDay', 'perMonth'].includes(k)) return { ok: false, error: `unknown budget window ${k}` };
    if (!nonNegative(v)) return { ok: false, error: `budgetUsd.${k} must be >= 0` };
    limits[k as keyof BudgetLimits] = v;
  }
  return { ok: true, limits };
}
