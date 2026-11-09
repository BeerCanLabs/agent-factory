import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { factoryApi } from '../api/client.js';
import type {
  NotOfferedSubscriptionVendor,
  StoredModel,
  SubscriptionConnectionView,
  SubscriptionScope,
  SubscriptionSignInStart,
  SubscriptionSpendReport,
  SubscriptionTemplateView,
} from '../api/types.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import {
  canManageFactorySubscriptions,
  canOwnSubscriptions,
  effectivePrincipalOf,
} from '../auth/access-gate.js';
import { modelDisplayLabel } from '../components/models-model.js';
import {
  allowsManualModelEntry,
  attestationCopyForScope,
  canDisconnectConnection,
  canManageConnectionModels,
  canMutateConnection,
  catalogModelsForConnection,
  connectionSpendSummary,
  defaultSubscriptionTabFor,
  discoveryStatusBanner,
  filterConnectionsForTab,
  formatSubscriptionApiError,
  resolveNotOfferedVendors,
  subscriptionSpendTotals,
  subscriptionTabsFor,
  suggestSubscriptionCatalogName,
  validateConnectInput,
  validateDailyTokenCapInput,
  validateSubscriptionModelForm,
  type SubscriptionTab,
} from './subscriptions-model.js';

interface SubscriptionsViewProps {
  onNavigateModels?: () => void;
}

const fmtTokens = (n: number): string => n.toLocaleString();

