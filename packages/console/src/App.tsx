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
import { factoryApi } from './api/client.js';
import type { AgentRecord, ApprovalItem } from './api/types.js';

/** Deep link, e.g. from the OAuth consent page: `/?view=credentials&agent=<id>`. */
function initialLocation(): { screen: ScreenId; agentId?: string } {
  const q = new URLSearchParams(window.location.search);
  return { screen: q.get('view') === 'credentials' ? 'credentials' : 'fleet', agentId: q.get('agent') ?? undefined };
}

const MainLayout: React.FC = () => {
  const [initial] = useState(initialLocation);
  const [currentScreen, setCurrentScreen] = useState<ScreenId>(initial.screen);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(initial.agentId ?? 'higgins');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [outstanding, setOutstanding] = useState<Record<string, number>>({});

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

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadOutstanding();
    const interval = setInterval(loadOutstanding, 60000);
    return () => clearInterval(interval);
  }, []);

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
      <Header onRefresh={loadData} isRefreshing={isRefreshing} />

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
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <CloudflareAuthProvider>
        <MainLayout />
      </CloudflareAuthProvider>
    </ThemeProvider>
  );
};

export default App;
