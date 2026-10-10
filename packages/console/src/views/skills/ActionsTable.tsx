import React from 'react';
import type { SkillAction } from '../../api/types.js';
import { HoldBadge } from './StatusBadge.js';
import { actionCounts, sortActions } from './skills-model.js';
import { label } from './ui.js';

/**
 * What a skill does at each system, and which actions wait for a person (SK2, E9). The author declares each hold and an
 * admin reviews it when approving the version. It is shown here, not yet enforced: the gatekeeper-egress cannot tell
 * actions on one route apart until grants carry actions (GAP-070).
 */
export const ActionsTable: React.FC<{ actions?: SkillAction[]; loading?: boolean }> = ({ actions, loading }) => {
  if (loading) return <p className="text-[11px] text-slate-500">Loading actions…</p>;
  const rows = sortActions(actions);
  if (!rows.length) return <p className="text-[11px] text-slate-500">Declares no actions. It was written before skills listed what they do, so nothing says which of its calls need a person.</p>;
  const { hitl, autonomous } = actionCounts(rows);
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold">{hitl}</span> need a person, <span className="font-semibold">{autonomous}</span> autonomous.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left">
              <th className={`${label} pr-3 pb-1`}>Action</th>
              <th className={`${label} pr-3 pb-1`}>Call</th>
              <th className={`${label} pb-1`}>Hold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                <td className="py-1 pr-3 font-mono font-semibold text-slate-800 dark:text-slate-200">{a.id}</td>
                <td className="py-1 pr-3 font-mono text-slate-600 dark:text-slate-400 break-words">
                  <span className="font-semibold">{a.method}</span> {a.path} <span className="text-slate-400">via</span> {a.route}
                </td>
                <td className="py-1">
                  <HoldBadge action={a} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-500">A hold is the author’s declaration, reviewed at approval. It is recorded and shown, and enforced per action once grants carry actions (GAP-070).</p>
    </div>
  );
};
