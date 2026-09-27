import React, { useState } from 'react';
import { DollarSign, AlertOctagon, TrendingUp, ShieldAlert, Cpu } from 'lucide-react';
import type { AgentRecord } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';

interface FinOpsViewProps {
  agents: AgentRecord[];
  onRefresh: () => void;
}

export const FinOpsView: React.FC<FinOpsViewProps> = ({ agents, onRefresh }) => {
  const permissions = usePermissions();
  const [viewPeriod, setViewPeriod] = useState<'daily' | 'monthly'>('monthly');
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [newBudgetLimit, setNewBudgetLimit] = useState<number>(100);
  const [editingPeriod, setEditingPeriod] = useState<'daily' | 'monthly'>('monthly');
  const [isUpdating, setIsUpdating] = useState(false);

  const isBuiltinAgent = (a: AgentRecord) => Boolean(
    a.isBuiltin || a.category === 'builtin' || a.budgetExempt || ['doorman', 'keymaster', 'doctor', 'coach'].includes(a.id)
  );

  // FinOps is exclusively for autonomous submind agents with budget allocations.
  // Core system actors (Doorman, Keymaster, Doctor, Coach) are infrastructure and excluded from FinOps.
  const submindAgents = agents.filter((a) => !isBuiltinAgent(a));

  // Compute spend and budget totals strictly for submind autonomous agents
  const totalDailySpend = submindAgents.reduce((sum, a) => sum + (a.currentSpendUsd || 0), 0);
  const totalMonthlySpend = submindAgents.reduce((sum, a) => sum + (a.currentSpendMonthlyUsd || a.currentSpendUsd || 0), 0);
  const totalDailyBudget = submindAgents.reduce((sum, a) => sum + (a.spendLimitUsd || 0), 0);
  const totalMonthlyBudget = submindAgents.reduce((sum, a) => sum + (a.spendLimitMonthlyUsd || (a.spendLimitUsd ? a.spendLimitUsd * 30 : 0)), 0);

  const activeSpend = viewPeriod === 'monthly' ? totalMonthlySpend : totalDailySpend;
  const activeBudget = viewPeriod === 'monthly' ? totalMonthlyBudget : totalDailyBudget;
  const spendPercent = activeBudget > 0 ? (activeSpend / activeBudget) * 100 : 0;

  const handleUpdateBudget = async (agentId: string) => {
    setIsUpdating(true);
    try {
      await factoryApi.setAgentBudget(agentId, newBudgetLimit, editingPeriod);
      alert(`Budget cap for ${agentId} updated to $${newBudgetLimit}/${editingPeriod === 'monthly' ? 'month' : 'day'}.`);
      setEditingAgentId(null);
      onRefresh();
    } catch (err: any) {
      alert(`Budget update failed: ${err.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleIsolate = async (agent: AgentRecord) => {
    if (!confirm(`EMERGENCY ACTION: Sever all network egress for ${agent.name} immediately?`)) return;
    try {
      await factoryApi.isolateAgent(agent.id);
      alert(`Agent ${agent.name} egress severed.`);
      onRefresh();
    } catch (err: any) {
      alert(`Isolation failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Window Toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <DollarSign className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <span>FinOps Governance & Spend Circuit Breakers</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Real-time token burn attribution, departmental cost caps, and emergency egress kill-switches.
          </p>
        </div>

        {/* Global Window View Toggle */}
        <div className="flex items-center space-x-1.5 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <button
            onClick={() => setViewPeriod('monthly')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              viewPeriod === 'monthly'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Monthly Budget
          </button>
          <button
            onClick={() => setViewPeriod('daily')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              viewPeriod === 'daily'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Daily Budget
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2 shadow-sm transition-colors">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Global {viewPeriod === 'monthly' ? '30-Day Monthly' : '24h Daily'} Spend
          </span>
          <div className="text-3xl font-bold text-slate-900 dark:text-white">${activeSpend.toFixed(2)}</div>
          <div className="w-full bg-slate-100 dark:bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-200 dark:border-slate-800">
            <div
              className={`h-full transition-all duration-500 ${
                spendPercent > 85 ? 'bg-red-500' : spendPercent > 60 ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, spendPercent)}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
            <span>{spendPercent.toFixed(1)}% of limit</span>
            <span>Limit: ${activeBudget.toFixed(2)}/{viewPeriod === 'monthly' ? 'mo' : 'day'}</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2 shadow-sm transition-colors">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Pricing Rate Engine</span>
          <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">Gateway Metered</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            All tokens priced synchronously at outbound proxy layer before upstream forwarding. 
            Zero unmetered LLM egress permitted.
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2 shadow-sm transition-colors">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Automated Circuit Breakers</span>
          <div className="text-lg font-bold text-slate-900 dark:text-white">Active (Multi-Window)</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            When a submind agent reaches 100% of its spend ceiling, egress gateway returns 402 Payment Required 
            and freezes execution. Core platform actors (Doorman, Keymaster, Doctor, Coach) are exempt.
          </p>
        </div>
      </div>

      {/* Cost Attribution Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm transition-colors">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <TrendingUp className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Submind Spend Attribution & Budget Allocation</span>
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {viewPeriod === 'monthly' ? 'Monthly Allocation Window' : 'Daily Rolling Window'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Agent</th>
                <th className="py-3 px-4">Department</th>
                <th className="py-3 px-4">Active Model</th>
                <th className="py-3 px-4">Current Spend</th>
                <th className="py-3 px-4">Configured Budget</th>
                <th className="py-3 px-4">Headroom</th>
                <th className="py-3 px-4 text-right">FinOps Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60">
              {submindAgents.map((agent) => {
                const currentSpend = viewPeriod === 'monthly'
                  ? (agent.currentSpendMonthlyUsd ?? agent.currentSpendUsd ?? 0)
                  : (agent.currentSpendUsd ?? 0);

                const currentLimit = viewPeriod === 'monthly'
                  ? (agent.spendLimitMonthlyUsd || (agent.spendLimitUsd ? agent.spendLimitUsd * 30 : 0))
                  : (agent.spendLimitUsd || 0);

                const headroom = Math.max(0, currentLimit - currentSpend);
                const isEditing = editingAgentId === agent.id;

                const hasMonthly = Boolean(agent.spendLimitMonthlyUsd && agent.spendLimitMonthlyUsd > 0);
                const hasDaily = Boolean(agent.spendLimitUsd && agent.spendLimitUsd > 0);

                return (
                  <tr key={agent.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900 dark:text-white">{agent.name}</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{agent.id}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                      {agent.domain || 'Submind Autonomous Operations'}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-700 dark:text-slate-300">{agent.model}</td>
                    <td className="py-3 px-4 font-semibold text-slate-800 dark:text-slate-200">
                      ${currentSpend.toFixed(2)}
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 font-normal">
                        {viewPeriod === 'monthly' ? 'month-to-date' : 'past 24h'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {isEditing ? (
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1.5">
                          <div className="flex items-center space-x-1">
                            <span className="text-slate-400">$</span>
                            <input
                              type="number"
                              min="1"
                              value={newBudgetLimit}
                              onChange={(e) => setNewBudgetLimit(Number(e.target.value))}
                              className="w-16 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-2 py-0.5 text-xs text-slate-900 dark:text-white"
                            />
                            <select
                              value={editingPeriod}
                              onChange={(e) => setEditingPeriod(e.target.value as 'daily' | 'monthly')}
                              className="bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-900 dark:text-white cursor-pointer"
                            >
                              <option value="monthly">/ month</option>
                              <option value="daily">/ day</option>
                            </select>
                          </div>
                          <div className="flex items-center space-x-1">
                            <button
                              onClick={() => handleUpdateBudget(agent.id)}
                              disabled={isUpdating}
                              className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-semibold transition"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingAgentId(null)}
                              className="px-1 text-slate-400 hover:text-slate-700 dark:hover:text-white text-[10px]"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          <div className="flex items-center space-x-2">
                            {hasMonthly ? (
                              <span className="font-semibold text-slate-900 dark:text-slate-100">
                                ${agent.spendLimitMonthlyUsd?.toFixed(2)}/mo
                              </span>
                            ) : hasDaily ? (
                              <span className="font-semibold text-slate-900 dark:text-slate-100">
                                ${agent.spendLimitUsd?.toFixed(2)}/day
                              </span>
                            ) : (
                              <span className="text-slate-400 italic">No budget set</span>
                            )}
                            {permissions.canSetBudget && (
                              <button
                                onClick={() => {
                                  setEditingAgentId(agent.id);
                                  setEditingPeriod(hasMonthly ? 'monthly' : 'daily');
                                  setNewBudgetLimit(agent.spendLimitMonthlyUsd || agent.spendLimitUsd || 100);
                                }}
                                className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:underline font-semibold"
                              >
                                Edit
                              </button>
                            )}
                          </div>
                          {hasMonthly && hasDaily && (
                            <div className="text-[10px] text-slate-400 dark:text-slate-500">
                              also: ${agent.spendLimitUsd?.toFixed(2)}/day cap
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        ${headroom.toFixed(2)}
                      </span>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500">
                        remaining
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleIsolate(agent)}
                        disabled={!permissions.canQuarantine}
                        className="px-2.5 py-1 bg-red-100 hover:bg-red-200 dark:bg-red-950/80 dark:hover:bg-red-900 disabled:opacity-40 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800/80 rounded font-semibold text-[10px] flex items-center space-x-1 inline-flex transition"
                        title="Emergency Quarantine: Cut all outbound egress"
                      >
                        <ShieldAlert className="w-3 h-3 text-red-500 dark:text-red-400" />
                        <span>Quarantine</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
