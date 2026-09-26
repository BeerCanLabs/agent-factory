import React, { useState, useEffect } from 'react';
import { CloudflareAuthProvider, useAuth } from './auth/CloudflareAuth.js';
import { Header } from './components/Header.js';
import { Sidebar, type ScreenId } from './components/Sidebar.js';
import { FleetView } from './views/FleetView.js';
import { AgentWorkbench } from './views/AgentWorkbench.js';
import { ApprovalsView } from './views/ApprovalsView.js';
import { FinOpsView } from './views/FinOpsView.js';
import { LedgerView } from './views/LedgerView.js';
import { TriageView } from './views/TriageView.js';
import { StudioView } from './views/StudioView.js';
import { factoryApi } from './api/client.js';
import type { AgentRecord, ApprovalItem } from './api/types.js';

const MainLayout: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<ScreenId>('fleet');
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('higgins');
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setCurrentScreen('workbench');
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const activeAgentsCount = agents.filter((a) => a.state === 'RUNNING').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header onRefresh={loadData} isRefreshing={isRefreshing} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentScreen={currentScreen}
          onSelectScreen={setCurrentScreen}
          pendingApprovalsCount={approvals.length}
          activeAgentsCount={activeAgentsCount}
        />

        <main className="flex-1 overflow-y-auto p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {currentScreen === 'fleet' && (
            <FleetView agents={agents} onSelectAgent={handleSelectAgent} onRefresh={loadData} />
          )}

          {currentScreen === 'workbench' && selectedAgent && (
            <AgentWorkbench
              agent={selectedAgent}
              agents={agents}
              onSelectAgent={setSelectedAgentId}
              onRefresh={loadData}
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
    <CloudflareAuthProvider>
      <MainLayout />
    </CloudflareAuthProvider>
  );
};

export default App;
