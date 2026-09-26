import React, { useState } from 'react';
import { CheckSquare, Check, X, AlertTriangle, Clock, ShieldAlert, FileCode } from 'lucide-react';
import type { ApprovalItem } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';

interface ApprovalsViewProps {
  approvals: ApprovalItem[];
  onRefresh: () => void;
}

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({ approvals, onRefresh }) => {
  const permissions = usePermissions();
  const [selectedApproval, setSelectedApproval] = useState<ApprovalItem | null>(approvals[0] || null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleDecision = async (decision: 'approved' | 'rejected') => {
    if (!selectedApproval) return;
    setIsProcessing(true);
    try {
      await factoryApi.decideApproval(selectedApproval.id, decision, decisionNotes);
      alert(`Approval ${selectedApproval.id} has been ${decision}. Gateway route released.`);
      setDecisionNotes('');
      onRefresh();
    } catch (err: any) {
      alert(`Decision submission failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const getRiskBadge = (risk: string) => {
    switch (risk) {
      case 'HIGH':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400 border border-red-800">
            <ShieldAlert className="w-3 h-3 mr-1" />
            HIGH RISK
          </span>
        );
      case 'MEDIUM':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800">
            <AlertTriangle className="w-3 h-3 mr-1" />
            MEDIUM RISK
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">
            LOW RISK
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <CheckSquare className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            <span>Human-in-the-Loop (HITL) Approvals</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Outbound tool actions held by the Egress Gateway requiring explicit human authorization.
          </p>
        </div>

        <div className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300 dark:border-amber-800">
          {approvals.length} Action{approvals.length === 1 ? '' : 's'} Pending Review
        </div>
      </div>

      {approvals.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center space-y-3 shadow-sm transition-colors">
          <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto text-xl font-bold">
            ✓
          </div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">All Clear! No Pending Approvals</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Autonomous fleet tools are operating within auto-approved route parameters. Any elevated action will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Approval List */}
          <div className="space-y-3">
            {approvals.map((appr) => {
              const isSelected = selectedApproval?.id === appr.id;
              return (
                <div
                  key={appr.id}
                  onClick={() => setSelectedApproval(appr)}
                  className={`p-4 rounded-xl border transition cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500/10 dark:bg-slate-850 border-amber-500 shadow-md'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">{appr.id}</span>
                    {getRiskBadge(appr.risk)}
                  </div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white mb-1 truncate">{appr.tool}</h4>
                  <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>Agent: <strong className="text-slate-700 dark:text-slate-200">{appr.agentId}</strong></span>
                    <span className="flex items-center space-x-1">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(appr.requestedAt).toLocaleTimeString()}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Detailed Review & Decision */}
          {selectedApproval && (
            <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 shadow-sm transition-colors">
              <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-mono text-xs text-amber-600 dark:text-amber-400 font-bold">{selectedApproval.id}</span>
                    {getRiskBadge(selectedApproval.risk)}
                  </div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white mt-1">{selectedApproval.tool}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Target Host: <code className="text-slate-700 dark:text-slate-300 font-mono">{selectedApproval.host || 'External API'}</code>
                  </p>
                </div>
                <div className="text-right text-xs">
                  <div className="text-slate-400 dark:text-slate-500">Originating Run</div>
                  <div className="font-mono text-slate-800 dark:text-slate-200 font-semibold">{selectedApproval.runId}</div>
                </div>
              </div>

              {/* JSON Parameters View */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <span className="flex items-center space-x-1.5">
                    <FileCode className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Payload & Tool Arguments</span>
                  </span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">Read-Only Audit Snapshot</span>
                </div>
                <pre className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs font-mono text-emerald-700 dark:text-emerald-300 overflow-x-auto max-h-56">
                  {JSON.stringify(selectedApproval.input, null, 2)}
                </pre>
              </div>

              {/* Decision Input & Action Buttons */}
              <div className="space-y-3 pt-2">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Decision Audit Notes (Optional Rationale)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g., Verified Stephanie's calendar availability; authorized creation."
                    value={decisionNotes}
                    onChange={(e) => setDecisionNotes(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="flex items-center justify-end space-x-3 pt-2">
                  <button
                    onClick={() => handleDecision('rejected')}
                    disabled={isProcessing || !permissions.canApproveTool}
                    className="px-4 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/60 dark:hover:bg-red-800 disabled:opacity-40 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-700/80 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Reject Action</span>
                  </button>
                  <button
                    onClick={() => handleDecision('approved')}
                    disabled={isProcessing || !permissions.canApproveTool}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-lg shadow-emerald-950/20 transition"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Authorize & Execute</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
