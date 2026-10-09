import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Fingerprint,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Pencil,
  Copy,
  Check,
  Shield,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  AlertCircle,
  ExternalLink,
  Info,
} from 'lucide-react';
import { factoryApi } from '../api/client.js';
import type { FactoryRole, IdentityLink, IdentityProvider } from '../api/types.js';
import { IDENTITY_PROVIDERS } from '../api/types.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import { usePermissions } from '../auth/usePermissions.js';
import { Dialog } from '../components/Dialog.js';

const ALL_ROLES: Array<{ role: FactoryRole; label: string; desc: string }> = [
  { role: 'admin', label: 'Admin', desc: 'Full sovereign authority: manage fleet, identities, credentials, budgets & purge' },
  { role: 'operator', label: 'Operator', desc: 'Operational authority: wake, dispatch prompts, converse with agents, pause & resume' },
  { role: 'approver', label: 'Approver', desc: 'Human-in-the-Loop authority: review and approve held tool executions' },
  { role: 'viewer', label: 'Viewer', desc: 'Read-only access: view agent states, metrics, and immutable ledger' },
  { role: 'ingest', label: 'Ingest', desc: 'Event ingestion authority: post telemetry and metrics' },
];

const PROVIDER_INFO: Record<IdentityProvider, { label: string; badgeClass: string; placeholder: string; helper: string }> = {
  discord: {
    label: 'Discord',
    badgeClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    placeholder: 'e.g. 987654321098765432',
    helper: 'Right-click user profile in Discord with Developer Mode enabled → Copy User ID.',
  },
  slack: {
    label: 'Slack',
    badgeClass: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30',
    placeholder: 'e.g. U0123456789',
    helper: 'Slack Member ID from user profile (Click profile → More → Copy member ID).',
  },
  teams: {
    label: 'MS Teams',
    badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    placeholder: 'e.g. 29:1a2b3c4d5e...',
    helper: 'Microsoft Teams AAD User ID or Bot Framework participant ID.',
  },
  webui: {
    label: 'Web UI',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    placeholder: 'e.g. user-session-id',
    helper: 'External session or subject identifier from browser interface.',
  },
  cli: {
    label: 'CLI Tool',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    placeholder: 'e.g. dev-macbook-user',
    helper: 'External workstation or CLI client identifier.',
  },
};

const ROLE_BADGE: Record<FactoryRole, string> = {
  admin: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  operator: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  approver: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  viewer: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  ingest: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
};

const EXTERNAL_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const ACTOR_REGEX = /^(cloudflare|oidc|token):\S+$/;

