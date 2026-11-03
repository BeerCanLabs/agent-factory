import React, { useState, useEffect } from 'react';
import { CloudflareAuthProvider, useAuth } from './auth/CloudflareAuth.js';
import { ThemeProvider } from './context/ThemeContext.js';
import { Header } from './components/Header.js';
import { Sidebar, type ScreenId } from './components/Sidebar.js';
import { FleetView } from './views/FleetView.js';
import { AgentWorkbench } from './views/AgentWorkbench.js';
import { ApprovalsView } from './views/ApprovalsView.js';
import { FinOpsView } from './views/FinOpsView.js';
import { LedgerView } from './views/LedgerView.js';
import { TriageView } from './views/TriageView.js';
import { StudioView } from './views/StudioView.js';
import { CredentialsView } from './views/CredentialsView.js';
import { SkillsView } from './views/SkillsView.js';
import { SystemsView } from './views/SystemsView.js';
import { IdentitiesView } from './views/IdentitiesView.js';
import { ExecutiveOfficeView } from './views/ExecutiveOfficeView.js';
import { PeopleView } from './views/PeopleView.js';
import { KeysView } from './views/KeysView.js';
import { canManagePeople, hasAnyAccess } from './auth/access-gate.js';
import { DrainModal } from './components/DrainModal.js';
import { UpdateDrawer } from './components/UpdateDrawer.js';
import { factoryApi } from './api/client.js';
import type { AgentRecord, ApprovalItem } from './api/types.js';

/** Deep link, e.g. from the OAuth consent page: `/?view=credentials&agent=<id>`, or `/?view=identities`, `/?view=skills`, `/?view=systems`, `/?view=models`. */
function initialLocation(): { screen: ScreenId; agentId?: string } {
  const q = new URLSearchParams(window.location.search);
  const view = q.get('view');
  return {
    screen:
      view === 'credentials' || view === 'identities' || view === 'skills' || view === 'systems' || view === 'models'
        ? view
        : 'fleet',
    agentId: q.get('agent') ?? undefined,
  };
}


/** S9: a signed-in person with no grant sees only this, and the console asks the factory for nothing else. */
const NoAccess: React.FC<{ actor?: string }> = ({ actor }) => (
  <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300">
    <div className="max-w-md text-center p-8">
      <h1 className="text-lg font-semibold">No access yet</h1>
      <p className="text-sm mt-2">{actor ? `You are signed in as ${actor}, but` : 'You are not signed in, or'} this factory has not granted you anything. Ask an admin for a grant.</p>
      <p className="text-sm mt-4"><a className="underline" href="/login">Sign in as someone else</a></p>
    </div>
  </div>
);

/** S9: what the factory says applies right now: act-as and break-glass. */
const Banners: React.FC = () => {
  const { actAs, setActAs, whoami } = useAuth();
  return (
    <>
      {actAs && (
        <div className="bg-amber-100 text-amber-900 text-xs px-4 py-2 flex justify-between">
          <span>Acting as <b>{actAs}</b>. Every action is ledgered as you on their behalf.</span>
          <button className="underline" onClick={() => setActAs(null)}>Stop acting as</button>
        </div>
      )}
      {Boolean(whoami?.breakGlassAlert) && (
        <div className="bg-red-100 text-red-900 text-xs px-4 py-2">Break-glass key was used. Rotate it in Your API Keys / People &amp; Access.</div>
      )}
    </>
  );
};

const Gate: React.FC = () => {
  const { isLoading, whoami } = useAuth();
  if (isLoading) return null;
  if (!hasAnyAccess(whoami)) return <NoAccess actor={whoami?.actor} />;
  return <MainLayout />;
};

