import React, { useState } from 'react';
import { X, RefreshCw, ArrowUpCircle, CheckCircle2, Clock } from 'lucide-react';
import type { AgentRecord } from '../api/types.js';

interface UpdateDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  agents: AgentRecord[];
  onSelectAgentForUpdate: (agent: AgentRecord) => void;
  onCheckUpdate: (agentId: string) => Promise<void>;
}

export const UpdateDrawer: React.FC<UpdateDrawerProps> = ({
  isOpen,
  onClose,
  agents,
  onSelectAgentForUpdate,
  onCheckUpdate,
}) => {
  const [checkingId, setCheckingId] = useState<string | null>(null);

  if (!isOpen) return null;

  const updatesAvailable = agents.filter((a) => a.updateAvailable);
  const upToDate = agents.filter((a) => !a.updateAvailable);

  const handleCheck = async (id: string) => {
    setCheckingId(id);
    try {
      await onCheckUpdate(id);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-950/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="p-1 rounded-md bg-emerald-500/10 text-emerald-500">
                <ArrowUpCircle className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Cartridge Updates</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {updatesAvailable.length} update{updatesAvailable.length === 1 ? '' : 's'} available across fleet
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6 overflow-y-auto flex-1">
            {/* Available Updates */}
            {updatesAvailable.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  Available Updates ({updatesAvailable.length})
                </h3>
                <div className="space-y-2.5">
                  {updatesAvailable.map((agent) => (
                    <div
                      key={agent.id}
                      className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-950/20 space-y-2.5 transition hover:border-emerald-500/50"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-2">
                            <span>{agent.name}</span>
                            {agent.pendingDrain && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30 flex items-center space-x-1">
                                <Clock className="w-2.5 h-2.5" />
                                <span>Drain Pending</span>
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                            v{agent.installedVersion || '0.1.0'} →{' '}
                            <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                              v{agent.offeredVersion}
                            </span>
                          </div>
                        </div>

                        <button
                          onClick={() => onSelectAgentForUpdate(agent)}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-sm transition"
                        >
                          Review & Install
                        </button>
                      </div>

                      {agent.releaseNotes && (
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 font-mono line-clamp-2 bg-white/60 dark:bg-slate-900/60 p-2 rounded border border-slate-200 dark:border-slate-800">
                          {agent.releaseNotes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Up to date agents */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Up to Date ({upToDate.length})
              </h3>
              <div className="space-y-2">
                {upToDate.map((agent) => (
                  <div
                    key={agent.id}
                    className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center space-x-2.5">
                      <CheckCircle2 className="w-4 h-4 text-slate-400" />
                      <div>
                        <div className="font-semibold text-slate-800 dark:text-slate-200">{agent.name}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                          v{agent.installedVersion || '0.1.0'}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleCheck(agent.id)}
                      disabled={checkingId === agent.id}
                      className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition"
                      title="Check for updates on GitHub"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${checkingId === agent.id ? 'animate-spin text-emerald-500' : ''}`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
