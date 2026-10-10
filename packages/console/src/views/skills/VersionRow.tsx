import React from 'react';
import { CheckCircle2, ExternalLink, GitCommit, Loader2, RotateCcw, ShieldCheck, ShieldOff, XCircle } from 'lucide-react';
import type { SkillSummary, SkillVersion } from '../../api/types.js';
import { ActionsTable } from './ActionsTable.js';
import { Requirements } from './Requirements.js';
import { StatusBadge } from './StatusBadge.js';
import type { Decision } from './dialogs.js';
import { decisionLabel, shortSha, sourceLinks, statusOf, when } from './skills-model.js';
import { btnPrimary, btnQuiet, label } from './ui.js';

export const VersionRow: React.FC<{
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
          {v.retired && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Retired{v.retiredBy ? <> by <span className="font-medium text-slate-700 dark:text-slate-300">{v.retiredBy}</span></> : ''} {when(v.retiredAt)}
              {v.retiredReason && (
                <>
                  : <span className="italic text-slate-700 dark:text-slate-300">“{v.retiredReason}”</span>
                </>
              )}
            </div>
          )}
          {decided && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {decisionLabel(v)} by <span className="font-medium text-slate-700 dark:text-slate-300">{v.decidedBy}</span> {when(v.decidedAt)}
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
            {v.status === 'pending' && !v.retired && (
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
            {v.status === 'approved' && !v.retired && (
              <button className={`${btnQuiet} text-rose-700 dark:text-rose-400`} onClick={() => onDecide({ kind: 'reject', skill, version: v })}>
                <ShieldOff className="w-3.5 h-3.5" />
                Revoke
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
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
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
          <div className={label}>Actions</div>
          <ActionsTable actions={v.manifest?.actions} loading={!v.manifest} />
        </div>
      </div>
    </div>
  );
};
