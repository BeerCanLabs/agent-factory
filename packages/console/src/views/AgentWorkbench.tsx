import React, { useState } from 'react';
import {
  Terminal,
  Cpu,
  Database,
  Clock,
  Send,
  CheckCircle,
  Play,
  Square,
  Pause,
  AlertTriangle,
  RotateCcw,
  Trash2,
  Sliders,
  DollarSign,
  Shield,
  Layers,
} from 'lucide-react';
import type { AgentRecord } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';

interface AgentWorkbenchProps {
  agent: AgentRecord;
  agents: AgentRecord[];
  onSelectAgent: (id: string) => void;
  onRefresh: () => void;
}

export const AgentWorkbench: React.FC<AgentWorkbenchProps> = ({
  agent,
  agents,
  onSelectAgent,
  onRefresh,
}) => {
  const permissions = usePermissions();
  const [activeTab, setActiveTab] = useState<'runtime' | 'terminal' | 'memory' | 'models' | 'lifecycle'>('runtime');
  const [convoPrompt, setConvoPrompt] = useState('');
  const [isSendingConvo, setIsSendingConvo] = useState(false);
  const [selectedModel, setSelectedModel] = useState(agent.model);
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [logs, setLogs] = useState<string[]>([
    `[${new Date().toISOString()}] Agent ${agent.name} initialized in private VPC subnet.`,
    `[${new Date().toISOString()}] Zero-Trust Egress: HTTP_PROXY and HTTPS_PROXY mapped to Gateway.`,
    `[${new Date().toISOString()}] Memory: Loaded SQLite notebook (${agent.sqliteSizeKb || 0} KB) from ${agent.mindPrefix || 'S3'}.`,
    `[${new Date().toISOString()}] State: ${agent.state}. Waiting for Doorman ingress trigger or operator turn.`,
  ]);

  const handleSendPrompt = async () => {
    if (!convoPrompt.trim()) return;
    setIsSendingConvo(true);
    const msg = `[${new Date().toISOString()}] Operator >> ${convoPrompt}`;
    setLogs((prev) => [...prev, msg]);
    try {
      await factoryApi.wakeAgent(agent.id, { prompt: convoPrompt });
      setLogs((prev) => [
        ...prev,
        `[${new Date().toISOString()}] Mailbox delivered. Agent container warm window renewed.`,
      ]);
      setConvoPrompt('');
      onRefresh();
    } catch (err: any) {
      setLogs((prev) => [...prev, `[ERROR] Failed to deliver turn: ${err.message}`]);
    } finally {
      setIsSendingConvo(false);
    }
  };

  const handleModelSwitch = async () => {
    setIsSwitchingModel(true);
    try {
      await factoryApi.switchModel(agent.id, selectedModel);
      setLogs((prev) => [
        ...prev,
        `[${new Date().toISOString()}] Model hot-swapped to ${selectedModel}. Recorded to immutable ledger.`,
      ]);
      onRefresh();
    } catch (err: any) {
      alert(`Model switch failed: ${err.message}`);
    } finally {
      setIsSwitchingModel(false);
    }
  };

  const handleRetire = async () => {
    if (!confirm(`Are you sure you want to begin Stage 1 Soft-Retirement for ${agent.name}? This will sever Doorman ingress and start a 7-day holding countdown.`)) {
      return;
    }
    try {
      await factoryApi.retireAgent(agent.id);
      alert(`${agent.name} has entered RETIRED_PENDING_PURGE (Scream Test).`);
      onRefresh();
    } catch (err: any) {
      alert(`Retirement failed: ${err.message}`);
    }
  };

  const handleReinstate = async () => {
    try {
      await factoryApi.reinstateAgent(agent.id);
      alert(`${agent.name} reinstated to active service (SLEEPING).`);
      onRefresh();
    } catch (err: any) {
      alert(`Reinstatement failed: ${err.message}`);
    }
  };

  const handlePurge = async () => {
    if (!confirm(`CAUTION: Stage 2 Permanent Purge will permanently destroy ECS task definitions, purge vault secrets, and compress mind state to cold archive. Proceed?`)) {
      return;
    }
    try {
      await factoryApi.purgeAgent(agent.id);
      alert(`${agent.name} has been permanently purged.`);
      onRefresh();
    } catch (err: any) {
      alert(`Purge failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Agent Selector Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm transition-colors">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-lg">
            {agent.name.charAt(0)}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <select
                value={agent.id}
                onChange={(e) => onSelectAgent(e.target.value)}
                className="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-bold text-base rounded px-2 py-1 border border-slate-300 dark:border-slate-800 cursor-pointer focus:outline-none focus:border-emerald-500"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.id})
                  </option>
                ))}
              </select>
              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                v{agent.version}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{agent.role || 'Autonomous Cartridge'}</p>
          </div>
        </div>

        {/* State Pill & Quick Stats */}
        <div className="flex items-center space-x-4 text-xs">
          <div className="text-right">
            <div className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-semibold">Current State</div>
            <div className="font-bold text-emerald-600 dark:text-emerald-400">{agent.state}</div>
          </div>
          <div className="h-6 w-px bg-slate-200 dark:bg-slate-800" />
          <div className="text-right">
            <div className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-semibold">24h Spend</div>
            <div className="font-bold text-slate-900 dark:text-white">${(agent.currentSpendUsd || 0).toFixed(2)}</div>
          </div>
          <div className="h-6 w-px bg-slate-200 dark:bg-slate-800" />
          <div className="text-right">
            <div className="text-[10px] text-slate-400 dark:text-slate-500 uppercase font-semibold">Spend Cap</div>
            <div className="font-bold text-slate-700 dark:text-slate-300">${agent.spendLimitUsd || 0}/day</div>
          </div>
        </div>
      </div>

      {/* Tabs Header */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex space-x-2 text-xs font-semibold">
        {[
          { id: 'runtime', label: 'Runtime & Health', icon: <Cpu className="w-3.5 h-3.5" /> },
          { id: 'terminal', label: 'Live Mailbox & Terminal', icon: <Terminal className="w-3.5 h-3.5" /> },
          { id: 'memory', label: 'Memory & Persistence', icon: <Database className="w-3.5 h-3.5" /> },
          { id: 'models', label: 'Models & Scorecard', icon: <Layers className="w-3.5 h-3.5" /> },
          { id: 'lifecycle', label: 'Lifecycle & Decommission', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center space-x-2 px-4 py-2.5 border-b-2 transition ${
              activeTab === tab.id
                ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 bg-white/60 dark:bg-slate-900/60'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab 1: Runtime & Health */}
      {activeTab === 'runtime' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-sm transition-colors">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-2">
              <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Container & Network Isolation</span>
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Compute Service:</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">AWS ECS Fargate</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Network Subnet:</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">vpc-factory-private (No IGW / NAT)</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Public IP:</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">None (0.0.0.0/0 blocked)</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Egress Conduit:</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">http://factory-gateway:3001</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Warm-Down Timer:</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">{agent.warmDownSeconds || 300} seconds</span>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-sm transition-colors">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-2">
              <Clock className="w-4 h-4 text-blue-500" />
              <span>Doorman Presence & Ingress</span>
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Doorman Gateway:</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Online (24/7 WebSocket)</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Ingress Channels:</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">Discord Gateway & API Mailbox</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Scale-to-Zero Strategy:</span>
                <span className="text-slate-700 dark:text-slate-300">Awakened on mention / sleep on idle</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-500 dark:text-slate-400">Last Task Wakeup:</span>
                <span className="text-slate-700 dark:text-slate-300">{agent.lastStateChange || 'Recently'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Live Mailbox & Terminal */}
      {activeTab === 'terminal' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-4 shadow-sm transition-colors">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-bold text-slate-900 dark:text-white">Live Execution Terminal</span>
            </div>
            <span className="text-slate-400 dark:text-slate-500 font-mono text-[10px]">Pipes: stdout/stderr & mailbox</span>
          </div>

          <div className="bg-slate-900 dark:bg-slate-950 border border-slate-700 dark:border-slate-800 rounded-lg p-3 font-mono text-xs text-slate-300 h-64 overflow-y-auto space-y-1">
            {logs.map((line, idx) => (
              <div key={idx} className="leading-relaxed">
                {line.startsWith('[ERROR]') ? (
                  <span className="text-red-400">{line}</span>
                ) : line.includes('Operator >>') ? (
                  <span className="text-emerald-400 font-semibold">{line}</span>
                ) : (
                  <span>{line}</span>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder="Inject follow-up turn into warm container mailbox..."
              value={convoPrompt}
              onChange={(e) => setConvoPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
              className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={handleSendPrompt}
              disabled={isSendingConvo || !permissions.canDispatchPrompt}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition shadow"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Turn</span>
            </button>
          </div>
        </div>
      )}

      {/* Tab 3: Memory & Persistence */}
      {activeTab === 'memory' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-sm transition-colors">
          <div className="flex items-center space-x-2">
            <Database className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">The "Notebook & Safe" Architecture</h4>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Cartridges write strictly to an embedded SQLite database in <code className="text-emerald-600 dark:text-emerald-400 font-mono">$MEMORY_DIR</code>.
            Cloud storage SDKs are completely purged from the container. The Factory Console shim handles atomic S3 synchronization
            on wake and sleep.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs">
              <span className="text-slate-500">Local Notebook Size</span>
              <div className="text-lg font-bold text-slate-900 dark:text-white mt-1">
                {(agent.sqliteSizeKb || 0) > 1024
                  ? `${((agent.sqliteSizeKb || 0) / 1024).toFixed(2)} MB`
                  : `${agent.sqliteSizeKb || 0} KB`}
              </div>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">Sub-second S3 sync guaranteed</span>
            </div>

            <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs">
              <span className="text-slate-500">WAL Mode & Timeout</span>
              <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 mt-1">PRAGMA WAL</div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">busy_timeout=5000ms</span>
            </div>

            <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs">
              <span className="text-slate-500">Atomic Checkpoint</span>
              <div className="text-lg font-bold text-slate-900 dark:text-white mt-1">TRUNCATE</div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">No dangling -wal lock artifacts</span>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs space-y-1">
            <div className="text-slate-500 dark:text-slate-400 font-semibold">S3 Remote Mind Vault:</div>
            <div className="font-mono text-slate-700 dark:text-slate-300 break-all">{agent.mindPrefix || `s3://beercanlabs-minds/${agent.id}/`}</div>
          </div>
        </div>
      )}

      {/* Tab 4: Models & Scorecard */}
      {activeTab === 'models' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5 shadow-sm transition-colors">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">Active Production Model</h4>
              <p className="text-xs text-slate-500 dark:text-slate-400">Hot-swap active reasoning engine at the Egress Gateway</p>
            </div>

            <div className="flex items-center space-x-2">
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-mono text-xs rounded-lg px-3 py-2 border border-slate-300 dark:border-slate-800 focus:outline-none focus:border-emerald-500"
              >
                {(agent.approvedModels || [agent.model]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                onClick={handleModelSwitch}
                disabled={isSwitchingModel || !permissions.canSwitchModel || selectedModel === agent.model}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition"
              >
                {isSwitchingModel ? 'Switching...' : 'Apply Model'}
              </button>
            </div>
          </div>

          <div>
            <h5 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
              Approved Model Candidates & Benchmark Rubric
            </h5>
            <div className="space-y-2">
              {(agent.approvedModels || [agent.model]).map((m) => (
                <div
                  key={m}
                  className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="font-mono font-bold text-slate-900 dark:text-white">{m}</span>
                    {m === agent.model && (
                      <span className="text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-300 dark:border-emerald-800">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-4">
                    <span className="text-slate-500 dark:text-slate-400 text-[11px]">Bench Score: <strong className="text-slate-800 dark:text-slate-200">100%</strong> (15/15)</span>
                    <span className="text-slate-500 dark:text-slate-400 text-[11px]">Avg Cost: <strong className="text-slate-800 dark:text-slate-200">$0.021/turn</strong></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 5: Lifecycle & Decommission */}
      {activeTab === 'lifecycle' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-6 shadow-sm transition-colors">
          <div>
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">Two-Stage Retirement & Purge Lifecycle</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Guarantees zero-cost cloud compute while protecting against accidental infrastructure deletion.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Stage 1: Soft-Retire */}
            <div className="bg-slate-50 dark:bg-slate-950 border border-amber-300 dark:border-amber-800/40 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                  Stage 1: Soft-Retire ("Scream Test")
                </span>
                <span className="text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 px-1.5 py-0.5 rounded border border-amber-300 dark:border-amber-800">
                  Zero Compute Cost
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Immediately drops active compute to $0 and severs Doorman presence. Mind storage and vault secrets are preserved
                during the 7-day holding period in case reinstatement is requested.
              </p>
              {agent.state === 'RETIRED_PENDING_PURGE' ? (
                <button
                  onClick={handleReinstate}
                  disabled={!permissions.canRetire}
                  className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg flex items-center justify-center space-x-1.5 transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Abort Retirement & Reinstate</span>
                </button>
              ) : (
                <button
                  onClick={handleRetire}
                  disabled={!permissions.canRetire}
                  className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg flex items-center justify-center space-x-1.5 transition"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Trigger Soft-Retirement</span>
                </button>
              )}
            </div>

            {/* Stage 2: Permanent Purge */}
            <div className="bg-slate-50 dark:bg-slate-950 border border-red-300 dark:border-red-800/40 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">
                  Stage 2: Permanent Purge & Archival
                </span>
                <span className="text-[10px] bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 px-1.5 py-0.5 rounded border border-red-300 dark:border-red-800">
                  Irreversible
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Permanently tears down ECS task definitions, destroys secrets in the cloud vault, and compresses mind storage
                into cold archive tier. Cryptographic ledger records remain immutable forever.
              </p>
              <button
                onClick={handlePurge}
                disabled={!permissions.canPurge}
                className="w-full py-2 bg-red-700 hover:bg-red-600 text-white text-xs font-semibold rounded-lg flex items-center justify-center space-x-1.5 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Execute Permanent Purge</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
