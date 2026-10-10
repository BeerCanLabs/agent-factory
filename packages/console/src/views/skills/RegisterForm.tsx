import React, { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import type { SkillVersion } from '../../api/types.js';
import { ApiError, factoryApi } from '../../api/client.js';
import { errorText } from './skills-model.js';
import { btnPrimary, btnQuiet, card, input, label } from './ui.js';

/** Register by repository, path and commit (SHA, branch or tag). The control plane reads skill.yaml at that pin. */
export const RegisterForm: React.FC<{ onRegistered: (v: SkillVersion) => void; onClose: () => void }> = ({ onRegistered, onClose }) => {
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
