import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpCircle, Clock, Loader2, Plus, RefreshCw, RotateCcw, Trash2, XCircle } from 'lucide-react';
import type { AgentRecord, AgentSkills, SkillSummary } from '../../api/types.js';
import { ApiError, factoryApi } from '../../api/client.js';
import { useAuth } from '../../auth/CloudflareAuth.js';
import { usePermissions } from '../../auth/usePermissions.js';
import { Dialog } from '../../components/Dialog.js';
import { AdoptionDialog, type AdoptionAction } from './dialogs.js';
import { VisibilityBadge } from './StatusBadge.js';
import { agentSkillRows, choosableVersions, defaultVersion, isOwnerOf, isRollBack, permsFor, rebuildState, rebuildText, type AdoptedRow } from './agent-skills-model.js';
import { errorText, when } from './skills-model.js';
import { btnDanger, btnPrimary, btnQuiet, card, input, label } from './ui.js';

/**
 * An agent's skills (DESIGN_AUTHORITY.md §6.14 SK3 to SK6, TSK-161): what it runs, what it has asked for, and what it could
 * be given, and the changes an owner or admin may make: ask for a skill, move to a newer or older version, cancel a
 * request, remove a skill. A change is a configuration change the factory builds and deploys (a rebuilding banner says so),
 * never a pull request. What is shown and offered is decided in `agent-skills-model.ts` (tested); the control plane enforces
 * every role and rule. There is no "hold" to offer: an agent stays on the version it runs until someone moves it.
 */

const REBUILD_POLL_MS = 5_000;
const REBUILD_FOLLOW_MAX_MS = 10 * 60_000;
const REBUILD_SLOW_POLL_MS = 30_000;

// A summary good enough for the shared adoption dialog, from what the agent's own list says about the skill.
const summaryOf = (id: string, data: AgentSkills | null): SkillSummary => {
  const a = data?.available.find((s) => s.id === id);
  return {
    id,
    name: a?.name ?? id,
    description: a?.description ?? '',
    visibility: a?.visibility ?? 'public',
    ...(a?.owner ? { owner: a.owner } : {}),
    latestApproved: a?.version ?? null,
    requires: a?.requires ?? { systems: [], secrets: [], routes: [] },
    versions: [],
  } as SkillSummary;
};

type Ask = { skillId: string; name: string; current?: string };

