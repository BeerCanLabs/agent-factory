import React from 'react';
import { Bot, Clock, RotateCcw, ShieldCheck, UserMinus, XCircle } from 'lucide-react';
import type { SkillAdopter, SkillSummary } from '../../api/types.js';
import { adopterCounts, adopterRows, when } from './skills-model.js';
import { btnQuiet, label } from './ui.js';
import type { AdoptionAction } from './dialogs.js';

/**
 * Which agents use a skill, and which are waiting to (SK3, SK7). `approved` means the agent's configuration lists the
 * skill, and the factory rebuilds the agent with it; whether the running image has it yet is the agent's own page.
 */
export const AdoptersPanel: React.FC<{
  skill: SkillSummary;
  canDecide: boolean;
  onAct: (a: AdoptionAction) => void;
}> = ({ skill, canDecide, onAct }) => {
  const adopters: SkillAdopter[] = skill.adopters ?? [];
  const rows = adopterRows(adopters, skill, { canDecide });
  const counts = adopterCounts(adopters);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className={label}>Adopters</div>
        <span className="text-[11px] text-slate-500">
          {counts.approved} using
          {counts.requested > 0 && <span className="ml-2 font-semibold text-amber-700 dark:text-amber-400">{counts.requested} waiting</span>}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          No agent has adopted {skill.visibility === 'private' ? 'this private skill' : 'this skill'} yet.
          {skill.visibility === 'private' && skill.owner ? ` Approving a version adopts it for ${skill.owner}.` : ''}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => (
            <li key={`${r.agentId}:${r.state}`} className="py-1.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
              <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
                <Bot className="w-3.5 h-3.5 text-slate-400" />
                <span className="font-mono font-semibold text-slate-900 dark:text-white">{r.agentId}</span>
                <span className="font-mono text-slate-600 dark:text-slate-400">{r.version}</span>
                {r.state === 'requested' ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800">
                    <Clock className="w-3 h-3" />
                    Waiting for an admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800">
                    <ShieldCheck className="w-3 h-3" />
                    Using
                  </span>
                )}
                {r.auto && <span className="text-[10px] text-slate-500">adopted automatically</span>}
                {r.upgradeAvailable && skill.latestApproved && <span className="text-[10px] font-semibold text-sky-700 dark:text-sky-400">update available: {skill.latestApproved}</span>}
                <span className="text-slate-500">
                  {r.state === 'requested' ? (r.requestedBy ? `asked by ${r.requestedBy}` : '') : r.approvedBy ? `approved by ${r.approvedBy}` : ''}
                  {r.since ? ` · ${when(r.since)}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {r.offer.approve && (
                  <button className={btnQuiet} onClick={() => onAct({ kind: 'approve', skill, adopter: r })}>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Approve
                  </button>
                )}
                {r.offer.reject && (
                  <button className={btnQuiet} onClick={() => onAct({ kind: 'reject', skill, adopter: r })}>
                    <XCircle className="w-3.5 h-3.5" />
                    Reject
                  </button>
                )}
                {r.offer.upgrade && (
                  <button className={btnQuiet} onClick={() => onAct({ kind: 'upgrade', skill, adopter: r })}>
                    <RotateCcw className="w-3.5 h-3.5" />
                    Upgrade
                  </button>
                )}
                {r.offer.remove && r.state === 'approved' && (
                  <button className={`${btnQuiet} text-rose-700 dark:text-rose-400`} onClick={() => onAct({ kind: 'remove', skill, adopter: r })}>
                    <UserMinus className="w-3.5 h-3.5" />
                    Remove
                  </button>
                )}
                {r.offer.remove && r.state === 'requested' && !r.offer.reject && (
                  <button className={btnQuiet} onClick={() => onAct({ kind: 'remove', skill, adopter: r })}>
                    <UserMinus className="w-3.5 h-3.5" />
                    Withdraw
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
