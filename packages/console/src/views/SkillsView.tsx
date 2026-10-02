import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  GitCommit,
  Loader2,
  PauseCircle,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  XCircle,
} from 'lucide-react';
import type { SkillRequires, SkillSummary, SkillVersion } from '../api/types.js';
import { ApiError, factoryApi } from '../api/client.js';
import { usePermissions } from '../auth/usePermissions.js';
import { Dialog } from '../components/Dialog.js';

/**
 * TSK-055 (DESIGN_AUTHORITY.md §6.14 SK1, SK2): the skill registry. Every signed-in user sees the catalog and can
 * register a skill by repository, path and commit; the control plane reads `skill.yaml` at that pin itself. Only an
 * admin approves (after the factory's checks pass), rejects or revokes, and re-runs checks. The control plane enforces
 * every role; this screen only hides what a role cannot do.
 *
 * Polling is light (GAP-056): the catalog once a minute while this screen is open and the tab is visible, plus the
 * expanded skills' records; a version whose checks were started here is followed every 10 seconds until they end.
 */

const LIST_POLL_MS = 60_000;
const CHECK_POLL_MS = 10_000;
const CHECK_FOLLOW_MAX_MS = 30 * 60_000;

type StatusKey = 'pending' | 'running' | 'passed' | 'failed' | 'approved' | 'rejected' | 'revoked';

