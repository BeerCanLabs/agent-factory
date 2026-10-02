import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * An in-page modal dialog. The console never uses `window.alert`, `confirm` or `prompt`: a decision is made here, with
 * its consequences in view. Escape and the close button cancel, unless `busy`.
 */
export const Dialog: React.FC<{
  title: string;
  onClose: () => void;
  busy?: boolean;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
  footer: React.ReactNode;
}> = ({ title, onClose, busy = false, tone = 'default', children, footer }) => {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !latest.current.busy) latest.current.onClose();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('textarea, input, button[data-autofocus]')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50 backdrop-blur-[2px]" onMouseDown={() => !busy && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-xl border ${
          tone === 'danger' ? 'border-rose-300 dark:border-rose-800' : 'border-slate-200 dark:border-slate-700'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className={`text-sm font-bold ${tone === 'danger' ? 'text-rose-700 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>{title}</h3>
          <button onClick={onClose} disabled={busy} className="p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-xs text-slate-700 dark:text-slate-300">{children}</div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 rounded-b-xl">{footer}</div>
      </div>
    </div>
  );
};
