import type { AgentPolicy, AgentRecord, OfferedModel, AgentModelsState, SetAgentModelsInput } from '../api/types.js';
import { isOwnerOf, actorOf } from '../views/skills/agent-skills-model.js';

export { isOwnerOf, actorOf };

export const CANONICAL_PROVIDER_ORDER = ['Anthropic', 'Google', 'xAI', 'Bedrock', 'OpenAI'] as const;

export interface ModelSelectionDraft {
  approvedModels: string[];
  currentModel: string | null;
  primaryModel: string | null;
  secondaryModel?: string;
}

export interface BudgetFormData {
  monthlyUsd: string;
  hasDailyLimit: boolean;
  dailyUsd: string;
}

/**
 * Determines the provider grouping label for a given model.
 * - 'bedrock-converse' is ALWAYS 'Bedrock' (even if model name has 'claude' or vendorId is 'anthropic').
 * - 'anthropic' / 'anthropic-messages' / vendorId 'anthropic' is 'Anthropic'.
 * - 'google' / 'gemini' / 'vertex-gemini' / 'vertex-ai' / 'vertex-anthropic' / vendorId 'gemini' is 'Google'.
 * - 'xai' / vendorId 'xai' is 'xAI'.
 * - 'openai' / vendorId 'openai' is 'OpenAI'.
 * - Otherwise title-cases vendorId || provider || 'Other'.
 */
export function providerGroupOf(model: OfferedModel): string {
  const provider = (model.provider || '').toLowerCase().trim();
  const vendorId = (model.vendorId || '').toLowerCase().trim();

  if (provider === 'bedrock-converse') {
    return 'Bedrock';
  }

  if (provider === 'anthropic' || provider === 'anthropic-messages' || vendorId === 'anthropic') {
    return 'Anthropic';
  }

  if (
    ['google', 'gemini', 'vertex-gemini', 'vertex-ai', 'vertex-anthropic'].includes(provider) ||
    vendorId === 'gemini'
  ) {
    return 'Google';
  }

  if (provider === 'xai' || vendorId === 'xai') {
    return 'xAI';
  }

  if (provider === 'openai' || vendorId === 'openai') {
    return 'OpenAI';
  }

  const custom = model.vendorId?.trim() || model.provider?.trim();
  if (!custom) return 'Other';
  return custom.charAt(0).toUpperCase() + custom.slice(1);
}

/**
 * Groups models by serving provider, ordering by canonical order
 * ('Anthropic', 'Google', 'xAI', 'Bedrock', 'OpenAI') followed alphabetically by any custom groups.
 * Empty groups are omitted.
 */
