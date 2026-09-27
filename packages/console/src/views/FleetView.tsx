import React, { useState } from 'react';
import {
  Play,
  Square,
  Pause,
  RotateCcw,
  Search,
  ExternalLink,
  Zap,
  Clock,
  DollarSign,
  AlertCircle,
  CheckCircle2,
  Sliders,
  UploadCloud,
} from 'lucide-react';
import type { AgentRecord, AgentState } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';

interface FleetViewProps {
  agents: AgentRecord[];
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
}

export const FleetView: React.FC<FleetViewProps> = ({ agents, onSelectAgent, onRefresh }) => {
  const permissions = usePermissions();
  const [filterCategory, setFilterCategory] = useState<'USER' | 'BUILTIN' | 'ALL'>('USER');
  const [filterState, setFilterState] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [wakeModalAgent, setWakeModalAgent] = useState<AgentRecord | null>(null);
  const [wakePrompt, setWakePrompt] = useState('Process incoming operational turn');
  const [isWaking, setIsWaking] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const userAgents = agents.filter((a) => !a.isBuiltin && a.category !== 'builtin');
  const builtinAgents = agents.filter((a) => Boolean(a.isBuiltin || a.category === 'builtin'));

  const filteredAgents = agents.filter((a) => {
    const isBuiltin = Boolean(a.isBuiltin || a.category === 'builtin');
    const matchesCategory =
      filterCategory === 'ALL' ||
      (filterCategory === 'USER' && !isBuiltin) ||
      (filterCategory === 'BUILTIN' && isBuiltin);
    const matchesState = filterState === 'ALL' || a.state === filterState;
    const matchesSearch =
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (a.role && a.role.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesState && matchesSearch;
  });

  const displayedAgents =
    filterCategory === 'USER' ? userAgents : filterCategory === 'BUILTIN' ? builtinAgents : agents;
  const runningCount = displayedAgents.filter((a) => a.state === 'RUNNING').length;
  const sleepingCount = displayedAgents.filter((a) => a.state === 'SLEEPING').length;
  const totalSpend = displayedAgents.reduce((sum, a) => sum + (a.currentSpendUsd || 0), 0);
  const totalBudget = displayedAgents
    .filter((a) => !a.isBuiltin && a.category !== 'builtin' && !a.budgetExempt)
    .reduce((sum, a) => sum + (a.spendLimitUsd || 0), 0);

  const handleWake = async () => {
    if (!wakeModalAgent) return;
    setIsWaking(true);
    try {
      await factoryApi.wakeAgent(wakeModalAgent.id, { prompt: wakePrompt });
      setActionMessage(`Agent ${wakeModalAgent.name} awakened successfully.`);
      setWakeModalAgent(null);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to wake agent: ${err.message}`);
    } finally {
      setIsWaking(false);
    }
  };

  const handleSleep = async (agent: AgentRecord) => {
    if (!agent.lastRunId) {
      alert('Agent is already cold or has no active run.');
      return;
    }
    try {
      await factoryApi.cancelRun(agent.lastRunId);
      setActionMessage(`Sleep command sent to ${agent.name}.`);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to sleep agent: ${err.message}`);
    }
  };

  const handlePause = async (agent: AgentRecord) => {
    try {
      await factoryApi.pauseAgent(agent.id);
      setActionMessage(`Agent ${agent.name} quarantined/paused.`);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to pause agent: ${err.message}`);
    }
  };

  const handleResume = async (agent: AgentRecord) => {
    try {
      await factoryApi.resumeAgent(agent.id);
      setActionMessage(`Agent ${agent.name} resumed to active service.`);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to resume agent: ${err.message}`);
    }
  };

  const handleDeploy = async (agent: AgentRecord) => {
    try {
      await factoryApi.deployAgent(agent.id);
      setActionMessage(`Deployment triggered for ${agent.name}. Compute identity and task definitions are provisioning.`);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to deploy agent: ${err.message}`);
    }
  };

  const getStateBadge = (state: AgentState) => {
    switch (state) {
      case 'RUNNING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1.5" />
            RUNNING
          </span>
        );
      case 'SLEEPING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mr-1.5" />
            SLEEPING ($0 Compute)
          </span>
        );
      case 'PENDING_DEPLOY':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border border-blue-300 dark:border-blue-800">
            <Clock className="w-3 h-3 mr-1 text-blue-600 dark:text-blue-400" />
            PENDING DEPLOY
          </span>
        );
      case 'DEPLOYING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-800">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping mr-1.5" />
            DEPLOYING...
          </span>
        );
      case 'PENDING_BUDGET':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
            <AlertCircle className="w-3 h-3 mr-1 text-amber-600 dark:text-amber-400" />
            PENDING BUDGET
          </span>
        );
      case 'PAUSED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-950 text-amber-400 border border-amber-800">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5" />
            PAUSED (Quarantine)
          </span>
        );
      case 'RETIRED_PENDING_PURGE':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-950 text-red-400 border border-red-800">
            <AlertCircle className="w-3 h-3 mr-1" />
            SCREAM TEST (Retiring)
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
            {state}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Action Notification */}
      {actionMessage && (
        <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 px-4 py-2.5 rounded-lg flex items-center justify-between text-xs animate-fade-in">
          <div className="flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{actionMessage}</span>
          </div>
          <button onClick={() => setActionMessage(null)} className="text-emerald-400 hover:text-emerald-200">
            ✕
          </button>
        </div>
      )}

      {/* Category Separation Tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <Zap className="w-5 h-5 text-indigo-500" />
            <span>
              {filterCategory === 'USER'
                ? 'Autonomous Subminds'
                : filterCategory === 'BUILTIN'
                ? 'Built-in System Actors'
                : 'All Fleet Cartridges'}
            </span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {filterCategory === 'USER'
              ? 'User-defined submind personas and autonomous operational agents.'
              : filterCategory === 'BUILTIN'
              ? 'Core factory operational actors (Doorman, Keymaster, Doctor, Coach).'
              : 'Complete unified view of all factory subminds and system actors.'}
          </p>
        </div>

        <div className="flex items-center space-x-1.5 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <button
            onClick={() => setFilterCategory('USER')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center space-x-2 ${
              filterCategory === 'USER'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>User Subminds</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                filterCategory === 'USER'
                  ? 'bg-indigo-700 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {userAgents.length}
            </span>
          </button>

          <button
            onClick={() => setFilterCategory('BUILTIN')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center space-x-2 ${
              filterCategory === 'BUILTIN'
                ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>Built-in & System</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                filterCategory === 'BUILTIN'
                  ? 'bg-slate-900 text-slate-300'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {builtinAgents.length}
            </span>
          </button>

          <button
            onClick={() => setFilterCategory('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              filterCategory === 'ALL'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            All ({agents.length})
          </button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm transition-colors">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Fleet Size</span>
            <Zap className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{displayedAgents.length}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {filterCategory === 'USER' ? 'Submind Personas' : filterCategory === 'BUILTIN' ? 'System Utilities' : 'Autonomous Cartridges'}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm transition-colors">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Active Containers</span>
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">{runningCount}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{sleepingCount} Cold / Sleeping</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm transition-colors">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>24h Egress Spend</span>
            <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">${totalSpend.toFixed(2)}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">of ${totalBudget.toFixed(2)} allocated budget</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm transition-colors">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Perimeter Isolation</span>
            <span className="text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-300 dark:border-emerald-800">
              Zero-Trust
            </span>
          </div>
          <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 mt-1">No Public IPs</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">Egress Routed via Gateway Only</div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/70 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 p-3 rounded-xl shadow-sm transition-colors">
        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search fleet by name, role, ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="flex items-center space-x-1.5 self-start sm:self-auto overflow-x-auto w-full sm:w-auto">
          {['ALL', 'RUNNING', 'SLEEPING', 'PAUSED'].map((st) => (
            <button
              key={st}
              onClick={() => setFilterState(st)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                filterState === st
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Fleet Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Agent</th>
                <th className="py-3 px-4">Department</th>
                <th className="py-3 px-4">State</th>
                <th className="py-3 px-4">Active Model</th>
                <th className="py-3 px-4">Spend (24h)</th>
                <th className="py-3 px-4">Persistence</th>
                <th className="py-3 px-4 text-right">Quick Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60">
              {filteredAgents.map((agent) => (
                <tr key={agent.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
                  <td className="py-3 px-4">
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => onSelectAgent(agent.id)}
                        className="text-left font-bold text-slate-900 dark:text-slate-100 hover:text-emerald-600 dark:hover:text-emerald-400 transition flex items-center space-x-1.5"
                      >
                        <span>{agent.name}</span>
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                      </button>
                      {agent.isBuiltin || agent.category === 'builtin' ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700">
                          Built-in
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                          User Submind
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{agent.id}</p>
                  </td>
                  <td className="py-3 px-4 text-slate-700 dark:text-slate-300 font-medium">{agent.domain || 'Core'}</td>
                  <td className="py-3 px-4">{getStateBadge(agent.state)}</td>
                  <td className="py-3 px-4">
                    <span className="font-mono text-[11px] bg-slate-100 dark:bg-slate-950 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
                      {agent.model}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">${(agent.currentSpendUsd || 0).toFixed(2)}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      cap: {agent.isBuiltin || agent.category === 'builtin' || agent.budgetExempt
                        ? 'Exempt'
                        : agent.spendLimitMonthlyUsd
                        ? `$${agent.spendLimitMonthlyUsd}/mo`
                        : `$${agent.spendLimitUsd || 0}/day`}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-[11px] text-slate-700 dark:text-slate-300">
                      SQLite: {(agent.sqliteSizeKb || 0) > 1024 ? `${((agent.sqliteSizeKb || 0) / 1024).toFixed(1)}MB` : `${agent.sqliteSizeKb || 0}KB`}
                    </div>
                    <div className="text-[10px] text-emerald-600 dark:text-emerald-400/80">S3 WAL Checkpointed</div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end space-x-1.5">
                      {agent.state === 'PENDING_DEPLOY' && (
                        <button
                          onClick={() => handleDeploy(agent)}
                          disabled={!permissions.canDeploy}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded font-medium text-xs flex items-center space-x-1 shadow-sm transition"
                          title="Deploy Agent: Provision Cloud Compute & IAM"
                        >
                          <UploadCloud className="w-3.5 h-3.5" />
                          <span>Deploy</span>
                        </button>
                      )}

                      {agent.state === 'DEPLOYING' && (
                        <span className="px-2.5 py-1 bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 rounded font-medium text-xs flex items-center space-x-1 border border-indigo-300 dark:border-indigo-800">
                          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping mr-1" />
                          <span>Deploying</span>
                        </span>
                      )}

                      {agent.state === 'SLEEPING' && (
                        <button
                          onClick={() => setWakeModalAgent(agent)}
                          disabled={!permissions.canWake}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded font-medium text-xs flex items-center space-x-1 shadow-sm transition"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>Wake</span>
                        </button>
                      )}

                      {agent.state === 'RUNNING' && (
                        <button
                          onClick={() => handleSleep(agent)}
                          disabled={!permissions.canSleep}
                          className="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded font-medium text-xs flex items-center space-x-1 border border-slate-300 dark:border-slate-700 transition"
                        >
                          <Square className="w-3 h-3 fill-current text-amber-500 dark:text-amber-400" />
                          <span>Sleep</span>
                        </button>
                      )}

                      {agent.state !== 'PAUSED' ? (
                        <button
                          onClick={() => handlePause(agent)}
                          disabled={!permissions.canPause}
                          title="Quarantine / Pause Agent"
                          className="p-1 text-slate-500 dark:text-slate-400 hover:text-amber-500 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition"
                        >
                          <Pause className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleResume(agent)}
                          disabled={!permissions.canResume}
                          title="Resume Agent"
                          className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium text-xs flex items-center space-x-1 transition"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Resume</span>
                        </button>
                      )}

                      <button
                        onClick={() => onSelectAgent(agent.id)}
                        className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition"
                        title="Open Workbench"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Wake Dispatch Modal */}
      {wakeModalAgent && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-2xl transition-colors">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">Wake Agent: {wakeModalAgent.name}</h3>
              </div>
              <button onClick={() => setWakeModalAgent(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-white">
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400">
              Awakening will initialize the container from cold storage, pull remote mind SQLite notebook from S3,
              and start the warm operational window.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Initial Turn Prompt / Input Payload</label>
              <textarea
                rows={4}
                value={wakePrompt}
                onChange={(e) => setWakePrompt(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg p-3 text-xs text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                onClick={() => setWakeModalAgent(null)}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                onClick={handleWake}
                disabled={isWaking}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold flex items-center space-x-2 shadow-lg transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{isWaking ? 'Awakening...' : 'Confirm Wake'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