const STATUS: Record<StatusKey, { label: string; className: string; icon: React.ReactNode }> = {
  pending: {
    label: 'Pending',
    className: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
    icon: <CircleDashed className="w-3 h-3" />,
  },
  running: {
    label: 'Checks running',
    className: 'bg-sky-50 text-sky-800 border-sky-300 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-800',
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  passed: {
    label: 'Checks passed',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  failed: {
    label: 'Checks failed',
    className: 'bg-rose-50 text-rose-800 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800',
    icon: <XCircle className="w-3 h-3" />,
  },
  approved: {
    label: 'Approved',
    className: 'bg-emerald-600 text-white border-emerald-700 dark:bg-emerald-600 dark:text-white dark:border-emerald-500',
    icon: <ShieldCheck className="w-3 h-3" />,
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-slate-200 text-slate-700 border-slate-400 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-600',
    icon: <XCircle className="w-3 h-3" />,
  },
  revoked: {
    label: 'Revoked',
    className: 'bg-rose-100 text-rose-800 border-rose-400 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-700',
    icon: <ShieldOff className="w-3 h-3" />,
  },
};

export function statusOf(v: Pick<SkillVersion, 'status' | 'tests' | 'checkRun' | 'revoked'>): StatusKey {
  if (v.status === 'approved') return 'approved';
  if (v.status === 'rejected') return v.revoked ? 'revoked' : 'rejected';
  if (v.tests === 'passed') return 'passed';
  if (v.tests === 'failed') return 'failed';
  return v.checkRun ? 'running' : 'pending';
}

const StatusBadge: React.FC<{ status: StatusKey }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border ${STATUS[status].className}`}>
    {STATUS[status].icon}
    {STATUS[status].label}
  </span>
);

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
const shortSha = (sha: string) => sha.slice(0, 7);
const key = (id: string, version: string) => `${id}@${version}`;

/** A browsable link for the pin: GitHub-style `tree/<sha>/<path>` on github.com, the repository itself elsewhere. */
function sourceLinks(v: Pick<SkillVersion, 'repo' | 'path' | 'commit'>): { repo: string; pin: string } {
  const base = v.repo.replace(/\.git$/, '').replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    // shown as text only
  }
  const pin = host === 'github.com' ? `${base}/tree/${v.commit}${v.path === '.' ? '' : `/${v.path}`}` : base;
  return { repo: base, pin };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`;
const btnDanger = `${btn} bg-rose-600 hover:bg-rose-500 text-white`;
const btnQuiet = `${btn} bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700`;
const input =
  'w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-500';
const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm transition-colors';
const label = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

const Requirements: React.FC<{ requires?: SkillRequires }> = ({ requires }) => {
  if (!requires) return <p className="text-[11px] text-slate-500">Loading requirements…</p>;
  const none = !requires.routes.length && !requires.connections.length && !requires.credentials.length && !requires.models.length;
  if (none) return <p className="text-[11px] text-slate-500">Declares no routes, connections, credentials or models.</p>;
  const chip = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300';
  const row = (name: string, items: React.ReactNode[]) =>
    items.length > 0 && (
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 w-24 shrink-0">{name}</span>
        {items}
      </div>
    );
  return (
    <div className="space-y-1">
      {row('Routes', requires.routes.map((r) => <span key={r} className={chip}>{r}</span>))}
      {row(
        'Connections',
        requires.connections.map((c) => (
          <span key={c.provider} className={chip} title={c.scopes.join('\n')}>
            {c.provider}
            {c.scopes.length ? ` · ${c.scopes.join(', ')}` : ' · no scopes'}
          </span>
        )),
      )}
      {row(
        'Credentials',
        requires.credentials.map((c) => (
          <span key={c.name} className={chip} title={c.description}>
            {c.name}
            {c.source ? ` (${c.source})` : ''}
          </span>
        )),
      )}
      {row('Models', requires.models.map((m) => <span key={m} className={chip}>{m}</span>))}
      <p className="text-[10px] text-slate-500">A request, never a grant: an agent's policy decides what the skill may use (SK2, E7).</p>
    </div>
  );
};

type Decision = { kind: 'approve' | 'reject'; skill: SkillSummary; version: SkillVersion };

/**
 * Approve: an optional reason, then a confirmation. Reject or revoke: a reason. Revoking a version in use is refused
 * with the agents listed; "Revoke anyway" pauses them, behind a second confirmation that names them (SK1).
 */
const DecisionDialog: React.FC<{ decision: Decision; onClose: () => void; onDone: (message: string) => void }> = ({ decision, onClose, onDone }) => {
  const { kind, skill, version: v } = decision;
  const revoke = kind === 'reject' && v.status === 'approved';
  const [step, setStep] = useState<'form' | 'confirm' | 'in_use' | 'force'>('form');
  const [reason, setReason] = useState('');
  const [agents, setAgents] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = `${v.id}@${v.version}`;

  const submit = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await factoryApi.approveSkill(v.id, v.version, reason.trim() || undefined);
        onDone(`Approved ${name}. Agent owners can now adopt it.`);
      } else {
        const res = await factoryApi.rejectSkill(v.id, v.version, reason.trim(), force);
        const paused = res.paused ?? [];
        onDone(revoke ? `Revoked ${name}.${paused.length ? ` Paused ${paused.join(', ')} until each is redeployed without it.` : ''}` : `Rejected ${name}.`);
      }
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      if (err instanceof ApiError && err.status === 409 && body?.error === 'skill_in_use') {
        setAgents(Array.isArray(body.agents) ? body.agents.map(String) : []);
        setAcknowledged(false);
        setStep('in_use');
      } else if (body?.error === 'checks_failed') {
        setError(`The factory's checks failed: ${(body.failures ?? []).join('; ') || 'see the version'}.`);
      } else if (body?.error === 'checks_pending') {
        setError("The factory's checks have not passed yet; approval waits for them.");
      } else {
        setError(body?.message ? `${errorText(err)}: ${body.message}` : errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const pin = (
    <div className="font-mono text-[11px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 space-y-0.5">
      <div className="font-semibold text-slate-800 dark:text-slate-200">{name}</div>
      <div className="text-slate-500 break-all">
        {sourceLinks(v).repo} · {v.path} · {shortSha(v.commit)}
      </div>
    </div>
  );
  const errorBox = error && (
    <p className="text-[11px] text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded px-2 py-1.5">{error}</p>
  );
  const cancel = (
    <button className={btnQuiet} onClick={onClose} disabled={busy}>
      Cancel
    </button>
  );
  const spinner = busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null;

  if (kind === 'approve') {
    return (
      <Dialog
        title={step === 'form' ? `Approve ${skill.name} ${v.version}` : 'Confirm approval'}
        onClose={onClose}
        busy={busy}
        footer={
          step === 'form' ? (
            <>
              {cancel}
              <button className={btnPrimary} onClick={() => setStep('confirm')}>
                Continue
              </button>
            </>
          ) : (
            <>
              <button className={btnQuiet} onClick={() => setStep('form')} disabled={busy}>
                Back
              </button>
              <button className={btnPrimary} data-autofocus onClick={() => submit()} disabled={busy}>
                {spinner}
                <ShieldCheck className="w-3.5 h-3.5" />
                Approve {v.version}
              </button>
            </>
          )
        }
      >
        {pin}
        {step === 'form' ? (
          <>
            <p>The factory's checks on this commit passed. Approving lets agent owners adopt this version, always within each agent's policy.</p>
            <Requirements requires={v.manifest?.requires} />
            <label className="block space-y-1">
              <span className={label}>Reason (optional)</span>
              <textarea className={`${input} h-20`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. reviewed at the pinned commit" />
            </label>
          </>
        ) : (
          <>
            <p>
              Approve <strong className="font-mono">{name}</strong> at commit <span className="font-mono">{shortSha(v.commit)}</span>?
            </p>
            {reason.trim() && <p className="text-slate-500">Reason: {reason.trim()}</p>}
            <p className="text-slate-500">The approval is recorded in the ledger under your name.</p>
          </>
        )}
        {errorBox}
      </Dialog>
    );
  }

  const verb = revoke ? 'Revoke' : 'Reject';
  if (step === 'form') {
    return (
      <Dialog
        title={`${verb} ${skill.name} ${v.version}`}
        tone="danger"
        onClose={onClose}
        busy={busy}
        footer={
          <>
            {cancel}
            <button className={btnDanger} onClick={() => submit()} disabled={busy || !reason.trim()}>
              {spinner}
              {revoke ? <ShieldOff className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
              {verb} {v.version}
            </button>
          </>
        }
      >
        {pin}
        <p>
          {revoke
            ? 'Revoking an approved version stops any agent from adopting it. If an agent uses it, the factory refuses until that agent is redeployed without it, and you will be shown which agents.'
            : 'A rejected version can never be adopted. Register a new version to try again.'}
        </p>
        <label className="block space-y-1">
          <span className={label}>Reason (required)</span>
          <textarea className={`${input} h-20`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Why; the author sees this" />
        </label>
        {errorBox}
      </Dialog>
    );
  }

  const agentList = (
    <ul className="space-y-1">
      {agents.map((a) => (
        <li key={a} className="flex items-center gap-2 font-mono text-[11px] bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded px-2 py-1">
          <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
          {a}
        </li>
      ))}
    </ul>
  );

  if (step === 'in_use') {
    return (
      <Dialog
        title={`${name} is in use`}
        tone="danger"
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button className={btnQuiet} onClick={onClose} data-autofocus>
              Keep it approved
            </button>
            <button className={btnDanger} onClick={() => setStep('force')}>
              <AlertTriangle className="w-3.5 h-3.5" />
              Revoke anyway and pause these agents
            </button>
          </>
        }
      >
        <p>
          The factory refused: {agents.length === 1 ? 'this agent’s' : `these ${agents.length} agents’`} deployed configuration uses <strong className="font-mono">{name}</strong>.
        </p>
        {agentList}
        <p>The safe path is to redeploy {agents.length === 1 ? 'it' : 'them'} without this version first, then revoke it.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Revoke and pause agents"
      tone="danger"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={() => setStep('in_use')} disabled={busy}>
            Back
          </button>
          <button className={btnDanger} onClick={() => submit(true)} disabled={busy || !acknowledged}>
            {spinner}
            <ShieldOff className="w-3.5 h-3.5" />
            Revoke and pause {agents.length} agent{agents.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p>
        This revokes <strong className="font-mono">{name}</strong> now and pauses:
      </p>
      {agentList}
      <p>Each stays paused until it is redeployed without this version. The revocation and every pause are recorded in the ledger under your name.</p>
      <label className="flex items-start gap-2 text-[11px] font-semibold text-rose-800 dark:text-rose-300">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I understand that {agents.join(', ')} will be paused.</span>
      </label>
      <p className="text-slate-500">Reason: {reason.trim()}</p>
      {errorBox}
    </Dialog>
  );
};

/** Register by repository, path and commit (SHA, branch or tag). The control plane reads skill.yaml at that pin. */
const RegisterForm: React.FC<{ onRegistered: (v: SkillVersion) => void; onClose: () => void }> = ({ onRegistered, onClose }) => {
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('.');
  const [commit, setCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setReasons([]);
    try {
      onRegistered(await factoryApi.registerSkill({ repo: repo.trim(), path: path.trim() || '.', commit: commit.trim() }));
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      setReasons(Array.isArray(body?.reasons) && body.reasons.length ? body.reasons.map(String) : [errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={`${card} p-4 space-y-3 border-emerald-300 dark:border-emerald-800/70`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">Register a skill</h3>
        <button type="button" className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Name where the skill lives. The factory reads <span className="font-mono">skill.yaml</span> in that folder at that commit with its own read-only source token, pins the
        exact commit (a branch or tag is resolved to its SHA now), and starts its checks. An admin approves it once the checks pass.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] gap-3">
        <label className="space-y-1">
          <span className={label}>Repository URL</span>
          <input className={`${input} font-mono`} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/your-org/skill-name" required />
        </label>
        <label className="space-y-1">
          <span className={label}>Path</span>
          <input className={`${input} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="." />
        </label>
        <label className="space-y-1">
          <span className={label}>Commit, branch or tag</span>
          <input className={`${input} font-mono`} value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="main, v1.2.0 or a full SHA" required />
        </label>
      </div>
      {reasons.length > 0 && (
        <div className="text-[11px] text-rose-800 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-lg px-3 py-2 space-y-1">
          <div className="font-semibold">Not registered:</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {reasons.map((r, i) => (
              <li key={i} className="font-mono">{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end">
        <button type="submit" className={btnPrimary} disabled={busy || !repo.trim() || !commit.trim()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {busy ? 'Reading skill.yaml…' : 'Register'}
        </button>
      </div>
    </form>
  );
};

const VersionRow: React.FC<{
  skill: SkillSummary;
  version: SkillVersion;
  isLatestApproved: boolean;
  canDecide: boolean;
  following: boolean;
  onDecide: (d: Decision) => void;
  onRerun: (v: SkillVersion) => void;
}> = ({ skill, version: v, isLatestApproved, canDecide, following, onDecide, onRerun }) => {
  const status = statusOf(v);
  const links = sourceLinks(v);
  const decided = v.status !== 'pending' && v.decidedBy;
  const approveTitle =
    v.tests === 'passed' ? 'Approve this version' : v.tests === 'failed' ? 'The checks failed: this version cannot be approved' : 'Approval waits for the checks to pass';
  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center flex-wrap gap-2">
            <span className="font-mono text-sm font-bold text-slate-900 dark:text-white">{v.version}</span>
            <StatusBadge status={status} />
            {isLatestApproved && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                Latest approved
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-1.5">
            <GitCommit className="w-3.5 h-3.5" />
            <a href={links.pin} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-0.5" title={v.commit}>
              {shortSha(v.commit)}
              <ExternalLink className="w-3 h-3" />
            </a>
            <span>·</span>
            <span className="font-mono">{v.path === '.' ? 'repository root' : v.path}</span>
            <span>·</span>
            <span>
              registered by <span className="font-medium text-slate-700 dark:text-slate-300">{v.registeredBy}</span> {when(v.registeredAt)}
            </span>
          </div>
          {decided && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {STATUS[status].label} by <span className="font-medium text-slate-700 dark:text-slate-300">{v.decidedBy}</span> {when(v.decidedAt)}
              {v.reason && (
                <>
                  : <span className="italic text-slate-700 dark:text-slate-300">“{v.reason}”</span>
                </>
              )}
            </div>
          )}
        </div>
        {canDecide && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {v.status === 'pending' && (
              <>
                <button className={btnQuiet} onClick={() => onRerun(v)} disabled={following} title="Run the factory's checks on this commit again">
                  <RotateCcw className={`w-3.5 h-3.5 ${following ? 'animate-spin' : ''}`} />
                  {following ? 'Checking…' : 'Re-run checks'}
                </button>
                <button className={btnQuiet} onClick={() => onDecide({ kind: 'reject', skill, version: v })}>
                  <XCircle className="w-3.5 h-3.5" />
                  Reject
                </button>
                <button className={btnPrimary} onClick={() => onDecide({ kind: 'approve', skill, version: v })} disabled={v.tests !== 'passed'} title={approveTitle}>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Approve
                </button>
              </>
            )}
            {v.status === 'approved' && (
              <button className={`${btnQuiet} text-rose-700 dark:text-rose-400`} onClick={() => onDecide({ kind: 'reject', skill, version: v })}>
                <ShieldOff className="w-3.5 h-3.5" />
                Revoke
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
          <div className={label}>Factory checks</div>
          {status === 'running' || (v.tests === 'pending-build' && v.checkRun) ? (
            <p className="text-[11px] text-sky-700 dark:text-sky-300 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Running since {when(v.checkRun?.startedAt)} ({v.checkRun?.checker}, started by {v.checkRun?.startedBy})
            </p>
          ) : v.tests === 'pending-build' ? (
            <p className="text-[11px] text-slate-500">Not run: no checker has picked this version up. An admin can re-run the checks.</p>
          ) : v.tests === 'passed' ? (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Passed {when(v.checks?.at)}: builds, tests pass, no secrets, hosts or provider SDKs.
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] text-rose-700 dark:text-rose-400 flex items-center gap-1.5">
                <XCircle className="w-3.5 h-3.5" />
                Failed {when(v.checks?.at)}
              </p>
              <ul className="space-y-0.5">
                {(v.checks?.failures?.length ? v.checks.failures : ['no reason was recorded']).map((f, i) => (
                  <li key={i} className="font-mono text-[10.5px] text-rose-800 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 rounded px-1.5 py-0.5 break-words">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
          <div className={label}>Requires</div>
          <Requirements requires={v.manifest?.requires} />
        </div>
      </div>
    </div>
  );
};

const SkillCard: React.FC<{
  summary: SkillSummary;
  detail?: SkillSummary;
  expanded: boolean;
  onToggle: () => void;
  canDecide: boolean;
  following: Set<string>;
  onDecide: (d: Decision) => void;
  onRerun: (v: SkillVersion) => void;
}> = ({ summary, detail, expanded, onToggle, canDecide, following, onDecide, onRerun }) => {
  const byVersion = new Map((detail?.versions ?? []).map((v) => [v.version, v]));
  // The list's summaries are kept fresh by the minute poll; the full record (manifest) comes from the detail fetch.
  const versions = [...summary.versions].reverse().map((v) => ({ ...byVersion.get(v.version), ...v, id: summary.id, manifest: byVersion.get(v.version)?.manifest }));
  const awaiting = summary.versions.filter((v) => v.status === 'pending' && v.tests === 'passed').length;
  const newest = summary.versions.at(-1);
  const links = newest ? sourceLinks(newest) : undefined;
  return (
    <div className={card}>
      <button onClick={onToggle} className="w-full text-left p-4 flex flex-col md:flex-row md:items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-slate-400">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
          <div>
            <div className="flex items-center flex-wrap gap-2">
              <span className="text-sm font-bold text-slate-900 dark:text-white">{summary.name}</span>
              <span className="font-mono text-[11px] text-slate-500">{summary.id}</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{summary.description}</p>
            {links && newest && (
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono break-all">
                {links.repo}
                {newest.path !== '.' ? ` · ${newest.path}` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-2 shrink-0 pl-7 md:pl-0">
          {awaiting > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">
              {awaiting} awaiting approval
            </span>
          )}
          <span className="text-[11px] text-slate-600 dark:text-slate-400">
            Latest approved:{' '}
            {summary.latestApproved ? <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">{summary.latestApproved}</span> : <span className="italic">none</span>}
          </span>
          <span className="text-[11px] text-slate-500">
            · {summary.versions.length} version{summary.versions.length === 1 ? '' : 's'}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {versions.map((v) => (
            <VersionRow
              key={v.version}
              skill={summary}
              version={v as SkillVersion}
              isLatestApproved={summary.latestApproved === v.version}
              canDecide={canDecide}
              following={following.has(key(summary.id, v.version))}
              onDecide={onDecide}
              onRerun={onRerun}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const SkillsView: React.FC = () => {
  const { canDecideSkills } = usePermissions();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, SkillSummary>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState<Map<string, number>>(new Map());
  const [decision, setDecision] = useState<Decision | null>(null);
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
        open = new Set(list.filter((s) => s.versions.some((v) => v.status === 'pending')).map((s) => s.id));
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

  const queue = (skills ?? []).flatMap((s) => s.versions.filter((v) => v.status === 'pending' && v.tests === 'passed')).length;

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
              Shared skills agents can adopt. Each version is pinned to a commit, checked by the factory, and approved by an admin.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {queue > 0 && <span className="font-semibold text-amber-700 dark:text-amber-400">{queue} awaiting approval</span>}
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

      {!canDecideSkills && <p className="text-xs text-slate-500 dark:text-slate-400">Anyone signed in can register a skill. Only admins approve, reject, revoke or re-run checks.</p>}
      {notice && (
        <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-lg px-3 py-2">{notice}</div>
      )}
      {error && <div className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-lg px-3 py-2">{error}</div>}

      {registering && <RegisterForm onRegistered={onRegistered} onClose={() => setRegistering(false)} />}

      {skills && skills.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">No skills are registered yet.</p>}
      <div className="space-y-3">
        {(skills ?? []).map((s) => (
          <SkillCard
            key={s.id}
            summary={s}
            detail={details[s.id]}
            expanded={expanded.has(s.id)}
            onToggle={() => toggle(s.id)}
            canDecide={canDecideSkills}
            following={new Set(following.keys())}
            onDecide={(d) => {
              setNotice(null);
              setDecision(d);
            }}
            onRerun={rerun}
          />
        ))}
      </div>

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
