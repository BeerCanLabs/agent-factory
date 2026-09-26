import React from 'react';
import {
  Users,
  Terminal,
  CheckSquare,
  DollarSign,
  FileText,
  AlertOctagon,
  Cpu,
  LogOut,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../auth/CloudflareAuth.js';

export type ScreenId = 'fleet' | 'workbench' | 'approvals' | 'finops' | 'ledger' | 'triage' | 'studio';

interface SidebarProps {
  currentScreen: ScreenId;
  onSelectScreen: (screen: ScreenId) => void;
  pendingApprovalsCount: number;
  activeAgentsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentScreen,
  onSelectScreen,
  pendingApprovalsCount,
  activeAgentsCount,
}) => {
  const { activeRole } = useAuth();

  const navItems: Array<{ id: ScreenId; label: string; icon: React.ReactNode; badge?: string | number; badgeColor?: string }> = [
    {
      id: 'fleet',
      label: 'Fleet Command',
      icon: <Users className="w-4 h-4" />,
      badge: activeAgentsCount > 0 ? activeAgentsCount : undefined,
      badgeColor: 'bg-emerald-950 text-emerald-400 border border-emerald-800/80',
    },
    {
      id: 'workbench',
      label: 'Agent Workbench',
      icon: <Terminal className="w-4 h-4" />,
    },
    {
      id: 'approvals',
      label: 'Approvals (HITL)',
      icon: <CheckSquare className="w-4 h-4" />,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
      badgeColor: 'bg-amber-950 text-amber-400 border border-amber-800/80 animate-pulse',
    },
    {
      id: 'finops',
      label: 'FinOps & Budget',
      icon: <DollarSign className="w-4 h-4" />,
    },
    {
      id: 'ledger',
      label: 'Immutable Ledger',
      icon: <FileText className="w-4 h-4" />,
    },
    {
      id: 'triage',
      label: 'Triage & Incidents',
      icon: <AlertOctagon className="w-4 h-4" />,
    },
    {
      id: 'studio',
      label: 'Cartridge Studio',
      icon: <Cpu className="w-4 h-4" />,
    },
  ];

  return (
    <aside className="w-64 bg-slate-100/70 dark:bg-slate-900/50 border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between shrink-0 min-h-[calc(100vh-57px)] transition-colors">
      <div className="p-4 space-y-1">
        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Navigation
        </div>
        {navItems.map((item) => {
          const isActive = currentScreen === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectScreen(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                isActive
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center space-x-3">
                <span className={isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}>{item.icon}</span>
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${item.badgeColor}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Role Notice & Links */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
        <div className="bg-white dark:bg-slate-950 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 shadow-sm">
          <div className="text-[10px] uppercase font-bold text-slate-500">Effective Permissions</div>
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-300 mt-0.5 flex items-center justify-between">
            <span className="capitalize">{activeRole}</span>
            <span className="text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-300 dark:border-emerald-800">
              Active
            </span>
          </div>
          <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
            {activeRole === 'admin' && 'Full sovereign authority: cloud provisioning, budgets & purge.'}
            {activeRole === 'operator' && 'Operational authority: wake, dispatch, pause, model switch.'}
            {activeRole === 'approver' && 'HITL authority: review and approve pending tool calls.'}
            {activeRole === 'viewer' && 'Read-only access to fleet metrics, spend, and ledger.'}
          </p>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 px-1">
          <span>BeerCanLabs Engine</span>
          <span className="font-mono text-[10px]">v0.1.0</span>
        </div>
      </div>
    </aside>
  );
};
