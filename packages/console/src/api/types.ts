export type AgentState =
  | 'DRAFT'
  | 'PENDING_BUDGET'
  | 'PENDING_DEPLOY'
  | 'DEPLOYING'
  | 'SLEEPING'
  | 'RUNNING'
  | 'PAUSED'
  | 'RETIRED_PENDING_PURGE'
  | 'PURGED';

export interface AgentRecord {
  id: string;
  name: string;
  role?: string;
  version: string;
  state: AgentState;
  model: string;
  approvedModels?: string[];
  spendLimitUsd?: number;
  currentSpendUsd?: number;
  warmDownSeconds?: number;
  lastRunId?: string;
  lastStateChange?: string;
  retireCountdownEnd?: string;
  domain?: string;
  manifest?: Record<string, any>;
  sqliteSizeKb?: number;
  lastWalCheckpoint?: string;
  mindPrefix?: string;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  state: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  startedAt: string;
  endedAt?: string;
  error?: string;
  spendUsd?: number;
  tokens?: {
    input: number;
    output: number;
  };
}

export interface ApprovalItem {
  id: string;
  agentId: string;
  runId: string;
  tool: string;
  host?: string;
  input: Record<string, any>;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  notes?: string;
}

export interface LedgerEvent {
  id: string;
  timestamp: string;
  type: string;
  agentId?: string;
  runId?: string;
  actor: string;
  spendUsd?: number;
  payload: Record<string, any>;
  prevHash?: string;
  hash: string;
}

export interface FactoryMetrics {
  activeRuns: number;
  agentsByState: Record<string, number>;
  totalSpendUsd: number;
  spendLimitUsd: number;
  ledgerEventsCount: number;
  ledgerHealthy: boolean;
  wormVerified: boolean;
}

export interface TriageIncident {
  id: string;
  timestamp: string;
  agentId: string;
  severity: 'CRITICAL' | 'ERROR' | 'WARNING';
  category: 'OOM' | 'SECRET_MISSING' | 'TIMEOUT' | 'LLM_ERROR' | 'CRASH_LOOP';
  message: string;
  stackTrace?: string;
}

export interface AuthUser {
  email: string;
  name: string;
  roles: Array<'viewer' | 'operator' | 'approver' | 'admin'>;
  provider: string;
}
