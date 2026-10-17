import React, { useState } from 'react';
import {
  Sparkles,
  KeyRound,
  CheckCircle,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  X,
  Server,
  DollarSign,
  Cpu,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { factoryApi } from '../api/client.js';
import type { StagedModel, AiProviderTemplate } from '../api/types.js';

interface OnboardVendorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  templates: Record<string, AiProviderTemplate>;
}

export const OnboardVendorModal: React.FC<OnboardVendorModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  templates,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [vendorId, setVendorId] = useState('openai');
  const [customName, setCustomName] = useState('');
  const [customUpstream, setCustomUpstream] = useState('');
  const [customAdapter, setCustomAdapter] = useState('openAiCompatible');

  const [apiKey, setApiKey] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [stagedModels, setStagedModels] = useState<StagedModel[]>([]);
  const [selectedRawIds, setSelectedRawIds] = useState<Set<string>>(new Set());
  const [admittingPrices, setAdmittingPrices] = useState<Record<string, { input: number; output: number }>>({});

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const currentTemplate = templates[vendorId];
  const isCustom = vendorId === 'custom';
  const customId = customName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'custom-provider';
  const systemId = isCustom ? customId : vendorId;
  const heldSecret = currentTemplate?.heldSecret || `${systemId.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  const handleStep1Next = async () => {
    setError(null);
    if (isCustom) {
      if (!customName.trim() || !customUpstream.trim()) {
        setError('Please provide a name and upstream URL for custom endpoint');
        return;
      }
      try {
        const u = new URL(customUpstream.trim());
        if (u.protocol !== 'https:') {
          setError('Upstream base URL must start with https://');
          return;
        }
      } catch {
        setError('Upstream base URL must be a valid URL (e.g. https://api.deepseek.com)');
        return;
      }
      try {
        const proposed = await factoryApi.proposeSystem({
          id: customId,
          name: customName.trim(),
          kind: 'ai-provider',
          upstream: customUpstream.trim(),
          aiProvider: {
            adapter: 'openAiCompatible',
            discoveryPath: '/v1/models',
          },
          credential: { secret: heldSecret, header: 'authorization', format: 'Bearer {}' },
        });
        await factoryApi.approveSystem(customId, proposed.system.version, 'Custom AI provider admitted via Console');
      } catch (e: any) {
        setError(`Failed to register vendor: ${e.message}`);
        return;
      }
    }
    setStep(2);
  };

  const handleStep2Next = async () => {
    setError(null);
    if (!apiKey.trim()) {
      setError('An API key or bearer token is required to authenticate with the vendor');
      return;
    }
    try {
      await factoryApi.submitPlatformCredential(heldSecret, apiKey.trim());
    } catch (e: any) {
      setError(`Failed to save credential in Keymaster: ${e.message}`);
      return;
    }
    setStep(3);
    void runDiscovery();
  };

  const runDiscovery = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const res = await factoryApi.scanVendorModels({
        vendorId: isCustom ? customId : vendorId,
      });
      setStagedModels(res.staged);
      // Pre-select top recommended models
      const initialSelected = new Set(res.staged.slice(0, 5).map((m) => m.rawId));
      setSelectedRawIds(initialSelected);

      // Initialize pricing
      const prices: Record<string, { input: number; output: number }> = {};
      for (const m of res.staged) {
        prices[m.rawId] = {
          input: m.suggestedPrice?.inputPerMTok ?? 2.0,
          output: m.suggestedPrice?.outputPerMTok ?? 10.0,
        };
      }
      setAdmittingPrices(prices);
    } catch (e: any) {
      setError(`Discovery scan failed: ${e.message}`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleToggleModel = (rawId: string) => {
    const next = new Set(selectedRawIds);
    if (next.has(rawId)) {
      next.delete(rawId);
    } else {
      next.add(rawId);
    }
    setSelectedRawIds(next);
  };

  const handleStep3Next = () => {
    if (selectedRawIds.size === 0) {
      setError('Please select at least one model to admit to the factory');
      return;
    }
    setError(null);
    setStep(4);
  };

  const handleAdmitAll = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const selected = Array.from(selectedRawIds)
        .map((rawId) => stagedModels.find((m) => m.rawId === rawId))
        .filter(Boolean) as StagedModel[];

      // Disambiguate friendly name collisions across the admitted set
      const usedNames = new Set<string>();

      for (const staged of selected) {
        const rawId = staged.rawId;
        let modelName = staged.suggestedFriendlyName || rawId;
        if (usedNames.has(modelName)) {
          modelName = rawId;
        }
        if (usedNames.has(modelName)) {
          modelName = `${rawId}-${Math.random().toString(36).substring(2, 6)}`;
        }
        usedNames.add(modelName);

        const price = admittingPrices[rawId] ?? { input: 1.0, output: 5.0 };
        const providerKey = currentTemplate?.adapterKey ?? 'openai';

        await factoryApi.admitModel({
          name: modelName,
          provider: providerKey,
          id: rawId,
          vendorId: isCustom ? customId : vendorId,
          endpoint: isCustom ? customUpstream.trim() : undefined,
          price: {
            inputPerMTok: price.input,
            outputPerMTok: price.output,
          },
        });
      }
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(`Model admission failed: ${e.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Onboard AI Provider & Models
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Collaborative onboarding across Registrar, Keymaster, Executive & Accountant
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Progress Tracker */}
        <div className="px-6 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-medium">
          <div className={`flex items-center gap-2 ${step >= 1 ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-400'}`}>
            <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[10px]">1</span>
            <span>Registrar</span>
          </div>
          <div className="h-px w-6 bg-slate-300 dark:bg-slate-700" />
          <div className={`flex items-center gap-2 ${step >= 2 ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-400'}`}>
            <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[10px]">2</span>
            <span>Keymaster</span>
          </div>
          <div className="h-px w-6 bg-slate-300 dark:bg-slate-700" />
          <div className={`flex items-center gap-2 ${step >= 3 ? 'text-purple-600 dark:text-purple-400 font-semibold' : 'text-slate-400'}`}>
            <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[10px]">3</span>
            <span>Executive</span>
          </div>
          <div className="h-px w-6 bg-slate-300 dark:bg-slate-700" />
          <div className={`flex items-center gap-2 ${step >= 4 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-slate-400'}`}>
            <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[10px]">4</span>
            <span>Accountant</span>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-6 flex-1 overflow-y-auto space-y-4">
          {/* STEP 1: REGISTRAR */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="p-4 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/60 dark:border-indigo-800/60 rounded-xl space-y-1">
                <p className="text-xs font-semibold text-indigo-900 dark:text-indigo-300 flex items-center gap-2">
                  <Server className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Office of the Registrar (§6.8 E10)
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Select an AI Model Provider template or register a custom provider endpoint to establish the upstream egress contract.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Provider Vendor
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(templates).map(([key, t]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setVendorId(key)}
                      className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all ${
                        vendorId === key
                          ? 'border-indigo-600 bg-indigo-50/40 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500/20'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <span className="font-semibold text-xs">{t.name}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{t.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {isCustom && (
                <div className="space-y-3 pt-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Display Name</label>
                    <input
                      type="text"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder="e.g. DeepSeek Local vLLM"
                      className="mt-1 w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Upstream Base URL</label>
                    <input
                      type="text"
                      value={customUpstream}
                      onChange={(e) => setCustomUpstream(e.target.value)}
                      placeholder="https://api.deepseek.com"
                      className="mt-1 w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: KEYMASTER */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="p-4 bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/60 rounded-xl space-y-1">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-300 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  Office of the Keymaster (§6.11 K1–K5)
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Provide the API key for <strong className="font-semibold">{currentTemplate?.name || customName || vendorId}</strong>. It will be stored write-only as a gatekeeper-held platform credential (<code className="font-mono text-[10px]">{heldSecret}</code>) and never logged or exposed to agents.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Vendor API Key / Bearer Token
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono"
                  autoFocus
                />
                <p className="text-[10px] text-slate-500">
                  The Keymaster immediately seals this secret and uses it exclusively to authenticate discovery and model completion calls.
                </p>
              </div>
            </div>
          )}

          {/* STEP 3: EXECUTIVE */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="p-4 bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/60 dark:border-purple-800/60 rounded-xl space-y-1">
                <p className="text-xs font-semibold text-purple-900 dark:text-purple-300 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  Office of the Executive (§6.9 M1–M4)
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  The Executive queried the vendor endpoint to discover available models. Select the models you want admitted to the factory catalog.
                </p>
              </div>

              {isScanning ? (
                <div className="p-8 text-center space-y-2">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-purple-600" />
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">Querying vendor models endpoint...</p>
                  <p className="text-[11px] text-slate-500">Connecting to {isCustom ? customUpstream : currentTemplate?.upstream}</p>
                </div>
              ) : stagedModels.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 border border-dashed rounded-xl">
                  No models discovered. Check credentials or refresh the scan.
                  <button
                    onClick={() => void runDiscovery()}
                    className="mt-3 block mx-auto px-3 py-1.5 text-xs bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                  >
                    Retry Discovery Scan
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                    <span>Discovered {stagedModels.length} models</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedRawIds.size === stagedModels.length) {
                          setSelectedRawIds(new Set());
                        } else {
                          setSelectedRawIds(new Set(stagedModels.map((m) => m.rawId)));
                        }
                      }}
                      className="text-purple-600 dark:text-purple-400 hover:underline"
                    >
                      {selectedRawIds.size === stagedModels.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    {stagedModels.map((model) => (
                      <label
                        key={model.rawId}
                        className="p-3 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedRawIds.has(model.rawId)}
                          onChange={() => handleToggleModel(model.rawId)}
                          className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                            {model.suggestedFriendlyName}
                          </p>
                          <p className="text-[10px] text-slate-500 font-mono truncate">{model.rawId}</p>
                        </div>
                        {model.suggestedPrice && (
                          <div className="text-right text-[10px] text-slate-600 dark:text-slate-400">
                            <div>${model.suggestedPrice.inputPerMTok.toFixed(2)}/M in</div>
                            <div>${model.suggestedPrice.outputPerMTok.toFixed(2)}/M out</div>
                          </div>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: ACCOUNTANT */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/60 rounded-xl space-y-1">
                <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  Office of the Accountant (§6.4 FinOps & Token Pricing)
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Review and customize token pricing per million tokens for admitted models. The Accountant enforces these rates during metered egress.
                </p>
              </div>

              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                {Array.from(selectedRawIds).map((rawId) => {
                  const staged = stagedModels.find((m) => m.rawId === rawId);
                  const price = admittingPrices[rawId] ?? { input: 1.0, output: 5.0 };
                  return (
                    <div
                      key={rawId}
                      className="p-3 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-950 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {staged?.suggestedFriendlyName || rawId}
                        </p>
                        <p className="text-[10px] text-slate-500 font-mono truncate">{rawId}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div>
                          <label className="text-[9px] uppercase font-bold text-slate-400 block">Input $/M</label>
                          <input
                            type="number"
                            step="0.01"
                            value={price.input}
                            onChange={(e) =>
                              setAdmittingPrices({
                                ...admittingPrices,
                                [rawId]: { ...price, input: parseFloat(e.target.value) || 0 },
                              })
                            }
                            className="w-20 px-2 py-1 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-right font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] uppercase font-bold text-slate-400 block">Output $/M</label>
                          <input
                            type="number"
                            step="0.01"
                            value={price.output}
                            onChange={(e) =>
                              setAdmittingPrices({
                                ...admittingPrices,
                                [rawId]: { ...price, output: parseFloat(e.target.value) || 0 },
                              })
                            }
                            className="w-20 px-2 py-1 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-right font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="p-4 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((step - 1) as any)}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg flex items-center gap-1.5 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            >
              Cancel
            </button>

            {step === 1 && (
              <button
                type="button"
                onClick={handleStep1Next}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg flex items-center gap-1.5 shadow-sm"
              >
                Proceed to Keymaster <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 2 && (
              <button
                type="button"
                onClick={handleStep2Next}
                className="px-4 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-lg flex items-center gap-1.5 shadow-sm"
              >
                Save & Scan with Executive <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={handleStep3Next}
                disabled={isScanning || selectedRawIds.size === 0}
                className="px-4 py-2 text-xs font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 shadow-sm"
              >
                Set Pricing with Accountant <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={handleAdmitAll}
                disabled={isSubmitting}
                className="px-5 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 shadow-sm"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Admitting Models...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5" /> Admit {selectedRawIds.size} Models
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
