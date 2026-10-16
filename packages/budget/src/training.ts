/** A skill's training account. Adoption spend never posts here. An account exists only after a person sets a cap. */
export type TrainingAccount = { capUsd: number; spentUsd: number };

export type TrainingCharge =
  | { ok: true; account: TrainingAccount }
  | { ok: false; error: 'training_budget_required' | 'training_budget_exceeded' };

/**
 * Post a trial's cost to the skill account. Refuses when no cap was set or the charge would pass the cap.
 * Does not touch an agent's spend.
 */
export function chargeTraining(account: TrainingAccount | undefined, costUsd: number): TrainingCharge {
  if (!account || !(account.capUsd > 0)) return { ok: false, error: 'training_budget_required' };
  if (!Number.isFinite(costUsd) || costUsd < 0) return { ok: false, error: 'training_budget_exceeded' };
  const spentUsd = account.spentUsd + costUsd;
  if (spentUsd > account.capUsd) return { ok: false, error: 'training_budget_exceeded' };
  return { ok: true, account: { capUsd: account.capUsd, spentUsd } };
}
