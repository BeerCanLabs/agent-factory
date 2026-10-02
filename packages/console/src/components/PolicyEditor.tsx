import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, Shield } from 'lucide-react';
import type { AgentPolicy, AgentRecord, OfferedModel } from '../api/types.js';
import { factoryApi } from '../api/client.js';

/**
 * TSK-048: the company's policy for one agent, set by an admin in the factory (E7, L4). The agent's repo only
 * declares the egress it needs and a preferred model (E8, M2); routes and hosts can be granted only from that
 * declaration, and models only from what this factory offers (M3). Budget is the company's alone.
 */
export const PolicyEditor: React.FC<{ agent: AgentRecord; canEdit: boolean }> = ({ agent, canEdit }) => {
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [offered, setOffered] = useState<OfferedModel[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [perDay, setPerDay] = useState('');
  const [perMonth, setPerMonth] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const budgetExempt = Boolean(agent.isBuiltin || agent.budgetExempt || agent.category === 'builtin');
  const declaredRoutes = agent.egress?.routes ?? [];
  const declaredHosts = agent.egress?.hosts ?? [];
  const preferred = agent.requestedModels?.[0] ?? agent.model;

  const load = (p: AgentPolicy) => {
    setPolicy(p);
    setRoutes(p.routes ?? []);
    setHosts(p.hosts ?? []);
    setModels(p.models ?? []);
    setPerDay(p.budgetUsd?.perDay !== undefined ? String(p.budgetUsd.perDay) : '');
    setPerMonth(p.budgetUsd?.perMonth !== undefined ? String(p.budgetUsd.perMonth) : '');
  };

  useEffect(() => {
    setError(null);
    setSaved(null);
    Promise.all([factoryApi.getPolicy(agent.id), factoryApi.listModels()])
      .then(([p, m]) => {
        load(p);
        setOffered(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agent.id]);

  // Everything declared (or offered), plus anything the saved policy grants that is not, so it can be seen and
  // removed. Rows come from the saved policy, not the edit in progress, so unticking one never makes it vanish.
  // E7: the factory model API (`models`) comes with this policy; models are chosen below, not as a route.
  const routeRows = useMemo(() => [...new Set([...declaredRoutes, ...(policy?.routes ?? [])])].filter((r) => r !== 'models'), [declaredRoutes, policy]);
  const hostRows = useMemo(() => [...new Set([...declaredHosts, ...(policy?.hosts ?? [])])], [declaredHosts, policy]);
  const modelRows = useMemo(() => [...new Set([...offered.map((m) => m.name), ...(policy?.models ?? [])])], [offered, policy]);
  const offeredNames = new Set(offered.map((m) => m.name));

  const toggle = (list: string[], set: (v: string[]) => void, item: string) =>
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const money = (v: string): number | undefined | null => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const save = async () => {
    if (!policy) return;
    const day = money(perDay);
    const month = money(perMonth);
    if (day === null || month === null) {
      setError('Budgets must be numbers of dollars, 0 or more.');
      return;
    }
    const budgetUsd = { ...(policy.budgetUsd?.perRun !== undefined ? { perRun: policy.budgetUsd.perRun } : {}), ...(day !== undefined ? { perDay: day } : {}), ...(month !== undefined ? { perMonth: month } : {}) };
    const next: AgentPolicy = {
      ...policy,
      routes,
      hosts,
      models,
      ...(budgetExempt ? {} : { budgetUsd }),
    };
    if (budgetExempt || Object.keys(budgetUsd).length === 0) delete next.budgetUsd;
    setSaving(true);
    setError(null);
    try {
      load(await factoryApi.setPolicy(agent.id, next));
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
        <input type="checkbox" checked={checked} onChange={onChange} disabled={!canEdit || disabled} />
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

  return (
    <div className="space-y-4">
      <div className="flex items-start space-x-2 text-xs text-slate-600 dark:text-slate-300">
        <Shield className="w-4 h-4 text-emerald-500 shrink-0" />
        <p>
          This is what the company grants {agent.name}. The agent's repo only asks: it declares the egress it needs and the
          model it was built for. Routes and hosts can be granted only from that declaration; models from what this factory
          offers. A deploy never changes this policy.
          {!canEdit && ' Only an admin can change it.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

        <div className={card}>
          <h4 className={heading}>Models</h4>
          <p className={hint}>Granting models gives the agent the factory model API; there is no separate route to check.</p>
          {modelRows.length === 0 && <p className={hint}>This factory offers no models.</p>}
          {modelRows.map((m) => {
            const price = offered.find((o) => o.name === m)?.price;
            return row(
              m,
              models.includes(m),
              () => toggle(models, setModels, m),
              <span className="flex items-center space-x-1">
                {m === preferred && tag('preferred', 'ok')}
                {price && tag(`$${price.inputPerMTok}/$${price.outputPerMTok} per M tok`, 'muted')}
                {!offeredNames.has(m) && tag('not offered', 'warn')}
              </span>,
              !offeredNames.has(m) && !models.includes(m),
            );
          })}

          {!budgetExempt && (
            <>
              <h4 className={`${heading} pt-3`}>Budget (USD)</h4>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className={hint}>Per day</span>
                  <input
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
                    inputMode="decimal"
                    value={perDay}
                    onChange={(e) => setPerDay(e.target.value)}
                    disabled={!canEdit}
                    placeholder="no limit"
                  />
                </label>
                <label className="space-y-1">
                  <span className={hint}>Per month</span>
                  <input
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
                    inputMode="decimal"
                    value={perMonth}
                    onChange={(e) => setPerMonth(e.target.value)}
                    disabled={!canEdit}
                    placeholder="no limit"
                  />
                </label>
              </div>
            </>
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
