import React from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import type { SkillSummary, SkillVersion } from '../../api/types.js';
import { AdoptersPanel } from './AdoptersPanel.js';
import { StatusBadge, VisibilityBadge } from './StatusBadge.js';
import { VersionRow } from './VersionRow.js';
import type { AdoptionAction, Decision } from './dialogs.js';
import { adopterCounts, canRetire, key, sourceLinks, visibilityOf } from './skills-model.js';
import { btnQuiet, card } from './ui.js';

export const SkillCard: React.FC<{
  summary: SkillSummary;
  detail?: SkillSummary;
  expanded: boolean;
  onToggle: () => void;
  canDecide: boolean;
  canRetireSkills: boolean;
  following: Set<string>;
  onDecide: (d: Decision) => void;
  onRerun: (v: SkillVersion) => void;
  onAdoption: (a: AdoptionAction) => void;
  onRetire: (s: SkillSummary) => void;
}> = ({ summary, detail, expanded, onToggle, canDecide, canRetireSkills, following, onDecide, onRerun, onAdoption, onRetire }) => {
  const byVersion = new Map((detail?.versions ?? []).map((v) => [v.version, v]));
  // The list's summaries are kept fresh by the minute poll; the full record (manifest) comes from the detail fetch.
  const versions = [...summary.versions].reverse().map((v) => ({ ...byVersion.get(v.version), ...v, id: summary.id, manifest: byVersion.get(v.version)?.manifest }));
  const awaiting = summary.versions.filter((v) => v.status === 'pending' && v.tests === 'passed').length;
  const { approved: using, requested } = adopterCounts(summary.adopters);
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
              <VisibilityBadge visibility={visibilityOf(summary)} owner={summary.owner} />
              {summary.retired && <StatusBadge status="retired" />}
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
          {requested > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">
              {requested} adoption request{requested === 1 ? '' : 's'}
            </span>
          )}
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
            · {summary.versions.length} version{summary.versions.length === 1 ? '' : 's'} · {using} agent{using === 1 ? '' : 's'} using
          </span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          <div className="px-4 py-3 space-y-3">
            <AdoptersPanel skill={summary} canDecide={canDecide} onAct={onAdoption} />
            {canRetire(summary, { canRetireSkills }) && (
              <div className="flex justify-end">
                <button className={`${btnQuiet} text-rose-700 dark:text-rose-400`} onClick={() => onRetire(summary)} title="No new version can be approved or adopted; every version stays on record">
                  <Archive className="w-3.5 h-3.5" />
                  Retire this skill
                </button>
              </div>
            )}
          </div>
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
