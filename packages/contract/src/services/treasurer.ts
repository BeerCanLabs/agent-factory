import { z } from 'zod';

/**
 * SpendMeteringContract: Inter-service contract between Tinman and Treasurer (E5, §6.5).
 * Tinman checks budget before model invocation and reports metered spend on completion.
 */
export const budgetCheckRequestSchema = z.object({
  agentId: z.string().min(1),
  estimatedTokens: z.number().int().positive().optional(),
});

export type BudgetCheckRequest = z.infer<typeof budgetCheckRequestSchema>;

export const budgetCheckResultSchema = z.object({
  allowed: z.boolean(),
  circuitBroken: z.boolean(),
  remainingDailyBudgetUsd: z.number().nonnegative().optional(),
  reason: z.string().optional(),
});

export type BudgetCheckResult = z.infer<typeof budgetCheckResultSchema>;

export const spendReportSchema = z.object({
  agentId: z.string().min(1),
  runId: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export type SpendReport = z.infer<typeof spendReportSchema>;
