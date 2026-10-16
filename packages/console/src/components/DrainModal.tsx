import React, { useState } from 'react';
import { ArrowRight, AlertTriangle, Clock, Zap, CheckCircle2, X } from 'lucide-react';
import type { AgentRecord } from '../api/types.js';
import { factoryApi } from '../api/client.js';

interface DrainModalProps {
  agent: AgentRecord;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const DrainModal: React.FC<DrainModalProps> = ({ agent, isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<'drain' | 'restart_now'>('drain');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isWorking = agent.state === 'WORKING';
  const currentVersion = agent.installedVersion || '0.1.0';
  const newVersion = agent.offeredVersion || 'latest';

  const handleInstall = async () => {
    setLoading(true);
    setError(null);
    try {
      await factoryApi.installAgentUpdate(agent.id, {
        mode: isWorking ? mode : 'restart_now',
        version: agent.offeredVersion,
        commit: agent.offeredCommit,
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to install update');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 font-bold">🚀</span>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">Install Agent Update</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Cartridge: {agent.name} ({agent.id})</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Version comparison */}
          <div className="flex items-center justify-between p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Installed</span>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-300">v{currentVersion}</div>
            </div>
            <ArrowRight className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-500">Target</span>
              <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">v{newVersion}</div>
            </div>
          </div>

          {/* Release Notes */}
          {agent.releaseNotes && (
            <div>
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                Release Notes
              </label>
              <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto">
                {agent.releaseNotes}
              </div>
            </div>
          )}

          {/* Lifecycle & Reboot Strategy */}
          {isWorking ? (
            <div className="space-y-2 pt-2">
              <div className="flex items-center space-x-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4" />
                <span>Agent is currently WORKING on a run</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Choose how you want to apply this update without disrupting active conversations:
              </p>

              <div className="space-y-2 pt-1">
                <label
                  onClick={() => setMode('drain')}
                  className={`flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition ${
                    mode === 'drain'
                      ? 'bg-emerald-500/10 border-emerald-500/50 text-slate-900 dark:text-white'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'drain'}
                    onChange={() => setMode('drain')}
                    className="mt-0.5 text-emerald-500"
                  />
                  <div>
                    <div className="text-xs font-bold flex items-center space-x-1">
                      <Clock className="w-3.5 h-3.5 text-emerald-500" />
                      <span>Apply when current run sleeps (Drain - Recommended)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Stages the new container image immediately. Applies to task definition as soon as the active turn finishes and sleeps cleanly. Zero message interruption.
                    </p>
                  </div>
                </label>

                <label
                  onClick={() => setMode('restart_now')}
                  className={`flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition ${
                    mode === 'restart_now'
                      ? 'bg-amber-500/10 border-amber-500/50 text-slate-900 dark:text-white'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'restart_now'}
                    onChange={() => setMode('restart_now')}
                    className="mt-0.5 text-amber-500"
                  />
                  <div>
                    <div className="text-xs font-bold flex items-center space-x-1">
                      <Zap className="w-3.5 h-3.5 text-amber-500" />
                      <span>Restart Now (Force Interrupt)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Terminates the active container process immediately and applies the new version. Current turn may be aborted.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          ) : (
            <div className="flex items-center space-x-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              <span>
                Agent is currently <strong>SLEEPING</strong>. The update will be applied immediately with zero downtime for the next wake.
              </span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end space-x-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-lg transition"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={loading}
            className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-sm transition flex items-center space-x-1.5 disabled:opacity-50"
          >
            {loading ? 'Installing...' : isWorking && mode === 'drain' ? 'Stage Drain Update' : 'Apply & Restart'}
          </button>
        </div>
      </div>
    </div>
  );
};
