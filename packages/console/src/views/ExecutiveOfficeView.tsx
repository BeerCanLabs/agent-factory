import React, { useEffect, useState } from 'react';
import {
  Cpu,
  Sparkles,
  RefreshCw,
  Plus,
  Trash2,
  CheckCircle,
  AlertTriangle,
  Layers,
  ArrowRight,
  DollarSign,
  Search,
} from 'lucide-react';
import { factoryApi } from '../api/client.js';
import type { StoredModel, StagedModel, AiProviderTemplate, ModelsCatalogResponse } from '../api/types.js';
import { OnboardVendorModal } from '../components/OnboardVendorModal.js';

export const ExecutiveOfficeView: React.FC = () => {
  const [catalog, setCatalog] = useState<ModelsCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isOnboardModalOpen, setIsOnboardModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [retiringModel, setRetiringModel] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);

  const loadCatalog = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await factoryApi.getDynamicModelCatalog();
      setCatalog(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCatalog();
  }, []);

  const handleSetDefault = async (name: string) => {
    setSettingDefault(name);
    try {
      await factoryApi.setDefaultModel(name);
      setSuccessMsg(`Set "${name}" as the factory default model.`);
      void loadCatalog();
    } catch (e: any) {
      setError(`Failed to set default model: ${e.message}`);
    } finally {
      setSettingDefault(null);
    }
  };

  const handleRetire = async (name: string) => {
    if (!confirm(`Are you sure you want to retire model "${name}"? It will be removed from all agent policies.`)) {
      return;
    }
    setRetiringModel(name);
    try {
      const res = await factoryApi.deleteModel(name);
      setSuccessMsg(`Model "${name}" retired. Affected agents: ${res.affectedAgents.join(', ') || 'none'}.`);
      void loadCatalog();
    } catch (e: any) {
      setError(`Failed to retire model: ${e.message}`);
    } finally {
      setRetiringModel(null);
    }
  };

  const handleQuickAdmit = async (staged: StagedModel) => {
    try {
      await factoryApi.admitModel({
        name: staged.suggestedFriendlyName || staged.rawId,
        provider: 'openAiCompatible',
        id: staged.rawId,
        vendorId: staged.vendorId,
        price: staged.suggestedPrice ?? { inputPerMTok: 2.0, outputPerMTok: 10.0 },
      });
      setSuccessMsg(`Admitted ${staged.suggestedFriendlyName} to factory model catalog!`);
      void loadCatalog();
    } catch (e: any) {
      setError(`Failed to admit model: ${e.message}`);
    }
  };

  const filteredOffered = (catalog?.models ?? []).filter(
    (m) =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      (m.vendorId ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Office Header Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800 flex items-center justify-center text-purple-600 dark:text-purple-400 shrink-0">
            <Cpu className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 dark:text-white">Office of the Executive</h1>
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 rounded-md">
                §6.9 M1–M4
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-2xl leading-relaxed">
              The Executive orchestrates model discovery and vendor admissions. When you onboard a new AI provider, the Executive polls their endpoint, discovers offered models, and coordinates with the Keymaster and Accountant to admit and price them for agents.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void loadCatalog()}
            disabled={loading}
            className="p-2.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-800/80 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            title="Refresh Catalog"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsOnboardModalOpen(true)}
            className="px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-semibold flex items-center gap-2 shadow-sm transition-colors"
          >
            <Sparkles className="w-4 h-4" /> Onboard AI Provider
          </button>
        </div>
      </div>

      {/* Notifications */}
      {successMsg && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600" /> {successMsg}
          </span>
          <button onClick={() => setSuccessMsg(null)} className="text-emerald-600 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-800 dark:text-rose-300 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" /> {error}
          </span>
          <button onClick={() => setError(null)} className="text-rose-600 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Offered Models Section */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-600" />
              Admitted Model Catalog ({filteredOffered.length})
            </h2>
            <p className="text-xs text-slate-500">
              Models currently available for grant in agent policies via the Factory Model API. Default:{' '}
              <code className="font-mono text-purple-600 dark:text-purple-400 font-semibold">
                {catalog?.default ?? 'claude-haiku-4-5'}
              </code>
            </p>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search offered models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-white w-64"
            />
          </div>
        </div>

        {loading && !catalog ? (
          <div className="p-12 text-center text-xs text-slate-400">Loading factory catalog...</div>
        ) : filteredOffered.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 border border-dashed rounded-xl">
            No models matched your criteria.
          </div>
        ) : (
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                <tr>
                  <th className="p-3">Model Name</th>
                  <th className="p-3">Vendor / Provider</th>
                  <th className="p-3">Upstream Model ID</th>
                  <th className="p-3 text-right">Pricing (per MTok)</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {filteredOffered.map((model) => (
                  <tr key={model.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="p-3">
                      <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                        {model.name}
                        {model.name === catalog?.default && (
                          <span className="px-1.5 py-0.5 text-[9px] bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-semibold rounded">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">Admitted {model.admittedAt ? new Date(model.admittedAt).toLocaleDateString() : 'bootstrap'}</div>
                    </td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        {model.vendorId ?? model.provider}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-slate-600 dark:text-slate-400 text-[11px]">
                      {model.id}
                    </td>
                    <td className="p-3 text-right font-mono text-slate-700 dark:text-slate-300">
                      {model.price ? (
                        <>
                          <div>${model.price.inputPerMTok.toFixed(2)} in</div>
                          <div className="text-[10px] text-slate-400">${model.price.outputPerMTok.toFixed(2)} out</div>
                        </>
                      ) : (
                        <span className="text-slate-400 italic">Unpriced</span>
                      )}
                    </td>
                    <td className="p-3 text-right space-x-2">
                      {model.name !== catalog?.default && (
                        <button
                          onClick={() => void handleSetDefault(model.name)}
                          disabled={settingDefault === model.name}
                          className="px-2.5 py-1 text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/40 rounded transition-colors"
                        >
                          {settingDefault === model.name ? 'Setting...' : 'Set as Default'}
                        </button>
                      )}
                      <button
                        onClick={() => void handleRetire(model.name)}
                        disabled={retiringModel === model.name}
                        className="px-2.5 py-1 text-[11px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded transition-colors"
                      >
                        {retiringModel === model.name ? 'Retiring...' : 'Retire'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Staged / Discovered Models Section */}
      {catalog && catalog.staged && catalog.staged.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                Discovered Models Pending Admission ({catalog.staged.length})
              </h2>
              <p className="text-xs text-slate-500">
                Models fetched from vendor endpoints awaiting formal admission and pricing before agents can request them.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {catalog.staged.map((staged) => (
              <div
                key={`${staged.vendorId}-${staged.rawId}`}
                className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                      {staged.vendorId}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {new Date(staged.discoveredAt).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-semibold text-xs text-slate-900 dark:text-white mt-2">
                    {staged.suggestedFriendlyName}
                  </h3>
                  <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{staged.rawId}</p>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-200/60 dark:border-slate-800/60 text-[10px]">
                  <span className="text-slate-500 font-mono">
                    ${staged.suggestedPrice?.inputPerMTok ?? 2.0} / ${staged.suggestedPrice?.outputPerMTok ?? 10.0}
                  </span>
                  <button
                    onClick={() => void handleQuickAdmit(staged)}
                    className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium flex items-center gap-1 shadow-sm transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Admit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Onboard Vendor Modal */}
      <OnboardVendorModal
        isOpen={isOnboardModalOpen}
        onClose={() => setIsOnboardModalOpen(false)}
        onSuccess={() => {
          setSuccessMsg('Successfully onboarded new AI provider and models!');
          void loadCatalog();
        }}
        templates={catalog?.templates ?? {}}
      />
    </div>
  );
};
