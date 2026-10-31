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
  /** SK4: the skills the deployed image contains, as the approved versions it was built from. Absent: none. */
  deployedSkills?: Array<{ id: string; version: string }>;
  installedVersion?: string;
  updateAvailable?: boolean;
  offeredVersion?: string;
  offeredCommit?: string;
  releaseNotes?: string;
  publishedAt?: string;
  lastCheckedAt?: string;
  stagedVersion?: string;
  stagedCommit?: string;
  pendingDrain?: boolean;
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
  /** E1.5 (#296): set on a helper run's rows; the run and agent that started it. */
  parentRunId?: string;
  parentAgentId?: string;
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
  /** The principal actor the factory knows this person by, e.g. `cloudflare:alice@example.com`. */
  actor?: string;
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
  /** AP3.3: one more model turn with the notice before an answer given without tools is returned. */
  grounding?: 'warn-once';
  currentModel?: string | null;
  primaryModel?: string | null;
  secondaryModel?: string;
}

/** A model this factory offers (M3). */
export interface OfferedModel {
  name: string;
  provider: string;
  id?: string;
  vendorId?: string;
  price?: { inputPerMTok: number; outputPerMTok: number };
}

/** Effective and configured model selection state for an agent (M2). */
export interface AgentModelsState {
  agentId: string;
  approvedModels: string[];
  usesDefault: boolean;
  currentModel: string | null;
  primaryModel: string | null;
  secondaryModel?: string;
  defaultModel: string | null;
}

/** Payload to update an agent's model selection (M2). */
export interface SetAgentModelsInput {
  approvedModels?: string[];
  currentModel?: string | null;
  primaryModel?: string | null;
  secondaryModel?: string | null;
}

/** What a skill declares it needs (SK2): a request, never a grant. */
export interface SkillRequires {
  routes: string[];
  connections: Array<{ provider: string; scopes: string[] }>;
  credentials: Array<{ name: string; source?: string; description?: string }>;
  models: string[];
}

/** SK1: a public skill can be given to any agent; a private skill belongs to one owner agent. */
export type SkillVisibility = 'public' | 'private';

/**
 * One thing a skill does at a system (SK2, E11). `hold: true` is human-in-the-loop: a person approves the exact request
 * first (E9). `hold: false` is autonomous. A declared hold is shown here but enforced only once grants carry actions
 * (GAP-070).
 */
export interface SkillAction {
  id: string;
  route: string;
  method: string;
  path: string;
  hold: boolean;
}

export interface SkillManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  language: string;
  entry: string;
  /** Absent in a record written before skills were public or private: it is public. */
  visibility?: SkillVisibility;
  owner?: string;
  requires: SkillRequires;
  actions?: SkillAction[];
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
  /** SK6: the skill was retired; this version stays recorded but can no longer be approved or adopted. */
  retired?: boolean;
  retiredBy?: string;
  retiredAt?: string;
  retiredReason?: string;
  /** Only on a registration response: the branch or tag the commit was resolved from. */
  resolvedFrom?: string;
  /** Only on a forced revocation response: the agents that were paused, and the ones the skill was removed from. */
  paused?: string[];
  removedFrom?: string[];
}

/** An agent's use of a skill (SK7): asked for, or approved and in its configuration. */
export interface SkillAdopter {
  agentId: string;
  version: string;
  state: 'requested' | 'approved';
  requestedBy?: string;
  approvedBy?: string;
  since?: string;
  /** A private skill adopted for its owner when a version was approved. */
  auto?: boolean;
  /** Only from the adopters endpoint: a newer approved version exists. */
  upgradeAvailable?: boolean;
}

/** A skill in the catalog: `versions` are summaries in the list, full records for one skill. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  /** Absent from a control plane that predates public and private skills: public. */
  visibility?: SkillVisibility;
  owner?: string;
  /** Every version is retired (SK6). */
  retired?: boolean;
  latestApproved: string | null;
  /** Admin-configured default version for newly created agents (GAP-216, SK3, CF6). */
  defaultVersion?: string;
  requires: SkillRequires;
  versions: SkillVersion[];
  /** Who uses this skill (SK7). */
  adopters?: SkillAdopter[];
}

export interface DefaultSkillEntry {
  id: string;
  version: string;
}

