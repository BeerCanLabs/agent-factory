import React, { useState, useEffect } from 'react';
import { AlertOctagon, AlertTriangle, ShieldCheck, Flame, Bug, RefreshCw } from 'lucide-react';
import type { TriageIncident } from '../api/types.js';
import { factoryApi } from '../api/client.js';

export const TriageView: React.FC = () => {
  const [incidents, setIncidents] = useState<TriageIncident[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadIncidents = async () => {
    setIsRefreshing(true);
    try {
      const data = await factoryApi.getTriageIncidents();
      setIncidents(data);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadIncidents();
  }, []);

  const getSeverityBadge = (sev: string) => {
    switch (sev) {
      case 'CRITICAL':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400 border border-red-800">
            CRITICAL
          </span>
        );
      case 'ERROR':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800">
            ERROR
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
            WARNING
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <AlertOctagon className="w-5 h-5 text-red-400" />
            <span>Triage & Unified Fault Center</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Centralized error and crash stream: container OOMs, pre-flight secret validation failures, and egress timeouts.
          </p>
        </div>

        <button
          onClick={loadIncidents}
          disabled={isRefreshing}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
          <span>Refresh Incidents</span>
        </button>
      </div>

      {/* Incident Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-400">Crash-Loop Watchdog</div>
            <div className="text-sm font-bold text-emerald-400">Normal (0 quarantined)</div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-400">Active Faults (24h)</div>
            <div className="text-sm font-bold text-white">{incidents.length} Logged Incidents</div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold">
            <Flame className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-400">Alert Notification Sink</div>
            <div className="text-sm font-bold text-slate-300">AWS EventBridge & SQS</div>
          </div>
        </div>
      </div>

      {/* Incident List */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="p-4 border-b border-slate-800 font-bold text-sm text-white flex items-center space-x-2">
          <Bug className="w-4 h-4 text-slate-400" />
          <span>Incident Stream</span>
        </div>

        <div className="divide-y divide-slate-800/60">
          {incidents.map((inc) => (
            <div key={inc.id} className="p-4 hover:bg-slate-850 transition space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-slate-400 font-bold">{inc.id}</span>
                  {getSeverityBadge(inc.severity)}
                  <span className="font-mono text-emerald-400 font-semibold">{inc.agentId}</span>
                  <span className="text-slate-500 uppercase text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800">
                    {inc.category}
                  </span>
                </div>
                <span className="text-slate-500 font-mono text-[11px]">{new Date(inc.timestamp).toLocaleString()}</span>
              </div>
              <p className="text-xs text-slate-200 leading-relaxed font-mono bg-slate-950 p-2.5 rounded border border-slate-800">
                {inc.message}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
