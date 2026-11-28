import React, { useEffect, useState } from 'react';
import { factoryApi } from '../api/client.js';
import { legacyCredentialRows, type LegacyCredentialRow } from './legacy-credentials-model.js';

/** Slice 5 (#566): operators see remaining old-credential use before Phase 3 removes those paths. */
export const LegacyCredentialsView: React.FC = () => {
  const [rows, setRows] = useState<LegacyCredentialRow[]>(() => legacyCredentialRows([]));
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      factoryApi.legacyCredentialUse()
        .then((report) => {
          if (!cancelled) setRows(legacyCredentialRows(report.kinds));
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const refresh = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('factory-grants-stale', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener('factory-grants-stale', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="space-y-4 text-xs max-w-5xl">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Who still uses old credentials</h2>
        <p className="text-slate-500 dark:text-slate-400">
          These paths still sign people in. "Since start" counts requests on this control plane since it booted. "Ledger samples" are the audit rows (one per caller and key every 15 minutes) and stay after a restart. An empty since-start count is not a reason to turn a path off.
        </p>
      </div>
      {error && <p className="text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Credential</th>
              <th className="px-3 py-2 font-semibold">Since start</th>
              <th className="px-3 py-2 font-semibold">Ledger samples</th>
              <th className="px-3 py-2 font-semibold">Who</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-200 dark:border-slate-800 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800 dark:text-slate-200">{row.label}</div>
                  <div className="text-slate-500">{row.detail}</div>
                </td>
                <td className="px-3 py-2 font-mono">{row.count}</td>
                <td className="px-3 py-2 font-mono">{row.ledgerSamples}</td>
                <td className="px-3 py-2 text-slate-500">
                  {row.recent.length === 0
                    ? '—'
                    : row.recent.slice(0, 5).map((sample, i) => (
                        <div key={`${sample.ts}-${sample.actor ?? ''}-${sample.path}-${i}`}>
                          {sample.actor ?? 'unknown'} · {sample.path}
                          {sample.keyId ? ` · ${sample.keyId}` : ''}
                        </div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
