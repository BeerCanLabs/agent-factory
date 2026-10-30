import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPolicy, AgentRecord, OfferedModel } from '../api/types.js';
import {
  providerGroupOf,
  groupModelsByProvider,
  approvedOfferedModels,
  selectCurrentModel,
  selectPrimaryModel,
  selectSecondaryModel,
  toggleApprovedModel,
  toSetAgentModelsPayload,
  isBudgetExemptAgent,
  budgetFormFromPolicy,
  applyBudgetFormToPolicy,
  isDraftDirty,
  isBudgetDirty,
  type ModelSelectionDraft,
  type BudgetFormData,
} from './models-model.js';

describe('models-model: provider grouping', () => {
  it('maps bedrock-converse to Bedrock even with Claude in name or Anthropic vendor', () => {
    assert.equal(
      providerGroupOf({ name: 'anthropic.claude-3-5-sonnet', provider: 'bedrock-converse', vendorId: 'anthropic' }),
      'Bedrock',
    );
    assert.equal(
      providerGroupOf({ name: 'amazon.titan-text', provider: 'bedrock-converse' }),
      'Bedrock',
    );
  });

  it('maps direct Anthropic providers and vendors', () => {
    assert.equal(providerGroupOf({ name: 'claude-3-7-sonnet', provider: 'anthropic' }), 'Anthropic');
    assert.equal(providerGroupOf({ name: 'claude-3-5-haiku', provider: 'anthropic-messages' }), 'Anthropic');
    assert.equal(providerGroupOf({ name: 'claude-custom', provider: 'custom', vendorId: 'anthropic' }), 'Anthropic');
  });

  it('maps Google / Vertex / Gemini providers and vendors', () => {
    assert.equal(providerGroupOf({ name: 'gemini-2.0-flash', provider: 'google' }), 'Google');
    assert.equal(providerGroupOf({ name: 'gemini-1.5-pro', provider: 'gemini' }), 'Google');
    assert.equal(providerGroupOf({ name: 'gemini-1.5-flash', provider: 'vertex-gemini' }), 'Google');
    assert.equal(providerGroupOf({ name: 'text-bison', provider: 'vertex-ai' }), 'Google');
    assert.equal(providerGroupOf({ name: 'claude-via-vertex', provider: 'vertex-anthropic' }), 'Google');
    assert.equal(providerGroupOf({ name: 'custom-gemini', provider: 'custom', vendorId: 'gemini' }), 'Google');
  });

  it('maps xAI provider and vendor', () => {
    assert.equal(providerGroupOf({ name: 'grok-2', provider: 'xai' }), 'xAI');
    assert.equal(providerGroupOf({ name: 'grok-beta', provider: 'other', vendorId: 'xai' }), 'xAI');
  });

  it('maps OpenAI provider and vendor', () => {
    assert.equal(providerGroupOf({ name: 'gpt-4o', provider: 'openai' }), 'OpenAI');
    assert.equal(providerGroupOf({ name: 'o3-mini', provider: 'custom', vendorId: 'openai' }), 'OpenAI');
  });

  it('formats custom vendors and providers with title-casing or fallback to Other', () => {
    assert.equal(providerGroupOf({ name: 'mistral-large', provider: 'mistral' }), 'Mistral');
    assert.equal(providerGroupOf({ name: 'cohere-command', provider: 'custom', vendorId: 'cohere' }), 'Cohere');
    assert.equal(providerGroupOf({ name: 'unknown-model', provider: '' }), 'Other');
  });

  it('groups models according to canonical provider order and omits empty groups', () => {
    const catalog: OfferedModel[] = [
      { name: 'gpt-4o', provider: 'openai' },
      { name: 'claude-sonnet', provider: 'anthropic' },
      { name: 'grok-2', provider: 'xai' },
      { name: 'mistral-large', provider: 'mistral' },
      { name: 'claude-bedrock', provider: 'bedrock-converse' },
      { name: 'gemini-flash', provider: 'google' },
    ];

    const grouped = groupModelsByProvider(catalog);
    assert.deepEqual(
      grouped.map((g) => g.provider),
      ['Anthropic', 'Google', 'xAI', 'Bedrock', 'OpenAI', 'Mistral'],
    );
    assert.equal(grouped.find((g) => g.provider === 'Anthropic')?.models.length, 1);
    assert.equal(grouped.find((g) => g.provider === 'Bedrock')?.models[0].name, 'claude-bedrock');
  });

  it('approvedOfferedModels maps approved names against catalog and synthesizes missing', () => {
    const catalog: OfferedModel[] = [
      { name: 'claude-sonnet', provider: 'anthropic', price: { inputPerMTok: 3, outputPerMTok: 15 } },
    ];
    const approved = ['claude-sonnet', 'retired-model'];
    const result = approvedOfferedModels(approved, catalog);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'claude-sonnet');
    assert.equal(result[0].provider, 'anthropic');
    assert.equal(result[0].price?.inputPerMTok, 3);
    assert.equal(result[1].name, 'retired-model');
    assert.equal(result[1].provider, 'other');
  });
});

