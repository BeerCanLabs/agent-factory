import React from 'react';
import { Archive, CheckCircle2, CircleDashed, Globe, Loader2, Lock, ShieldCheck, ShieldOff, UserCheck, Zap, XCircle } from 'lucide-react';
import type { SkillAction, SkillVisibility } from '../../api/types.js';
import { holdKind, holdLabel, type StatusKey } from './skills-model.js';

export const STATUS: Record<StatusKey, { label: string; className: string; icon: React.ReactNode }> = {
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
  retired: {
    label: 'Retired',
    className: 'bg-slate-200 text-slate-600 border-slate-400 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-600',
    icon: <Archive className="w-3 h-3" />,
  },
};

export const STATUS_LABEL = (status: StatusKey) => STATUS[status].label;

export const StatusBadge: React.FC<{ status: StatusKey }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border ${STATUS[status].className}`}>
    {STATUS[status].icon}
    {STATUS[status].label}
  </span>
);

/** Public (any agent can be given it) or private to one owner agent (SK1). */
export const VisibilityBadge: React.FC<{ visibility: SkillVisibility; owner?: string }> = ({ visibility, owner }) =>
  visibility === 'private' ? (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border bg-violet-50 text-violet-800 border-violet-300 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-800"
      title={owner ? `Private: only ${owner} can adopt it, and only admins and ${owner}'s owners can see it` : 'Private: one owner agent only'}
    >
      <Lock className="w-3 h-3" />
      Private{owner ? ` · ${owner}` : ''}
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border bg-sky-50 text-sky-800 border-sky-300 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800"
      title="Public: any agent can be given it, with an admin's approval"
    >
      <Globe className="w-3 h-3" />
      Public
    </span>
  );

/** A human-in-the-loop action waits for a person; an autonomous one does not (SK2, E9). */
export const HoldBadge: React.FC<{ action: Pick<SkillAction, 'hold'> }> = ({ action }) =>
  holdKind(action) === 'hitl' ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800">
      <UserCheck className="w-3 h-3" />
      {holdLabel(action)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border bg-slate-50 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
      <Zap className="w-3 h-3" />
      {holdLabel(action)}
    </span>
  );
