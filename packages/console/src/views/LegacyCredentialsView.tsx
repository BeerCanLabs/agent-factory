import React, { useEffect, useState } from 'react';
import { factoryApi } from '../api/client.js';
import { legacyCredentialRows, type LegacyCredentialRow } from './legacy-credentials-model.js';

/** Slice 5 (#566): operators see remaining old-credential use before Phase 3 removes those paths. */
export const LegacyCredentialsView: React.FC = () => {
  const [rows, setRows] = useState<LegacyCredentialRow[]>(() => legacyCredentialRows([]));
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    factoryApi.legacyCredentialUse()
      .then((report) => {
        if (!cancelled) setRows(legacyCredentialRows(report.kinds));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4 text-xs max-w-5xl">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Who still uses old credentials</h2>
        <p className="text-slate-500 dark:text-slate-400">
          These paths still sign people in. Phase 3 removes them after this list stays empty. Counts come from auth.request log lines on this control plane, and each new use is also written to the ledger. A factory access token is not listed.
        </p>
      </div>
      {error && <p className="text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Credential</th>
              <th className="px-3 py-2 font-semibold">Uses</th>
              <th className="px-3 py-2 font-semibold">Last seen</th>
              <th className="px-3 py-2 font-semibold">Recent caller</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const latest = row.recent[0];
              return (
                <tr key={row.id} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800 dark:text-slate-200">{row.label}</div>
                    <div className="text-slate-500">{row.detail}</div>
                  </td>
                  <td className="px-3 py-2 font-mono">{row.count}</td>
                  <td className="px-3 py-2 text-slate-500">{row.lastSeenAt ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {latest ? `${latest.actor ?? 'unknown'} · ${latest.path}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
