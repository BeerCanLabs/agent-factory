import React, { useState } from 'react';
import { ShieldCheck, UserCheck, RefreshCw, AlertTriangle, CheckCircle, Database, Sun, Moon } from 'lucide-react';
import { useAuth } from '../auth/CloudflareAuth.js';
import { useTheme } from '../context/ThemeContext.js';
import { factoryApi } from '../api/client.js';

interface HeaderProps {
  onRefresh: () => void;
  isRefreshing: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onRefresh, isRefreshing }) => {
  const { user, activeRole, setActiveRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [verifyingWorm, setVerifyingWorm] = useState(false);
  const [wormStatus, setWormStatus] = useState<'verified' | 'unverified' | null>('verified');

  const handleVerifyWorm = async () => {
    setVerifyingWorm(true);
    try {
      const res = await factoryApi.verifyLedgerWorm();
      if (res.ok && res.worm) {
        setWormStatus('verified');
      } else {
        setWormStatus('unverified');
      }
    } catch {
      setWormStatus('unverified');
    } finally {
      setVerifyingWorm(false);
    }
  };

  return (
    <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 px-6 py-3 flex items-center justify-between transition-colors">
      {/* Brand & Environment */}
      <div className="flex items-center space-x-3">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 font-bold text-lg shadow-sm">
          ⚡
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-base font-bold tracking-tight text-slate-900 dark:text-white">Agent Factory</h1>
            <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800/60">
              AWS PROD
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Autonomous Fleet Operations & Governance</p>
        </div>
      </div>

      {/* Global Status Telemetry */}
      <div className="hidden md:flex items-center space-x-6 text-xs">
        {/* WORM Status */}
        <div className="flex items-center space-x-2 bg-slate-100 dark:bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800">
          <Database className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="text-slate-600 dark:text-slate-400 font-medium">Ledger WORM:</span>
          {wormStatus === 'verified' ? (
            <span className="flex items-center text-emerald-600 dark:text-emerald-400 font-semibold space-x-1">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>Cryptographically Sealed</span>
            </span>
          ) : (
            <span className="flex items-center text-amber-600 dark:text-amber-400 font-semibold space-x-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Pending Verify</span>
            </span>
          )}
          <button
            onClick={handleVerifyWorm}
            disabled={verifyingWorm}
            className="ml-2 text-[10px] bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 transition"
          >
            {verifyingWorm ? 'Verifying...' : 'Verify'}
          </button>
        </div>

        {/* Refresh */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="p-1.5 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-950 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 transition"
          title="Refresh All Fleet Data"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-emerald-500' : ''}`} />
        </button>

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-950 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 transition flex items-center justify-center"
          title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4 text-amber-400 hover:text-amber-300" />
          ) : (
            <Moon className="w-4 h-4 text-indigo-600 hover:text-indigo-700" />
          )}
        </button>
      </div>

      {/* Cloudflare Access Identity & Role Switcher */}
      <div className="flex items-center space-x-3">
        {/* Role Selector (Simulate/Switch) */}
        <div className="flex items-center bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-1 text-xs">
          <span className="px-2 text-slate-500 dark:text-slate-400 font-medium flex items-center space-x-1">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-500" />
            <span className="hidden sm:inline">Role:</span>
          </span>
          <select
            value={activeRole}
            onChange={(e) => setActiveRole(e.target.value as any)}
            className="bg-white dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 font-semibold rounded px-2 py-1 outline-none border border-slate-200 dark:border-transparent cursor-pointer"
          >
            <option value="admin">Super Admin</option>
            <option value="operator">Operator</option>
            <option value="approver">Approver (HITL)</option>
            <option value="viewer">Viewer (Read-Only)</option>
          </select>
        </div>

        {/* User Identity Chip */}
        <div className="flex items-center space-x-2 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <UserCheck className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="font-semibold text-slate-800 dark:text-slate-200 hidden sm:inline">{user.email}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden lg:inline">
            (Cloudflare Zero Trust)
          </span>
        </div>
      </div>
    </header>
  );
};
