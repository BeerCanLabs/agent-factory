import React, { useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import type { SkillVersion } from '../../api/types.js';
import { ApiError, factoryApi } from '../../api/client.js';
import { errorText } from './skills-model.js';
import { btnPrimary, card, input, label } from './ui.js';

/** Register by package upload. */
export const RegisterForm: React.FC<{ onRegistered: (v: SkillVersion) => void; onClose: () => void }> = ({ onRegistered, onClose }) => {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setReasons([]);
    try {
      onRegistered(await factoryApi.uploadSkillPackage(file));
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
      <div className="space-y-2">
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Upload a self-contained skill package (<span className="font-mono">.tar.gz</span>, up to 5 MiB). Built with <span className="font-mono">factory skill pack &lt;dir&gt;</span>. The factory validates tests, manifest (<span className="font-mono">spec: 1</span>), and stores the package by SHA-256 for offline builds.
        </p>
        <label className="block space-y-1">
          <span className={label}>Package archive</span>
          <input
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            className={`${input} file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 dark:file:bg-emerald-950 dark:file:text-emerald-300 hover:file:bg-emerald-100`}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
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
        <button
          type="submit"
          className={btnPrimary}
          disabled={busy || !file}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {busy ? 'Uploading package…' : 'Upload package'}
        </button>
      </div>
    </form>
  );
};