const MainLayout: React.FC = () => {
  const { hasRole, whoami } = useAuth();
  const [initial] = useState(initialLocation);
  const [currentScreen, setCurrentScreen] = useState<ScreenId>(initial.screen);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(initial.agentId ?? 'higgins');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [outstanding, setOutstanding] = useState<Record<string, number>>({});
  const [isUpdateDrawerOpen, setIsUpdateDrawerOpen] = useState(false);
  const [selectedAgentForUpdate, setSelectedAgentForUpdate] = useState<AgentRecord | null>(null);

  const updatesAvailableCount = agents.filter((a) => a.updateAvailable).length;

  const handleCheckUpdate = async (agentId: string) => {
    await factoryApi.checkAgentUpdate(agentId);
    await loadData();
  };

  // Outstanding credentials per agent (§6.11 K5). Admin-only on the API; others simply see no counts.
  const loadOutstanding = async () => {
    try {
      const res = await factoryApi.getOutstandingCredentials();
      setOutstanding(Object.fromEntries(res.agents.map((a) => [a.agentId, a.outstanding])));
    } catch {
      setOutstanding({});
    }
  };

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const [agentList, apprList] = await Promise.all([
        factoryApi.listAgents(),
        factoryApi.listApprovals(),
      ]);
      setAgents(agentList);
      setApprovals(apprList);
      if (agentList.length > 0 && !agentList.some((a) => a.id === selectedAgentId)) {
        setSelectedAgentId(agentList[0].id);
      }
    } catch (err) {
      console.error('Failed to load fleet data:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Polling is light on purpose (GAP-056): the fleet every minute, credential counts every 10 minutes (they change
  // only when someone acts, and the control plane caches them), and nothing while the tab is hidden. Every action
  // in the console reloads what it changed.
  useEffect(() => poll(loadData, FLEET_POLL_MS), []);
  useEffect(() => poll(loadOutstanding, CREDENTIALS_POLL_MS), []);

  const handleOpenCredentials = (agentId: string) => {
    setSelectedAgentId(agentId);
    setCurrentScreen('credentials');
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setCurrentScreen('workbench');
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const activeAgentsCount = agents.filter((a) => a.state === 'RUNNING').length;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
      <Header
        onRefresh={loadData}
        isRefreshing={isRefreshing}
        updateCount={updatesAvailableCount}
        onOpenUpdates={() => setIsUpdateDrawerOpen(true)}
      />

      <Banners />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentScreen={currentScreen}
          onSelectScreen={setCurrentScreen}
          pendingApprovalsCount={approvals.length}
          activeAgentsCount={activeAgentsCount}
          outstandingCredentialsCount={Object.values(outstanding).reduce((n, c) => n + c, 0)}
        />

        <main className="flex-1 overflow-y-auto p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {currentScreen === 'fleet' && (
            <FleetView
              agents={agents}
              onSelectAgent={handleSelectAgent}
              onRefresh={loadData}
              outstandingCredentials={outstanding}
              onOpenCredentials={handleOpenCredentials}
              onOpenUpdateModal={(agent) => setSelectedAgentForUpdate(agent)}
              onCheckUpdate={handleCheckUpdate}
            />
          )}

          {currentScreen === 'workbench' && selectedAgent && (
            <AgentWorkbench
              agent={selectedAgent}
              agents={agents}
              onSelectAgent={setSelectedAgentId}
              onRefresh={loadData}
            />
          )}

          {currentScreen === 'credentials' && selectedAgent && (
            <CredentialsView
              agents={agents}
              agentId={selectedAgent.id}
              onSelectAgent={setSelectedAgentId}
              onChanged={loadOutstanding}
            />
          )}

          {currentScreen === 'identities' && (
            hasRole('admin') ? (
              <IdentitiesView />
            ) : (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center text-xs text-slate-500">
                <p className="font-semibold text-slate-700 dark:text-slate-300">Admin Privileges Required</p>
                <p className="text-slate-500 text-[11px] mt-1">
                  Viewing and managing Bouncer external identity links requires administrator authority.
                </p>
              </div>
            )
          )}

          {currentScreen === 'people' && canManagePeople(whoami) && <PeopleView />}
          {currentScreen === 'keys' && <KeysView />}
          {currentScreen === 'models' && <ExecutiveOfficeView />}
          {currentScreen === 'skills' && <SkillsView />}
          {currentScreen === 'systems' && <SystemsView />}

          {currentScreen === 'approvals' && (

            <ApprovalsView approvals={approvals} onRefresh={loadData} />
          )}

          {currentScreen === 'finops' && (
            <FinOpsView agents={agents} onRefresh={loadData} />
          )}

          {currentScreen === 'ledger' && <LedgerView />}

          {currentScreen === 'triage' && <TriageView />}

          {currentScreen === 'studio' && <StudioView onRefresh={loadData} />}
        </main>
      </div>

      <UpdateDrawer
        isOpen={isUpdateDrawerOpen}
        onClose={() => setIsUpdateDrawerOpen(false)}
        agents={agents}
        onSelectAgentForUpdate={(agent) => {
          setSelectedAgentForUpdate(agent);
          setIsUpdateDrawerOpen(false);
        }}
        onCheckUpdate={handleCheckUpdate}
      />

      {selectedAgentForUpdate && (
        <DrainModal
          agent={selectedAgentForUpdate}
          isOpen={Boolean(selectedAgentForUpdate)}
          onClose={() => setSelectedAgentForUpdate(null)}
          onSuccess={() => {
            loadData();
          }}
        />
      )}
    </div>
  );
};


const FLEET_POLL_MS = 60_000;
const CREDENTIALS_POLL_MS = 10 * 60_000;

/** Runs `load` now and every `ms` while the page is visible, and once more when it becomes visible again. */
function poll(load: () => void, ms: number): () => void {
  load();
  const tick = () => {
    if (document.visibilityState === 'visible') load();
  };
  const interval = setInterval(tick, ms);
  const onVisible = () => tick();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <CloudflareAuthProvider>
        <Gate />
      </CloudflareAuthProvider>
    </ThemeProvider>
  );
};

export default App;
