import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Puzzle, RefreshCw } from 'lucide-react';
import type { SkillSummary, SkillVersion } from '../api/types.js';
import { ApiError, factoryApi } from '../api/client.js';
import { usePermissions } from '../auth/usePermissions.js';
import { RegisterForm } from './skills/RegisterForm.js';
import { SkillCard } from './skills/SkillCard.js';
import { AdoptionDialog, DecisionDialog, RetireDialog, type AdoptionAction, type Decision } from './skills/dialogs.js';
import {
  adoptionRequestCount,
  errorText,
  filterSkills,
  key,
  openByDefault,
  queueCount,
  shortSha,
  visibilityCounts,
  type VisibilityFilter,
} from './skills/skills-model.js';
import { btnQuiet, card, input } from './skills/ui.js';

/**
 * The skill registry and catalog (DESIGN_AUTHORITY.md §6.14 SK1 to SK7). Every signed-in user sees the catalog and can
 * register a skill by repository, path and commit; the control plane reads `skill.yaml` at that pin itself. Only an
 * admin approves (after the factory's checks pass), rejects, revokes, retires, re-runs checks, or decides an agent's
 * adoption. A private skill appears only to admins and its owner agent's owners; the control plane decides that, and
 * enforces every role: this screen only hides what a role cannot do.
 *
 * What the screen shows and offers is decided in `skills/skills-model.ts` (tested); the pieces it draws are in `skills/`.
 *
 * Polling is light (GAP-056): the catalog once a minute while this screen is open and the tab is visible, plus the
 * expanded skills' records; a version whose checks were started here is followed every 10 seconds until they end.
 */

const LIST_POLL_MS = 60_000;
const CHECK_POLL_MS = 10_000;
const CHECK_FOLLOW_MAX_MS = 30 * 60_000;

