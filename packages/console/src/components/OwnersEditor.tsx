import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, UserPlus, Users, X } from 'lucide-react';
import type { AgentRecord } from '../api/types.js';
import { factoryApi } from '../api/client.js';
import { useAuth } from '../auth/CloudflareAuth.js';

const MAX_OWNERS = 10;

/**
 * TSK-103: an agent's owners, as principal actors (`cloudflare:alice@example.com`). An owner is the person the agent
 * treats as its owner: the factory puts `isOwner` on their caller badge, which is what lets the cartridge answer them
 * (RBAC fails closed for anyone else). An admin sets them; each change is a new, ledgered configuration version.
 */
export const OwnersEditor: React.FC<{ agent: AgentRecord; canEdit: boolean }> = ({ agent, canEdit }) => {
  const { user } = useAuth();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [owners, setOwners] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (list: string[]) => {
    setSaved(list);
    setOwners(list);
  };

  useEffect(() => {
    setError(null);
    setSavedAt(null);
    setSaved(null);
    factoryApi.getOwners(agent.id).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agent.id]);

  // The actor the factory knows this signed-in person by (from /api/auth/me), for the "add me" shortcut.
  const myActor = user.actor?.toLowerCase() ?? '';

  const add = (raw: string) => {
    const actor = raw.trim().toLowerCase();
    if (!actor) return;
    if (!/^(cloudflare|oidc|token):\S+$/.test(actor)) {
      setError('An owner is a principal actor such as cloudflare:alice@example.com, oidc:... or token:...');
      return;
    }
    if (owners.length >= MAX_OWNERS) {
      setError(`An agent has at most ${MAX_OWNERS} owners.`);
      return;
    }
    setError(null);
    if (!owners.includes(actor)) setOwners([...owners, actor].sort());
    setDraft('');
  };

  const dirty = saved !== null && JSON.stringify([...owners].sort()) !== JSON.stringify([...saved].sort());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      load(await factoryApi.setOwners(agent.id, owners, `console: owners of ${agent.id} set by ${user.email || 'admin'}`));
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 shadow-sm';
  const hint = 'text-xs text-slate-500 dark:text-slate-400';

  if (saved === null && !error) return <div className={hint}>Loading owners…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start space-x-2 text-xs text-slate-600 dark:text-slate-300">
        <Users className="w-4 h-4 text-emerald-500 shrink-0" />
        <p>
          Owners get full access to {agent.name}: the factory marks them as the agent's owner on every message they send, and the
          agent answers only callers it recognises. An agent with no owners treats everyone as unprivileged.
          {!canEdit && ' Only an admin can change owners.'}
        </p>
      </div>

      <div className={card}>
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">Owners</h4>
        {owners.length === 0 && <p className={hint}>No owners.</p>}
        {owners.map((o) => (
          <div key={o} className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/80 text-xs">
            <span className="font-mono text-slate-800 dark:text-slate-200">{o}</span>
            {canEdit && (
              <button
                onClick={() => setOwners(owners.filter((x) => x !== o))}
                disabled={busy}
                aria-label={`Remove ${o}`}
                className="text-slate-400 hover:text-rose-500 disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add(draft)}
              placeholder="cloudflare:alice@example.com"
              aria-label="Owner principal actor"
              className="flex-1 min-w-[16rem] rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 font-mono"
            />
            <button onClick={() => add(draft)} disabled={busy || !draft.trim()} className="px-3 py-1 rounded border border-slate-300 dark:border-slate-700 font-semibold disabled:opacity-50">
              Add
            </button>
            {myActor && !owners.includes(myActor) && (
              <button onClick={() => add(myActor)} disabled={busy} className="flex items-center space-x-1 px-3 py-1 rounded border border-emerald-500 text-emerald-600 dark:text-emerald-400 font-semibold disabled:opacity-50">
                <UserPlus className="w-3.5 h-3.5" />
                <span>Add me ({myActor})</span>
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}
      {savedAt && !error && !dirty && (
        <div className="flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle className="w-4 h-4" />
          <span>Saved at {savedAt}. Recorded as a new configuration version.</span>
        </div>
      )}
      {canEdit && (
        <div className="flex items-center space-x-2">
          <button onClick={save} disabled={busy || !dirty} className="px-4 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : 'Save owners'}
          </button>
          {dirty && !busy && (
            <button onClick={() => setOwners(saved ?? [])} className="px-3 py-1.5 rounded text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              Discard changes
            </button>
          )}
        </div>
      )}
    </div>
  );
};