describe('models-model: slot selection', () => {
  it('selectCurrentModel sets currentModel and initializes primaryModel if null', () => {
    const initial: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    };
    const s1 = selectCurrentModel(initial, 'm1');
    assert.equal(s1.currentModel, 'm1');
    assert.equal(s1.primaryModel, 'm1'); // initialized so validation passes

    const s2 = selectCurrentModel(s1, 'm2');
    assert.equal(s2.currentModel, 'm2');
    assert.equal(s2.primaryModel, 'm1'); // already set, remains m1
  });

  it('selectPrimaryModel sets primaryModel and initializes currentModel if null', () => {
    const initial: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    };
    const s1 = selectPrimaryModel(initial, 'm2');
    assert.equal(s1.primaryModel, 'm2');
    assert.equal(s1.currentModel, 'm2');
  });

  it('selectPrimaryModel swaps Primary and Secondary when user picks Secondary model', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2', 'm3'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const swapped = selectPrimaryModel(state, 'm2');
    assert.equal(swapped.primaryModel, 'm2');
    assert.equal(swapped.secondaryModel, 'm1');
    assert.equal(swapped.currentModel, 'm1'); // currentModel untouched
  });

  it('selectSecondaryModel clears secondaryModel when empty or undefined', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const cleared = selectSecondaryModel(state, '');
    assert.equal(cleared.secondaryModel, undefined);
  });

  it('selectSecondaryModel swaps Secondary and Primary when secondary was set', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    // User selects m1 (Primary's model) in Secondary
    const swapped = selectSecondaryModel(state, 'm1');
    assert.equal(swapped.secondaryModel, 'm1');
    assert.equal(swapped.primaryModel, 'm2');
  });

  it('selectSecondaryModel disallows selecting Primary model when Secondary was None', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    };
    // User selects m1 in Secondary when Secondary was None
    const result = selectSecondaryModel(state, 'm1');
    assert.equal(result.secondaryModel, undefined); // unchanged
    assert.equal(result.primaryModel, 'm1');
  });
});