export const SubscriptionsView: React.FC<SubscriptionsViewProps> = ({ onNavigateModels }) => {
  const { whoami } = useAuth();
  const tabs = subscriptionTabsFor(whoami);
  const [activeTab, setActiveTab] = useState<SubscriptionTab>(() => defaultSubscriptionTabFor(whoami));

  const [connections, setConnections] = useState<SubscriptionConnectionView[]>([]);
  const [templates, setTemplates] = useState<SubscriptionTemplateView[]>([]);
  const [notOffered, setNotOffered] = useState<readonly NotOfferedSubscriptionVendor[]>(() =>
    resolveNotOfferedVendors(undefined),
  );
  const [catalogModels, setCatalogModels] = useState<StoredModel[]>([]);
  const [spend, setSpend] = useState<SubscriptionSpendReport | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Connect / Reconnect device-code flow state
  const [connectOpenForScope, setConnectOpenForScope] = useState<SubscriptionScope | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('openai-subscription');
  const [customConnectName, setCustomConnectName] = useState<string>('');
  const [attested, setAttested] = useState<boolean>(false);
  const [connectSubmitting, setConnectSubmitting] = useState<boolean>(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [activeSignIn, setActiveSignIn] = useState<SubscriptionSignInStart | null>(null);
  const [pollingNow, setPollingNow] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Reconnect confirmation per connection
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [reconnectAttested, setReconnectAttested] = useState<boolean>(false);

  useEffect(() => {
    const valid = tabs.some((t) => t.id === activeTab);
    if (!valid && tabs.length > 0) {
      setActiveTab(defaultSubscriptionTabFor(whoami));
    }
  }, [whoami, tabs, activeTab]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subRes, spendRes, catRes] = await Promise.all([
        factoryApi.listSubscriptions(),
        factoryApi.getSubscriptionSpend().catch(() => null),
        factoryApi.getDynamicModelCatalog().catch(() => null),
      ]);
      setConnections(subRes.connections ?? []);
      const tmpl = subRes.templates ?? [];
      setTemplates(tmpl);
      if (tmpl.length > 0 && !tmpl.some((t) => t.id === selectedTemplateId)) {
        setSelectedTemplateId(tmpl[0].id);
      }
      setNotOffered(resolveNotOfferedVendors(subRes.notOffered));
      if (spendRes) setSpend(spendRes);
      if (catRes?.models) setCatalogModels(catRes.models);
    } catch (err) {
      setError(formatSubscriptionApiError(err));
    } finally {
      setLoading(false);
    }
  }, [selectedTemplateId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, whoami?.onBehalfOf, whoami?.actor]);

  // Poll active device sign-in until connected, expired, or cancelled
  const pollRef = useRef(false);
  const pollSignInOnce = useCallback(
    async (signIn: SubscriptionSignInStart) => {
      if (pollRef.current) return;
      pollRef.current = true;
      setPollingNow(true);
      try {
        const res = await factoryApi.pollSubscriptionSignIn(signIn.signInId);
        if (res.status === 'connected') {
          setActiveSignIn(null);
          setConnectOpenForScope(null);
          setReconnectingId(null);
          setAttested(false);
          setReconnectAttested(false);
          setCustomConnectName('');
          setConnectError(null);
          setNotice(
            res.reconnect
              ? `Reconnected "${res.connection.name}" (${res.connection.scope}).`
              : `Connected "${res.connection.name}" (${res.connection.scope}). Select models below to admit them to the catalog.`,
          );
          await loadAll();
        }
      } catch (err) {
        setActiveSignIn(null);
        setConnectError(formatSubscriptionApiError(err));
      } finally {
        pollRef.current = false;
        setPollingNow(false);
      }
    },
    [loadAll],
  );

  useEffect(() => {
    if (!activeSignIn) return;
    const ms = Math.max(2000, (activeSignIn.intervalSeconds || 5) * 1000);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void pollSignInOnce(activeSignIn);
      }
    }, ms);
    return () => clearInterval(id);
  }, [activeSignIn, pollSignInOnce]);

  const handleStartConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectOpenForScope) return;
    setConnectError(null);
    setNotice(null);
    const check = validateConnectInput({
      templateId: selectedTemplateId,
      subscriberAttested: attested,
      name: customConnectName,
    });
    if (!check.ok) {
      setConnectError(check.error);
      return;
    }
    setConnectSubmitting(true);
    try {
      const res = await factoryApi.startSubscriptionConnect({
        templateId: check.templateId,
        subscriberAttested: true,
        scope: connectOpenForScope,
        ...(check.name ? { name: check.name } : {}),
      });
      setActiveSignIn(res.signIn);
    } catch (err) {
      setConnectError(formatSubscriptionApiError(err));
    } finally {
      setConnectSubmitting(false);
    }
  };

  const handleStartReconnect = async (conn: SubscriptionConnectionView) => {
    if (!reconnectAttested) {
      setConnectError('Please check the subscriber confirmation box before reconnecting.');
      return;
    }
    setConnectError(null);
    setNotice(null);
    setConnectSubmitting(true);
    try {
      const res = await factoryApi.startSubscriptionReconnect(conn.id, true);
      setActiveSignIn(res.signIn);
      setReconnectingId(null);
      setReconnectAttested(false);
    } catch (err) {
      setConnectError(formatSubscriptionApiError(err));
    } finally {
      setConnectSubmitting(false);
    }
  };

  const copyDeviceCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Clipboard API unavailable; code remains selectable on screen.
    }
  };

  const callerPrincipal = effectivePrincipalOf(whoami);
  const visibleConnections = filterConnectionsForTab(connections, activeTab, whoami);
  const canConnectPersonal = canOwnSubscriptions(whoami) && Boolean(callerPrincipal);
  const canConnectFactory = canManageFactorySubscriptions(whoami);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2.5">
            <KeyRound className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
            <span>Subscriptions &amp; BYOM Connections</span>
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Connect vendor plans that explicitly permit third-party agent software (§6.9 M5). Tokens live in the Keymaster vault and are never exposed to agents.
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2.5">
          {onNavigateModels && (
            <button
              type="button"
              onClick={onNavigateModels}
              className="px-3 py-2 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 transition"
            >
              Model Catalog
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="px-3 py-2 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          {activeTab === 'personal' && canOwnSubscriptions(whoami) && (
            <button
              type="button"
              onClick={() => {
                setConnectOpenForScope('personal');
                setConnectError(null);
                setAttested(false);
              }}
              disabled={!callerPrincipal}
              title={
                callerPrincipal
                  ? 'Connect your own subscription ($0 BYOM)'
                  : 'Sign in as a user:<id> principal (or use Act-As) to connect a personal subscription'
              }
              className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              <span>Connect My Subscription</span>
            </button>
          )}

          {(activeTab === 'factory' || activeTab === 'fleet') && canConnectFactory && (
            <button
              type="button"
              onClick={() => {
                setConnectOpenForScope('factory');
                setConnectError(null);
                setAttested(false);
              }}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              <span>Connect Factory Subscription</span>
            </button>
          )}
        </div>
      </div>

      {/* Notices & Errors */}
      {error && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800/80 text-rose-800 dark:text-rose-300 text-xs flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 text-xs flex items-center justify-between gap-2.5"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[11px] underline text-emerald-700 dark:text-emerald-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {connectError && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800/80 text-rose-800 dark:text-rose-300 text-xs flex items-start justify-between gap-2.5"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{connectError}</span>
          </div>
          <button
            type="button"
            onClick={() => setConnectError(null)}
            className="text-[11px] underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Active Device-Code Sign-In Banner */}
      {activeSignIn && (
        <div
          role="region"
          aria-label="Subscription device code sign-in"
          className="bg-indigo-50 dark:bg-indigo-950/40 border-2 border-indigo-400 dark:border-indigo-700 rounded-xl p-5 space-y-4 shadow-sm"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 animate-spin" />
                <h3 className="text-sm font-bold text-indigo-950 dark:text-indigo-200">
                  {activeSignIn.reconnect
                    ? 'Complete Vendor Re-Consent in Your Browser'
                    : activeSignIn.scope === 'personal'
                      ? 'Complete Personal Subscription Sign-In'
                      : 'Complete Factory Subscription Sign-In'}
                </h3>
              </div>
              <p className="text-xs text-indigo-800 dark:text-indigo-300 mt-1">
                Open the vendor verification page below, enter the one-time device code, and approve sign-in. This page will detect completion automatically.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void pollSignInOnce(activeSignIn)}
                disabled={pollingNow}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${pollingNow ? 'animate-spin' : ''}`} />
                <span>Check Now</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSignIn(null)}
                className="px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">One-Time Device Code</div>
                <div className="font-mono text-lg font-bold tracking-widest text-slate-900 dark:text-white mt-0.5">
                  {activeSignIn.userCode}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void copyDeviceCode(activeSignIn.userCode)}
                className="px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copiedCode ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Vendor Verification URL</div>
                <div className="font-mono text-xs text-indigo-700 dark:text-indigo-300 truncate mt-1">
                  {activeSignIn.verificationUrl}
                </div>
              </div>
              <a
                href={activeSignIn.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0"
              >
                <span>Open Vendor Page</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          <p className="text-[11px] text-indigo-700 dark:text-indigo-300">
            Expires at {new Date(activeSignIn.expiresAt).toLocaleTimeString()} · Scope:{' '}
            <span className="font-mono font-semibold">{activeSignIn.scope}</span>
            {activeSignIn.ownerPrincipalId ? (
              <>
                {' '}
                · Owner: <span className="font-mono font-semibold">{activeSignIn.ownerPrincipalId}</span>
              </>
            ) : null}
          </p>
        </div>
      )}

      {/* Connect Subscription Form Panel */}
      {connectOpenForScope && !activeSignIn && (
        <form
          onSubmit={handleStartConnect}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                {connectOpenForScope === 'personal'
                  ? 'Connect Personal Subscription ($0 BYOM)'
                  : 'Connect Shared Factory Subscription'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {connectOpenForScope === 'personal'
                  ? `Stored in your isolated Keymaster vault slice (${callerPrincipal ?? 'user:<id>'}). Usable only on your personal agents at $0 factory budget.`
                  : 'Stored in the shared Keymaster vault slice. Models admitted by Factory Admins are available across the fleet.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConnectOpenForScope(null)}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="sub-template-select" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Permitted Vendor Subscription Template
              </label>
              <select
                id="sub-template-select"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.permission.tiers.join(', ')})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="sub-custom-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Connection Display Name (Optional — auto-named from profile if blank)
              </label>
              <input
                id="sub-custom-name"
                type="text"
                value={customConnectName}
                onChange={(e) => setCustomConnectName(e.target.value)}
                placeholder="e.g. Dale's Grok Subscription"
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Selected Template Permission Details */}
          {(() => {
            const tmpl = templates.find((t) => t.id === selectedTemplateId);
            if (!tmpl) return null;
            return (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
                <div className="font-semibold text-slate-800 dark:text-slate-200">{tmpl.description}</div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    Permitted tiers: <span className="font-mono font-semibold">{tmpl.permission.tiers.join(', ')}</span>
                  </span>
                  <span>
                    Permission checked: <span className="font-mono font-semibold">{tmpl.permission.checkedDate}</span>
                  </span>
                  {tmpl.permission.statementUrls.map((url, idx) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 dark:text-indigo-400 underline inline-flex items-center gap-1"
                    >
                      <span>Vendor Terms {tmpl.permission.statementUrls.length > 1 ? `#${idx + 1}` : ''}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}

          <label className="flex items-start gap-2.5 text-xs text-slate-800 dark:text-slate-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>{attestationCopyForScope(connectOpenForScope)}</span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConnectOpenForScope(null)}
              className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={connectSubmitting || !attested}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
            >
              {connectSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Start Device Sign-In</span>
            </button>
          </div>
        </form>
      )}

      {/* Scope Tabs */}
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Subscription scopes" className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            const count = filterConnectionsForTab(connections, tab.id, whoami).length;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition ${
                  selected
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                    selected
                      ? 'bg-indigo-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Scope Context Helper */}
      {activeTab === 'personal' && !canConnectPersonal && (
        <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/70 text-xs text-amber-900 dark:text-amber-300">
          {!callerPrincipal ? (
            <span>
              You are signed in with a non-user credential (<span className="font-mono">{whoami?.actor}</span>). Sign in via your factory user account (or select a <span className="font-mono">user:&lt;id&gt;</span> in <b>Act-As</b>) to connect or manage personal BYOM subscriptions.
            </span>
          ) : (
            <span>Your current grants do not include personal subscription management (<span className="font-mono">subscriptions.own</span>).</span>
          )}
        </div>
      )}

      {/* Subscription Token Spend Overview */}
      {(() => {
        const totals = subscriptionSpendTotals(spend);
        if (!spend || (totals.dayTokens === 0 && totals.monthTokens === 0 && Object.keys(spend.agents).length === 0)) {
          return null;
        }
        return (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Subscription Tokens Today ({spend.day})</div>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-0.5">
                {fmtTokens(totals.dayTokens)}
              </div>
              <div className="text-[11px] text-slate-500">{totals.dayCalls} calls</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Subscription Tokens Month ({spend.month})</div>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-0.5">
                {fmtTokens(totals.monthTokens)}
              </div>
              <div className="text-[11px] text-slate-500">{totals.monthCalls} calls</div>
            </div>
            <div className="col-span-2">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Top Agents by Subscription Tokens (Month)</div>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {Object.entries(spend.agents)
                  .sort(([, a], [, b]) => b.month.totalTokens - a.month.totalTokens)
                  .slice(0, 5)
                  .map(([agentId, usage]) => (
                    <span
                      key={agentId}
                      className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                    >
                      {agentId}: {fmtTokens(usage.month.totalTokens)} tok
                    </span>
                  ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Connections List */}
      <div className="space-y-4">
        {loading && connections.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-xs text-slate-500">
            Loading subscription connections…
          </div>
        ) : visibleConnections.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-2">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {activeTab === 'personal'
                ? 'No personal BYOM subscriptions connected yet'
                : activeTab === 'factory'
                  ? 'No shared factory subscriptions connected yet'
                  : 'No subscription connections in this factory'}
            </p>
            <p className="text-xs text-slate-500 max-w-lg mx-auto">
              {activeTab === 'personal'
                ? 'Connect your own ChatGPT Plus/Pro or xAI Grok subscription above to add $0 BYOM models for your personal agents.'
                : 'Connect a permitted vendor subscription above, then select discovered models to admit into the catalog.'}
            </p>
          </div>
        ) : (
          visibleConnections.map((conn) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              whoami={whoami}
              catalogModels={catalogModelsForConnection(conn, catalogModels)}
              usage={connectionSpendSummary(conn.id, spend)}
              reconnecting={reconnectingId === conn.id}
              reconnectAttested={reconnectAttested}
              onToggleReconnect={(open) => {
                setReconnectingId(open ? conn.id : null);
                setReconnectAttested(false);
              }}
              onReconnectAttestedChange={setReconnectAttested}
              onConfirmReconnect={() => void handleStartReconnect(conn)}
              onReload={loadAll}
              onNotice={setNotice}
              onError={setError}
            />
          ))
        )}
      </div>

      {/* Vendor Permission Records & Prohibited ("Not Offered") Vendors (M5(2)) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
        {/* Permitted Templates */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Permitted Subscription Templates (§6.9 M5(2), (5))
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Subscription OAuth is allowed only for shipped templates whose vendors explicitly permit third-party agent software.
          </p>
          <div className="space-y-3">
            {templates.map((t) => (
              <div
                key={t.id}
                className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">{t.name}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800">
                    Checked {t.permission.checkedDate}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400">{t.description}</p>
                <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    Tiers: <span className="font-mono text-slate-700 dark:text-slate-300">{t.permission.tiers.join(', ')}</span>
                  </span>
                  {t.permission.statementUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 dark:text-indigo-400 underline inline-flex items-center gap-1"
                    >
                      <span>{new URL(url).hostname}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ))}
                </div>
                {t.instructions && (
                  <details className="pt-1 text-xs">
                    <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-300">
                      Setup instructions ({t.instructions.reviewState === 'approved' ? 'Approved' : t.instructions.label ?? 'Pending human review'})
                    </summary>
                    <p className="mt-1.5 text-[11px] whitespace-pre-line text-slate-600 dark:text-slate-400">
                      {t.instructions.instructions}
                    </p>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Not Offered Vendors (Anthropic & Google — M5(2)) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Ban className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Consumer Subscriptions Not Offered (§6.9 M5(2))
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The following vendors prohibit using consumer subscription credentials in third-party agent software and are blocked by contract schema.
          </p>
          <div className="space-y-3">
            {notOffered.map((v) => (
              <div
                key={v.vendor}
                className="p-3.5 rounded-lg bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/60 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">{v.name}</span>
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border border-rose-300 dark:border-rose-800">
                      Not Offered
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">Checked {v.checkedDate}</span>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{v.reason}</p>
                <div className="flex flex-wrap gap-3 pt-0.5">
                  {v.statementUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-rose-700 dark:text-rose-400 underline inline-flex items-center gap-1"
                    >
                      <span>{url}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const ConnectionCard: React.FC<{
  conn: SubscriptionConnectionView;
  whoami: ReturnType<typeof useAuth>['whoami'];
  catalogModels: StoredModel[];
  usage: ReturnType<typeof connectionSpendSummary>;
  reconnecting: boolean;
  reconnectAttested: boolean;
  onToggleReconnect: (open: boolean) => void;
  onReconnectAttestedChange: (checked: boolean) => void;
  onConfirmReconnect: () => void;
  onReload: () => Promise<void>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}> = ({
  conn,
  whoami,
  catalogModels,
  usage,
  reconnecting,
  reconnectAttested,
  onToggleReconnect,
  onReconnectAttestedChange,
  onConfirmReconnect,
  onReload,
  onNotice,
  onError,
}) => {
  const canMutate = canMutateConnection(conn, whoami);
  const canDisconnect = canDisconnectConnection(conn, whoami);
  const canManageModels = canManageConnectionModels(conn, whoami);
  const manualModelAllowed = allowsManualModelEntry(conn);
  const discBanner = discoveryStatusBanner(conn);

  // Rename state
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(conn.name);
  const [savingName, setSavingName] = useState(false);

  // Daily token cap state
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState(conn.dailyTokenCap !== undefined ? String(conn.dailyTokenCap) : '');
  const [savingCap, setSavingCap] = useState(false);

  // Discovery & model admission state
  const [discovering, setDiscovering] = useState(false);
  const [modelIdInput, setModelIdInput] = useState<string>(() => conn.discoveredModels?.[0]?.id ?? '');
  const [catalogNameInput, setCatalogNameInput] = useState<string>(() =>
    conn.discoveredModels?.[0]?.id ? suggestSubscriptionCatalogName(conn.discoveredModels[0].id, conn) : '',
  );
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [explicitZeroPrice, setExplicitZeroPrice] = useState(true);
  const [addingModel, setAddingModel] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    setNameDraft(conn.name);
  }, [conn.name]);

  useEffect(() => {
    setCapDraft(conn.dailyTokenCap !== undefined ? String(conn.dailyTokenCap) : '');
  }, [conn.dailyTokenCap]);

  const handleSaveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === conn.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await factoryApi.updateSubscription(conn.id, { name: trimmed });
      setEditingName(false);
      onNotice(`Renamed connection to "${trimmed}".`);
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveCap = async () => {
    const check = validateDailyTokenCapInput(capDraft);
    if (!check.ok) {
      onError(check.error);
      return;
    }
    setSavingCap(true);
    try {
      await factoryApi.updateSubscription(conn.id, { dailyTokenCap: check.dailyTokenCap });
      setEditingCap(false);
      onNotice(
        check.dailyTokenCap === null
          ? `Cleared per-agent daily token cap on "${conn.name}".`
          : `Set per-agent daily token cap to ${fmtTokens(check.dailyTokenCap)} tokens/UTC day on "${conn.name}".`,
      );
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
    } finally {
      setSavingCap(false);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const res = await factoryApi.discoverSubscriptionModels(conn.id);
      if (res.models.length > 0 && !modelIdInput) {
        setModelIdInput(res.models[0].id);
        setCatalogNameInput(suggestSubscriptionCatalogName(res.models[0].id, conn));
      }
      const retiredNote =
        res.entriesRetired.length > 0 ? ` Retired dropped entries: ${res.entriesRetired.join(', ')}.` : '';
      onNotice(`Model discovery completed for "${conn.name}".${retiredNote}`);
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
      await onReload();
    } finally {
      setDiscovering(false);
    }
  };

  const handleAddModel = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateSubscriptionModelForm({
      scope: conn.scope,
      name: catalogNameInput,
      modelId: modelIdInput,
      inputPrice,
      outputPrice,
      explicitZeroPrice,
    });
    if (!check.ok) {
      onError(check.error);
      return;
    }
    setAddingModel(true);
    try {
      await factoryApi.addSubscriptionModel(conn.id, {
        name: check.name,
        modelId: check.modelId,
        ...(conn.scope === 'factory' ? { price: check.price } : {}),
      });
      onNotice(`Admitted "${check.name}" (${check.modelId} · ${conn.name}) to catalog.`);
      setCatalogNameInput('');
      if (manualModelAllowed) setModelIdInput('');
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
    } finally {
      setAddingModel(false);
    }
  };

  const handleRetireModel = async (modelName: string) => {
    if (!confirm(`Retire catalog entry "${modelName}" from "${conn.name}"? Agents using it will transition to their fallback model.`)) {
      return;
    }
    try {
      const res = await factoryApi.retireSubscriptionModel(conn.id, modelName);
      onNotice(
        `Retired "${res.retired}".${res.affectedAgents.length ? ` Updated ${res.affectedAgents.length} agent policies.` : ''}`,
      );
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
    }
  };

  const handleDisconnect = async () => {
    if (
      !confirm(
        `Disconnect "${conn.name}"? Its Keymaster grant will be removed and all catalog entries on this connection will be retired.`,
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await factoryApi.disconnectSubscription(conn.id);
      onNotice(
        `Disconnected "${conn.name}" (${res.entriesRetired} catalog entr${res.entriesRetired === 1 ? 'y' : 'ies'} retired).`,
      );
      await onReload();
    } catch (err) {
      onError(formatSubscriptionApiError(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const selectDiscoveredModel = (rawId: string) => {
    setModelIdInput(rawId);
    setCatalogNameInput(suggestSubscriptionCatalogName(rawId, conn));
  };

  return (
    <div
      className={`bg-white dark:bg-slate-900 border rounded-xl p-5 space-y-4 shadow-sm ${
        conn.status === 'needs_reconsent'
          ? 'border-rose-300 dark:border-rose-800/80'
          : conn.limitWindow
            ? 'border-amber-300 dark:border-amber-800/80'
            : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* Top Row: Name, Status, Scope, Actions */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center flex-wrap gap-2">
            {editingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  aria-label="Connection display name"
                  className="bg-slate-50 dark:bg-slate-950 border border-indigo-500 rounded px-2.5 py-1 text-sm font-bold text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveName()}
                  disabled={savingName}
                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-semibold"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingName(false);
                    setNameDraft(conn.name);
                  }}
                  className="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded text-xs text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <span className="text-base font-bold text-slate-900 dark:text-white">{conn.name}</span>
            )}

            {/* Status Badge */}
            {conn.status === 'active' ? (
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800">
                Active
              </span>
            ) : (
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-400 border border-rose-300 dark:border-rose-800">
                Needs Re-consent
              </span>
            )}

            {/* Scope Badge */}
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${
                conn.scope === 'personal'
                  ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800'
                  : 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800'
              }`}
            >
              {conn.scope === 'personal' ? `Personal BYOM · ${conn.ownerPrincipalId ?? 'owner'}` : 'Factory Shared'}
            </span>

            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
              Tier: {conn.tier || 'unknown'}
            </span>
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              ID: <span className="font-mono">{conn.id}</span>
            </span>
            <span>
              Template: <span className="font-mono">{conn.templateId}</span>
            </span>
            {conn.subscriberEmail && (
              <span>
                Subscriber: <span className="font-mono">{conn.subscriberEmail}</span>
              </span>
            )}
            <span>Connected {new Date(conn.connectedAt).toLocaleDateString()}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center flex-wrap gap-2 shrink-0">
          {canMutate && !editingName && (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 transition"
            >
              Rename
            </button>
          )}
          {canMutate && (
            <button
              type="button"
              onClick={() => onToggleReconnect(!reconnecting)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                conn.status === 'needs_reconsent'
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
              }`}
            >
              Reconnect
            </button>
          )}
          {canDisconnect && (
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="px-2.5 py-1.5 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-800/70 text-rose-700 dark:text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Needs Re-consent Warning Banner */}
      {conn.status === 'needs_reconsent' && (
        <div
          role="alert"
          className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-xs text-rose-900 dark:text-rose-200 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
          <div>
            <div className="font-bold">Subscription token refresh was refused — Needs Re-consent</div>
            <p className="mt-0.5 text-rose-800 dark:text-rose-300">
              Gatekeeper skips this connection without retrying refresh until reconnected
              {conn.reconsentReason ? ` (vendor reason: ${conn.reconsentReason})` : ''}. Click <b>Reconnect</b> to sign in again with the same vendor account.
            </p>
          </div>
        </div>
      )}

      {/* Reconnect Attestation Inline Box */}
      {reconnecting && (
        <div className="p-3.5 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-300 dark:border-indigo-800 space-y-2.5">
          <label className="flex items-start gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={reconnectAttested}
              onChange={(e) => onReconnectAttestedChange(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600"
            />
            <span>{attestationCopyForScope(conn.scope)}</span>
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onToggleReconnect(false)}
              className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!reconnectAttested}
              onClick={onConfirmReconnect}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded text-xs font-semibold"
            >
              Start Reconnect Device Code
            </button>
          </div>
        </div>
      )}

      {/* Active Limit Window Banner (M5(7)) */}
      {conn.limitWindow && (
        <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="space-y-0.5">
            <div className="font-bold">
              Active Limit Window ({conn.limitWindow.kind === 'tier-refused' ? 'Plan Tier Refused' : 'Plan Usage Limit'} ·{' '}
              <span className="font-mono">{conn.limitWindow.code}</span>)
            </div>
            <div className="text-amber-800 dark:text-amber-300">
              Opened {new Date(conn.limitWindow.openedAt).toLocaleString()} ·{' '}
              {conn.limitWindow.resetAt ? (
                <>
                  Resets at <b>{new Date(conn.limitWindow.resetAt).toLocaleString()}</b> ({conn.limitWindow.resetAt})
                </>
              ) : (
                <>No vendor reset timestamp reported — probed at most once per hour</>
              )}
              {conn.limitWindow.lastProbeAt ? ` · Last probe: ${new Date(conn.limitWindow.lastProbeAt).toLocaleTimeString()}` : ''}.
              All entries on this connection temporarily fail over without altering agent model selections.
            </div>
          </div>
        </div>
      )}

      {/* Metrics Strip: Daily Token Cap + Subscription Token Usage */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5">
        {/* Daily Token Cap */}
        <div className="space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Per-Agent Daily Token Cap (UTC)
          </div>
          {editingCap ? (
            <div className="flex items-center gap-1.5 pt-0.5">
              <input
                type="text"
                value={capDraft}
                onChange={(e) => setCapDraft(e.target.value)}
                placeholder="Blank = uncapped"
                aria-label="Per-agent daily token cap"
                className="w-36 bg-white dark:bg-slate-900 border border-indigo-500 rounded px-2 py-1 text-xs font-mono text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => void handleSaveCap()}
                disabled={savingCap}
                className="px-2 py-1 bg-emerald-600 text-white rounded text-xs font-semibold"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingCap(false);
                  setCapDraft(conn.dailyTokenCap !== undefined ? String(conn.dailyTokenCap) : '');
                }}
                className="px-2 py-1 bg-slate-200 dark:bg-slate-800 rounded text-xs text-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                {conn.dailyTokenCap !== undefined ? `${fmtTokens(conn.dailyTokenCap)} tok / agent / day` : 'Uncapped'}
              </span>
              {canMutate && (
                <button
                  type="button"
                  onClick={() => setEditingCap(true)}
                  className="text-[11px] text-indigo-600 dark:text-indigo-400 underline font-semibold"
                >
                  Edit
                </button>
              )}
            </div>
          )}
          {conn.activeCaps && conn.activeCaps.length > 0 && (
            <div className="text-[11px] text-amber-700 dark:text-amber-400 pt-0.5">
              Cap reached today:{' '}
              {conn.activeCaps.map((c) => `${c.agentId} (${fmtTokens(c.tokensUsed)}/${fmtTokens(c.dailyTokenCap)}, resets ${c.resetAt})`).join(', ')}
            </div>
          )}
        </div>

        {/* Today Usage */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tokens Used Today (UTC)</div>
          <div className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-0.5">
            {fmtTokens(usage.dayTokens)} tokens
          </div>
          <div className="text-[11px] text-slate-500">{usage.dayCalls} calls today</div>
        </div>

        {/* Month Usage */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tokens Used This Month (UTC)</div>
          <div className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-0.5">
            {fmtTokens(usage.monthTokens)} tokens
          </div>
          <div className="text-[11px] text-slate-500">
            {usage.monthCalls} calls
            {usage.byAgent.length > 0
              ? ` · Agents: ${usage.byAgent.map((a) => `${a.agentId} (${fmtTokens(a.monthTokens)})`).join(', ')}`
              : ''}
          </div>
        </div>
      </div>

      {/* Admitted Catalog Entries on This Connection */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center justify-between">
          <span>Catalog Models Admitted on This Connection ({catalogModels.length})</span>
          {conn.scope === 'personal' && (
            <span className="text-[11px] font-normal text-indigo-600 dark:text-indigo-400">
              Personal BYOM entries are fixed at $0 and visible only on your personal agents
            </span>
          )}
        </div>
        {catalogModels.length === 0 ? (
          <p className="text-xs text-slate-500 italic">
            No catalog entries admitted yet — nothing is added automatically on connect. Select a model below to admit it.
          </p>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
            {catalogModels.map((m) => (
              <div key={m.name} className="px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center flex-wrap gap-2">
                  <span className="font-mono font-bold text-slate-900 dark:text-white">{m.name}</span>
                  <span className="text-slate-600 dark:text-slate-300 font-medium">{modelDisplayLabel(m)}</span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                    Subscription
                  </span>
                  <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                    {conn.scope === 'personal'
                      ? '$0.00 / 1M (BYOM)'
                      : m.price
                        ? `$${m.price.inputPerMTok} in / $${m.price.outputPerMTok} out`
                        : 'Unpriced'}
                  </span>
                </div>
                {canManageModels && (
                  <button
                    type="button"
                    onClick={() => void handleRetireModel(m.name)}
                    className="text-rose-600 dark:text-rose-400 hover:underline text-xs font-semibold shrink-0"
                  >
                    Retire Entry
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Discovery & Add Model Section */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-3.5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div
            className={`text-xs ${
              discBanner.tone === 'warning'
                ? 'text-amber-700 dark:text-amber-400'
                : discBanner.tone === 'ok'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {discBanner.text}
          </div>
          {canMutate && (
            <button
              type="button"
              onClick={() => void handleDiscover()}
              disabled={discovering}
              className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5 shrink-0"
            >
              <Sparkles className={`w-3.5 h-3.5 ${discovering ? 'animate-pulse text-indigo-500' : ''}`} />
              <span>{discovering ? 'Discovering…' : 'Discover Models'}</span>
            </button>
          )}
        </div>

        {/* Discovered Models Chips */}
        {conn.discoveredModels && conn.discoveredModels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {conn.discoveredModels.map((dm) => {
              const selected = modelIdInput === dm.id;
              return (
                <button
                  key={dm.id}
                  type="button"
                  onClick={() => selectDiscoveredModel(dm.id)}
                  className={`px-2.5 py-1 rounded text-xs font-mono border transition ${
                    selected
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:border-indigo-400'
                  }`}
                >
                  {dm.id}
                  {dm.displayName && dm.displayName !== dm.id ? ` (${dm.displayName})` : ''}
                </button>
              );
            })}
          </div>
        )}

        {/* Add Subscription Catalog Entry Form */}
        {canManageModels && (
          <form onSubmit={handleAddModel} className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5 space-y-3">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              {conn.scope === 'personal'
                ? 'Add $0 Personal BYOM Model Entry'
                : 'Admit Factory Subscription Model Entry'}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Vendor Model ID {manualModelAllowed ? '(manual entry allowed)' : '(from discovered list)'}
                </label>
                {!manualModelAllowed && conn.discoveredModels ? (
                  <select
                    value={modelIdInput}
                    onChange={(e) => selectDiscoveredModel(e.target.value)}
                    aria-label="Discovered vendor model ID"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-white"
                  >
                    <option value="">Select model…</option>
                    {conn.discoveredModels.map((dm) => (
                      <option key={dm.id} value={dm.id}>
                        {dm.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={modelIdInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setModelIdInput(v);
                      if (!catalogNameInput) {
                        setCatalogNameInput(suggestSubscriptionCatalogName(v, conn));
                      }
                    }}
                    placeholder="e.g. grok-4.6 or gpt-5-codex"
                    aria-label="Vendor model ID"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-white"
                  />
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Unique Factory Catalog Name
                </label>
                <input
                  type="text"
                  value={catalogNameInput}
                  onChange={(e) => setCatalogNameInput(e.target.value)}
                  placeholder="e.g. grok-4.6-dale"
                  aria-label="Unique factory catalog name"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Catalog Pricing (§6.9 M5(1))
                </label>
                {conn.scope === 'personal' ? (
                  <div className="px-2.5 py-1.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs font-mono text-emerald-800 dark:text-emerald-300">
                    Fixed $0.00 / 1M (Owner BYOM)
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={explicitZeroPrice}
                        onChange={(e) => setExplicitZeroPrice(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Explicit $0 (included in plan)</span>
                    </label>
                    {!explicitZeroPrice && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={inputPrice}
                          onChange={(e) => setInputPrice(e.target.value)}
                          placeholder="In $/1M"
                          aria-label="Input USD per 1M tokens"
                          className="w-24 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono"
                        />
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          value={outputPrice}
                          onChange={(e) => setOutputPrice(e.target.value)}
                          placeholder="Out $/1M"
                          aria-label="Output USD per 1M tokens"
                          className="w-24 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={addingModel || !modelIdInput.trim() || !catalogNameInput.trim()}
                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                {addingModel ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                <span>{conn.scope === 'personal' ? 'Add $0 BYOM Model' : 'Admit Subscription Model'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
