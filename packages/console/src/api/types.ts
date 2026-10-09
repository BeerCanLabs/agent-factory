// Must include every state the control plane sets (packages/registrar/src/catalog.ts); a conformance test enforces this.
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
  /** Models the agent's repo was built for, preferred first (M2). A request, not a grant. */
  requestedModels?: string[];
  approvedModels?: string[];
  /** Egress the agent's repo declares (E7 request, E8 ceiling). Not a grant. */
  egress?: { routes: string[]; hosts: string[] };
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

/** E9: the reviewable copy of a held request, exactly what will be sent on release (never the credential). */
export interface HeldRequestCopy {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** How to render it, e.g. `linkedin-post`. */
  preview?: string;
}

/** `GET /api/v1/approvals`: an MCP tool call waiting on its run, or a held request in a person's name (E9). */
export interface ApprovalItem {
  approvalId: string;
  agentId: string;
  runId: string;
  route: string;
  tool: string;
  argsSha256: string;
  state: 'pending' | 'approved' | 'rejected' | 'consumed';
  requestedAt: string;
  kind?: 'held';
  request?: HeldRequestCopy;
  decidedBy?: string;
  decidedAt?: string;
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

/** An agent's policy: what the company grants it (E7). Set only by an admin, in the factory. */
export interface AgentPolicy {
  routes: string[];
  models?: string[];
  hosts?: string[];
  tools?: Record<string, unknown>;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  tokensPerMinute?: number;
}

/** A model this factory offers (M3). */
export interface OfferedModel {
  name: string;
  provider: string;
  price?: { inputPerMTok: number; outputPerMTok: number };
}

/** What a skill declares it needs (SK2): a request, never a grant. */
export interface SkillRequires {
  routes: string[];
  connections: Array<{ provider: string; scopes: string[] }>;
  credentials: Array<{ name: string; source?: string; description?: string }>;
  models: string[];
}

export interface SkillManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  language: string;
  entry: string;
  requires: SkillRequires;
}

export type SkillStatus = 'pending' | 'approved' | 'rejected';
export type SkillChecksState = 'pending-build' | 'passed' | 'failed';

/** One registered version of a skill (SK1), as the registry records it. */
export interface SkillVersion {
  id: string;
  version: string;
  repo: string;
  path: string;
  commit: string;
  manifest?: SkillManifest;
  status: SkillStatus;
  tests: SkillChecksState;
  checks?: { at: string; run?: string; failures?: string[] };
  checkRun?: { id: string; checker: string; startedAt: string; startedBy: string };
  registeredBy: string;
  registeredAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  revoked?: boolean;
  /** Only on a registration response: the branch or tag the commit was resolved from. */
  resolvedFrom?: string;
  /** Only on a forced revocation response: the agents that were paused. */
  paused?: string[];
}

/** A skill in the catalog: `versions` are summaries in the list, full records for one skill. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  latestApproved: string | null;
  requires: SkillRequires;
  versions: SkillVersion[];
}

export type SystemStatus = 'proposed' | 'approved' | 'rejected';

export type SystemOAuthUser = {
  kind: 'oauth-user';
  authUrl: string;
  tokenUrl: string;
  clientSecret?: string;
  authParams?: Record<string, string>;
  refresh?: boolean;
  defaultScopes?: string[];
};

export type SystemJwtBearer = {
  kind: 'jwt-bearer';
  tokenUrl: string;
  keySecret?: string;
  defaultScopes?: string[];
};

export type SystemOAuth = SystemOAuthUser | SystemJwtBearer;

export interface SystemDefinition {
  id: string;
  name: string;
  description?: string;
  kind: 'http' | 'mcp';
  upstream: string;
  credential?: {
    secret: string;
    header: string;
    format?: string;
    fallback?: boolean;
    encoding?: 'basic';
  };
  connection?: string;
  scopes?: string[];
  hold?: {
    methods: string[];
    preview?: string;
  };
  stripSignInLinks?: boolean;
  /** A message route's longest `content` in characters (Discord: 2000); a longer message is refused, never split. */
  maxContentChars?: number;
  oauth?: SystemOAuth;
  version: number;
  status: SystemStatus;
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  hash: string;
}

export interface SystemSummary {
  id: string;
  name: string;
  description?: string;
  kind: 'http' | 'mcp';
  upstream: string;
  status: SystemStatus;
  latestVersion: number;
  approvedVersion: number | null;
  activeDefinition: SystemDefinition | null;
  versions: SystemDefinition[];
}

export const IDENTITY_PROVIDERS = ['discord', 'slack', 'teams', 'webui', 'cli'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export type FactoryRole = 'admin' | 'operator' | 'approver' | 'viewer' | 'ingest';

export interface IdentityLink {
  provider: IdentityProvider;
  id: string;
  actor: string;
  name?: string;
  roles?: FactoryRole[];
  linkedBy: string;
  linkedAt: string;
}