/** Asks for a skill, or moves to another approved version of it (a newer one is an upgrade, an older one a roll back). */
const RequestDialog: React.FC<{ agentId: string; ask: Ask; canDecide: boolean; onClose: () => void; onDone: (m: string, tone?: NoticeTone) => void }> = ({ agentId, ask, canDecide, onClose, onDone }) => {
  const [versions, setVersions] = useState<string[] | null>(null);
  const [version, setVersion] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    factoryApi
      .getSkill(ask.skillId)
      .then((s) => {
        if (!live) return;
        const v = choosableVersions(s.versions, ask.current);
        setVersions(v);
        setVersion(defaultVersion(v, ask.current));
      })
      .catch((e: unknown) => live && (setVersions([]), setError(errorText(e))));
    return () => {
      live = false;
    };
  }, [ask.skillId, ask.current]);

  const back = !!ask.current && !!version && isRollBack(ask.current, version);
  // Until a version is chosen the dialog does not say upgrade or roll back: it does not know which it is.
  const verb = !ask.current ? 'Adopt' : !version ? 'Change' : back ? 'Roll back' : 'Upgrade';
  const text = reason.trim() || undefined;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await factoryApi.requestAdoption(agentId, ask.skillId, version, text);
      if (!canDecide) {
        onDone(`Asked for ${ask.skillId}@${version} for ${agentId}. An admin decides it; nothing changes until then.`);
        return;
      }
      try {
        await factoryApi.approveAdoption(agentId, ask.skillId, text);
      } catch (err) {
        onDone(`Asked for ${ask.skillId}@${version} for ${agentId}, but approving it failed (${errorText(err)}). The request is still waiting under Pending, and nothing has changed on ${agentId}.`, 'warn');
        return;
      }
      onDone(`${agentId} is being rebuilt with ${ask.skillId}@${version}.`);
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      setError(body?.error === 'already_adopted' ? `${agentId} already runs ${ask.skillId}@${version}.` : body?.error === 'skill_retired' ? 'This skill is retired, so it can no longer be adopted.' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={verb === 'Change' ? `Change the version of ${ask.name} on ${agentId}` : `${verb} ${ask.name} on ${agentId}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={btnPrimary} data-autofocus onClick={submit} disabled={busy || !version}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
            {canDecide ? `${verb} now` : 'Ask for it'}
          </button>
        </>
      }
    >
      {versions === null ? (
        <p className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the approved versions…
        </p>
      ) : versions.length === 0 ? (
        <p>{ask.current ? `There is no other approved version of ${ask.skillId} to move to.` : `${ask.skillId} has no approved version.`}</p>
      ) : (
        <label className="block space-y-1">
          <span className={label}>Version</span>
          <select className={input} value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
            {!version && <option value="">Choose a version</option>}
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === versions[0] && !ask.current ? ' (newest)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        {canDecide
          ? `This asks for the version and approves it in one step. ${agentId}’s configuration gets a new version and ${agentId} is rebuilt; the factory does this, with no change to any repository.`
          : `An admin decides this. Adopting a skill adds access, so the request waits for them; ${agentId} is rebuilt only once it is approved.`}
      </p>
      {back && <p className="text-amber-700 dark:text-amber-400">This goes back to an older version.</p>}
      <label className="block space-y-1">
        <span className={label}>Reason (optional)</span>
        <textarea className={`${input} h-16`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the ledger" />
      </label>
      {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
    </Dialog>
  );
};

/** Withdraws a request that is waiting. Nothing is built: the agent keeps what it runs. */
const CancelDialog: React.FC<{ agentId: string; skillId: string; version: string; onClose: () => void; onDone: (m: string) => void }> = ({ agentId, skillId, version, onClose, onDone }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await factoryApi.removeAdoption(agentId, skillId);
      onDone(`Cancelled the request for ${skillId}@${version}. Nothing changed on ${agentId}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Cancel the request for ${skillId}`}
      tone="danger"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button className={btnDanger} data-autofocus onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            Cancel request
          </button>
        </>
      }
    >
      <p>
        The request for <span className="font-mono">{skillId}@{version}</span> ends. {agentId} keeps what it runs and nothing is built.
      </p>
      {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
    </Dialog>
  );
};

type NoticeTone = 'ok' | 'warn';

const Section: React.FC<{ title: string; count: number; hint?: string; children: React.ReactNode }> = ({ title, count, hint, children }) => (
  <section className={`${card} p-4 space-y-3`}>
    <div className="flex items-baseline justify-between gap-3">
      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">
        {title} <span className="text-slate-400 font-normal">({count})</span>
      </h4>
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
    {count === 0 ? <p className="text-[11px] text-slate-500 italic">None.</p> : children}
  </section>
);

export const AgentSkillsTab: React.FC<{ agent: AgentRecord; onRefresh: () => void | Promise<void> }> = ({ agent, onRefresh }) => {
  const { user } = useAuth();
  const { canDecideAdoptions } = usePermissions();
  const [data, setData] = useState<AgentSkills | null>(null);
  const [owners, setOwners] = useState<string[]>([]);
  const latest = useRef({ load: async () => {}, onRefresh: (() => {}) as () => void | Promise<void> });
  const loadSeq = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [adoption, setAdoption] = useState<AdoptionAction | null>(null);
  const [cancel, setCancel] = useState<{ skillId: string; version: string } | null>(null);
  const mounted = useRef(true);
  const startedFollowing = useRef<number | null>(null);

  // Only the newest load may write: an older one that answers late (a slow response, or another click on Refresh) is dropped.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const current = () => mounted.current && seq === loadSeq.current;
    setRefreshing(true);
    try {
      const [skills, o] = await Promise.all([
        factoryApi.getAgentSkills(agent.id),
        // An owners failure is shown, not turned into "no owners": that would hide every action from an owner without a word.
        factoryApi.getOwners(agent.id).then((list) => ({ list, error: null as string | null }), (e: unknown) => ({ list: [] as string[], error: errorText(e) })),
      ]);
      if (!current()) return;
      setData(skills);
      setOwners(o.list);
      setOwnersError(o.error);
      setLoadError(null);
    } catch (err) {
      if (current()) setLoadError(errorText(err));
    } finally {
      if (current()) setRefreshing(false);
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    setData(null);
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const perms = permsFor({ isAdmin: canDecideAdoptions, isOwner: isOwnerOf(owners, user.email) });
  const rows = data ? agentSkillRows(data, perms) : null;
  const rebuild = rebuildState(agent, data?.adopted ?? []);

  latest.current = { load, onRefresh };

  // While the agent is rebuilt, follow it: the list and the agent's state, every few seconds, then every half minute if it
  // is still going after ten minutes (never stopping while the banner says rebuilding). It depends only on whether a rebuild
  // is on, so a parent that re-renders (or passes a new callback) cannot restart or stall it.
  const rebuilding = rebuild.kind === 'rebuilding';
  useEffect(() => {
    if (!rebuilding) {
      startedFollowing.current = null;
      return;
    }
    startedFollowing.current ??= Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      void latest.current.load();
      void latest.current.onRefresh();
      const slow = Date.now() - (startedFollowing.current ?? Date.now()) > REBUILD_FOLLOW_MAX_MS;
      timer = setTimeout(tick, slow ? REBUILD_SLOW_POLL_MS : REBUILD_POLL_MS);
    };
    timer = setTimeout(tick, REBUILD_POLL_MS);
    return () => clearTimeout(timer);
  }, [rebuilding]);

  const done = (message: string, tone: NoticeTone = 'ok') => {
    setAsk(null);
    setAdoption(null);
    setCancel(null);
    setNotice({ text: message, tone });
    void load();
    void onRefresh();
  };

  const banner = rebuildText(rebuild);
  const adoptedAction = (kind: AdoptionAction['kind'], row: AdoptedRow) => setAdoption({ kind, skill: summaryOf(row.id, data), adopter: { agentId: agent.id, version: row.version, state: 'approved' } });

  return (
    <div className="space-y-4" data-testid="agent-skills">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl">
          The skills {agent.name} runs, and what it could be given. Changing them is a configuration change the factory builds and deploys: no pull request on any repository. A skill never grants access by itself; {agent.name}’s policy still names the routes it may use.
        </p>
        <button className={btnQuiet} onClick={() => void load()} disabled={refreshing} title="Refresh the list">
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {banner && (
        <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 border ${rebuild.kind === 'rebuilding' ? 'bg-sky-50 text-sky-900 border-sky-300 dark:bg-sky-950/40 dark:text-sky-200 dark:border-sky-800' : 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800'}`} role="status">
          {rebuild.kind === 'rebuilding' ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Clock className="w-3.5 h-3.5 shrink-0" />}
          {banner}
        </div>
      )}
      {notice && (
        <div className={`text-xs rounded-lg px-3 py-2 border flex justify-between gap-3 ${notice.tone === 'warn' ? 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800' : 'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-800'}`} role="status">
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="underline shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {loadError && <p className="text-xs text-rose-600 dark:text-rose-400">Could not load the skills: {loadError}</p>}
      {!rows && !loadError && (
        <p className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </p>
      )}

      {rows && (
        <>
          <Section title="Adopted" count={rows.adopted.length} hint="in its configuration">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.adopted.map((r) => (
                <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2" data-testid={`adopted-${r.id}`}>
                  <div className="text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{r.id}</span> <span className="font-mono text-slate-500">{r.version}</span>
                    {r.updateTo && <span className="ml-2 px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-sky-50 text-sky-800 border-sky-300 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800">update available: {r.updateTo}</span>}
                    <div className="text-[11px] text-slate-500">{r.source}{r.approvedAt ? ` · ${when(r.approvedAt)}` : ''}</div>
                  </div>
                  <div className="flex gap-2">
                    {r.offer.upgrade && (
                      <button className={btnPrimary} onClick={() => setAsk({ skillId: r.id, name: summaryOf(r.id, data).name, current: r.version })}>
                        <ArrowUpCircle className="w-3.5 h-3.5" /> Upgrade
                      </button>
                    )}
                    {r.offer.rollBack && (
                      <button className={btnQuiet} onClick={() => setAsk({ skillId: r.id, name: summaryOf(r.id, data).name, current: r.version })}>
                        <RotateCcw className="w-3.5 h-3.5" /> Change version
                      </button>
                    )}
                    {r.offer.remove && (
                      <button className={btnQuiet} onClick={() => adoptedAction('remove', r)}>
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Pending" count={rows.pending.length} hint="waiting for an admin">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.pending.map((p) => (
                <li key={p.skillId} className="py-2 flex flex-wrap items-center justify-between gap-2" data-testid={`pending-${p.skillId}`}>
                  <div className="text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{p.skillId}</span> <span className="font-mono text-slate-500">{p.version}</span>
                    <div className="text-[11px] text-slate-500">
                      asked by {p.requestedBy ?? 'unknown'}
                      {p.requestedAt ? ` · ${when(p.requestedAt)}` : ''}
                      {p.reason ? ` · “${p.reason}”` : ''}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {p.offer.approve && (
                      <button className={btnPrimary} onClick={() => setAdoption({ kind: 'approve', skill: summaryOf(p.skillId, data), adopter: { agentId: agent.id, version: p.version, state: 'requested', ...(p.requestedBy ? { requestedBy: p.requestedBy } : {}) } })}>
                        Approve
                      </button>
                    )}
                    {p.offer.reject && (
                      <button className={btnQuiet} onClick={() => setAdoption({ kind: 'reject', skill: summaryOf(p.skillId, data), adopter: { agentId: agent.id, version: p.version, state: 'requested', ...(p.requestedBy ? { requestedBy: p.requestedBy } : {}) } })}>
                        Reject
                      </button>
                    )}
                    {p.offer.cancel && (
                      <button className={btnQuiet} onClick={() => setCancel({ skillId: p.skillId, version: p.version })}>
                        <XCircle className="w-3.5 h-3.5" /> Cancel request
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Available" count={rows.available.length} hint="newest approved version">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.available.map((s) => (
                <li key={s.id} className="py-2 flex flex-wrap items-center justify-between gap-2" data-testid={`available-${s.id}`}>
                  <div className="text-xs max-w-xl">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{s.name}</span> <span className="font-mono text-slate-500">{s.id}@{s.version}</span>{' '}
                    <VisibilityBadge visibility={s.visibility} />
                    <div className="text-[11px] text-slate-500">{s.description}</div>
                  </div>
                  {s.offer.request && (
                    <button className={btnPrimary} onClick={() => setAsk({ skillId: s.id, name: s.name })}>
                      <Plus className="w-3.5 h-3.5" /> {perms.canDecide ? 'Adopt' : 'Ask for it'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Section>

          {rows.refused.length > 0 && (
            <Section title="Removed private skills" count={rows.refused.length} hint="not adopted again by themselves">
              <ul className="text-[11px] text-slate-500 space-y-1">
                {rows.refused.map((r) => (
                  <li key={r.skillId} className="flex items-center gap-2">
                    <ArrowDownToLine className="w-3 h-3" /> <span className="font-mono">{r.skillId}</span> was removed; a new version is adopted only if it is asked for again and an admin approves.
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {ownersError && !canDecideAdoptions && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Could not read {agent.name}’s owners ({ownersError}), so the buttons that change its skills are hidden. Refresh to try again.
        </p>
      )}
      {!perms.canManage && !ownersError && rows && <p className="text-[11px] text-slate-500">Only {agent.name}’s owners and admins can change its skills.</p>}

      {ask && <RequestDialog agentId={agent.id} ask={ask} canDecide={perms.canDecide} onClose={() => setAsk(null)} onDone={done} />}
      {adoption && <AdoptionDialog action={adoption} onClose={() => setAdoption(null)} onDone={(m) => done(m)} />}
      {cancel && <CancelDialog agentId={agent.id} skillId={cancel.skillId} version={cancel.version} onClose={() => setCancel(null)} onDone={(m) => done(m)} />}
    </div>
  );
};