export const SkillsView: React.FC = () => {
  const { canDecideSkills, canDecideAdoptions, canRetireSkills } = usePermissions();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, SkillSummary>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState<Map<string, number>>(new Map());
  const [decision, setDecision] = useState<Decision | null>(null);
  const [adoption, setAdoption] = useState<AdoptionAction | null>(null);
  const [retiring, setRetiring] = useState<SkillSummary | null>(null);
  const [filter, setFilter] = useState<VisibilityFilter>('all');
  const [query, setQuery] = useState('');
  const [registering, setRegistering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const firstLoad = useRef(true);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await factoryApi.getSkill(id);
      setDetails((prev) => ({ ...prev, [id]: d }));
    } catch (err) {
      setError(`Could not load ${id}: ${errorText(err)}`);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await factoryApi.listSkills();
      setSkills(list);
      setError(null);
      let open = expandedRef.current;
      if (firstLoad.current) {
        // Open the approval queue: skills with a version waiting on a decision.
        firstLoad.current = false;
        open = new Set(openByDefault(list));
        setExpanded(open);
      }
      await Promise.all([...open].filter((id) => list.some((s) => s.id === id)).map(loadDetail));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [loadDetail]);

  // The catalog once a minute, only while this screen is open and the tab is visible (GAP-056).
  useEffect(() => {
    load();
    const tick = () => document.visibilityState === 'visible' && load();
    const interval = setInterval(tick, LIST_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  // Versions whose checks were started from this screen: refresh just that version until its checks end.
  useEffect(() => {
    if (!following.size) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const done: string[] = [];
      for (const [k, since] of following) {
        const at = k.lastIndexOf('@');
        const [id, version] = [k.slice(0, at), k.slice(at + 1)];
        try {
          const rec = await factoryApi.getSkillVersion(id, version);
          setDetails((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], versions: prev[id].versions.map((v) => (v.version === version ? rec : v)) } } : prev));
          setSkills((prev) =>
            prev?.map((s) => (s.id === id ? { ...s, versions: s.versions.map((v) => (v.version === version ? { ...v, ...rec, manifest: undefined } : v)) } : s)) ?? prev,
          );
          if (rec.tests !== 'pending-build') {
            done.push(k);
            setNotice(`Checks ${rec.tests === 'passed' ? 'passed' : 'failed'} for ${k}.`);
          } else if (Date.now() - since > CHECK_FOLLOW_MAX_MS) done.push(k);
        } catch {
          done.push(k);
        }
      }
      if (done.length) {
        setFollowing((prev) => {
          const next = new Map(prev);
          done.forEach((k) => next.delete(k));
          return next;
        });
        load();
      }
    };
    const interval = setInterval(check, CHECK_POLL_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
    };
  }, [following, load]);

  const follow = (id: string, version: string) => setFollowing((prev) => new Map(prev).set(key(id, version), Date.now()));

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      loadDetail(id);
    }
    setExpanded(next);
  };

  const rerun = async (v: SkillVersion) => {
    setNotice(null);
    try {
      await factoryApi.rerunSkillChecks(v.id, v.version);
      setNotice(`Checks started for ${v.id}@${v.version}.`);
      follow(v.id, v.version);
      load();
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      setError(`Could not re-run the checks for ${v.id}@${v.version}: ${body?.message ?? errorText(err)}`);
    }
  };

  const onRegistered = (v: SkillVersion) => {
    setRegistering(false);
    setNotice(
      `Registered ${v.id}@${v.version} at ${shortSha(v.commit)}${v.resolvedFrom ? ` (resolved from ${v.resolvedFrom})` : ''}. ${
        v.checkRun ? 'The factory is checking it now.' : 'It waits for the factory’s checks before an admin can approve it.'
      }`,
    );
    setExpanded((prev) => new Set(prev).add(v.id));
    if (v.checkRun) follow(v.id, v.version);
    load().then(() => loadDetail(v.id));
  };

  const queue = queueCount(skills ?? []);
  const requests = adoptionRequestCount(skills ?? []);
  const counts = visibilityCounts(skills ?? []);
  const shown = filterSkills(skills ?? [], filter, query);

  return (
    <div className="space-y-6">
      <div className={`${card} p-4 flex flex-col md:flex-row md:items-center justify-between gap-4`}>
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/40 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
            <Puzzle className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">Skills</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tools agents adopt through the factory. A public skill can be given to any agent; a private one belongs to a single agent. Each version is pinned to a commit, checked by the factory, and approved by an admin.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {queue > 0 && <span className="font-semibold text-amber-700 dark:text-amber-400">{queue} awaiting approval</span>}
          {requests > 0 && <span className="font-semibold text-amber-700 dark:text-amber-400">{requests} adoption request{requests === 1 ? '' : 's'}</span>}
          <button
            className={btnQuiet}
            onClick={() => {
              setNotice(null);
              setRegistering((r) => !r);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Register a skill
          </button>
          <button onClick={load} className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!canDecideSkills && <p className="text-xs text-slate-500 dark:text-slate-400">Anyone signed in can register a skill. Only admins approve, reject, revoke, retire, re-run checks or decide an agent’s adoption.</p>}
      {notice && (
        <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-lg px-3 py-2">{notice}</div>
      )}
      {error && <div className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-lg px-3 py-2">{error}</div>}

      {registering && <RegisterForm onRegistered={onRegistered} onClose={() => setRegistering(false)} />}

      {skills && skills.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div role="tablist" aria-label="Skill visibility" className="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden text-xs font-semibold">
            {(['all', 'public', 'private'] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 transition ${filter === f ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              >
                {f === 'all' ? 'All' : f === 'public' ? 'Public' : 'Private'} <span className="opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          <input
            className={`${input} sm:max-w-xs`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, id or owner"
            aria-label="Search skills"
          />
        </div>
      )}

      {skills && skills.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">No skills are registered yet. Register one by repository, path and commit.</p>}
      {skills && skills.length > 0 && shown.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {query.trim() ? `No ${filter === 'all' ? '' : `${filter} `}skills match “${query.trim()}”.` : `No ${filter} skills.`}
        </p>
      )}
      <div className="space-y-3">
        {shown.map((s) => (
          <SkillCard
            key={s.id}
            summary={s}
            detail={details[s.id]}
            expanded={expanded.has(s.id)}
            onToggle={() => toggle(s.id)}
            canDecide={canDecideSkills}
            canRetireSkills={canRetireSkills}
            following={new Set(following.keys())}
            onDecide={(d) => {
              setNotice(null);
              setDecision(d);
            }}
            onRerun={rerun}
            onAdoption={(a) => {
              setNotice(null);
              setAdoption(a);
            }}
            onRetire={(sk) => {
              setNotice(null);
              setRetiring(sk);
            }}
          />
        ))}
      </div>

      {adoption && (
        <AdoptionDialog
          action={adoption}
          onClose={() => setAdoption(null)}
          onDone={(message) => {
            setAdoption(null);
            setNotice(message);
            load();
          }}
        />
      )}

      {retiring && (
        <RetireDialog
          skill={retiring}
          adopters={retiring.adopters ?? []}
          onClose={() => setRetiring(null)}
          onDone={(message) => {
            setRetiring(null);
            setNotice(message);
            load();
          }}
        />
      )}

      {decision && (
        <DecisionDialog
          decision={decision}
          onClose={() => setDecision(null)}
          onDone={(message) => {
            setDecision(null);
            setNotice(message);
            load();
          }}
        />
      )}
    </div>
  );
};