describe('models-model: toggleApprovedModel (check/uncheck transitions)', () => {
  it('checking a model adds it to approvedModels with zero automatic slot mutations', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    };
    const next = toggleApprovedModel(state, 'm2', true);
    assert.deepEqual(next.approvedModels, ['m1', 'm2']);
    assert.equal(next.currentModel, 'm1');
    assert.equal(next.primaryModel, 'm1');
    assert.equal(next.secondaryModel, undefined);
  });

  it('unchecking secondaryModel removes it and clears secondaryModel', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2', 'm3'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const next = toggleApprovedModel(state, 'm2', false);
    assert.deepEqual(next.approvedModels, ['m1', 'm3']);
    assert.equal(next.currentModel, 'm1');
    assert.equal(next.primaryModel, 'm1');
    assert.equal(next.secondaryModel, undefined);
  });

  it('unchecking currentModel when currentModel !== primaryModel sets currentModel = primaryModel', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2', 'm3'],
      currentModel: 'm3',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const next = toggleApprovedModel(state, 'm3', false);
    assert.deepEqual(next.approvedModels, ['m1', 'm2']);
    assert.equal(next.currentModel, 'm1');
    assert.equal(next.primaryModel, 'm1');
    assert.equal(next.secondaryModel, 'm2');
  });

  it('unchecking primaryModel when primaryModel !== currentModel sets primaryModel = currentModel', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2', 'm3'],
      currentModel: 'm3',
      primaryModel: 'm1',
      secondaryModel: 'm3',
    };
    const next = toggleApprovedModel(state, 'm1', false);
    assert.deepEqual(next.approvedModels, ['m2', 'm3']);
    assert.equal(next.primaryModel, 'm3');
    assert.equal(next.currentModel, 'm3');
    assert.equal(next.secondaryModel, undefined); // secondary equaled current, so cleared
  });

  it('unchecking currentModel === primaryModel with secondary set promotes secondary to current and primary', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const next = toggleApprovedModel(state, 'm1', false);
    assert.deepEqual(next.approvedModels, ['m2']);
    assert.equal(next.currentModel, 'm2');
    assert.equal(next.primaryModel, 'm2');
    assert.equal(next.secondaryModel, undefined);
  });

  it('unchecking currentModel === primaryModel with no secondary leaves remaining models but sets current and primary to null', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    };
    const next = toggleApprovedModel(state, 'm1', false);
    assert.deepEqual(next.approvedModels, ['m2']);
    assert.equal(next.currentModel, null);
    assert.equal(next.primaryModel, null);
    assert.equal(next.secondaryModel, undefined);
  });

  it('unchecking the only approved model clears all slots to null/undefined', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    };
    const next = toggleApprovedModel(state, 'm1', false);
    assert.deepEqual(next.approvedModels, []);
    assert.equal(next.currentModel, null);
    assert.equal(next.primaryModel, null);
    assert.equal(next.secondaryModel, undefined);
  });
});