export const IdentitiesView: React.FC = () => {
  const { user } = useAuth();
  const { canManageIdentities } = usePermissions();

  const [links, setLinks] = useState<IdentityLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<IdentityProvider | 'all'>('all');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Link / Edit Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [modalProvider, setModalProvider] = useState<IdentityProvider>('discord');
  const [modalId, setModalId] = useState('');
  const [modalActor, setModalActor] = useState('');
  const [modalName, setModalName] = useState('');
  const [modalRoles, setModalRoles] = useState<FactoryRole[]>(['admin', 'operator', 'approver', 'viewer', 'ingest']);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Unlink Modal State
  const [unlinkTarget, setUnlinkTarget] = useState<IdentityLink | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setRefreshing(true);
      const data = await factoryApi.listIdentityLinks();
      setLinks(data);
    } catch (err: any) {
      console.error('Failed to load identity links:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const openCreateModal = () => {
    setIsEditing(false);
    setModalProvider('discord');
    setModalId('');
    // Pre-fill with current Cloudflare actor if user has email
    const defaultActor = user?.email ? `cloudflare:${user.email.toLowerCase()}` : '';
    setModalActor(defaultActor);
    setModalName(user?.name && user.name !== user.email ? user.name : '');
    setModalRoles(['admin', 'operator', 'approver', 'viewer', 'ingest']);
    setModalError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (link: IdentityLink) => {
    setIsEditing(true);
    setModalProvider(link.provider);
    setModalId(link.id);
    setModalActor(link.actor);
    setModalName(link.name ?? '');
    setModalRoles(link.roles ? [...link.roles] : []);
    setModalError(null);
    setIsModalOpen(true);
  };

  const handleSaveLink = async () => {
    setModalError(null);
    const trimmedId = modalId.trim();
    const trimmedActor = modalActor.trim().toLowerCase();
    const trimmedName = modalName.trim();

    if (!trimmedId) {
      setModalError('External ID is required.');
      return;
    }
    if (!EXTERNAL_ID_REGEX.test(trimmedId)) {
      setModalError('External ID must only contain letters, digits, dot, dash, or underscore (1-128 chars).');
      return;
    }
    if (!trimmedActor) {
      setModalError('Principal Actor is required.');
      return;
    }
    if (!ACTOR_REGEX.test(trimmedActor)) {
      setModalError('Principal Actor must be in format cloudflare:user@example.com, oidc:subject, or token:name.');
      return;
    }

    try {
      setModalSubmitting(true);
      await factoryApi.setIdentityLink(modalProvider, trimmedId, {
        actor: trimmedActor,
        ...(trimmedName ? { name: trimmedName } : {}),
        roles: modalRoles.length > 0 ? modalRoles : undefined,
      });
      setIsModalOpen(false);
      await loadData();
    } catch (err: any) {
      setModalError(err.message || 'Failed to save identity link.');
    } finally {
      setModalSubmitting(false);
    }
  };

  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    setUnlinkError(null);
    try {
      setUnlinking(true);
      await factoryApi.unlinkIdentity(unlinkTarget.provider, unlinkTarget.id);
      setUnlinkTarget(null);
      await loadData();
    } catch (err: any) {
      setUnlinkError(err.message || 'Failed to unlink identity.');
    } finally {
      setUnlinking(false);
    }
  };

  const toggleRole = (role: FactoryRole) => {
    setModalRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  // Filtered links
  const filteredLinks = useMemo(() => {
    return links.filter((link) => {
      const matchesProvider = selectedProvider === 'all' || link.provider === selectedProvider;
      if (!matchesProvider) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      return (
        link.id.toLowerCase().includes(q) ||
        link.actor.toLowerCase().includes(q) ||
        (link.name && link.name.toLowerCase().includes(q)) ||
        link.provider.toLowerCase().includes(q) ||
        (link.roles && link.roles.some((r) => r.toLowerCase().includes(q)))
      );
    });
  }, [links, selectedProvider, searchQuery]);

  // Provider counts
  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = { all: links.length };
    for (const p of IDENTITY_PROVIDERS) {
      counts[p] = links.filter((l) => l.provider === p).length;
    }
    return counts;
  }, [links]);

  const adminCount = links.filter((l) => l.roles?.includes('admin')).length;
  const activeProvidersCount = IDENTITY_PROVIDERS.filter((p) => links.some((l) => l.provider === p)).length;

  return (
    <div className="space-y-6">
      {/* Header & Primary Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-600 dark:text-emerald-400">
              <Fingerprint className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">Identities & Access</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Bouncer perimeter gate — map external IDs to Cloudflare principals with authorized roles.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadData()}
            disabled={refreshing}
            className="p-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg transition disabled:opacity-50"
            title="Refresh identity links"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={openCreateModal}
            disabled={!canManageIdentities}
            className="flex items-center space-x-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            <span>Link External Identity</span>
          </button>
        </div>
      </div>

      {/* Perimeter Gate Info Banner */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 flex items-start space-x-3">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold text-slate-200">
            Perimeter Authorization & Clean Slate Identity Mapping
          </p>
          <p className="text-slate-400 leading-relaxed">
            When an interaction arrives from an external surface (Discord, Slack, Teams, WebUI, CLI), the Bouncer
            checks this registry to resolve who the caller is and verify their authorized roles. Unmapped callers or
            callers without the required role (e.g.{' '}
            <code className="text-emerald-300 font-mono bg-slate-800/80 px-1 py-0.5 rounded">operator</code> or{' '}
            <code className="text-emerald-300 font-mono bg-slate-800/80 px-1 py-0.5 rounded">admin</code>) are refused
            at the perimeter before any agent compute or tool execution is provisioned.
          </p>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Mapped Identities</div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{links.length}</div>
          <div className="text-[11px] text-slate-400 mt-1">Across all external channels</div>
        </div>
        <div className="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Admin Principals</div>
          <div className="text-2xl font-bold text-rose-500 mt-1">{adminCount}</div>
          <div className="text-[11px] text-slate-400 mt-1">Full sovereign control granted</div>
        </div>
        <div className="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Active Surfaces</div>
          <div className="text-2xl font-bold text-emerald-500 mt-1">{activeProvidersCount} / 5</div>
          <div className="text-[11px] text-slate-400 mt-1">Discord, Slack, Teams, Web, CLI</div>
        </div>
        <div className="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Perimeter Policy</div>
          <div className="text-sm font-bold text-slate-800 dark:text-slate-200 mt-1 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            Zero-Trust Ingress
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Clean slate (No grandfathering)</div>
        </div>
      </div>

      {/* Search & Provider Filter Tabs */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Provider Tabs */}
        <div className="flex items-center space-x-1 overflow-x-auto pb-1 sm:pb-0">
          <button
            onClick={() => setSelectedProvider('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
              selectedProvider === 'all'
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            All Channels ({providerCounts.all})
          </button>
          {IDENTITY_PROVIDERS.map((p) => (
            <button
              key={p}
              onClick={() => setSelectedProvider(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap flex items-center space-x-1.5 ${
                selectedProvider === p
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <span>{PROVIDER_INFO[p].label}</span>
              <span className="text-[10px] opacity-75 font-mono">({providerCounts[p]})</span>
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            placeholder="Search external ID, actor, name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
          />
        </div>
      </div>

      {/* Identity Links Table / Cards */}
      <div className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-slate-400" />
            Loading identity mappings...
          </div>
        ) : filteredLinks.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-3">
            <Fingerprint className="w-10 h-10 mx-auto text-slate-400 stroke-1" />
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-300">
                {links.length === 0 ? 'No external identities linked yet' : 'No matching identity links found'}
              </p>
              <p className="text-slate-500 text-[11px] mt-0.5">
                {links.length === 0
                  ? 'Map a Discord, Slack, Teams, WebUI, or CLI ID to your Cloudflare identity to enable interaction.'
                  : 'Try adjusting your search query or provider filter.'}
              </p>
            </div>
            {links.length === 0 && canManageIdentities && (
              <button
                onClick={openCreateModal}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg text-xs transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Link Your First Identity</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Channel / Surface</th>
                  <th className="py-3 px-4">External Identifier</th>
                  <th className="py-3 px-4">Display Name</th>
                  <th className="py-3 px-4">Cloudflare Principal</th>
                  <th className="py-3 px-4">Authorized Roles</th>
                  <th className="py-3 px-4">Audit Record</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {filteredLinks.map((link) => {
                  const pInfo = PROVIDER_INFO[link.provider];
                  const copyKey = `${link.provider}:${link.id}`;
                  const isCopied = copiedKey === copyKey;

                  return (
                    <tr
                      key={copyKey}
                      className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      {/* Provider Badge */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${pInfo.badgeClass}`}
                        >
                          {pInfo.label}
                        </span>
                      </td>

                      {/* External ID with copy button */}
                      <td className="py-3 px-4">
                        <div className="flex items-center space-x-1.5 font-mono text-[11px] text-slate-800 dark:text-slate-200">
                          <span>{link.id}</span>
                          <button
                            onClick={() => copyToClipboard(link.id, copyKey)}
                            className="p-1 text-slate-400 hover:text-slate-200 rounded hover:bg-slate-800 transition"
                            title="Copy External ID"
                          >
                            {isCopied ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Display Name */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {link.name ? (
                          <span className="font-semibold text-slate-900 dark:text-white">{link.name}</span>
                        ) : (
                          <span className="text-slate-500 italic">None specified</span>
                        )}
                      </td>

                      {/* Principal Actor */}
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                        {link.actor}
                      </td>

                      {/* Authorized Roles */}
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {link.roles && link.roles.length > 0 ? (
                            link.roles.map((r) => (
                              <span
                                key={r}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase font-semibold border ${
                                  ROLE_BADGE[r] || 'bg-slate-800 text-slate-300 border-slate-700'
                                }`}
                              >
                                {r}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/30">
                              <AlertCircle className="w-2.5 h-2.5" />
                              <span>No roles (Blocked)</span>
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Linked By & Date */}
                      <td className="py-3 px-4 text-slate-500 text-[11px] whitespace-nowrap">
                        <div className="font-mono text-[10px] text-slate-400">{link.linkedBy}</div>
                        <div className="text-[10px]">
                          {new Date(link.linkedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center space-x-1">
                          <button
                            onClick={() => openEditModal(link)}
                            disabled={!canManageIdentities}
                            className="p-1.5 text-slate-400 hover:text-slate-200 rounded hover:bg-slate-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Edit Identity Link"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              setUnlinkTarget(link);
                              setUnlinkError(null);
                            }}
                            disabled={!canManageIdentities}
                            className="p-1.5 text-slate-400 hover:text-rose-400 rounded hover:bg-rose-500/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Unlink Identity"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Link / Edit Modal */}
      {isModalOpen && (
        <Dialog
          title={isEditing ? `Edit Identity Link (${modalProvider}:${modalId})` : 'Link External Identity'}
          onClose={() => !modalSubmitting && setIsModalOpen(false)}
          busy={modalSubmitting}
          footer={
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                disabled={modalSubmitting}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveLink}
                disabled={modalSubmitting}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-sm transition disabled:opacity-50"
              >
                {modalSubmitting ? 'Saving...' : isEditing ? 'Update Link' : 'Save Link'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            {modalError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            {/* Provider Selection */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Channel / Provider
              </label>
              <select
                value={modalProvider}
                onChange={(e) => setModalProvider(e.target.value as IdentityProvider)}
                disabled={isEditing || modalSubmitting}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              >
                {IDENTITY_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_INFO[p].label}
                  </option>
                ))}
              </select>
            </div>

            {/* External ID */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                External User Identifier
              </label>
              <input
                type="text"
                placeholder={PROVIDER_INFO[modalProvider].placeholder}
                value={modalId}
                onChange={(e) => setModalId(e.target.value)}
                disabled={isEditing || modalSubmitting}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-500 mt-1">{PROVIDER_INFO[modalProvider].helper}</p>
            </div>

            {/* Principal Actor */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Cloudflare Principal Actor
              </label>
              <input
                type="text"
                placeholder="e.g. cloudflare:alice@example.com"
                value={modalActor}
                onChange={(e) => setModalActor(e.target.value)}
                disabled={modalSubmitting}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Format: <code className="text-emerald-400">cloudflare:email@example.com</code>,{' '}
                <code className="text-emerald-400">oidc:subject</code>, or{' '}
                <code className="text-emerald-400">token:name</code>.
              </p>
            </div>

            {/* Display Name */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Display Name (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Dale"
                value={modalName}
                onChange={(e) => setModalName(e.target.value)}
                disabled={modalSubmitting}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Friendly name known to agents when conversing with this identity.
              </p>
            </div>

            {/* Role Assignment */}
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Authorized Roles
                </label>
                <div className="flex items-center space-x-1.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setModalRoles(['admin', 'operator', 'approver', 'viewer', 'ingest'])}
                    className="text-emerald-400 hover:underline"
                  >
                    Admin Preset
                  </button>
                  <span className="text-slate-600">•</span>
                  <button
                    type="button"
                    onClick={() => setModalRoles(['operator', 'approver', 'viewer'])}
                    className="text-emerald-400 hover:underline"
                  >
                    Operator Preset
                  </button>
                  <span className="text-slate-600">•</span>
                  <button
                    type="button"
                    onClick={() => setModalRoles([])}
                    className="text-slate-400 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="space-y-2 bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                {ALL_ROLES.map(({ role, label, desc }) => {
                  const isChecked = modalRoles.includes(role);
                  return (
                    <label
                      key={role}
                      className="flex items-start space-x-2.5 cursor-pointer hover:opacity-90 select-none"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRole(role)}
                        disabled={modalSubmitting}
                        className="mt-0.5 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-slate-900 bg-slate-900"
                      />
                      <div className="flex-1 text-xs">
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-slate-200">{label}</span>
                          <span
                            className={`px-1.5 py-0.2 rounded text-[9px] font-mono uppercase font-semibold border ${ROLE_BADGE[role]}`}
                          >
                            {role}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">{desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </Dialog>
      )}

      {/* Unlink Confirmation Modal */}
      {unlinkTarget && (
        <Dialog
          title="Unlink External Identity"
          tone="danger"
          onClose={() => !unlinking && setUnlinkTarget(null)}
          busy={unlinking}
          footer={
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setUnlinkTarget(null)}
                disabled={unlinking}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={unlinking}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-sm transition disabled:opacity-50"
              >
                {unlinking ? 'Unlinking...' : 'Confirm Unlink'}
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            {unlinkError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{unlinkError}</span>
              </div>
            )}
            <p>
              Are you sure you want to unlink{' '}
              <strong className="text-white font-mono">
                {unlinkTarget.provider}:{unlinkTarget.id}
              </strong>
              {unlinkTarget.name ? ` (${unlinkTarget.name})` : ''} linked to{' '}
              <code className="text-emerald-400 font-mono">{unlinkTarget.actor}</code>?
            </p>
            <p className="text-slate-400 text-[11px]">
              This external caller will be immediately refused by the Bouncer perimeter gate for all agent
              interactions until an administrator links them again.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
};
