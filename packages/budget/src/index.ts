import type { BudgetCheckResult, SpendReport } from '@beercanlabs/factory-contract';
export {
  budgetCheckRequestSchema,
  budgetCheckResultSchema,
  spendReportSchema,
  type BudgetCheckRequest,
  type BudgetCheckResult,
  type SpendReport,
} from '@beercanlabs/factory-contract';

export interface BudgetLimits {
  perRun?: number;
  perDay?: number;
  perMonth?: number;
}

export interface CurrentSpend {
  runUsd?: number;
  dayUsd?: number;
  monthUsd?: number;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Standard fallback model pricing catalog ($ per million tokens).
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-sonnet-4-5': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
};

/**
 * Evaluates requested or current spend against budget limits (The Treasurer).
 * If any limit is exceeded, trips the circuit-breaker and returns allowed: false.
 */
export function checkBudget(
  limits?: BudgetLimits,
  current?: CurrentSpend,
  projectedCostUsd = 0
): BudgetCheckResult {
  if (!limits) {
    return { allowed: true, circuitBroken: false };
  }

  const runSpend = (current?.runUsd ?? 0) + projectedCostUsd;
  const daySpend = (current?.dayUsd ?? 0) + projectedCostUsd;
  const monthSpend = (current?.monthUsd ?? 0) + projectedCostUsd;

  if (limits.perRun !== undefined && runSpend > limits.perRun) {
    return {
      allowed: false,
      circuitBroken: true,
      reason: `Run budget exceeded: requested/current $${runSpend.toFixed(4)} > limit $${limits.perRun}`,
    };
  }

  if (limits.perDay !== undefined && daySpend > limits.perDay) {
    return {
      allowed: false,
      circuitBroken: true,
      remainingDailyBudgetUsd: Math.max(0, limits.perDay - (current?.dayUsd ?? 0)),
      reason: `Daily budget exceeded: requested/current $${daySpend.toFixed(4)} > limit $${limits.perDay}`,
    };
  }

  if (limits.perMonth !== undefined && monthSpend > limits.perMonth) {
    return {
      allowed: false,
      circuitBroken: true,
      reason: `Monthly budget exceeded: requested/current $${monthSpend.toFixed(4)} > limit $${limits.perMonth}`,
    };
  }

  const remainingDaily =
    limits.perDay !== undefined
      ? Math.max(0, limits.perDay - daySpend)
      : undefined;

  return {
    allowed: true,
    circuitBroken: false,
    remainingDailyBudgetUsd: remainingDaily,
  };
}

/**
 * Calculates USD cost based on token counts and model pricing.
 */
export function calculateTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  customCatalog?: Record<string, ModelPricing>
): number {
  const catalog = { ...DEFAULT_MODEL_PRICING, ...(customCatalog ?? {}) };
  const pricing = catalog[model] ?? { inputPerMillion: 3.0, outputPerMillion: 15.0 };

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;

  return Number((inputCost + outputCost).toFixed(6));
}
