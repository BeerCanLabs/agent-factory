import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Layers,
  RotateCcw,
  Save,
  Shield,
  Info,
} from 'lucide-react';
import type { AgentPolicy, AgentRecord, OfferedModel, AgentModelsState } from '../api/types.js';
import { factoryApi } from '../api/client.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import { usePermissions } from '../auth/usePermissions.js';
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
  initialDraftFromState,
  isDraftDirty,
  isBudgetDirty,
  isOwnerOf,
  type ModelSelectionDraft,
  type BudgetFormData,
} from './models-model.js';

interface ModelsViewProps {
  agent: AgentRecord;
  onRefresh?: () => void;
}

export const ModelsView: React.FC<ModelsViewProps> = ({ agent, onRefresh }) => {
  const { user } = useAuth();
  const permissions = usePermissions();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Data states
  const [owners, setOwners] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<OfferedModel[]>([]);
  const [modelsState, setModelsState] = useState<AgentModelsState | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);

  // Model Selection Draft
  const [initialDraft, setInitialDraft] = useState<ModelSelectionDraft>({
    approvedModels: [],
    currentModel: null,
    primaryModel: null,
    secondaryModel: undefined,
  });
  const [draft, setDraft] = useState<ModelSelectionDraft>({
    approvedModels: [],
    currentModel: null,
    primaryModel: null,
    secondaryModel: undefined,
  });
  const [modelAccessExpanded, setModelAccessExpanded] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsSavedAt, setModelsSavedAt] = useState<string | null>(null);

  // Budget Form
  const isExempt = isBudgetExemptAgent(agent);
  const [initialBudgetForm, setInitialBudgetForm] = useState<BudgetFormData>({
    monthlyUsd: '',
    hasDailyLimit: false,
    dailyUsd: '',
  });
  const [budgetForm, setBudgetForm] = useState<BudgetFormData>({
    monthlyUsd: '',
    hasDailyLimit: false,
    dailyUsd: '',
  });
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetSavedAt, setBudgetSavedAt] = useState<string | null>(null);

  // Permissions
  const canEditBudget = Boolean(permissions.canSetBudget);
  const canEditModels = Boolean(permissions.canSetPolicy || isOwnerOf(owners, user?.email));

  // Load data defensively
  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    setModelsError(null);
    setBudgetError(null);

    const [modelsRes, catalogRes, ownersRes, policyRes] = await Promise.allSettled([
      factoryApi.getAgentModels(agent.id),
      factoryApi.modelCatalog(),
      factoryApi.getOwners(agent.id),
      factoryApi.getPolicy(agent.id),
    ]);

    let loadedModelsState: AgentModelsState | null = null;
    if (modelsRes.status === 'fulfilled') {
      loadedModelsState = modelsRes.value;
      setModelsState(loadedModelsState);
      const initDraft = initialDraftFromState(loadedModelsState);
      setInitialDraft(initDraft);
      setDraft(initDraft);
    } else {
      setLoadError(`Failed to load agent models: ${modelsRes.reason?.message ?? String(modelsRes.reason)}`);
    }

    if (catalogRes.status === 'fulfilled') {
      setCatalog(catalogRes.value.models ?? []);
    }

    if (ownersRes.status === 'fulfilled') {
      setOwners(ownersRes.value ?? []);
    } else {
      setOwners([]);
    }

    let loadedPolicy: AgentPolicy | null = null;
    if (policyRes.status === 'fulfilled') {
      loadedPolicy = policyRes.value;
      setPolicy(loadedPolicy);
    } else {
      setPolicy(null);
    }

    const initBudget = budgetFormFromPolicy(loadedPolicy, agent);
    setInitialBudgetForm(initBudget);
    setBudgetForm(initBudget);

    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [agent.id]);

  // Model Selection Handlers
  const handleSaveModels = async () => {
    if (!canEditModels) return;
    if (draft.approvedModels.length > 0 && draft.currentModel === null) {
      setModelsError('Please select a Current Model before saving.');
      return;
    }
    setSavingModels(true);
    setModelsError(null);
    try {
      const payload = toSetAgentModelsPayload(draft);
      const updated = await factoryApi.setAgentModels(agent.id, payload, 'models updated in console');
      setModelsState(updated);
      const nextDraft = initialDraftFromState(updated);
      setInitialDraft(nextDraft);
      setDraft(nextDraft);
      setModelsSavedAt(new Date().toLocaleTimeString());
      onRefresh?.();
    } catch (e: any) {
      setModelsError(e?.message ?? String(e));
    } finally {
      setSavingModels(false);
    }
  };

  const handleDiscardModels = () => {
    setDraft({ ...initialDraft });
    setModelsError(null);
  };

  // Budget Handlers
  const handleSaveBudget = async () => {
    if (!canEditBudget || isExempt) return;
    setSavingBudget(true);
    setBudgetError(null);
    try {
      let basePolicy = policy;
      try {
        basePolicy = await factoryApi.getPolicy(agent.id);
      } catch {
        basePolicy = policy ?? { routes: [] };
      }

      const applied = applyBudgetFormToPolicy(basePolicy ?? { routes: [] }, budgetForm);
      if (!applied.ok) {
        setBudgetError(applied.error);
        setSavingBudget(false);
        return;
      }

      await factoryApi.saveAgentBudgetPolicy(agent.id, applied.policy, 'budget updated in console');
      setPolicy(applied.policy);
      const nextForm = budgetFormFromPolicy(applied.policy, agent);
      setInitialBudgetForm(nextForm);
      setBudgetForm(nextForm);
      setBudgetSavedAt(new Date().toLocaleTimeString());
      onRefresh?.();
    } catch (e: any) {
      setBudgetError(e?.message ?? String(e));
    } finally {
      setSavingBudget(false);
    }
  };

  const handleDiscardBudget = () => {
    setBudgetForm({ ...initialBudgetForm });
    setBudgetError(null);
  };

  const modelsDirty = isDraftDirty(initialDraft, draft);
  const budgetDirty = isBudgetDirty(initialBudgetForm, budgetForm);

  // Group approved models for dropdowns
  const approvedOffered = approvedOfferedModels(draft.approvedModels, catalog);
  const approvedGroups = groupModelsByProvider(approvedOffered);

  // Group full catalog for Model Access
  const catalogGroups = groupModelsByProvider(catalog);

  const cardStyle = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm space-y-4';
  const headingStyle = 'text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-2';
  const hintStyle = 'text-xs text-slate-500 dark:text-slate-400';

  if (loading && !modelsState) {
    return (
      <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
        Loading model configurations…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 p-3 rounded-lg border border-red-200 dark:border-red-900">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 1. TOP: Budget Card                                                        */}
      {/* ========================================================================= */}
      <div className={cardStyle}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className={headingStyle}>Agent Budget</h3>
          </div>
          {isExempt && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              Exempt from spend limits
            </span>
          )}
        </div>

        {isExempt ? (
          <p className={hintStyle}>
            Built-in system agents are critical infrastructure and are exempt from spend limits. Budgets cannot be assigned.
          </p>
        ) : canEditBudget ? (
          <div className="space-y-4">
            <p className={hintStyle}>
              Set monthly LLM egress spend limit and optional daily limit for this agent in USD. Unchecking daily limit removes it cleanly.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Monthly budget ($)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={budgetForm.monthlyUsd}
                  onChange={(e) => setBudgetForm({ ...budgetForm, monthlyUsd: e.target.value })}
                  placeholder="no monthly limit"
                  disabled={savingBudget}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={budgetForm.hasDailyLimit}
                    onChange={(e) => setBudgetForm({ ...budgetForm, hasDailyLimit: e.target.checked })}
                    disabled={savingBudget}
                    className="rounded text-emerald-600 focus:ring-emerald-500"
                  />
                  <span>Set a daily limit</span>
                </label>

                {budgetForm.hasDailyLimit && (
                  <div className="space-y-1">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={budgetForm.dailyUsd}
                      onChange={(e) => setBudgetForm({ ...budgetForm, dailyUsd: e.target.value })}
                      placeholder="daily limit in USD"
                      disabled={savingBudget}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                )}
              </div>
            </div>

            {budgetError && (
              <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{budgetError}</span>
              </div>
            )}
            {budgetSavedAt && !budgetError && (
              <div className="flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>Budget saved at {budgetSavedAt}.</span>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2 pt-1 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={handleDiscardBudget}
                disabled={savingBudget || !budgetDirty}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 flex items-center space-x-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Discard changes</span>
              </button>
              <button
                type="button"
                onClick={handleSaveBudget}
                disabled={savingBudget || !budgetDirty}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center space-x-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingBudget ? 'Saving…' : 'Save budget'}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 uppercase text-[10px] font-semibold">Monthly Limit</div>
                <div className="font-bold text-slate-800 dark:text-slate-200 text-sm mt-0.5">
                  {budgetForm.monthlyUsd ? `$${budgetForm.monthlyUsd}/mo` : 'Not set'}
                </div>
              </div>
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 uppercase text-[10px] font-semibold">Daily Limit</div>
                <div className="font-bold text-slate-800 dark:text-slate-200 text-sm mt-0.5">
                  {budgetForm.hasDailyLimit && budgetForm.dailyUsd ? `$${budgetForm.dailyUsd}/day` : 'Not set'}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-slate-400">Only a Factory Admin can modify spend limits.</p>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 2. MIDDLE: Model Selection Card                                            */}
      {/* ========================================================================= */}
      <div className={cardStyle}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className={headingStyle}>Model Selection</h3>
          </div>
          {modelsState?.usesDefault && !modelsDirty && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              Factory default ({modelsState.defaultModel ?? 'none configured'})
            </span>
          )}
        </div>

        <div className="flex items-start space-x-2 text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950/60 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
          <Info className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>
              <strong className="text-slate-800 dark:text-slate-100">Current Model</strong> is served first and updates automatically upon persistent failover.
            </p>
            <p>
              <strong className="text-slate-800 dark:text-slate-100">Primary Model</strong> is the 1st failback target; <strong className="text-slate-800 dark:text-slate-100">Secondary Model</strong> is an optional 2nd failback target.
            </p>
          </div>
        </div>

        {draft.approvedModels.length === 0 ? (
          <div className="p-4 text-center rounded-lg border border-dashed border-amber-300 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 text-xs text-amber-800 dark:text-amber-300 space-y-1">
            <p className="font-semibold">No models are approved for this agent.</p>
            <p className="text-[11px] text-amber-700 dark:text-amber-400">Expand Model Access below to approve one or more models.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Slot 1: Current Model */}
            <div className="space-y-1.5 p-3 rounded-lg bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-200/80 dark:border-emerald-800/40">
              <label className="text-xs font-bold text-emerald-900 dark:text-emerald-300 flex items-center justify-between">
                <span>Current Model</span>
                <span className="text-[10px] font-normal text-emerald-700 dark:text-emerald-400">Active target</span>
              </label>
              <select
                value={draft.currentModel ?? ''}
                onChange={(e) => setDraft(selectCurrentModel(draft, e.target.value))}
                disabled={!canEditModels || savingModels}
                className="w-full bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 rounded-lg p-2 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {draft.currentModel === null && <option value="">Select a model…</option>}
                {approvedGroups.map((g) => (
                  <optgroup key={g.provider} label={g.provider}>
                    {g.models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Slot 2: Primary Model */}
            <div className="space-y-1.5 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center justify-between">
                <span>Primary Model</span>
                <span className="text-[10px] font-normal text-slate-500 dark:text-slate-400">1st failback</span>
              </label>
              <select
                value={draft.primaryModel ?? ''}
                onChange={(e) => setDraft(selectPrimaryModel(draft, e.target.value))}
                disabled={!canEditModels || savingModels}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-2 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {draft.primaryModel === null && <option value="">Select a model…</option>}
                {approvedGroups.map((g) => (
                  <optgroup key={g.provider} label={g.provider}>
                    {g.models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Slot 3: Secondary Model */}
            <div className="space-y-1.5 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center justify-between">
                <span>Secondary Model</span>
                <span className="text-[10px] font-normal text-slate-500 dark:text-slate-400">2nd failback</span>
              </label>
              <select
                value={draft.secondaryModel ?? ''}
                onChange={(e) => setDraft(selectSecondaryModel(draft, e.target.value))}
                disabled={!canEditModels || savingModels}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-2 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="">None (no secondary failback)</option>
                {approvedGroups.map((g) => (
                  <optgroup key={g.provider} label={g.provider}>
                    {g.models.map((m) => {
                      const isPrimary = m.name === draft.primaryModel;
                      const secondaryUnset = draft.secondaryModel === undefined || draft.secondaryModel === '';
                      return (
                        <option
                          key={m.name}
                          value={m.name}
                          disabled={isPrimary && secondaryUnset}
                        >
                          {m.name}
                          {isPrimary ? (secondaryUnset ? ' (Primary)' : ' (Swap with Primary)') : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}

        {modelsError && (
          <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{modelsError}</span>
          </div>
        )}
        {modelsSavedAt && !modelsError && (
          <div className="flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>Models saved at {modelsSavedAt}. Change is in the ledger.</span>
          </div>
        )}

        {canEditModels && (
          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={handleDiscardModels}
              disabled={savingModels || !modelsDirty}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 flex items-center space-x-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Discard changes</span>
            </button>
            <button
              type="button"
              onClick={handleSaveModels}
              disabled={
                savingModels ||
                !modelsDirty ||
                (draft.approvedModels.length > 0 && draft.currentModel === null)
              }
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center space-x-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingModels ? 'Saving…' : 'Save models'}</span>
            </button>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 3. BOTTOM: Collapsible "Model Access" Card                                 */}
      {/* ========================================================================= */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <button
          type="button"
          onClick={() => setModelAccessExpanded(!modelAccessExpanded)}
          aria-expanded={modelAccessExpanded}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition"
        >
          <div className="flex items-center space-x-2.5">
            {modelAccessExpanded ? (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-slate-500" />
            )}
            <div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">Model Access</h4>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Catalog models granted to this agent. Checking adds to approved list; unchecking cascades slot fallbacks.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
              {draft.approvedModels.length} approved
            </span>
            {modelsState?.usesDefault && !modelsDirty && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                Factory default
              </span>
            )}
          </div>
        </button>

        {modelAccessExpanded && (
          <div className="p-5 border-t border-slate-100 dark:border-slate-800 space-y-5">
            {catalogGroups.length === 0 ? (
              <p className={hintStyle}>No models offered in this factory.</p>
            ) : (
              catalogGroups.map((group) => (
                <div key={group.provider} className="space-y-2">
                  <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 pb-1">
                    {group.provider}
                  </h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {group.models.map((m) => {
                      const isApproved = draft.approvedModels.includes(m.name);
                      const isCurrent = m.name === draft.currentModel;
                      const isPrimary = m.name === draft.primaryModel;
                      const isSecondary = m.name === draft.secondaryModel;

                      return (
                        <label
                          key={m.name}
                          className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition ${
                            isApproved
                              ? 'bg-slate-50 dark:bg-slate-800/60 border-slate-300 dark:border-slate-700'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5">
                            <input
                              type="checkbox"
                              checked={isApproved}
                              onChange={(e) => setDraft(toggleApprovedModel(draft, m.name, e.target.checked))}
                              disabled={!canEditModels || savingModels}
                              className="rounded text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                              {m.name}
                            </span>
                          </div>

                          <div className="flex items-center space-x-1.5">
                            {isCurrent && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                                Current
                              </span>
                            )}
                            {isPrimary && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                                Primary
                              </span>
                            )}
                            {isSecondary && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                                Secondary
                              </span>
                            )}
                            {m.price && (
                              <span className="text-[10px] font-mono text-slate-400">
                                ${m.price.inputPerMTok}/${m.price.outputPerMTok}
                              </span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
