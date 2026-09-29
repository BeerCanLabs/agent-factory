// Must include every state the control plane sets (packages/control-plane/src/catalog.ts); a conformance test enforces this.
export type AgentState =
  | 'DRAFT'
  | 'PENDING_BUDGET'
  | 'PENDING_DEPLOY'
  | 'DEPLOYING'
  | 'SLEEPING'
  | 'RUNNING'
  | 'WORKING'
  | 'IDLE'
  | 'TRAINING'
  | 'PAUSED'
  | 'ISOLATED'
  | 'BLOCKED_FOR_HUMAN'
  | 'ERROR'
  | 'OUT_OF_BUDGET'
  | 'RETIRED_PENDING_PURGE'
  | 'PURGED';

export type AgentCategory = 'user' | 'builtin';

export interface AgentRecord {
  id: string;
  name: string;
  role?: string;
  version: string;
  state: AgentState;
  category?: AgentCategory;
  isBuiltin?: boolean;
  budgetExempt?: boolean;
  model: string;
  approvedModels?: string[];
  spendLimitUsd?: number;
  spendLimitMonthlyUsd?: number;
  currentSpendUsd?: number;
  currentSpendMonthlyUsd?: number;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
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

// Keymaster credentials (DESIGN_AUTHORITY.md §6.11 K5). Mirrors packages/keymaster/src/{catalog,credentials}.ts.
export type CredentialStatus = 'present' | 'missing' | 'needs_consent' | 'missing_scopes' | 'needs_reconsent';

export interface CredentialInstructions {
  id: string;
  title: string;
  kind: 'static' | 'oauth';
  /** Markdown. */
  instructions: string;
  approved: { by: string; at: string } | null;
  reviewState: 'approved' | 'pending_review';
  label?: string;
}

export type CredentialAction =
  | { type: 'submit'; method: 'POST'; path: string }
  | { type: 'consent'; path: string; url: string; available: boolean; reason?: string }
  | { type: 'none'; reason: string };

export interface CredentialItem {
  kind: 'static' | 'oauth';
  name: string;
  source?: string;
  sourceInferred?: boolean;
  description?: string;
  status: CredentialStatus;
  outstanding: boolean;
  managedBy: 'agent' | 'platform';
  shared?: boolean;
  requiredBy?: string;
  scopes?: { declared: string[]; granted: string[]; missing: string[] };
  grant?: { grantedBy: string; obtainedAt: string };
  instructions: CredentialInstructions | null;
  action: CredentialAction;
}

export interface CredentialSummary {
  total: number;
  outstanding: number;
  present: number;
}

export interface AgentCredentials {
  agentId: string;
  summary: CredentialSummary;
  credentials: CredentialItem[];
}

export interface OutstandingCredentials {
  agents: Array<{ agentId: string; name: string } & CredentialSummary>;
  outstanding: number;
}
