import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  ExternalLink,
  Lock,
  Globe,
} from 'lucide-react';
import { factoryApi } from '../api/client.js';
import type { SystemSummary, SystemDefinition, SystemStatus } from '../api/types.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import { Dialog } from '../components/Dialog.js';

const STATUS_BADGE: Record<SystemStatus, { label: string; className: string; icon: React.ReactNode }> = {
  approved: {
    label: 'Approved',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  proposed: {
    label: 'Proposed',
    className: 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-rose-50 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
    icon: <XCircle className="w-3 h-3" />,
  },
};

export const SystemsView: React.FC = () => {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');

  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [isProposeOpen, setIsProposeOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Proposal form state
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formKind, setFormKind] = useState<'http' | 'mcp'>('http');
  const [formUpstream, setFormUpstream] = useState('');
  const [credKind, setCredKind] = useState<'none' | 'static' | 'connection'>('none');
  const [secretName, setSecretName] = useState('');
  const [secretHeader, setSecretHeader] = useState('authorization');
  const [secretFormat, setSecretFormat] = useState('Bearer {}');
  const [secretFallback, setSecretFallback] = useState(true);
  const [secretBasic, setSecretBasic] = useState(false);
  const [connectionName, setConnectionName] = useState('');
  const [connectionScopes, setConnectionScopes] = useState('');
  const [holdPost, setHoldPost] = useState(false);
  const [holdPreview, setHoldPreview] = useState('');
  const [stripLinks, setStripLinks] = useState(false);

  // OAuth Provider configuration state (TSK-067)
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [oauthKind, setOauthKind] = useState<'oauth-user' | 'jwt-bearer'>('oauth-user');
  const [oauthAuthUrl, setOauthAuthUrl] = useState('');
  const [oauthTokenUrl, setOauthTokenUrl] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthKeySecret, setOauthKeySecret] = useState('');
  const [oauthRefresh, setOauthRefresh] = useState(true);
  const [oauthDefaultScopes, setOauthDefaultScopes] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const list = await factoryApi.listSystems();
      setSystems(list);
    } catch (err) {
      console.error('Failed to load systems:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openProposeModal = (initial?: SystemSummary) => {
    if (initial) {
      const active = initial.activeDefinition ?? initial.versions[initial.versions.length - 1];
      setFormId(initial.id);
      setFormName(initial.name);
      setFormDesc(initial.description || '');
      setFormKind(initial.kind);
      setFormUpstream(initial.upstream);
      if (active?.connection) {
        setCredKind('connection');
        setConnectionName(active.connection);
        setConnectionScopes((active.scopes || []).join(', '));
      } else if (active?.credential) {
        setCredKind('static');
        setSecretName(active.credential.secret);
        setSecretHeader(active.credential.header);
        setSecretFormat(active.credential.format || 'Bearer {}');
        setSecretFallback(active.credential.fallback ?? true);
        setSecretBasic(active.credential.encoding === 'basic');
      } else {
        setCredKind('none');
      }
      setHoldPost(Boolean(active?.hold?.methods?.includes('POST')));
      setHoldPreview(active?.hold?.preview || '');
      setStripLinks(Boolean(active?.stripSignInLinks));

      if (active?.oauth) {
        setOauthEnabled(true);
        setOauthKind(active.oauth.kind);
        setOauthTokenUrl(active.oauth.tokenUrl);
        setOauthDefaultScopes((active.oauth.defaultScopes || []).join(', '));
        if (active.oauth.kind === 'oauth-user') {
          setOauthAuthUrl(active.oauth.authUrl);
          setOauthClientSecret(active.oauth.clientSecret ?? '');
          setOauthRefresh(active.oauth.refresh !== false);
          setOauthKeySecret('');
        } else {
          setOauthKeySecret(active.oauth.keySecret ?? '');
          setOauthAuthUrl('');
          setOauthClientSecret('');
          setOauthRefresh(true);
        }
      } else {
        setOauthEnabled(false);
        setOauthKind('oauth-user');
        setOauthAuthUrl('');
        setOauthTokenUrl('');
        setOauthClientSecret('');
        setOauthKeySecret('');
        setOauthRefresh(true);
        setOauthDefaultScopes('');
      }
    } else {
      setFormId('');
      setFormName('');
      setFormDesc('');
      setFormKind('http');
      setFormUpstream('');
      setCredKind('none');
      setSecretName('');
      setSecretHeader('authorization');
      setSecretFormat('Bearer {}');
      setSecretFallback(true);
      setSecretBasic(false);
      setConnectionName('');
      setConnectionScopes('');
      setHoldPost(false);
      setHoldPreview('');
      setStripLinks(false);
      setOauthEnabled(false);
      setOauthKind('oauth-user');
      setOauthAuthUrl('');
      setOauthTokenUrl('');
      setOauthClientSecret('');
      setOauthKeySecret('');
      setOauthRefresh(true);
      setOauthDefaultScopes('');
    }
    setActionError(null);
    setIsProposeOpen(true);
  };

  const handleProposeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);

    const payload: any = {
      id: formId.trim(),
      name: formName.trim(),
      kind: formKind,
      upstream: formUpstream.trim(),
    };
    if (formDesc.trim()) payload.description = formDesc.trim();

    if (credKind === 'static') {
      payload.credential = {
        secret: secretName.trim(),
        header: secretHeader.trim(),
        format: secretFormat.trim() || undefined,
        fallback: secretFallback,
        ...(secretBasic ? { encoding: 'basic' } : {}),
      };
    } else if (credKind === 'connection') {
      payload.connection = connectionName.trim();
      if (connectionScopes.trim()) {
        payload.scopes = connectionScopes.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }

    if (holdPost) {
      payload.hold = {
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        ...(holdPreview.trim() ? { preview: holdPreview.trim() } : {}),
      };
    }

    if (stripLinks) {
      payload.stripSignInLinks = true;
    }

    if (oauthEnabled) {
      if (oauthKind === 'oauth-user') {
        payload.oauth = {
          kind: 'oauth-user',
          authUrl: oauthAuthUrl.trim(),
          tokenUrl: oauthTokenUrl.trim(),
          ...(oauthClientSecret.trim() ? { clientSecret: oauthClientSecret.trim() } : {}),
          refresh: oauthRefresh,
          ...(oauthDefaultScopes.trim() ? { defaultScopes: oauthDefaultScopes.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        };
      } else {
        payload.oauth = {
          kind: 'jwt-bearer',
          tokenUrl: oauthTokenUrl.trim(),
          ...(oauthKeySecret.trim() ? { keySecret: oauthKeySecret.trim() } : {}),
          ...(oauthDefaultScopes.trim() ? { defaultScopes: oauthDefaultScopes.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        };
      }
    }

    try {
      await factoryApi.proposeSystem(payload);
      setIsProposeOpen(false);
      await loadData();
    } catch (err: any) {
      setActionError(err.message || 'Failed to propose system');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async (id: string, version?: number) => {
    try {
      await factoryApi.approveSystem(id, version);
      await loadData();
    } catch (err: any) {
      alert(`Approval failed: ${err.message}`);
    }
  };

  const handleReject = async (id: string, version?: number) => {
    try {
      await factoryApi.rejectSystem(id, version, 'Rejected by admin');
      await loadData();
    } catch (err: any) {
      alert(`Rejection failed: ${err.message}`);
    }
  };


  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Server className="w-6 h-6 text-indigo-500" />
            External Systems Catalog
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Systems as factory data (§6.3.1 E10). Defined once, approved by admin, resolved by gatekeeper-egress with zero deploy.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void loadData()}
            className="p-2 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
            title="Refresh systems"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => openProposeModal()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg shadow-sm flex items-center gap-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Propose System
          </button>
        </div>
      </div>

      {/* Systems List */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <th className="py-3 px-4 w-8"></th>
                <th className="py-3 px-4">System</th>
                <th className="py-3 px-4">Kind</th>
                <th className="py-3 px-4">Upstream</th>
                <th className="py-3 px-4">Credential / Connection</th>
                <th className="py-3 px-4">Governance</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
              {systems.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No external systems registered yet.
                  </td>
                </tr>
              )}
              {systems.map((sys) => {
                const isExpanded = expandedIds.has(sys.id);
                const active = sys.activeDefinition ?? sys.versions[sys.versions.length - 1];
                const badge = STATUS_BADGE[sys.status];

                return (
                  <React.Fragment key={sys.id}>
                    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => toggleExpand(sys.id)}
                          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{sys.name}</div>
                        <div className="text-xs font-mono text-slate-500">{sys.id}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded text-xs font-medium uppercase bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {sys.kind}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-400 max-w-xs truncate" title={sys.upstream}>
                        {sys.upstream}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {active?.oauth ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400 font-medium">
                              <Lock className="w-3.5 h-3.5" />
                              OAuth Provider ({active.oauth.kind})
                            </div>
                            {sys.status === 'approved' && (
                              <ProviderClient systemId={sys.id} kind={active.oauth.kind} canEdit={isAdmin} />
                            )}
                          </div>
                        ) : active?.connection ? (
                          <div className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 font-medium">
                            <Lock className="w-3.5 h-3.5" />
                            OAuth: {active.connection}
                          </div>
                        ) : active?.credential ? (
                          <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 font-mono">
                            <Lock className="w-3.5 h-3.5 text-amber-500" />
                            {active.credential.secret}
                          </div>
                        ) : (
                          <span className="text-slate-400">None</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs space-y-1">
                        {active?.hold ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                            <ShieldAlert className="w-3 h-3" />
                            E9 Hold ({active.hold.methods.join(',')})
                          </span>
                        ) : (
                          <span className="text-slate-400">Direct</span>
                        )}
                        {active?.stripSignInLinks && (
                          <div>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300 border border-sky-300 dark:border-sky-800">
                              K4 Strip Links
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${badge.className}`}>
                          {badge.icon}
                          {badge.label} (v{active?.version ?? sys.latestVersion})
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        {sys.status === 'proposed' && isAdmin && (
                          <>
                            <button
                              onClick={() => handleApprove(sys.id, active?.version)}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium transition-colors"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleReject(sys.id, active?.version)}
                              className="px-2.5 py-1 border border-rose-300 dark:border-rose-800 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded text-xs font-medium transition-colors"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => openProposeModal(sys)}
                          className="px-2.5 py-1 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>

                    {/* Version History Drawer */}
                    {isExpanded && (
                      <tr className="bg-slate-50/70 dark:bg-slate-950/30">
                        <td colSpan={8} className="p-4 pl-12">
                          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Version History</h4>
                          <div className="space-y-2">
                            {sys.versions.map((ver) => (
                              <div
                                key={ver.version}
                                className="flex items-center justify-between p-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs"
                              >
                                <div className="flex items-center gap-3">
                                  <span className="font-bold">v{ver.version}</span>
                                  <span className={`px-2 py-0.5 rounded text-[11px] border ${STATUS_BADGE[ver.status].className}`}>
                                    {ver.status}
                                  </span>
                                  <span className="font-mono text-slate-500 truncate max-w-xs">{ver.upstream}</span>
                                  {ver.oauth && (
                                    <span className="px-2 py-0.5 rounded text-[11px] bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-800 font-mono">
                                      OAuth ({ver.oauth.kind})
                                    </span>
                                  )}
                                  {ver.reason && <span className="text-slate-500 italic">"{ver.reason}"</span>}
                                </div>
                                <div className="flex items-center gap-3 text-slate-400">
                                  <span>by {ver.proposedBy}</span>
                                  <span>{new Date(ver.proposedAt).toLocaleString()}</span>
                                  {ver.status === 'proposed' && isAdmin && (
                                    <button
                                      onClick={() => handleApprove(sys.id, ver.version)}
                                      className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-medium"
                                    >
                                      Approve v{ver.version}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Propose System Modal */}
      {isProposeOpen && (
        <Dialog
          title={formId ? `Propose System Definition: ${formId}` : 'Propose New System Definition'}
          onClose={() => setIsProposeOpen(false)}
          busy={submitting}
          footer={
            <>
              <button
                type="button"
                onClick={() => setIsProposeOpen(false)}
                className="px-4 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="propose-system-form"
                disabled={submitting}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium shadow-sm transition-colors disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit Proposal'}
              </button>
            </>
          }
        >
          <form id="propose-system-form" onSubmit={handleProposeSubmit} className="space-y-4">

            {actionError && (
              <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-lg text-xs text-rose-700 dark:text-rose-300">
                {actionError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">System ID</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. discord, notion, x-api"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value.toLowerCase())}
                  className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Human Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. X (Twitter) API"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Description</label>
              <input
                type="text"
                placeholder="Optional description"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Kind</label>
                <select
                  value={formKind}
                  onChange={(e) => setFormKind(e.target.value as 'http' | 'mcp')}
                  className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-sm"
                >
                  <option value="http">HTTP Service</option>
                  <option value="mcp">MCP Server</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Upstream URL</label>
                <input
                  type="url"
                  required
                  placeholder="https://api.example.com"
                  value={formUpstream}
                  onChange={(e) => setFormUpstream(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-sm font-mono"
                />
              </div>
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">Credential Injected by Gatekeeper</label>
              <div className="flex gap-4 mb-3">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="credKind"
                    checked={credKind === 'none'}
                    onChange={() => setCredKind('none')}
                  />
                  None / Public
                </label>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="credKind"
                    checked={credKind === 'static'}
                    onChange={() => setCredKind('static')}
                  />
                  Static Secret (Vault)
                </label>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="credKind"
                    checked={credKind === 'connection'}
                    onChange={() => setCredKind('connection')}
                  />
                  Keymaster OAuth Connection
                </label>
              </div>

              {credKind === 'static' && (
                <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Secret Key / Template</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. {agent}_GITHUB_TOKEN or API_KEY"
                      value={secretName}
                      onChange={(e) => setSecretName(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Header Name</label>
                    <input
                      type="text"
                      required
                      placeholder="authorization or x-api-key"
                      value={secretHeader}
                      onChange={(e) => setSecretHeader(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Format</label>
                    <input
                      type="text"
                      placeholder="Bearer {} or Bot {}"
                      value={secretFormat}
                      onChange={(e) => setSecretFormat(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                  <div className="flex items-center pt-4">
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={secretFallback}
                        onChange={(e) => setSecretFallback(e.target.checked)}
                      />
                      Shared Secret Fallback
                    </label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-4" title="Send the formatted value as HTTP Basic credentials (git over HTTPS uses x-access-token:{})">
                      <input
                        type="checkbox"
                        checked={secretBasic}
                        onChange={(e) => setSecretBasic(e.target.checked)}
                      />
                      HTTP Basic
                    </label>
                  </div>
                </div>
              )}

              {credKind === 'connection' && (
                <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Connection Name</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. google, linkedin"
                      value={connectionName}
                      onChange={(e) => setConnectionName(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Scopes (comma-separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. read, write"
                      value={connectionScopes}
                      onChange={(e) => setConnectionScopes(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={oauthEnabled}
                  onChange={(e) => setOauthEnabled(e.target.checked)}
                />
                Define Keymaster OAuth Provider (TSK-067)
              </label>

              {oauthEnabled && (
                <div className="space-y-3 p-3 bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 rounded-lg">
                  <div className="flex gap-4">
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="radio"
                        name="oauthKind"
                        checked={oauthKind === 'oauth-user'}
                        onChange={() => setOauthKind('oauth-user')}
                      />
                      User OAuth (Authorization Code)
                    </label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="radio"
                        name="oauthKind"
                        checked={oauthKind === 'jwt-bearer'}
                        onChange={() => setOauthKind('jwt-bearer')}
                      />
                      Service Account (JWT Bearer)
                    </label>
                  </div>

                  {oauthKind === 'oauth-user' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">Authorization URL</label>
                        <input
                          type="url"
                          required
                          placeholder="https://accounts.google.com/o/oauth2/v2/auth"
                          value={oauthAuthUrl}
                          onChange={(e) => setOauthAuthUrl(e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">Token URL</label>
                        <input
                          type="url"
                          required
                          placeholder="https://oauth2.googleapis.com/token"
                          value={oauthTokenUrl}
                          onChange={(e) => setOauthTokenUrl(e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">Client entry name (optional)</label>
                        <input
                          type="text"
                          placeholder="Leave blank: the Keymaster names it"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                        />
                      </div>
                      <div className="flex items-center pt-4">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={oauthRefresh}
                            onChange={(e) => setOauthRefresh(e.target.checked)}
                          />
                          Issues Refresh Tokens
                        </label>
                      </div>
                    </div>
                  )}

                  {oauthKind === 'jwt-bearer' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">Token URL</label>
                        <input
                          type="url"
                          required
                          placeholder="https://oauth2.googleapis.com/token"
                          value={oauthTokenUrl}
                          onChange={(e) => setOauthTokenUrl(e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">Key entry name (optional)</label>
                        <input
                          type="text"
                          placeholder="Leave blank: the Keymaster names it"
                          value={oauthKeySecret}
                          onChange={(e) => setOauthKeySecret(e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Default Scopes (comma-separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. https://www.googleapis.com/auth/devstorage.read_write"
                      value={oauthDefaultScopes}
                      onChange={(e) => setOauthDefaultScopes(e.target.value)}
                      className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-3">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={holdPost}
                  onChange={(e) => setHoldPost(e.target.checked)}
                />
                E9 Hold on write actions (POST, PUT, PATCH, DELETE wait for human review)
              </label>

              {holdPost && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">Hold Preview Kind</label>
                  <input
                    type="text"
                    placeholder="e.g. linkedin-post, tweet"
                    value={holdPreview}
                    onChange={(e) => setHoldPreview(e.target.value)}
                    className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded font-mono"
                  />
                </div>
              )}

              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={stripLinks}
                  onChange={(e) => setStripLinks(e.target.checked)}
                />
                K4 Strip Sign-In Links (rewrites third-party OAuth links to factory host)
              </label>
            </div>
          </form>
        </Dialog>

      )}
    </div>
  );
};

/**
 * TSK-067, K5.3: an OAuth provider's app credentials, entered once and never shown again. The client ID and secret
 * the provider issued go straight to the Keymaster, which stores them under its own name for this provider.
 */
function ProviderClient({ systemId, kind, canEdit }: { systemId: string; kind: 'oauth-user' | 'jwt-bearer'; canEdit: boolean }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    factoryApi.getProviderClient(systemId).then((r) => setPresent(r.present)).catch(() => setPresent(null));
  }, [systemId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await factoryApi.setProviderClient(systemId, kind === 'oauth-user' ? { client_id: clientId.trim(), client_secret: secret } : { value: secret });
      setPresent(true);
      setOpen(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      // The value leaves the page as soon as it is sent.
      setSecret('');
      setBusy(false);
    }
  };

  return (
    <div className="text-[11px]">
      <span className={present ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
        {present === null ? 'Client: unknown' : present ? 'Client: set' : 'Client: not set'}
      </span>
      {canEdit && !open && (
        <button type="button" onClick={() => setOpen(true)} className="ml-2 underline text-indigo-600 dark:text-indigo-400">
          {present ? 'Replace client' : 'Set client'}
        </button>
      )}
      {open && (
        <form onSubmit={save} className="mt-1 space-y-1">
          {kind === 'oauth-user' && (
            <input
              type="text"
              required
              autoComplete="off"
              placeholder="Application (client) ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full px-2 py-1 border border-slate-300 dark:border-slate-700 rounded font-mono"
            />
          )}
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder={kind === 'oauth-user' ? 'Client secret (write-only)' : 'Service-account key JSON (write-only)'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="w-full px-2 py-1 border border-slate-300 dark:border-slate-700 rounded font-mono"
          />
          {error && <div className="text-red-600">{error}</div>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="px-2 py-0.5 rounded bg-indigo-600 text-white disabled:opacity-50">
              {busy ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setSecret(''); }} className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

