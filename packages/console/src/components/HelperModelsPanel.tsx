import React, { useEffect, useState } from 'react';
import { factoryApi, type HelperDefinition } from '../api/client.js';

/**
 * #332: each helper (subagent) has its own approved model list, a subset of the factory catalog. A parent may start a
 * helper only on a model checked here; an empty list means the helper cannot start at all.
 */
export const HelperModelsPanel: React.FC = () => {
  const [helpers, setHelpers] = useState<HelperDefinition[]>([]);
  const [offered, setOffered] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const [hs, models] = await Promise.all([factoryApi.listSubagents(), factoryApi.listModels()]);
      setHelpers(hs);
      setOffered(models.map((m) => m.name).sort());
      setDrafts(Object.fromEntries(hs.map((h) => [h.id, [...(h.approvedModels ?? [])]])));
    } catch (e: any) {
      setMsg(`Could not load helpers: ${e.message}`);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = (id: string, model: string) =>
    setDrafts((d) => {
      const cur = new Set(d[id] ?? []);
      if (cur.has(model)) cur.delete(model);
      else cur.add(model);
      return { ...d, [id]: [...cur].sort() };
    });

  const save = async (id: string) => {
    setSaving(id);
    try {
      await factoryApi.setSubagentModels(id, drafts[id] ?? []);
      setMsg(`Saved approved models for helper "${id}".`);
      await load();
    } catch (e: any) {
      setMsg(`Failed to save helper "${id}": ${e.message}`);
    } finally {
      setSaving(null);
    }
  };

  if (helpers.length === 0) return null;
  return (
    <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Helper approved models</h2>
        <p className="text-xs text-slate-500">
          A parent agent may start a helper only on a model checked here. No models checked means the helper cannot start.
        </p>
      </div>
      {msg && <p className="text-xs text-slate-600 dark:text-slate-300">{msg}</p>}
      {helpers.map((h) => {
        const draft = drafts[h.id] ?? [];
        const dirty = JSON.stringify(draft) !== JSON.stringify([...(h.approvedModels ?? [])].sort());
        return (
          <div key={h.id} className="p-3 border border-slate-200 dark:border-slate-800 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-slate-900 dark:text-white">{h.name ?? h.id}</span>
              <button
                disabled={!dirty || saving === h.id}
                onClick={() => void save(h.id)}
                className="px-2.5 py-1 text-[11px] rounded bg-purple-600 text-white disabled:opacity-40"
              >
                {saving === h.id ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div className="flex flex-wrap gap-3 mt-2">
              {offered.map((m) => (
                <label key={m} className="flex items-center gap-1 text-[11px] text-slate-700 dark:text-slate-300">
                  <input type="checkbox" checked={draft.includes(m)} onChange={() => toggle(h.id, m)} />
                  <span className="font-mono">{m}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
