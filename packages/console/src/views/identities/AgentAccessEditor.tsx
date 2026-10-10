import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Loader2, Plus, ShieldAlert, X } from 'lucide-react';
import type { AgentRecord, AgentRolesInfo } from '../../api/types.js';
import { factoryApi } from '../../api/client.js';
import { accessSentence, describeAccess, summarizeRoles, unassignedAgents, withRole, withoutAgent, type AgentRoleMap } from './access-model.js';

type Loaded = { state: 'loading' } | { state: 'ready'; info: AgentRolesInfo } | { state: 'error'; message: string };

/**
 * E12: what each agent will do for this person. For every agent the person holds a role on, the roles that agent's
 * cartridge declares (never `Owner`: that comes from owning it) to switch on or off, and in words what the factory says
 * those roles let them use. The words come from the factory, by the rule the egress applies; nothing is worked out here.
 */
export const AgentAccessEditor: React.FC<{ value: AgentRoleMap; onChange: (next: AgentRoleMap) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [effective, setEffective] = useState<Record<string, ReturnType<typeof describeAccess> | 'loading' | 'error'>>({});
  const asked = useRef<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    factoryApi
      .listAgents()
      .then((a) => live && setAgents(a))
      .catch((e: unknown) => live && setAgentsError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => [...new Set([...Object.keys(value), ...pending])].sort((a, b) => a.localeCompare(b)), [value, pending]);

  // The roles each shown agent declares, once.
  useEffect(() => {
    for (const id of shown) {
      if (loaded[id]) continue;
      setLoaded((p) => ({ ...p, [id]: { state: 'loading' } }));
      factoryApi
        .getAgentRoles(id)
        .then((info) => setLoaded((p) => ({ ...p, [id]: { state: 'ready', info } })))
        .catch((e: unknown) => setLoaded((p) => ({ ...p, [id]: { state: 'error', message: e instanceof Error ? e.message : String(e) } })));
    }
  }, [shown, loaded]);

  // What the held roles let each agent's person use: asked of the factory whenever they change.
  useEffect(() => {
    for (const id of shown) {
      const held = value[id] ?? [];
      const key = held.join('\u0000');
      if (asked.current[id] === key) continue;
      asked.current[id] = key;
      setEffective((p) => ({ ...p, [id]: 'loading' }));
      factoryApi
        .getAgentRoles(id, held)
        .then((info) => {
          if (asked.current[id] === key && info.effective) setEffective((p) => ({ ...p, [id]: describeAccess(info.effective!) }));
        })
        .catch(() => asked.current[id] === key && setEffective((p) => ({ ...p, [id]: 'error' })));
    }
  }, [shown, value]);

  const nameOf = (id: string) => agents?.find((a) => a.id === id)?.name ?? id;
  const addable = unassignedAgents(agents ?? [], value, pending);

  return (
    <div className="space-y-2 pt-2 border-t border-slate-800" data-testid="agent-access">
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Access to agents</label>
        <p className="text-[11px] text-slate-500 mt-0.5">
          What an agent will do for this person. These are separate from the factory roles above: a role here applies to one agent only, and never lets the person change or manage it.
        </p>
      </div>

      {shown.length === 0 && <p className="text-[11px] text-slate-500 italic">No agent will do anything for this person yet.</p>}

      {shown.map((id) => {
        const l = loaded[id];
        const held = value[id] ?? [];
        const assignable = l?.state === 'ready' ? l.info.assignable : [];
        const stale = held.filter((r) => l?.state === 'ready' && !assignable.includes(r));
        const eff = effective[id];
        return (
          <div key={id} className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <Bot className="w-3.5 h-3.5 text-slate-500" />
                <span className="font-semibold text-slate-200">{nameOf(id)}</span>
                <span className="font-mono text-[10px] text-slate-500">{id}</span>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setPending((p) => p.filter((x) => x !== id));
                  onChange(withoutAgent(value, id));
                }}
                className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-rose-400"
                title={`Remove every role on ${id}`}
              >
                <X className="w-3 h-3" />
                Remove access
              </button>
            </div>

            {l?.state === 'loading' && (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading the roles {id} declares…
              </p>
            )}
            {l?.state === 'error' && <p className="text-[11px] text-rose-400">Could not load the roles {id} declares: {l.message}</p>}
            {l?.state === 'ready' && assignable.length === 0 && stale.length === 0 && (
              <p className="text-[11px] text-amber-400">{id} declares no roles that can be given, so it will not do anything for anyone but its owner.</p>
            )}

            {l?.state === 'ready' && (assignable.length > 0 || stale.length > 0) && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Roles on ${id}`}>
                {assignable.map((role) => {
                  const on = held.includes(role);
                  const description = l.info.roles.find((r) => r.name === role)?.description;
                  return (
                    <button
                      key={role}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      disabled={disabled}
                      title={description ?? role}
                      onClick={() => onChange(withRole(value, id, role, !on))}
                      className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition ${
                        on ? 'bg-emerald-600 text-white border-emerald-500' : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-emerald-600'
                      }`}
                    >
                      {role}
                    </button>
                  );
                })}
                {stale.map((role) => (
                  <button
                    key={role}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(withRole(value, id, role, false))}
                    title={`${id} no longer declares ${role}. It gives nothing. Click to remove it.`}
                    className="px-2 py-1 rounded-md text-[11px] font-semibold border bg-amber-950/40 text-amber-300 border-amber-800 line-through"
                  >
                    {role}
                  </button>
                ))}
              </div>
            )}

            {eff === 'loading' && <p className="text-[11px] text-slate-500">Checking what that lets them use…</p>}
            {eff === 'error' && <p className="text-[11px] text-slate-500">Could not check what that lets them use.</p>}
            {eff && eff !== 'loading' && eff !== 'error' && (
              <div className="text-[11px] space-y-0.5" data-testid={`access-${id}`}>
                <p className="text-slate-300">{accessSentence(eff)}</p>
                {eff.notTheirs.length > 0 && <p className="text-slate-500">Not available to them: {eff.notTheirs.join(', ')}.</p>}
                {eff.unknownRoles.length > 0 && (
                  <p className="text-amber-400 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" />
                    {eff.unknownRoles.join(', ')} {eff.unknownRoles.length === 1 ? 'is' : 'are'} no longer declared and give nothing.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Plus className="w-3.5 h-3.5 text-slate-500" />
        <select
          aria-label="Add access to an agent"
          disabled={disabled || !agents || addable.length === 0}
          value=""
          onChange={(e) => e.target.value && setPending((p) => [...p, e.target.value])}
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
        >
          <option value="">{!agents ? 'Loading agents…' : addable.length === 0 ? 'No other agents' : 'Add access to an agent…'}</option>
          {addable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.id})
            </option>
          ))}
        </select>
      </div>
      {agentsError && <p className="text-[11px] text-rose-400">Could not load the agents: {agentsError}</p>}
      {summarizeRoles(value).length > 0 && <p className="text-[10px] text-slate-500">Saves as: {summarizeRoles(value).join('; ')}.</p>}
    </div>
  );
};
