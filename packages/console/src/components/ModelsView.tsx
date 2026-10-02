import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle, Layers } from 'lucide-react';
import type { AgentPolicy, AgentRecord, OfferedModel } from '../api/types.js';
import { factoryApi } from '../api/client.js';

/**
 * TSK-059 (GAP-062): a read-only view of an agent's models. One place chooses them: the Policy tab (M2, E7).
 * The agent's repo declares a preferred model; its policy grants models from what this factory offers (M3);
 * each model call goes through the gatekeeper-egress, which refuses any model the policy does not grant.
 */
export const ModelsView: React.FC<{ agent: AgentRecord; onOpenPolicy: () => void }> = ({ agent, onOpenPolicy }) => {
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [offered, setOffered] = useState<OfferedModel[]>([]);
  const [factoryDefault, setFactoryDefault] = useState('claude-haiku-4-5');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPolicy(null);
    setError(null);
    Promise.all([factoryApi.getPolicy(agent.id), factoryApi.modelCatalog()])
      .then(([p, c]) => {
        setPolicy(p);
        setOffered(c.models);
        setFactoryDefault(c.default);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agent.id]);

  const preferred = agent.requestedModels?.[0] ?? agent.model;
  const alsoDeclared = (agent.requestedModels ?? []).filter((m) => m !== preferred);
  const offeredByName = new Map(offered.map((m) => [m.name, m]));
  // M2: a policy that names no models grants the factory default model, nothing more.
  const usesDefault = Boolean(policy && !policy.models);
  const granted = policy ? policy.models ?? [factoryDefault] : undefined;

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 shadow-sm';
  const heading = 'text-sm font-bold text-slate-900 dark:text-white';
  const hint = 'text-xs text-slate-500 dark:text-slate-400';
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

  const runModel = (): { tone: 'ok' | 'warn'; text: React.ReactNode } => {
    if (!granted) return { tone: 'warn', text: <>Loading…</> };
    if (usesDefault && preferred !== factoryDefault) {
      return {
        tone: 'warn',
        text: <>The policy names no models, so this agent gets the factory default, <span className="font-mono font-semibold">{factoryDefault}</span>; calls to its preferred model are refused. Grant models in Policy to change that.</>,
      };
    }
    if (granted.length === 0) return { tone: 'warn', text: <>No models are granted, so every model call is refused.</> };
    if (preferred && granted.includes(preferred)) {
      return { tone: 'ok', text: <>Runs use <span className="font-mono font-semibold">{preferred}</span>, the preferred model, which the policy grants.</> };
    }
    return {
      tone: 'warn',
      text: (
        <>
          The preferred model {preferred ? <span className="font-mono font-semibold">{preferred}</span> : '(none declared)'} is not
          granted, so calls to it are refused. Runs can use only{' '}
          <span className="font-mono font-semibold">{granted.join(', ')}</span>.
        </>
      ),
    };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="flex items-start space-x-2 text-xs text-slate-600 dark:text-slate-300">
          <Layers className="w-4 h-4 text-emerald-500 shrink-0" />
          <p>
            {agent.name}'s repo declares the model it prefers. The company decides which models it gets, in its policy. Each
            model call goes through the gatekeeper-egress, which refuses any model the policy does not grant.
          </p>
        </div>
        <button
          onClick={onOpenPolicy}
          className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center space-x-1.5"
        >
          <span>Change granted models in Policy</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className={card}>
          <h4 className={heading}>Preferred model</h4>
          <p className={hint}>From the agent's declaration.</p>
          {preferred ? (
            <div>
              <div className="font-mono text-xs font-bold text-slate-900 dark:text-white">{preferred}</div>
              {!offeredByName.has(preferred) && (
                <div className="mt-1.5 flex items-center space-x-1.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-300 dark:border-amber-800/80">
                    Requested (not offered)
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className={hint}>None declared.</p>
          )}
          {alsoDeclared.length > 0 && (
            <p className={hint}>
              Also built for: <span className="font-mono">{alsoDeclared.join(', ')}</span>
            </p>
          )}
        </div>

        <div className={card}>
          <h4 className={heading}>Granted models</h4>
          <p className={hint}>From the agent's policy.</p>
          {!policy && !error && <p className={hint}>Loading policy…</p>}
          {usesDefault && <p className={hint}>The policy names no models, so the factory default applies.</p>}
          {granted && granted.length === 0 && <p className={hint}>None.</p>}
          {granted?.map((m) => {
            const price = offeredByName.get(m)?.price;
            return (
              <div key={m} className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80 text-xs">
                <span className="flex items-center space-x-2">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="font-mono text-slate-800 dark:text-slate-200">{m}</span>
                </span>
                <span className="flex items-center space-x-1">
                  {m === preferred && tag('preferred', 'ok')}
                  {price && tag(`$${price.inputPerMTok}/$${price.outputPerMTok} per M tok`, 'muted')}
                  {!offeredByName.has(m) && tag('not offered', 'warn')}
                </span>
              </div>
            );
          })}
        </div>

        <div className={card}>
          <h4 className={heading}>Model its runs use</h4>
          <p className={hint}>The model the agent's code asks for, if the policy grants it.</p>
          {policy &&
            (() => {
              const r = runModel();
              return (
                <div className={`flex items-start space-x-2 text-xs ${r.tone === 'ok' ? 'text-slate-700 dark:text-slate-200' : 'text-amber-700 dark:text-amber-300'}`}>
                  {r.tone === 'ok' ? (
                    <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{r.text}</span>
                </div>
              );
            })()}
        </div>
      </div>
    </div>
  );
};