export function groupModelsByProvider(models: readonly OfferedModel[]): Array<{ provider: string; models: OfferedModel[] }> {
  const map = new Map<string, OfferedModel[]>();
  for (const m of models) {
    const group = providerGroupOf(m);
    const list = map.get(group);
    if (list) {
      list.push(m);
    } else {
      map.set(group, [m]);
    }
  }

  const groups = Array.from(map.keys());
  groups.sort((a, b) => {
    const idxA = (CANONICAL_PROVIDER_ORDER as readonly string[]).indexOf(a);
    const idxB = (CANONICAL_PROVIDER_ORDER as readonly string[]).indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  const result: Array<{ provider: string; models: OfferedModel[] }> = [];
  for (const group of groups) {
    const list = map.get(group);
    if (list && list.length > 0) {
      result.push({ provider: group, models: list });
    }
  }
  return result;
}

/**
 * Maps approved model names against the catalog, preserving catalog metadata and provider,
 * and synthesizing an OfferedModel entry with provider: 'other' if missing from catalog.
 */
export function approvedOfferedModels(
  approvedModels: readonly string[],
  catalog: readonly OfferedModel[],
): OfferedModel[] {
  const catalogMap = new Map<string, OfferedModel>();
  for (const m of catalog) {
    catalogMap.set(m.name, m);
  }
  return approvedModels.map((name) => {
    const found = catalogMap.get(name);
    if (found) return found;
    return { name, provider: 'other' };
  });
}

/**
 * Selects the Current Model.
 * Can be any model in approvedModels (including matching Primary or Secondary).
 * If primaryModel was null (unset state), also sets primaryModel = nextCurrent so policy validation passes.
 */
export function selectCurrentModel(state: ModelSelectionDraft, nextCurrent: string): ModelSelectionDraft {
  const next: ModelSelectionDraft = {
    ...state,
    currentModel: nextCurrent || null,
  };
  if (nextCurrent && state.primaryModel === null) {
    next.primaryModel = nextCurrent;
  }
  return next;
}

/**
 * Selects the Primary Model (1st failback target).
 * If user selects the model currently set as secondaryModel, swaps Primary and Secondary!
 * If currentModel was null (unset state), also sets currentModel = nextPrimary.
 */
export function selectPrimaryModel(state: ModelSelectionDraft, nextPrimary: string): ModelSelectionDraft {
  const next: ModelSelectionDraft = { ...state };
  if (!nextPrimary) {
    next.primaryModel = null;
    return next;
  }

  if (nextPrimary === state.secondaryModel) {
    // Swap Primary and Secondary
    next.primaryModel = nextPrimary;
    next.secondaryModel = state.primaryModel ?? undefined;
  } else {
    next.primaryModel = nextPrimary;
  }

  if (state.currentModel === null) {
    next.currentModel = nextPrimary;
  }

  return next;
}

/**
 * Selects the Secondary Model (optional 2nd failback target).
 * Empty string or undefined clears secondaryModel to undefined.
 * If user selects the model currently set as primaryModel:
 * - If secondaryModel was already set, swaps Secondary and Primary.
 * - If secondaryModel was unset (None), swapping would leave Primary unset, so disallows (keeps state unchanged).
 */
export function selectSecondaryModel(
  state: ModelSelectionDraft,
  nextSecondary: string | undefined,
): ModelSelectionDraft {
  const next: ModelSelectionDraft = { ...state };
  if (!nextSecondary || nextSecondary.trim() === '') {
    delete next.secondaryModel;
    return next;
  }

  if (nextSecondary === state.primaryModel) {
    if (state.secondaryModel !== undefined && state.secondaryModel !== '') {
      next.secondaryModel = nextSecondary;
      next.primaryModel = state.secondaryModel;
    } else {
      // Disallow setting secondary to primary when secondary was None
      return state;
    }
  } else {
    next.secondaryModel = nextSecondary;
  }

  return next;
}

/**
 * Toggles an approved model in the Model Access list.
 * - Checked (true): adds to approvedModels with zero automatic slot mutation.
 * - Unchecked (false): applies exact §6.9 M2 removal transitions.
 */
export function toggleApprovedModel(
  state: ModelSelectionDraft,
  modelName: string,
  checked: boolean,
): ModelSelectionDraft {
  if (checked) {
    const approved = [...new Set([...state.approvedModels, modelName])];
    return {
      ...state,
      approvedModels: approved,
    };
  }

  const remaining = state.approvedModels.filter((m) => m !== modelName);
  if (remaining.length === 0) {
    return {
      approvedModels: [],
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    };
  }

  let current = state.currentModel;
  let primary = state.primaryModel;
  let secondary = state.secondaryModel;

  if (secondary === modelName) {
    secondary = undefined;
  }

  const currentRemoved = current === modelName;
  const primaryRemoved = primary === modelName;

  if (currentRemoved && primaryRemoved) {
    if (secondary !== undefined) {
      current = secondary;
      primary = secondary;
      secondary = undefined;
    } else {
      current = null;
      primary = null;
      secondary = undefined;
    }
  } else if (currentRemoved && !primaryRemoved) {
    current = primary;
  } else if (!currentRemoved && primaryRemoved) {
    primary = current;
    if (secondary === current) {
      secondary = undefined;
    }
  }

  const next: ModelSelectionDraft = {
    approvedModels: remaining,
    currentModel: current,
    primaryModel: primary,
  };
  if (secondary !== undefined) {
    next.secondaryModel = secondary;
  }
  return next;
}

/**
 * Formats a validatePolicy-compliant payload for PUT /api/v1/agents/:id/models.
 * When approvedModels is empty, omits currentModel and primaryModel to avoid rejection.
 */
export function toSetAgentModelsPayload(state: ModelSelectionDraft): SetAgentModelsInput {
  if (state.approvedModels.length === 0) {
    return {
      approvedModels: [],
      secondaryModel: null,
    };
  }
  return {
    approvedModels: state.approvedModels,
    currentModel: state.currentModel,
    primaryModel: state.primaryModel,
    secondaryModel: state.secondaryModel ?? null,
  };
}

export function isBudgetExemptAgent(agent: {
  isBuiltin?: boolean;
  budgetExempt?: boolean;
  category?: string;
}): boolean {
  return Boolean(agent.isBuiltin || agent.budgetExempt || agent.category === 'builtin');
}

/**
 * Extracts form values from an agent's policy, with fallback to agent record spend limit fields.
 * Never multiplies daily * 30.
 */
export function budgetFormFromPolicy(
  policy?: AgentPolicy | null,
  fallbackAgent?: AgentRecord | null,
): BudgetFormData {
  const hasPerMonth = policy?.budgetUsd?.perMonth !== undefined;
  const hasPerDay = policy?.budgetUsd?.perDay !== undefined;

  const monthlyUsd = hasPerMonth
    ? String(policy!.budgetUsd!.perMonth)
    : fallbackAgent?.spendLimitMonthlyUsd !== undefined && fallbackAgent.spendLimitMonthlyUsd > 0
    ? String(fallbackAgent.spendLimitMonthlyUsd)
    : '';

  const hasDailyLimit = hasPerDay
    ? true
    : Boolean(fallbackAgent?.spendLimitUsd && fallbackAgent.spendLimitUsd > 0 && !policy);

  const dailyUsd = hasPerDay
    ? String(policy!.budgetUsd!.perDay)
    : fallbackAgent?.spendLimitUsd !== undefined && fallbackAgent.spendLimitUsd > 0
    ? String(fallbackAgent.spendLimitUsd)
    : '';

  return { monthlyUsd, hasDailyLimit, dailyUsd };
}

/**
 * Validates and applies budget form inputs to an existing policy.
 * - Parses non-negative numbers.
 * - Sets budgetUsd.perMonth if provided.
 * - Sets budgetUsd.perDay ONLY if form.hasDailyLimit is true.
 * - Omits budgetUsd.perDay when form.hasDailyLimit is false.
 * - Preserves existing policy.budgetUsd.perRun if present.
 * - Omits budgetUsd completely if neither is set.
 */
export function applyBudgetFormToPolicy(
  existingPolicy: AgentPolicy,
  form: BudgetFormData,
): { ok: true; policy: AgentPolicy } | { ok: false; error: string } {
  const monthlyStr = form.monthlyUsd.trim();
  const dailyStr = form.dailyUsd.trim();

  let monthlyNum: number | undefined;
  if (monthlyStr !== '') {
    const n = Number(monthlyStr);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Monthly budget must be a non-negative number' };
    }
    monthlyNum = n;
  }

  let dailyNum: number | undefined;
  if (form.hasDailyLimit) {
    if (dailyStr === '') {
      return { ok: false, error: 'Daily limit cannot be empty when daily limit is enabled' };
    }
    const n = Number(dailyStr);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Daily limit must be a non-negative number' };
    }
    dailyNum = n;
  }

  const next: AgentPolicy = structuredClone(existingPolicy);

  const nextBudgetUsd: { perRun?: number; perDay?: number; perMonth?: number } = {};
  if (existingPolicy.budgetUsd?.perRun !== undefined) {
    nextBudgetUsd.perRun = existingPolicy.budgetUsd.perRun;
  }
  if (monthlyNum !== undefined) {
    nextBudgetUsd.perMonth = monthlyNum;
  }
  if (form.hasDailyLimit && dailyNum !== undefined) {
    nextBudgetUsd.perDay = dailyNum;
  }

  if (Object.keys(nextBudgetUsd).length > 0) {
    next.budgetUsd = nextBudgetUsd;
  } else {
    delete next.budgetUsd;
  }

  return { ok: true, policy: next };
}

export function initialDraftFromState(modelsState: AgentModelsState): ModelSelectionDraft {
  return {
    approvedModels: [...modelsState.approvedModels],
    currentModel: modelsState.currentModel,
    primaryModel: modelsState.primaryModel,
    secondaryModel: modelsState.secondaryModel,
  };
}

export function isDraftDirty(initial: ModelSelectionDraft, draft: ModelSelectionDraft): boolean {
  if (initial.currentModel !== draft.currentModel) return true;
  if (initial.primaryModel !== draft.primaryModel) return true;
  if ((initial.secondaryModel ?? undefined) !== (draft.secondaryModel ?? undefined)) return true;
  if (initial.approvedModels.length !== draft.approvedModels.length) return true;
  const initialSet = new Set(initial.approvedModels);
  return draft.approvedModels.some((m) => !initialSet.has(m));
}

export function isBudgetDirty(initial: BudgetFormData, current: BudgetFormData): boolean {
  return (
    initial.monthlyUsd !== current.monthlyUsd ||
    initial.hasDailyLimit !== current.hasDailyLimit ||
    (current.hasDailyLimit && initial.dailyUsd !== current.dailyUsd)
  );
}