export interface DefaultSkillsResponse {
  skills: DefaultSkillEntry[];
  updatedAt?: string;
  updatedBy?: string;
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
  /** E12: the roles this person holds on each agent, by agent id. Never `Owner`: that comes from owning the agent. */
  agentRoles?: Record<string, string[]>;
  linkedBy: string;
  linkedAt: string;
}

/** What a role may do with one skill (E12): the actions it allows and denies, `*` meaning every one. */
export interface DeclaredRoleSkillRule {
  allow: string[];
  deny: string[];
}

/** A role an agent's cartridge declares. */
export interface DeclaredRole {
  name: string;
  description?: string;
  skills: Record<string, DeclaredRoleSkillRule>;
}

/** What someone may do with one skill: all of it, only some actions, all but some, or none (refused, or simply not theirs). */
export type SkillAccess =
  | { kind: 'all' }
  | { kind: 'only'; actions: string[] }
  | { kind: 'except'; actions: string[] }
  | { kind: 'none'; why: 'denied' | 'unlisted' };

/** What the factory says someone who holds some roles on an agent may use: the rule the egress applies (E12). */
export interface EffectiveAccess {
  held: string[];
  unknownRoles: string[];
  skills: Array<{ skill: string; access: SkillAccess; routes: string[] }>;
  routes: Record<string, 'allowed' | 'denied'>;
}

/** `GET /api/v1/agents/:id/roles`: what the agent declares, and, when asked about some held roles, what they allow. */
export interface AgentRolesInfo {
  agentId: string;
  roles: DeclaredRole[];
  /** The names a person can be given: the declared roles, never `Owner`. */
  assignable: string[];
  skillRoutes: Record<string, string[]>;
  skillIds: string[];
  effective?: EffectiveAccess;
}

/** A skill in an agent's configuration, with who asked for and approved it (SK3). `auto`: a private skill adopted for its owner. */
export interface AgentAdoptedSkill {
  id: string;
  version: string;
  requestedBy?: string;
  approvedBy?: string;
  approvedAt?: string;
  auto?: true;
}

/** An adoption request waiting for an admin, or a private skill's adoption its owner removed (it is not adopted again by itself). */
export interface AgentSkillRequest {
  agentId: string;
  skillId: string;
  version: string;
  state: 'requested' | 'revoked';
  requestedBy?: string;
  requestedAt?: string;
  reason?: string;
}

/** The latest approved version of a skill this agent could be given. It also lists the skills the agent already runs. */
export interface AvailableSkill {
  id: string;
  name: string;
  description: string;
  visibility: SkillVisibility;
  owner?: string;
  version: string;
  requires: SkillRequires;
}

/** `GET /api/v1/agents/:id/skills` (SK3, SK5, SK7): what an agent runs, has asked for, was refused, and could adopt. */
export interface AgentSkills {
  agentId: string;
  adopted: AgentAdoptedSkill[];
  requests: AgentSkillRequest[];
  revoked: AgentSkillRequest[];
  available: AvailableSkill[];
}

/** Dynamic Model Catalog & FinOps Governance (GAP-162) */
export interface StoredModel {
  name: string;
  provider: string;
  id: string;
  vendorId?: string;
  region?: string;
  price?: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
  admittedAt: string;
  admittedBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface StagedModel {
  vendorId: string;
  rawId: string;
  displayName?: string;
  discoveredAt: string;
  suggestedFriendlyName: string;
  suggestedPrice?: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
}

export interface AiProviderTemplate {
  name: string;
  description: string;
  upstream: string;
  adapter: string;
  adapterKey?: 'openai' | 'anthropic' | 'xai' | 'google';
  heldSecret?: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'XAI_API_KEY' | 'GEMINI_API_KEY';
  discoveryPath: string;
  credentialHeader?: string;
  credentialFormat?: string;
}

export interface ModelsCatalogResponse {
  models: StoredModel[];
  staged: StagedModel[];
  default: string;
  templates: Record<string, AiProviderTemplate>;
}

export interface ScanModelsResponse {
  ok: boolean;
  vendorId?: string;
  count: number;
  staged: StagedModel[];
}

/** GAP-182: name the vendor; the factory takes provider, endpoint and credential from it. `provider`/`region` only for cloud model services. */
export interface AdmitModelRequest {
  name: string;
  provider?: string;
  id: string;
  vendorId?: string;
  region?: string;
  endpoint?: string;
  price?: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
}
