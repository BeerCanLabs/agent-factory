import React, { useEffect, useState } from 'react';
import { KeyRound, Link2, RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2, Save, Server } from 'lucide-react';
import type { AgentCredentials, AgentRecord, CredentialItem, CredentialStatus } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi, PLATFORM_CREDENTIALS } from '../api/client.js';

// DESIGN_AUTHORITY.md §6.11 K5: a client of the Keymaster API only. It adds no logic of its own, and a credential
// value typed here is sent once, write-only, and never shown again.

interface CredentialsViewProps {
  agents: AgentRecord[];
  agentId: string;
  onSelectAgent: (id: string) => void;
  onChanged: () => void;
}

const STATUS: Record<CredentialStatus, { label: string; className: string }> = {
  present: { label: 'Present', className: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-800' },
  missing: { label: 'Missing', className: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/60 dark:text-rose-400 dark:border-rose-800' },
  needs_consent: { label: 'Needs consent', className: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-800' },
  missing_scopes: { label: 'Missing scopes', className: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-800' },
  needs_reconsent: { label: 'Needs re-consent', className: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/60 dark:text-rose-400 dark:border-rose-800' },
};

/** Minimal, safe Markdown: paragraphs, numbered/bulleted lines, **bold**, `code`, and https links. No raw HTML. */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2]) out.push(<code key={k} className="font-mono text-[11px] bg-slate-100 dark:bg-slate-800 px-1 rounded">{m[2]}</code>);
    else out.push(<a key={k} href={m[4]} target="_blank" rel="noopener noreferrer" className="text-emerald-700 dark:text-emerald-400 underline">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const Markdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="space-y-1.5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
    {text.split('\n').filter((l) => l.trim()).map((line, i) => {
      const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (numbered) {
        return (
          <div key={i} className="flex space-x-2">
            <span className="font-semibold text-slate-500 w-4 shrink-0 text-right">{numbered[1]}.</span>
            <span>{inline(numbered[2], `l${i}`)}</span>
          </div>
        );
      }
      return <p key={i}>{inline(line, `l${i}`)}</p>;
    })}
  </div>
);

const StaticSecretInput: React.FC<{ agentId: string; item: CredentialItem; canWrite: boolean; onSaved: (msg: string) => void }> = ({ agentId, item, canWrite, onSaved }) => {
  // Held only until it is sent; cleared on success or failure, and never rendered back.
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (item.action.type !== 'submit') return;
      const res = await factoryApi.submitCredential(item.action.path, draft);
      onSaved(`${item.name} ${res.action === 'CREDENTIAL_ROTATED' ? 'rotated' : 'saved'}.`);
    } catch (err: any) {
      setError(`Not saved: ${err.message}`);
    } finally {
      setDraft('');
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          disabled={!canWrite || saving}
          placeholder={item.status === 'present' ? 'Replace (write-only)' : 'Paste value (write-only)'}
          aria-label={`Value for ${item.name}`}
          className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          onClick={save}
          disabled={!canWrite || saving || !draft.trim()}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg font-semibold text-xs flex items-center space-x-1.5 shadow-sm transition"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{saving ? 'Saving…' : item.status === 'present' ? 'Rotate' : 'Save'}</span>
        </button>
      </div>
      <p className="text-[10px] text-slate-500 dark:text-slate-400">Stored in the secret manager. The factory never shows a saved value again.</p>
      {error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
};

const CredentialCard: React.FC<{ agentId: string; item: CredentialItem; canWrite: boolean; onSaved: (msg: string) => void }> = ({ agentId, item, canWrite, onSaved }) => {
  const [showHelp, setShowHelp] = useState(item.outstanding);
  const status = STATUS[item.status];
  const action = item.action;

  return (
    <div className={`bg-white dark:bg-slate-900 border rounded-xl p-4 shadow-sm space-y-3 transition-colors ${item.outstanding ? 'border-amber-300 dark:border-amber-800/70' : 'border-slate-200 dark:border-slate-800'}`}>
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-2">
        <div>
          <div className="flex items-center flex-wrap gap-2">
            {item.kind === 'oauth' ? <Link2 className="w-4 h-4 text-indigo-500" /> : <KeyRound className="w-4 h-4 text-slate-500" />}
            <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">{item.name}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${status.className}`}>{status.label}</span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700">
              {item.kind === 'oauth' ? 'OAuth connection' : 'Static secret'}
            </span>
            {item.managedBy === 'platform' && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400 border border-sky-200 dark:border-sky-800 flex items-center space-x-1">
                <Server className="w-3 h-3" />
                <span>{item.shared ? 'Platform credential · shared; agents never see it' : 'Platform credential'}</span>
              </span>
            )}
          </div>
          {item.description && <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">{item.description}</p>}
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {item.source ? <>Source: <span className="font-mono">{item.source}</span>{item.sourceInferred ? ' (guessed from the name)' : ''}</> : 'No source declared'}
            {item.requiredBy ? <> · needed by <span className="font-mono">{item.requiredBy}</span></> : null}
            {item.grant ? <> · granted by {item.grant.grantedBy} on {new Date(item.grant.obtainedAt).toLocaleString()}</> : null}
          </p>
          {item.scopes && item.scopes.missing.length > 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">Missing scopes: <span className="font-mono">{item.scopes.missing.join(', ')}</span></p>
          )}
        </div>
        {action.type === 'consent' && (
          <div className="shrink-0 text-right">
            {canWrite && action.available ? (
              <a
                href={factoryApi.connectUrl(action.path)}
                className="inline-flex px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold text-xs items-center space-x-1.5 shadow-sm transition"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>{item.status === 'needs_consent' ? 'Connect' : 'Reconnect'}</span>
              </a>
            ) : (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">{action.reason ?? 'Admin only'}</span>
            )}
          </div>
        )}
      </div>

      {action.type === 'submit' && <StaticSecretInput agentId={agentId} item={item} canWrite={canWrite} onSaved={onSaved} />}
      {action.type === 'none' && <p className="text-[11px] text-slate-500 dark:text-slate-400">{action.reason}</p>}

      {item.instructions ? (
        <div className="border-t border-slate-200 dark:border-slate-800 pt-2">
          <button onClick={() => setShowHelp(!showHelp)} className="text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400">
            {showHelp ? '▾' : '▸'} How to create: {item.instructions.title}
          </button>
          {item.instructions.reviewState !== 'approved' && (
            <div className="mt-1.5 flex items-center space-x-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded px-2 py-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{item.instructions.label ?? 'Pending human review'}</span>
            </div>
          )}
          {item.instructions.approved && (
            <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-400 flex items-center space-x-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Approved by {item.instructions.approved.by} on {item.instructions.approved.at}</span>
            </p>
          )}
          {showHelp && <div className="mt-2"><Markdown text={item.instructions.instructions} /></div>}
        </div>
      ) : (
        item.managedBy === 'agent' && <p className="text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800 pt-2">No instructions in the catalog for this source yet.</p>
      )}
    </div>
  );
};

export const CredentialsView: React.FC<CredentialsViewProps> = ({ agents, agentId, onSelectAgent, onChanged }) => {
  const permissions = usePermissions();
  const [data, setData] = useState<AgentCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId);
  const isPlatform = agentId === PLATFORM_CREDENTIALS;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await (isPlatform ? factoryApi.getPlatformCredentials() : factoryApi.getCredentials(agentId)));
    } catch (err: any) {
      setData(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNotice(null);
    load();
  }, [agentId]);

  const onSaved = (msg: string) => {
    setNotice(msg);
    load();
    onChanged();
  };

  const outstanding = data?.credentials.filter((c) => c.outstanding) ?? [];
  const done = data?.credentials.filter((c) => !c.outstanding) ?? [];

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm transition-colors">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-600 dark:text-amber-400">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <select
              value={agentId}
              onChange={(e) => onSelectAgent(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-bold text-base rounded px-2 py-1 border border-slate-300 dark:border-slate-800 cursor-pointer focus:outline-none focus:border-emerald-500"
            >
              <option value={PLATFORM_CREDENTIALS}>Platform (gatekeeper-egress-held keys)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {isPlatform
                ? 'Keys the gatekeeper-egress holds for every agent (model providers, shared integrations). Agents never see them.'
                : <>Credentials {agent?.name ?? agentId} declares.</>}{' '}Values are write-only and never shown back.
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-3 text-xs">
          {data && (
            data.summary.outstanding === 0 ? (
              <span className="flex items-center space-x-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span>Nothing outstanding</span>
              </span>
            ) : (
              <span className="font-semibold text-amber-700 dark:text-amber-400">
                {data.summary.outstanding} of {data.summary.total} outstanding
              </span>
            )
          )}
          <button onClick={load} className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!permissions.canManageCredentials && (
        <p className="text-xs text-slate-500 dark:text-slate-400">Only admins can supply credentials or connect accounts.</p>
      )}
      {notice && <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-lg px-3 py-2">{notice}</div>}
      {error && <div className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-lg px-3 py-2">Could not load credentials: {error}</div>}
      {data && data.credentials.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">{isPlatform ? 'The gatekeeper-egress holds no platform keys.' : 'This agent declares no credentials.'}</p>}

      {outstanding.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">Outstanding</h2>
          {outstanding.map((c) => <CredentialCard key={`${c.kind}:${c.name}`} agentId={agentId} item={c} canWrite={permissions.canManageCredentials} onSaved={onSaved} />)}
        </section>
      )}
      {done.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">Present</h2>
          {done.map((c) => <CredentialCard key={`${c.kind}:${c.name}`} agentId={agentId} item={c} canWrite={permissions.canManageCredentials} onSaved={onSaved} />)}
        </section>
      )}
    </div>
  );
};
