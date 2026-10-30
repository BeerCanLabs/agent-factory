/**
 * Whether an agent may use a model (DESIGN_AUTHORITY §6.9 M2, §6.3.1 E7). The Executive decides; the gatekeeper-egress
 * enforces the answer. The inputs are plain values so the Executive does not depend on how the control plane stores a
 * policy.
 */
export type ModelPolicy = {
  /** The policy's allowed models. Absent means the policy names none, which grants only `defaultModel` (M2). */
  allowedModels?: readonly string[];
  /** The factory's default model: configuration an admin sets (M2, M3). Absent when none is configured. */
  defaultModel?: string;
  /** The agent is in training: the allow-list does not apply. A run's pin still does. */
  training: boolean;
  /** The run is pinned to this model (a caller named it for the run). */
  pinnedModel?: string;
  currentModel?: string | null;
  primaryModel?: string | null;
  secondaryModel?: string;
};

export type ModelCheck =
  | { allowed: true }
  | { allowed: false; status: 403; code: 'model_not_allowed'; detail: { model: string } }
  | { allowed: false; status: 403; code: 'model_pinned'; detail: { model: string; pinned: string } };

/** The allow-list is checked first, then the pin, so a model that fails both is `model_not_allowed`. */
export function checkModel(policy: ModelPolicy, model: string): ModelCheck {
  const allowed = policy.allowedModels ?? (policy.defaultModel ? [policy.defaultModel] : []);
  if (!policy.training && !allowed.includes(model)) return { allowed: false, status: 403, code: 'model_not_allowed', detail: { model } };
  if (policy.pinnedModel && policy.pinnedModel !== model) {
    return { allowed: false, status: 403, code: 'model_pinned', detail: { model, pinned: policy.pinnedModel } };
  }
  return { allowed: true };
}

export type ModelSelection =
  | { ok: true; model: string; requested?: string }
  | { ok: false; status: 503; code: 'no_default_model' }
  | { ok: false; status: 403; code: 'model_not_allowed'; detail: { model: string } };

/**
 * The model the factory serves for a call (M2, GAP-181). Agents never choose: the run's pin wins, then (in training
 * only, where the owner is trying models) the requested model, then currentModel, then primaryModel, then the policy's
 * first model, then the factory default. The requested name is returned only when it differs, so it can be recorded.
 */
export function selectModel(policy: ModelPolicy, requested?: string): ModelSelection {
  // A policy that lists models grants exactly those; an explicit empty list grants none. Only a policy that names no
  // models at all (the field absent) falls back to the factory default (M2).
  const granted = policy.allowedModels ?? (policy.defaultModel ? [policy.defaultModel] : []);
  if (policy.pinnedModel) {
    // A pin is a caller's choice for the run, never a way around the owner's grant (E7).
    if (!policy.training && !granted.includes(policy.pinnedModel)) {
      return { ok: false, status: 403, code: 'model_not_allowed', detail: { model: policy.pinnedModel } };
    }
    return { ok: true, model: policy.pinnedModel, ...(requested && requested !== policy.pinnedModel ? { requested } : {}) };
  }
  if (!policy.training && policy.currentModel === null) {
    return { ok: false, status: 403, code: 'model_not_allowed', detail: { model: requested ?? '' } };
  }
  const chosen = (policy.training ? requested : undefined) ?? (policy.currentModel ?? policy.primaryModel ?? granted[0]);
  if (!chosen) {
    if (policy.allowedModels) return { ok: false, status: 403, code: 'model_not_allowed', detail: { model: requested ?? '' } };
    return { ok: false, status: 503, code: 'no_default_model' };
  }
  if (!policy.training && !granted.includes(chosen)) {
    return { ok: false, status: 403, code: 'model_not_allowed', detail: { model: chosen } };
  }
  return { ok: true, model: chosen, ...(requested && requested !== chosen ? { requested } : {}) };
}

/**
 * Resolves the deterministic sequence of failback candidates for an execution turn (§6.9 M2):
 * Returns unique([sel.model, effectivePrimary, secondaryModel]), bounded by approved models outside training.
 */
export function failbackCandidates(policy: ModelPolicy, requested?: string): readonly string[] {
  const sel = selectModel(policy, requested);
  if (!sel.ok) return [];
  if (policy.pinnedModel || (policy.training && requested)) {
    return [sel.model];
  }
  const granted = policy.allowedModels ?? (policy.defaultModel ? [policy.defaultModel] : []);
  const effectivePrimary = policy.primaryModel === null ? undefined : (policy.primaryModel ?? granted[0]);
  const rawList: (string | null | undefined)[] = [sel.model, effectivePrimary, policy.secondaryModel];
  const result: string[] = [];
  for (const m of rawList) {
    if (typeof m === 'string' && m.length > 0 && (policy.training || granted.includes(m))) {
      if (!result.includes(m)) {
        result.push(m);
      }
    }
  }
  return result;
}

/** The models the agent may list: the offered ones it may use, in the catalog's order. */
export function offeredModels(policy: ModelPolicy, offered: Iterable<string>): string[] {
  return [...offered].filter((name) => checkModel(policy, name).allowed);
}
