import React from 'react';
import type { SkillRequires } from '../../api/types.js';

export const Requirements: React.FC<{ requires?: SkillRequires }> = ({ requires }) => {
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
