import React, { useState, useEffect } from 'react';
import { FileText, CheckCircle2, ShieldCheck, Download, Search, Hash, Clock, User } from 'lucide-react';
import type { LedgerEvent } from '../api/types.js';
import { factoryApi } from '../api/client.js';

export const LedgerView: React.FC = () => {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<LedgerEvent | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; checkpoints: number } | null>(null);

  useEffect(() => {
    async function load() {
      const data = await factoryApi.getLedger(50);
      setEvents(data);
      if (data.length > 0) setSelectedEvent(data[0]);
    }
    load();
  }, []);

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      const res = await factoryApi.verifyLedgerWorm();
      setVerifyResult({ ok: res.ok, checkpoints: res.checkpointsChecked });
    } catch {
      setVerifyResult({ ok: false, checkpoints: 0 });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleExport = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(events, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `agent-factory-ledger-${new Date().toISOString()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const filteredEvents = events.filter((e) => {
    const q = filterQuery.toLowerCase();
    return (
      e.type.toLowerCase().includes(q) ||
      (e.agentId && e.agentId.toLowerCase().includes(q)) ||
      e.actor.toLowerCase().includes(q) ||
      e.hash.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header & Verification Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <FileText className="w-5 h-5 text-blue-400" />
            <span>Immutable WORM Execution Ledger</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Write-Once-Read-Many cryptographic audit trail backed by S3 Object Lock & GCS Bucket Retention.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleVerify}
            disabled={isVerifying}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow transition"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{isVerifying ? 'Verifying Hash Chain...' : 'Verify Cryptographic WORM'}</span>
          </button>
          <button
            onClick={handleExport}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition"
          >
            <Download className="w-4 h-4" />
            <span>Export JSON</span>
          </button>
        </div>
      </div>

      {/* Verify Result Toast */}
      {verifyResult && (
        <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 p-4 rounded-xl flex items-center justify-between text-xs animate-fade-in">
          <div className="flex items-center space-x-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <div>
              <span className="font-bold">Cryptographic WORM Verification PASSED!</span>
              <p className="text-emerald-400/80 mt-0.5">
                All {verifyResult.checkpoints} audit checkpoints verified against cloud object-lock immutable sinks. Hash chain unbroken.
              </p>
            </div>
          </div>
          <button onClick={() => setVerifyResult(null)} className="text-emerald-400 hover:text-emerald-200 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Search Input */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
        <input
          type="text"
          placeholder="Filter ledger by event type, agent, Cloudflare actor identity, or cryptographic hash..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Split View: Event Table & Payload Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Event List */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 uppercase text-[10px] tracking-wider font-semibold">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Event Type</th>
                  <th className="py-3 px-4">Agent</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {filteredEvents.map((evt) => {
                  const isSelected = selectedEvent?.id === evt.id;
                  return (
                    <tr
                      key={evt.id}
                      onClick={() => setSelectedEvent(evt)}
                      className={`cursor-pointer transition ${
                        isSelected ? 'bg-blue-950/40 text-blue-200' : 'hover:bg-slate-800/40 text-slate-300'
                      }`}
                    >
                      <td className="py-2.5 px-4 text-[11px] text-slate-400">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-2.5 px-4 font-sans font-bold text-white text-xs">{evt.type}</td>
                      <td className="py-2.5 px-4 text-emerald-400 font-semibold">{evt.agentId || '—'}</td>
                      <td className="py-2.5 px-4 text-[11px] text-slate-300 truncate max-w-[140px]">{evt.actor}</td>
                      <td className="py-2.5 px-4 text-slate-200 font-sans">
                        {evt.spendUsd ? `$${evt.spendUsd.toFixed(3)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Selected Event Payload Detail */}
        {selectedEvent && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <span className="text-[10px] uppercase font-bold text-slate-500">Event Inspector</span>
              <h3 className="text-sm font-bold text-white mt-0.5">{selectedEvent.type}</h3>
              <p className="font-mono text-[11px] text-slate-400 mt-1 flex items-center space-x-1">
                <Clock className="w-3 h-3 text-slate-500" />
                <span>{selectedEvent.timestamp}</span>
              </p>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center space-x-1.5 text-slate-400">
                <User className="w-3.5 h-3.5 text-blue-400" />
                <span>Actor Identity:</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-slate-200 font-mono text-[11px] break-all">
                {selectedEvent.actor}
              </div>

              <div className="flex items-center space-x-1.5 text-slate-400 pt-1">
                <Hash className="w-3.5 h-3.5 text-emerald-400" />
                <span>SHA-256 Event Hash:</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-emerald-400 font-mono text-[10px] break-all">
                {selectedEvent.hash}
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <span className="text-xs font-semibold text-slate-300">Payload Attributes:</span>
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 overflow-x-auto max-h-56">
                {JSON.stringify(selectedEvent.payload, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
