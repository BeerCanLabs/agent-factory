import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle, ExternalLink, Shield } from 'lucide-react';
import type { AgentPolicy, AgentRecord, OfferedModel, AgentModelsState } from '../api/types.js';
import { factoryApi } from '../api/client.js';

interface PolicyEditorProps {
  agent: AgentRecord;
  canEdit: boolean;
  onOpenModels?: () => void;
}

/**
 * The company's policy for one agent (E7, L4).
 * Routes and hosts can be granted only from the agent repository's declarations.
 * Models and budget are managed in the Models tab (GAP-062, TSK-169).
 * When saving Routes & Hosts, existing budgetUsd, models, currentModel, primaryModel, and secondaryModel
 * are strictly preserved.
 */
export const PolicyEditor: React.FC<PolicyEditorProps> = ({ agent, canEdit, onOpenModels }) => {
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [modelsState, setModelsState] = useState<AgentModelsState | null>(null);
  const [catalog, setCatalog] = useState<OfferedModel[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const declaredRoutes = agent.egress?.routes ?? [];
  const declaredHosts = agent.egress?.hosts ?? [];

  useEffect(() => {
    setError(null);
    setSaved(null);
    Promise.allSettled([
      factoryApi.getPolicy(agent.id),
      factoryApi.getAgentModels(agent.id),
      factoryApi.modelCatalog(),
    ]).then(([pRes, mRes, cRes]) => {
      if (pRes.status === 'fulfilled') {
        const p = pRes.value;
        setPolicy(p);
        setRoutes(p.routes ?? []);
        setHosts(p.hosts ?? []);
      } else {
        setError(`Failed to load policy: ${pRes.reason?.message ?? String(pRes.reason)}`);
      }
      if (mRes.status === 'fulfilled') {
        setModelsState(mRes.value);
      }
      if (cRes.status === 'fulfilled') {
        setCatalog(cRes.value.models ?? []);
      }
    });
  }, [agent.id]);

  const routeRows = useMemo(
    () => [...new Set([...declaredRoutes, ...(policy?.routes ?? [])])].filter((r) => r !== 'models'),
    [declaredRoutes, policy],
  );
  const hostRows = useMemo(
    () => [...new Set([...declaredHosts, ...(policy?.hosts ?? [])])],
    [declaredHosts, policy],
  );

  const toggle = (list: string[], set: (v: string[]) => void, item: string) =>
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const save = async () => {
    if (!policy) return;
    // Strictly preserve policy.budgetUsd, models, currentModel, primaryModel, secondaryModel
    const next: AgentPolicy = {
      ...policy,
      routes,
      hosts,
    };
    setSaving(true);
    setError(null);
    try {
      const updated = await factoryApi.setPolicy(agent.id, next);
      setPolicy(updated);
      setRoutes(updated.routes ?? []);
      setHosts(updated.hosts ?? []);
      setSaved(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const row = (label: string, checked: boolean, onChange: () => void, note?: React.ReactNode, disabled = false) => (
    <label key={label} className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80 text-xs">
      <span className="flex items-center space-x-2">
        <input type="checkbox" checked={checked} onChange={onChange} disabled={!canEdit || disabled} className="rounded text-emerald-600 focus:ring-emerald-500" />
        <span className="font-mono text-slate-800 dark:text-slate-200">{label}</span>
      </span>
      {note}
    </label>
  );

  const tag = (text: string, tone: 'ok' | 'warn' | 'muted') => (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
        tone === 'ok'
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
          : tone === 'warn'
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
      }`}
    >
      {text}
    </span>
  );

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 shadow-sm';
  const heading = 'text-sm font-bold text-slate-900 dark:text-white';
  const hint = 'text-xs text-slate-500 dark:text-slate-400';

  if (!policy && !error) return <div className={hint}>Loading policy…</div>;

  const catalogMap = new Map(catalog.map((m) => [m.name, m]));
  const grantedModels = modelsState?.approvedModels ?? policy?.models ?? [];
  const usesDefault = Boolean(modelsState?.usesDefault ?? (policy && !policy.models));

  return (
    <div className="space-y-4">
      <div className="flex items-start space-x-2 text-xs text-slate-600 dark:text-slate-300">
        <Shield className="w-4 h-4 text-emerald-500 shrink-0" />
        <p>
          This is what the company grants {agent.name}. The agent's repo only asks: it declares the egress it needs and the
          model it was built for. Routes and hosts can be granted only from that declaration.
          {!canEdit && ' Only an admin can change it.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Routes & Hosts Column */}
        <div className={card}>
          <h4 className={heading}>Routes</h4>
          {routeRows.length === 0 && <p className={hint}>The agent declares no routes.</p>}
          {routeRows.map((r) =>
            row(
              r,
              routes.includes(r),
              () => toggle(routes, setRoutes, r),
              declaredRoutes.includes(r) ? undefined : tag('not declared', 'warn'),
              !declaredRoutes.includes(r) && !routes.includes(r),
            ),
          )}

          {hostRows.length > 0 && <h4 className={`${heading} pt-3`}>Hosts</h4>}
          {hostRows.map((h) =>
            row(
              h,
              hosts.includes(h),
              () => toggle(hosts, setHosts, h),
              declaredHosts.includes(h) ? undefined : tag('not declared', 'warn'),
              !declaredHosts.includes(h) && !hosts.includes(h),
            ),
          )}
        </div>

        {/* Granted Models Column (Read-Only Summary) */}
        <div className={card}>
          <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
            <h4 className={heading}>Granted Models</h4>
            {onOpenModels && (
              <button
                type="button"
                onClick={onOpenModels}
                className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline flex items-center space-x-1"
              >
                <span>Manage in Models</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <p className={hint}>
            Model permissions and failback slots are configured in the Models tab.
          </p>

          {usesDefault ? (
            <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Factory Default Model</div>
              <p className="text-slate-500 dark:text-slate-400">
                The policy grants no explicit model list, so this agent uses the factory default:{' '}
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  {modelsState?.defaultModel ?? 'none configured'}
                </span>
                .
              </p>
            </div>
          ) : grantedModels.length === 0 ? (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800/40 text-xs text-amber-700 dark:text-amber-400">
              No models granted. Every model call will be refused.
            </div>
          ) : (
            <div className="space-y-1.5">
              {grantedModels.map((m) => {
                const cat = catalogMap.get(m);
                const isCurrent = m === modelsState?.currentModel;
                const isPrimary = m === modelsState?.primaryModel;
                const isSecondary = m === modelsState?.secondaryModel;

                return (
                  <div
                    key={m}
                    className="flex items-center justify-between py-1.5 px-2 rounded bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800/80 text-xs"
                  >
                    <span className="flex items-center space-x-2">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span className="font-mono text-slate-800 dark:text-slate-200">{m}</span>
                    </span>
                    <div className="flex items-center space-x-1.5">
                      {isCurrent && tag('Current', 'ok')}
                      {isPrimary && tag('Primary', 'muted')}
                      {isSecondary && tag('Secondary', 'muted')}
                      {cat?.price && (
                        <span className="text-[10px] font-mono text-slate-400">
                          ${cat.price.inputPerMTok}/${cat.price.outputPerMTok}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}
      {saved && !error && (
        <div className="flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle className="w-4 h-4" />
          <span>Saved at {saved}. The change is in the ledger.</span>
        </div>
      )}
      {canEdit && (
        <button
          onClick={save}
          disabled={saving || !policy}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      )}
    </div>
  );
};