describe('models-model: toSetAgentModelsPayload', () => {
  it('formats payload correctly when approvedModels is empty', () => {
    const state: ModelSelectionDraft = {
      approvedModels: [],
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    };
    const payload = toSetAgentModelsPayload(state);
    assert.deepEqual(payload, {
      approvedModels: [],
      secondaryModel: null,
    });
  });

  it('formats payload correctly when approvedModels has models', () => {
    const state: ModelSelectionDraft = {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    };
    const payload = toSetAgentModelsPayload(state);
    assert.deepEqual(payload, {
      approvedModels: ['m1', 'm2'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: 'm2',
    });
  });
});

describe('models-model: budget helpers', () => {
  it('isBudgetExemptAgent identifies built-in and exempt agents', () => {
    assert.equal(isBudgetExemptAgent({ isBuiltin: true }), true);
    assert.equal(isBudgetExemptAgent({ category: 'builtin' }), true);
    assert.equal(isBudgetExemptAgent({ budgetExempt: true }), true);
    assert.equal(isBudgetExemptAgent({ isBuiltin: false, category: 'user' }), false);
  });

  it('budgetFormFromPolicy extracts values from policy without multiplying daily * 30', () => {
    const policy: AgentPolicy = {
      routes: [],
      budgetUsd: { perDay: 5, perMonth: 100 },
    };
    const form = budgetFormFromPolicy(policy);
    assert.equal(form.monthlyUsd, '100');
    assert.equal(form.hasDailyLimit, true);
    assert.equal(form.dailyUsd, '5');
  });

  it('budgetFormFromPolicy falls back to agent record when policy is missing without synthetic 30x math', () => {
    const agent: AgentRecord = {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      state: 'RUNNING',
      model: 'test',
      spendLimitUsd: 10,
      spendLimitMonthlyUsd: 250,
    };
    const form = budgetFormFromPolicy(null, agent);
    assert.equal(form.monthlyUsd, '250');
    assert.equal(form.hasDailyLimit, true);
    assert.equal(form.dailyUsd, '10');
  });

  it('budgetFormFromPolicy unchecks daily limit when policy has no perDay', () => {
    const policy: AgentPolicy = {
      routes: [],
      budgetUsd: { perMonth: 150 },
    };
    const form = budgetFormFromPolicy(policy);
    assert.equal(form.monthlyUsd, '150');
    assert.equal(form.hasDailyLimit, false);
    assert.equal(form.dailyUsd, '');
  });

  it('applyBudgetFormToPolicy saves perMonth and perDay when checked', () => {
    const policy: AgentPolicy = {
      routes: ['models'],
    };
    const form: BudgetFormData = {
      monthlyUsd: '200',
      hasDailyLimit: true,
      dailyUsd: '15',
    };
    const res = applyBudgetFormToPolicy(policy, form);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.policy.budgetUsd, { perMonth: 200, perDay: 15 });
    }
  });

  it('applyBudgetFormToPolicy omits perDay when hasDailyLimit is unchecked', () => {
    const policy: AgentPolicy = {
      routes: ['models'],
      budgetUsd: { perDay: 15, perMonth: 200 },
    };
    const form: BudgetFormData = {
      monthlyUsd: '200',
      hasDailyLimit: false,
      dailyUsd: '15',
    };
    const res = applyBudgetFormToPolicy(policy, form);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.policy.budgetUsd, { perMonth: 200 });
      assert.equal('perDay' in (res.policy.budgetUsd ?? {}), false);
    }
  });

  it('applyBudgetFormToPolicy preserves perRun if present', () => {
    const policy: AgentPolicy = {
      routes: ['models'],
      budgetUsd: { perRun: 1, perMonth: 50 },
    };
    const form: BudgetFormData = {
      monthlyUsd: '75',
      hasDailyLimit: false,
      dailyUsd: '',
    };
    const res = applyBudgetFormToPolicy(policy, form);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.policy.budgetUsd, { perRun: 1, perMonth: 75 });
    }
  });

  it('applyBudgetFormToPolicy deletes budgetUsd if all fields are empty', () => {
    const policy: AgentPolicy = {
      routes: ['models'],
      budgetUsd: { perMonth: 50 },
    };
    const form: BudgetFormData = {
      monthlyUsd: '',
      hasDailyLimit: false,
      dailyUsd: '',
    };
    const res = applyBudgetFormToPolicy(policy, form);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.policy.budgetUsd, undefined);
    }
  });

  it('applyBudgetFormToPolicy validates invalid and negative numbers', () => {
    const policy: AgentPolicy = { routes: [] };
    const res1 = applyBudgetFormToPolicy(policy, { monthlyUsd: '-10', hasDailyLimit: false, dailyUsd: '' });
    assert.equal(res1.ok, false);

    const res2 = applyBudgetFormToPolicy(policy, { monthlyUsd: 'abc', hasDailyLimit: false, dailyUsd: '' });
    assert.equal(res2.ok, false);

    const res3 = applyBudgetFormToPolicy(policy, { monthlyUsd: '100', hasDailyLimit: true, dailyUsd: '' });
    assert.equal(res3.ok, false);
  });
});

describe('models-model: dirty checks', () => {
  it('isDraftDirty detects slot and model changes', () => {
    const d1: ModelSelectionDraft = {
      approvedModels: ['m1'],
      currentModel: 'm1',
      primaryModel: 'm1',
      secondaryModel: undefined,
    };
    assert.equal(isDraftDirty(d1, { ...d1 }), false);
    assert.equal(isDraftDirty(d1, { ...d1, currentModel: 'm2' }), true);
    assert.equal(isDraftDirty(d1, { ...d1, secondaryModel: 'm2' }), true);
    assert.equal(isDraftDirty(d1, { ...d1, approvedModels: ['m1', 'm2'] }), true);
  });

  it('isBudgetDirty detects monthly and daily changes', () => {
    const b1: BudgetFormData = { monthlyUsd: '100', hasDailyLimit: false, dailyUsd: '' };
    assert.equal(isBudgetDirty(b1, { ...b1 }), false);
    assert.equal(isBudgetDirty(b1, { ...b1, monthlyUsd: '150' }), true);
    assert.equal(isBudgetDirty(b1, { ...b1, hasDailyLimit: true, dailyUsd: '5' }), true);
  });
});
