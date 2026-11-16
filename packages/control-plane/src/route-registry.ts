// DESIGN_AUTHORITY.md §6.15 (Bouncer), plans/factory-auth.md (D4, D18, D22, S14), plans/headless-neck.md (TSK-336, CL11)
import { PRIVILEGES, type Privilege } from '@beercanlabs/factory-bouncer';
import {
  type OperationContract,
  type OpenApiDocument,
  type McpSchemaCatalog,
  MCP_EXPOSURE_CLASSES,
  MCP_TOOLSETS,
  buildOpenApiDocument,
  buildMcpSchemaCatalog,
  validateOperationContract,
  derivePathParamsSchema,
  jsonSchema,
  type JsonSchemaObject,
} from '@beercanlabs/factory-contract';

/**
 * Valid route protection mechanisms for routes not guarded by standard Bouncer privileges.
 * (plans/factory-auth.md D18, D22, S14).
 */
export const ROUTE_PROTECTION_MECHANISMS = [
  'login-page',
  'oauth-state-pkce',
  'webhook-hmac',
  'run-token',
  'identity-probe',
  'transitional',
] as const;

export type RouteProtectionMechanism = (typeof ROUTE_PROTECTION_MECHANISMS)[number];

export interface RouteException {
  readonly id: string;
  readonly protection: RouteProtectionMechanism;
  readonly rationale: string;
  /**
   * For transitional entries, the exact retiring story ID that will tighten or remove it
   * (e.g. 'S12', 'S16', 'S17').
   */
  readonly retiringStory?: string;
  /**
   * For forward-declared planned entries (e.g. 'S12' for login page).
   */
  readonly plannedIn?: string;
}

/**
 * Single typed ROUTE_EXCEPTIONS registry naming all non-Bouncer-privilege routes and
 * their protection mechanisms.
 */
export const ROUTE_EXCEPTIONS = {
  'webhook-hooks': {
    id: 'webhook-hooks',
    protection: 'webhook-hmac',
    rationale: 'Generic agent webhook endpoint verified fail-closed via HMAC signature against the agent cartridge secret, or for a config-only agent its own GitHub App webhook secret (D18, D22, S15, GAP-258)',
  },
  'authz-check': {
    id: 'authz-check',
    protection: 'identity-probe',
    rationale: 'Side-effect-free authorization preflight for any verified principal; answers only for the caller (R5, R7, S3)',
  },
  'grants-scoped-list': {
    id: 'grants-scoped-list',
    protection: 'transitional',
    rationale: 'Grant list/create/revoke authorize per scope inside the handler (admin via grants.manage, or content-owner / accountable-lead on their own item, D10, D24, S3); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'grants-scoped-create': {
    id: 'grants-scoped-create',
    protection: 'transitional',
    rationale: 'Grant list/create/revoke authorize per scope inside the handler (admin via grants.manage, or content-owner / accountable-lead on their own item, D10, D24, S3); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'grants-scoped-revoke': {
    id: 'grants-scoped-revoke',
    protection: 'transitional',
    rationale: 'Grant list/create/revoke authorize per scope inside the handler (admin via grants.manage, or content-owner / accountable-lead on their own item, D10, D24, S3); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'keys-self-list': {
    id: 'keys-self-list',
    protection: 'transitional',
    rationale: 'API key management authorizes in the handler: a signed-in person manages keys they own, an admin any key and service keys; API-key callers are refused (D10, D14, S5); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'keys-self-create': {
    id: 'keys-self-create',
    protection: 'transitional',
    rationale: 'API key management authorizes in the handler: a signed-in person manages keys they own, an admin any key and service keys; API-key callers are refused (D10, D14, S5); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'keys-self-rotate': {
    id: 'keys-self-rotate',
    protection: 'transitional',
    rationale: 'API key management authorizes in the handler: a signed-in person manages keys they own, an admin any key and service keys; API-key callers are refused (D10, D14, S5); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'keys-self-revoke': {
    id: 'keys-self-revoke',
    protection: 'transitional',
    rationale: 'API key management authorizes in the handler: a signed-in person manages keys they own, an admin any key and service keys; API-key callers are refused (D10, D14, S5); S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'agent-transfer-read': {
    id: 'agent-transfer-read',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'agent-transfer-start': {
    id: 'agent-transfer-start',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'agent-transfer-accept': {
    id: 'agent-transfer-accept',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'agent-transfer-decline': {
    id: 'agent-transfer-decline',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'agent-transfer-cancel': {
    id: 'agent-transfer-cancel',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'skill-transfer-read': {
    id: 'skill-transfer-read',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'skill-transfer-decline': {
    id: 'skill-transfer-decline',
    protection: 'transitional',
    rationale: 'Two-phase ownership transfer (D15, D23, S3b) authorizes per party inside the handler: start by the active content-owner or admin, accept by the recipient (admin via act-as), decline by recipient or admin, cancel by the read-only outgoing owner or admin, read by any of those; S4 moves this into single Bouncer enforcement',
    retiringStory: 'S4',
  },
  'setup-status': {
    id: 'setup-status',
    protection: 'identity-probe',
    rationale: 'Setup completion and break-glass alert for any verified principal; read-only, names no secrets (R11, D16, S6)',
  },
  'health-probe': {
    id: 'health-probe',
    protection: 'identity-probe',
    rationale: 'Health for any verified principal (session or machine key, e.g. a health-probe key); 401 otherwise. Load balancers use the private FACTORY_INTERNAL_HEALTH_PORT listener (R17, D18, D22, S16)',
  },
  'identity-whoami': {
    id: 'identity-whoami',
    protection: 'identity-probe',
    rationale: 'Identity probe returning authenticated actor and roles for any verified principal without requiring specific Bouncer privilege (D6, D18)',
  },
  'webhook-github': {
    id: 'webhook-github',
    protection: 'webhook-hmac',
    rationale: 'GitHub release webhook verified fail-closed via X-Hub-Signature-256 HMAC-SHA256 signature against platform secret (D22, GAP-211, S15)',
  },
  'oauth-connections-callback': {
    id: 'oauth-connections-callback',
    protection: 'oauth-state-pkce',
    rationale: 'OAuth user connection redirect protected by HMAC-signed one-time state token and PKCE code exchange (D18, D22)',
  },
  'oauth-github-app-callback': {
    id: 'oauth-github-app-callback',
    protection: 'oauth-state-pkce',
    rationale: 'GitHub App manifest callback protected by HMAC-signed one-time state nonce (D18, D22)',
  },
  'run-token': {
    id: 'run-token',
    protection: 'run-token',
    rationale: 'Agent runtime endpoint authenticated via ephemeral run token minted at container start (D18, SV2)',
  },
  'ui-session': {
    id: 'ui-session',
    protection: 'identity-probe',
    rationale: 'Web UI HTML only for a verified principal (session, key or token); others are redirected to /login (D22, S12)',
  },
  'login-start': {
    id: 'login-start',
    protection: 'login-page',
    rationale: 'Begins sign-in with a configured IdP: mints a one-time state and PKCE challenge and redirects; reveals nothing (D19, S12)',
  },
  'login-callback': {
    id: 'login-callback',
    protection: 'oauth-state-pkce',
    rationale: 'IdP redirect accepted only with a live one-time state bound to that IdP; code exchanged with the PKCE verifier; email_verified required (R13, D18, S12)',
  },
  'login-cli-token': {
    id: 'login-cli-token',
    protection: 'oauth-state-pkce',
    rationale: "CLI loopback exchange: a one-time code minted after a verified browser sign-in plus the CLI PKCE verifier yields the person's own cli key (S13)",
  },
  'logout': {
    id: 'logout',
    protection: 'login-page',
    rationale: "Ends the caller's own session and clears the cookie; a cookie from another origin is refused; without a session it only clears the cookie (S12)",
  },
  'login-page': {
    id: 'login-page',
    protection: 'login-page',
    rationale: 'Login page HTML served without credentials at `/` to unauthenticated browsers; names no status (D18, D19, S16; full flow S12)',
  },
  'schema-openapi': {
    id: 'schema-openapi',
    protection: 'identity-probe',
    rationale: 'OpenAPI 3.1.0 specification export for any verified principal; unauthenticated callers get 401 (CL11, GAP-249)',
  },
  'schema-mcp': {
    id: 'schema-mcp',
    protection: 'identity-probe',
    rationale: 'MCP tools schema catalog export for any verified principal; unauthenticated callers get 401 (CL11, GAP-249)',
  },
} as const satisfies Record<string, RouteException>;

export type RouteExceptionId = keyof typeof ROUTE_EXCEPTIONS;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type ControlPlaneRoute = OperationContract &
  (
    | {
        readonly method: HttpMethod;
        readonly pattern: string;
        readonly privilege: Privilege | readonly Privilege[];
        readonly exception?: never;
        readonly description?: string;
      }
    | {
        readonly method: HttpMethod;
        readonly pattern: string;
        readonly privilege?: never;
        readonly exception: RouteExceptionId;
        readonly description?: string;
      }
  );

/**
 * Converts a REST-style route pattern (e.g. '/api/v1/agents/:id/policy') into a matching RegExp.
 */
export function pathToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[a-zA-Z0-9_]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/**
 * Declarative CONTROL_PLANE_ROUTES operations and privilege table covering every HTTP route handled by the control plane.
 * Generated and validated from @beercanlabs/factory-contract declarative operations registry (CL11).
 */
// Reusable Response Schemas
const SuccessResponseSchema: JsonSchemaObject = jsonSchema.object({
  ok: jsonSchema.boolean({ description: 'Operation execution status' }),
});

const AgentRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Agent identifier' }),
  name: jsonSchema.string({ description: 'Agent display name' }),
  role: jsonSchema.string({ description: 'Agent role' }),
  state: jsonSchema.string({ description: 'Lifecycle state' }),
  model: jsonSchema.string({ description: 'Default AI model' }),
});

const RunRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  runId: jsonSchema.string({ description: 'Run unique identifier' }),
  agentId: jsonSchema.string({ description: 'Target agent ID' }),
  state: jsonSchema.string({ description: 'Run state' }),
});

const ScheduleRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Schedule identifier' }),
  agentId: jsonSchema.string({ description: 'Target agent ID' }),
  cron: jsonSchema.string({ description: 'Cron schedule expression' }),
  prompt: jsonSchema.string({ description: 'Task prompt' }),
  enabled: jsonSchema.boolean({ description: 'Schedule enabled status' }),
});

const PrincipalRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  principal: jsonSchema.object({
    id: jsonSchema.string({ description: 'Principal ID' }),
    displayName: jsonSchema.string({ description: 'Display name' }),
    emails: jsonSchema.array(jsonSchema.string(), { description: 'Associated emails' }),
  }),
});

const GrantRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  grant: jsonSchema.object({
    id: jsonSchema.string({ description: 'Grant identifier' }),
    subject: jsonSchema.string({ description: 'Principal or group ID' }),
    role: jsonSchema.string({ description: 'Role name' }),
    scope: jsonSchema.object({
      kind: jsonSchema.string({ description: 'Scope kind' }),
      id: jsonSchema.string({ description: 'Scope entity ID' }),
    }),
  }),
});

const SubmissionRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Submission ID' }),
  kind: jsonSchema.string({ description: 'Submission kind' }),
  status: jsonSchema.string({ description: 'Submission status' }),
});

const SystemRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  system: jsonSchema.object({
    id: jsonSchema.string({ description: 'System identifier' }),
    name: jsonSchema.string({ description: 'System display name' }),
    upstream: jsonSchema.string({ description: 'Upstream URL' }),
  }),
});

const GroupRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  group: jsonSchema.object({
    id: jsonSchema.string({ description: 'Group identifier' }),
    name: jsonSchema.string({ description: 'Group display name' }),
    members: jsonSchema.array(jsonSchema.string(), { description: 'Member principal IDs' }),
  }),
});

const SubagentRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Subagent identifier' }),
  name: jsonSchema.string({ description: 'Subagent display name' }),
  description: jsonSchema.string({ description: 'Task specialization' }),
});

const ApiKeyRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  key: jsonSchema.object({
    id: jsonSchema.string({ description: 'API key ID' }),
    name: jsonSchema.string({ description: 'Label' }),
    prefix: jsonSchema.string({ description: 'Key prefix (fk_...)' }),
  }),
  secret: jsonSchema.string({ description: 'Full API key plaintext (only returned once at creation/rotation)' }),
});

const CredentialSetResponseSchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent identifier' }),
  name: jsonSchema.string({ description: 'Credential name' }),
  status: jsonSchema.string({ description: 'Credential status' }),
});

const TransferResponseSchema: JsonSchemaObject = jsonSchema.object({
  scope: jsonSchema.object({
    kind: jsonSchema.string({ description: 'Entity kind' }),
    id: jsonSchema.string({ description: 'Entity ID' }),
  }),
  action: jsonSchema.string({ description: 'Transfer action' }),
  owner: jsonSchema.string({ description: 'New or current owner' }),
});

const ConversationTurnResponseSchema: JsonSchemaObject = jsonSchema.object({
  turnId: jsonSchema.string({ description: 'Turn unique identifier' }),
  replyTo: jsonSchema.object({
    channel: jsonSchema.string({ description: 'Reply channel' }),
  }),
});

const ConversationRequestsResponseSchema: JsonSchemaObject = jsonSchema.object({
  turnId: jsonSchema.string({ description: 'Turn identifier' }),
  request: jsonSchema.object({
    op: jsonSchema.string({ description: 'Requested operation' }),
  }),
});

const ModelScanResponseSchema: JsonSchemaObject = jsonSchema.object({
  ok: jsonSchema.boolean({ description: 'Status' }),
  count: jsonSchema.integer({ description: 'Discovered model count' }),
  staged: jsonSchema.array(jsonSchema.string(), { description: 'Discovered model names' }),
});

const SubscriptionConnectResponseSchema: JsonSchemaObject = jsonSchema.object({
  signIn: jsonSchema.object({
    id: jsonSchema.string({ description: 'Sign-in session ID' }),
    url: jsonSchema.string({ description: 'OAuth authorization URL' }),
  }),
});

const SubscriptionDiscoverResponseSchema: JsonSchemaObject = jsonSchema.object({
  connection: jsonSchema.string({ description: 'Connection ID' }),
  listAvailable: jsonSchema.boolean({ description: 'Whether catalog list succeeded' }),
  models: jsonSchema.array(jsonSchema.string(), { description: 'Discovered models' }),
});

const RuntimeResponseSchema: JsonSchemaObject = jsonSchema.object({
  ok: jsonSchema.boolean({ description: 'Rollout status' }),
  runtime: jsonSchema.object({
    repo: jsonSchema.string({ description: 'Git repository' }),
    commit: jsonSchema.string({ description: 'Commit SHA' }),
    image: jsonSchema.string({ description: 'Container image digest' }),
  }),
});

const UpdateCheckResponseSchema: JsonSchemaObject = jsonSchema.object({
  hasUpdate: jsonSchema.boolean({ description: 'Whether an update is available' }),
  latestVersion: jsonSchema.string({ description: 'Latest release version' }),
});

const AgentSettingsResponseSchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent identifier' }),
  managed: jsonSchema.boolean({ description: 'Whether settings are config-managed' }),
  version: jsonSchema.integer({ description: 'Configuration version' }),
});

const AgentRenameResponseSchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent identifier' }),
  name: jsonSchema.string({ description: 'New name' }),
});

const AgentModelsResponseSchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent identifier' }),
  defaultModel: jsonSchema.string({ description: 'Default model name' }),
  approvedModels: jsonSchema.array(jsonSchema.string(), { description: 'Allowed models' }),
});

const AgentPolicyResponseSchema: JsonSchemaObject = jsonSchema.object({
  routes: jsonSchema.array(jsonSchema.string(), { description: 'Allowed routes' }),
  models: jsonSchema.array(jsonSchema.string(), { description: 'Allowed models' }),
  budgetUsd: jsonSchema.object({
    perDay: jsonSchema.number({ description: 'Daily limit' }),
    perMonth: jsonSchema.number({ description: 'Monthly limit' }),
  }),
  tools: jsonSchema.object({}, { description: 'Tool permission rules' }),
  subagents: jsonSchema.array(jsonSchema.string(), { description: 'Permitted helper subagents' }),
  wakeAgents: jsonSchema.array(jsonSchema.string(), { description: 'Permitted wake agent IDs' }),
  env: jsonSchema.object({}, {
    additionalProperties: jsonSchema.string({ description: 'Environment variable value' }),
    description: 'Non-secret deployment environment variables (UPPER_SNAKE_CASE, e.g. SDLC_*)',
  }),
});

const FleetStateRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  status: jsonSchema.string({ description: 'Administrative fleet status', enum: ['running', 'paused', 'deploy-freeze'] }),
  effective: jsonSchema.string({ description: 'Effective fleet state', enum: ['running', 'paused', 'deploy-freeze', 'deploying', 'prod-testing'] }),
  coder_app_ready: jsonSchema.boolean({ description: 'Whether coder app is ready' }),
  reason: {
    type: ['string', 'null'],
    description: 'Fleet status reason or null if cleared',
  },
  ops: jsonSchema.object({
    state: jsonSchema.string({ description: 'Ops deploy state', enum: ['idle', 'deploying', 'prod-testing', 'rolled-back'] }),
    by: { type: ['string', 'null'], description: 'Actor who set ops state' },
    at: { type: ['string', 'null'], description: 'ISO timestamp when ops state was set' },
    reason: { type: ['string', 'null'], description: 'Ops state transition reason' },
    runId: { type: ['string', 'null'], description: 'Run ID holding the deploy lock' },
  }),
});

const ApprovalRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  approvalId: jsonSchema.string({ description: 'Approval unique identifier' }),
  runId: jsonSchema.string({ description: 'Originating run identifier' }),
  agentId: jsonSchema.string({ description: 'Target agent ID' }),
  route: jsonSchema.string({ description: 'Associated route pattern' }),
  tool: jsonSchema.string({ description: 'Associated MCP tool name' }),
  argsSha256: jsonSchema.string({ description: 'SHA-256 digest of invocation arguments' }),
  state: jsonSchema.string({ description: 'Current approval status', enum: ['pending', 'approved', 'rejected', 'consumed', 'expired'] }),
  requestedAt: jsonSchema.string({ description: 'ISO timestamp when approval was requested' }),
  kind: jsonSchema.string({ description: 'Approval category', enum: ['tool', 'held', 'change', 'decision'] }),
  notes: jsonSchema.string({ description: 'Approver justification notes' }),
  decidedBy: jsonSchema.string({ description: 'Principal ID of deciding user' }),
  decidedAt: jsonSchema.string({ description: 'ISO timestamp when decided' }),
  capUsd: jsonSchema.number({ description: 'Spending cap in USD if approved with cap' }),
});

const DecisionHoldRecordResponseSchema: JsonSchemaObject = jsonSchema.object({
  requestKey: jsonSchema.string({ description: 'Unique decision request key' }),
  approvalId: jsonSchema.string({ description: 'Approval ID' }),
  agentId: jsonSchema.string({ description: 'Agent requesting decision' }),
  kind: jsonSchema.string({ description: 'Hold category' }),
  title: jsonSchema.string({ description: 'Hold title' }),
  summary: jsonSchema.string({ description: 'Hold summary' }),
  state: jsonSchema.string({ description: 'Approval state', enum: ['pending', 'approved', 'rejected'] }),
  approvers: jsonSchema.array(jsonSchema.string(), { description: 'Authorized approver GitHub logins' }),
  requiresCap: jsonSchema.boolean({ description: 'Whether hold requires a spend cap' }),
  cap_usd: {
    type: ['number', 'null'],
    description: 'Approved spend cap in USD',
  },
  by: {
    type: ['string', 'null'],
    description: 'GitHub login of the decider',
  },
  comment: {
    type: ['string', 'null'],
    description: 'Decision notes or comment',
  },
  requestedAt: jsonSchema.string({ description: 'ISO timestamp when hold was created' }),
  link: jsonSchema.string({ description: 'Optional context link' }),
  payload: jsonSchema.object({}, { description: 'Optional structured payload' }),
  decidedBy: jsonSchema.string({ description: 'Principal actor who decided' }),
  decidedAt: jsonSchema.string({ description: 'ISO timestamp when decided' }),
});

// Reusable Request Body Schemas
const AgentCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Agent slug ID (1 to 128 letters, digits, dot, dash or underscore)' }),
  name: jsonSchema.string({ description: 'Human-readable agent name (defaults to id)' }),
  role: jsonSchema.string({ description: 'Agent role or title' }),
  kind: jsonSchema.string({ description: 'Agent kind', enum: ['personal', 'team'] }),
  accountableLead: jsonSchema.string({ description: 'Accountable lead principal ID for team agents' }),
  owners: jsonSchema.array(jsonSchema.string(), { description: 'Owner principal IDs' }),
  model: jsonSchema.string({ description: 'Initial default model' }),
  soul: jsonSchema.string({ description: 'Core persona and instructions' }),
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Agent roles' }),
  memory: jsonSchema.object({
    archetype: jsonSchema.string({ description: 'Memory archetype (AM1)', enum: ['purpose-built', 'personal-assistant', 'team-member'] }),
  }, { description: 'Memory configuration' }),
  skills: jsonSchema.array(jsonSchema.object({
    id: jsonSchema.string({ description: 'Skill ID' }),
    version: jsonSchema.string({ description: 'Semantic version' }),
  }), { description: 'Initial adopted skills' }),
  includeDefaultSkills: jsonSchema.boolean({ description: 'Whether to adopt platform default skills' }),
  excludeDefaultSkills: jsonSchema.array(jsonSchema.string(), { description: 'Default skill IDs to exclude' }),
}, { required: ['id'] });

const ScheduleCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Optional schedule identifier (sched-<uuid>)' }),
  cron: jsonSchema.string({ description: 'Standard 5-field cron expression' }),
  prompt: jsonSchema.string({ description: 'Task prompt executed at scheduled times' }),
  agentId: jsonSchema.string({ description: 'Target agent ID' }),
  name: jsonSchema.string({ description: 'Human-readable schedule name' }),
  timezone: jsonSchema.string({ description: 'IANA timezone name' }),
  enabled: jsonSchema.boolean({ description: 'Whether schedule is enabled' }),
  channelId: jsonSchema.string({ description: 'Optional ingress channel ID' }),
  requestedBy: jsonSchema.object({
    actor: jsonSchema.string({ description: 'Principal actor requesting execution' }),
    provider: jsonSchema.string({ description: 'Identity provider if authenticated externally' }),
  }, { description: 'Authority attribution under which schedule runs execute' }),
}, { required: ['cron', 'prompt'] });

const ScheduleUpdateBodySchema: JsonSchemaObject = jsonSchema.object({
  cron: jsonSchema.string({ description: 'Standard 5-field cron expression' }),
  prompt: jsonSchema.string({ description: 'Task prompt executed at scheduled times' }),
  name: jsonSchema.string({ description: 'Human-readable schedule name' }),
  timezone: jsonSchema.string({ description: 'IANA timezone name' }),
  enabled: jsonSchema.boolean({ description: 'Whether schedule is enabled' }),
  channelId: jsonSchema.string({ description: 'Optional ingress channel ID' }),
});

const PrincipalCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  displayName: jsonSchema.string({ description: 'Full human-readable display name' }),
  emails: jsonSchema.array(jsonSchema.string(), { description: 'Verified email addresses' }),
  email: jsonSchema.string({ description: 'Single email address alias' }),
  id: jsonSchema.string({ description: 'Optional canonical user ID (user:<slug>)' }),
}, { required: ['displayName', 'emails'] });

const PrincipalUpdateBodySchema: JsonSchemaObject = jsonSchema.object({
  displayName: jsonSchema.string({ description: 'Updated display name' }),
}, { required: ['displayName'] });

const PrincipalEmailBodySchema: JsonSchemaObject = jsonSchema.object({
  email: jsonSchema.string({ description: 'Email address to associate with principal' }),
}, { required: ['email'] });

const PrincipalRevokeBodySchema: JsonSchemaObject = jsonSchema.object({
  confirm: jsonSchema.string({ description: 'Must match principal ID to confirm revocation' }),
  reason: jsonSchema.string({ description: 'Administrative reason for access revocation' }),
}, { required: ['confirm'] });

const GrantCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Optional explicit grant record ID' }),
  subject: jsonSchema.string({ description: 'Target principal or group ID' }),
  subjectDisplayName: jsonSchema.string({ description: 'Optional display name alias for target subject' }),
  role: jsonSchema.string({ description: 'Factory role granted' }),
  scope: jsonSchema.object({
    kind: jsonSchema.string({ description: 'Scope kind', enum: ['fleet', 'agent', 'skill'] }),
    id: jsonSchema.string({ description: 'Scope entity ID if not fleet' }),
  }, { required: ['kind'] }),
  state: jsonSchema.string({ description: 'Grant state (only active permitted)', enum: ['active'] }),
  expiresAt: {
    type: ['string', 'null'],
    format: 'date-time',
    description: 'ISO-8601 expiration timestamp or null for non-expiring',
  },
  replaceExisting: jsonSchema.boolean({ description: 'Whether to atomically replace existing grants for the same scope' }),
}, { required: ['subject', 'role', 'scope'] });

const BudgetUsdBodySchema: JsonSchemaObject = jsonSchema.object({
  budgetUsd: jsonSchema.object({
    perDay: jsonSchema.number({ description: 'Daily spend ceiling in USD', minimum: 0 }),
    perMonth: jsonSchema.number({ description: 'Monthly spend ceiling in USD', minimum: 0 }),
  }),
}, { required: ['budgetUsd'] });

const SpendBudgetsBodySchema: JsonSchemaObject = jsonSchema.object({
  aiMonthUsd: {
    type: ['number', 'null'],
    minimum: 0,
    description: 'Monthly spend ceiling in USD for AI providers, or null to clear',
  },
  infraMonthUsd: {
    type: ['number', 'null'],
    minimum: 0,
    description: 'Monthly spend ceiling in USD for infrastructure, or null to clear',
  },
  totalMonthUsd: {
    type: ['number', 'null'],
    minimum: 0,
    description: 'Total monthly spend ceiling in USD for entire factory, or null to clear',
  },
  alertAt: jsonSchema.array(
    jsonSchema.number({ exclusiveMinimum: 0, maximum: 10 }),
    {
      description: 'Non-empty list of fractional alert thresholds (e.g. [0.8, 1.0], values > 0 and <= 10)',
      minItems: 1,
    },
  ),
});

const SpendBudgetVersionResponseSchema: JsonSchemaObject = jsonSchema.object({
  version: jsonSchema.integer({ description: 'Budget version number' }),
  budgets: jsonSchema.object({
    aiMonthUsd: jsonSchema.number({ description: 'Monthly AI spend ceiling' }),
    infraMonthUsd: jsonSchema.number({ description: 'Monthly infra spend ceiling' }),
    totalMonthUsd: jsonSchema.number({ description: 'Total monthly spend ceiling' }),
    alertAt: jsonSchema.array(jsonSchema.number(), { description: 'Alert thresholds' }),
  }),
  setBy: jsonSchema.string({ description: 'Actor who set budget' }),
  setAt: jsonSchema.string({ description: 'Timestamp when budget was set' }),
}, { required: ['version', 'budgets', 'setBy', 'setAt'] });

const SpendBudgetsGetResponseSchema: JsonSchemaObject = jsonSchema.object({
  current: {
    type: ['object', 'null'],
    properties: SpendBudgetVersionResponseSchema.properties,
    description: 'Current factory budget version, or null if none set',
  },
  history: jsonSchema.array(SpendBudgetVersionResponseSchema, { description: 'Historical budget versions' }),
}, { required: ['current', 'history'] });

const HeartbeatBodySchema: JsonSchemaObject = jsonSchema.object({
  rssMb: jsonSchema.number({ description: 'Current process RSS memory in megabytes', minimum: 0 }),
});

const AgentDeployBodySchema: JsonSchemaObject = jsonSchema.object({
  repo: jsonSchema.string({ description: 'Optional repository HTTPS URL to re-pin for deploy' }),
  commit: jsonSchema.string({ description: 'Optional 40-character git commit SHA to re-pin for deploy', pattern: '^[0-9a-f]{40}$' }),
});

const EgressFailoverBodySchema: JsonSchemaObject = jsonSchema.object({
  toModel: jsonSchema.string({ description: 'Target model ID failover destination' }),
  fromModel: jsonSchema.string({ description: 'Origin model ID failing over from' }),
  reason: jsonSchema.string({ description: 'Reason for model failover' }),
}, { required: ['toModel'] });

const SkillUnpublishBodySchema: JsonSchemaObject = jsonSchema.object({
  reason: jsonSchema.string({ description: 'Optional administrative reason for unpublishing skill (up to 2000 chars)' }),
});

const ApprovalDecideBodySchema: JsonSchemaObject = jsonSchema.object({
  decision: jsonSchema.string({ description: 'Decision outcome', enum: ['approve', 'reject'] }),
  notes: jsonSchema.string({ description: 'Administrative justification or review notes' }),
  capUsd: {
    type: ['number', 'string'],
    description: 'Optional spend ceiling cap in USD when approving a decision hold',
  },
}, { required: ['decision'] });

const FleetStateOpsBodySchema: JsonSchemaObject = jsonSchema.object({
  state: jsonSchema.string({
    description: 'Deploy ops state reported by ops leader',
    enum: ['idle', 'deploying', 'prod-testing', 'rolled-back'],
  }),
  reason: jsonSchema.string({
    description: 'Deploy state transition justification or error details',
  }),
  deployId: jsonSchema.string({
    description: "The deploy's opaque id (#482), given with deploying; a takeover must name the same one",
    pattern: '^[A-Za-z0-9._@#/-]{1,128}$',
  }),
  takeover: jsonSchema.boolean({
    description: "true: take over this agent's own open deploy (same deployId) once its holding run has ended (#482)",
  }),
}, { required: ['state'] });

const FleetStateSetBodySchema: JsonSchemaObject = jsonSchema.object({
  status: jsonSchema.string({
    description: 'Fleet administrative status',
    enum: ['running', 'paused', 'deploy-freeze'],
  }),
  coder_app_ready: jsonSchema.boolean({
    description: 'Whether coder app is ready',
  }),
  reason: {
    type: ['string', 'null'],
    description: 'Status explanation or incident rationale, or null to clear',
  },
  opsAgents: {
    type: ['array', 'null'],
    items: jsonSchema.string({ description: 'Agent ID' }),
    description: 'List of agent IDs authorized to report ops deploy states, or null to clear',
  },
  ops: {
    type: ['object', 'null'],
    description: 'Admin override of ops deploy state, or null to reset to idle',
    properties: {
      state: jsonSchema.string({ description: 'Ops state', enum: ['idle', 'deploying', 'prod-testing', 'rolled-back'] }),
      reason: jsonSchema.string({ description: 'Ops state reason' }),
    },
    required: ['state'],
  },
  force: jsonSchema.boolean({
    description: 'Force state update even if a live run holds the deploy lock',
  }),
}, { required: ['status'] });

const DecisionHoldPublishBodySchema: JsonSchemaObject = jsonSchema.object({
  title: jsonSchema.string({
    description: 'Short title of the requested decision',
  }),
  summary: jsonSchema.string({
    description: 'Detailed description of the decision, context, and requested action',
  }),
  approvers: jsonSchema.array(jsonSchema.string({ description: 'GitHub login' }), {
    description: 'GitHub logins of human approvers authorized to decide this hold',
    minItems: 1,
  }),
  id: jsonSchema.string({
    description: 'Optional request key matching path parameter :requestKey',
  }),
  kind: jsonSchema.string({
    description: 'Decision hold category/kind',
  }),
  link: jsonSchema.string({
    description: 'HTTPS URL for context or review PR/issue',
    format: 'uri',
  }),
  requiresCap: jsonSchema.boolean({
    description: 'Whether approval requires specifying a spend ceiling cap (capUsd)',
  }),
  payload: jsonSchema.object({}, {
    description: 'Structured parameters or payload for the hold',
  }),
}, { required: ['title', 'summary', 'approvers'] });

const SubmissionCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  kind: jsonSchema.string({ description: 'Content kind', enum: ['agent', 'skill'] }),
  content: jsonSchema.object({}, { description: 'Complete cartridge manifest or skill package configuration' }),
}, { required: ['kind', 'content'] });

const InterviewSubmitBodySchema: JsonSchemaObject = jsonSchema.object({
  answers: jsonSchema.object({}, { description: 'Interview questions and answers map' }),
  finalize: jsonSchema.boolean({ description: 'Whether to create a formal submission or preview only' }),
}, { required: ['answers'] });

const AgentSkillAdoptBodySchema: JsonSchemaObject = jsonSchema.object({
  skillId: jsonSchema.string({ description: 'Skill package identifier' }),
  version: jsonSchema.string({ description: 'Semantic version of skill to adopt' }),
  holds: jsonSchema.object({}, { description: 'Hold overrides map (action -> boolean)' }),
  reason: jsonSchema.string({ description: 'Adoption rationale' }),
}, { required: ['skillId'] });

const AgentSkillPatchBodySchema: JsonSchemaObject = jsonSchema.object({
  holds: jsonSchema.object({}, { description: 'Hold overrides map (action -> boolean)' }),
  version: jsonSchema.string({ description: 'Target version update' }),
});

const AgentSkillHoldsBodySchema: JsonSchemaObject = jsonSchema.object({
  holds: jsonSchema.object({}, { description: 'Hold overrides map (action -> boolean)' }),
}, { required: ['holds'] });

const ConversationTurnBodySchema: JsonSchemaObject = jsonSchema.object({
  input: jsonSchema.object({}, { description: 'Input payload or structured turn content' }),
  message: jsonSchema.string({ description: 'Text message from user to agent' }),
  prompt: jsonSchema.string({ description: 'Prompt or instructions for agent' }),
  requestedBy: jsonSchema.object({
    provider: jsonSchema.string({ description: 'External identity provider' }),
    id: jsonSchema.string({ description: 'External user identifier' }),
  }, { description: 'Verified external caller identity' }),
});

const ConversationRequestsBodySchema: JsonSchemaObject = jsonSchema.object({
  op: jsonSchema.string({ description: 'Operation type', enum: ['list', 'turns'] }),
  conversation: jsonSchema.string({ description: 'Conversation ID when querying turns' }),
  limit: jsonSchema.integer({ description: 'Max items to return (1-20)', minimum: 1, maximum: 20 }),
  subject: jsonSchema.string({ description: 'Principal actor filter' }),
}, { required: ['op'] });

const RunStartBodySchema: JsonSchemaObject = jsonSchema.object({
  input: jsonSchema.object({}, { description: 'Initial input payload for container run' }),
  model: jsonSchema.string({ description: 'AI model override for this run' }),
  callbackUrl: jsonSchema.string({ description: 'Webhook callback URL on run completion' }),
  requestedBy: jsonSchema.object({
    provider: jsonSchema.string({ description: 'External identity provider' }),
    id: jsonSchema.string({ description: 'External user identifier' }),
  }, { description: 'Attested caller identity' }),
});

const RunWakeBodySchema: JsonSchemaObject = jsonSchema.object({
  input: jsonSchema.object({}, { description: 'Input payload to deliver on agent wake' }),
  model: jsonSchema.string({ description: 'AI model override' }),
  requestedBy: jsonSchema.object({
    provider: jsonSchema.string({ description: 'External identity provider' }),
    id: jsonSchema.string({ description: 'External user identifier' }),
  }, { description: 'Attested caller identity' }),
});

const AgentSettingsBodySchema: JsonSchemaObject = jsonSchema.object({
  name: jsonSchema.string({ description: 'Updated agent display name' }),
  settings: jsonSchema.object({}, { description: 'Configuration settings object' }),
  soul: jsonSchema.string({ description: 'Updated core persona and instructions' }),
  memory: jsonSchema.object({}, { description: 'Memory configuration block' }),
  roles: jsonSchema.array(jsonSchema.object({}, { description: 'Role definitions' })),
});

const AgentRenameBodySchema: JsonSchemaObject = jsonSchema.object({
  name: jsonSchema.string({ description: 'New display name for the agent' }),
}, { required: ['name'] });

const AgentPolicyBodySchema: JsonSchemaObject = jsonSchema.object({
  routes: jsonSchema.array(jsonSchema.string(), { description: 'Allowed egress network routes' }),
  models: jsonSchema.array(jsonSchema.string(), { description: 'Allowed AI models' }),
  budgetUsd: jsonSchema.object({
    perDay: jsonSchema.number({ description: 'Daily budget limit in USD', minimum: 0 }),
    perMonth: jsonSchema.number({ description: 'Monthly budget limit in USD', minimum: 0 }),
  }, { description: 'Agent spend limits' }),
  tools: jsonSchema.object({}, { description: 'Tool permission rules' }),
  subagents: jsonSchema.array(jsonSchema.string(), { description: 'Permitted helper subagents' }),
  wakeAgents: jsonSchema.array(jsonSchema.string(), { description: 'Permitted wake agent IDs' }),
  env: jsonSchema.object({}, {
    additionalProperties: jsonSchema.string({ description: 'Environment variable value' }),
    description: 'Non-secret deployment environment variables (UPPER_SNAKE_CASE, e.g. SDLC_*)',
  }),
});

const GlobalPolicyBodySchema: JsonSchemaObject = jsonSchema.object({
  budgetUsd: jsonSchema.object({
    perDay: jsonSchema.number({ description: 'Daily spend ceiling in USD', minimum: 0 }),
    perMonth: jsonSchema.number({ description: 'Monthly spend ceiling in USD', minimum: 0 }),
  }, { description: 'Global spend ceiling limits' }),
  routes: jsonSchema.array(jsonSchema.string(), { description: 'Global allowed egress network routes' }),
  models: jsonSchema.array(jsonSchema.string(), { description: 'Global allowed AI models' }),
  hosts: jsonSchema.array(jsonSchema.string(), { description: 'Global allowed network hostnames' }),
  tools: jsonSchema.object({}, { description: 'Global tool permission rules' }),
  tokensPerMinute: jsonSchema.integer({ description: 'Global tokens per minute rate limit', minimum: 0 }),
  grounding: jsonSchema.string({ description: 'Grounding mode', enum: ['warn-once'] }),
});

const AgentModelsBodySchema: JsonSchemaObject = jsonSchema.object({
  defaultModel: jsonSchema.string({ description: 'Primary model name' }),
  allowedModels: jsonSchema.array(jsonSchema.string(), { description: 'List of allowed model names' }),
  failoverModels: jsonSchema.array(jsonSchema.string(), { description: 'Ordered failover fallback models' }),
});

const AgentOwnersBodySchema: JsonSchemaObject = jsonSchema.object({
  owners: jsonSchema.array(jsonSchema.string(), { description: 'Array of principal IDs who co-own the agent' }),
}, { required: ['owners'] });

const AgentUpdateInstallBodySchema: JsonSchemaObject = jsonSchema.object({
  mode: jsonSchema.string({ description: 'Update installation mode', enum: ['drain', 'restart_now'] }),
  commit: jsonSchema.string({ description: 'Target git commit SHA' }),
  version: jsonSchema.string({ description: 'Target release version' }),
});

const AgentConvertBodySchema: JsonSchemaObject = jsonSchema.object({
  settings: jsonSchema.object({}, { description: 'Agent configuration settings' }),
  soul: jsonSchema.string({ description: 'Agent persona prompt' }),
  memory: jsonSchema.object({}, { description: 'Memory archetype and bounds' }),
  skills: jsonSchema.array(jsonSchema.object({
    id: jsonSchema.string({ description: 'Skill package ID' }),
    version: jsonSchema.string({ description: 'Skill version' }),
  })),
});

const ModelScanBodySchema: JsonSchemaObject = jsonSchema.object({
  vendorId: jsonSchema.string({ description: 'Vendor identifier to scan for new models' }),
}, { required: ['vendorId'] });

const ModelAdmitBodySchema: JsonSchemaObject = jsonSchema.object({
  model: jsonSchema.string({ description: 'Model identifier' }),
  credentialMode: jsonSchema.string({ description: 'Credential mode (api-key or subscription)' }),
  connection: jsonSchema.string({ description: 'Connection ID for subscription catalog entries' }),
  price: jsonSchema.object({
    inputPerMillion: jsonSchema.number({ description: 'Cost per million input tokens in USD' }),
    outputPerMillion: jsonSchema.number({ description: 'Cost per million output tokens in USD' }),
  }, { description: 'Token pricing configuration' }),
});

const ModelPricingBodySchema: JsonSchemaObject = jsonSchema.object({
  price: jsonSchema.object({
    inputPerMillion: jsonSchema.number({ description: 'Cost per million input tokens in USD' }),
    outputPerMillion: jsonSchema.number({ description: 'Cost per million output tokens in USD' }),
  }, { description: 'Updated token pricing', required: ['inputPerMillion', 'outputPerMillion'] }),
}, { required: ['price'] });

const ModelDefaultBodySchema: JsonSchemaObject = jsonSchema.object({
  model: jsonSchema.string({ description: 'Model identifier' }),
  name: jsonSchema.string({ description: 'Alias for model identifier (accepted if model omitted)' }),
});

const RegistryAgentBodySchema: JsonSchemaObject = jsonSchema.object({
  repo: jsonSchema.string({ description: 'HTTPS Git repository URL' }),
  commit: jsonSchema.string({ description: 'Pinned 40-character git commit SHA' }),
  id: jsonSchema.string({ description: 'Optional agent identifier' }),
  name: jsonSchema.string({ description: 'Human-readable agent name' }),
  cartridge: jsonSchema.object({}, { description: 'Embedded cartridge configuration' }),
});

const CredentialValueBodySchema: JsonSchemaObject = jsonSchema.object({
  value: jsonSchema.string({ description: 'Secret plaintext value to store securely' }),
}, { required: ['value'] });

const OAuthClientCredentialsBodySchema: JsonSchemaObject = jsonSchema.object({
  clientId: jsonSchema.string({ description: 'OAuth client ID' }),
  clientSecret: jsonSchema.string({ description: 'OAuth client secret' }),
  value: jsonSchema.string({ description: 'Raw client credential value' }),
});

const AppSetupStepBodySchema: JsonSchemaObject = jsonSchema.object({
  input: jsonSchema.object({}, { description: 'Setup step input values' }),
  value: jsonSchema.string({ description: 'Setup step token or credential value' }),
});

const DiscordTokenBodySchema: JsonSchemaObject = jsonSchema.object({
  token: jsonSchema.string({ description: 'Discord bot token' }),
}, { required: ['token'] });

const GitHubAppStartBodySchema: JsonSchemaObject = jsonSchema.object({
  replace: jsonSchema.boolean({ description: 'Whether to replace an existing GitHub App setup' }),
});

const GitHubAppInstallationsBodySchema: JsonSchemaObject = jsonSchema.object({
  orgs: jsonSchema.array(jsonSchema.string(), { description: 'GitHub organization names' }),
  installationIds: jsonSchema.array(jsonSchema.number(), { description: 'GitHub App installation IDs' }),
});

const TransferStartBodySchema: JsonSchemaObject = jsonSchema.object({
  to: jsonSchema.string({ description: 'Recipient principal ID (user:<slug>)' }),
  notes: jsonSchema.string({ description: 'Transfer message or justification' }),
}, { required: ['to'] });

const ConnectionImportBodySchema: JsonSchemaObject = jsonSchema.object({
  credentials: jsonSchema.object({}, { description: 'Provider connection credentials' }),
  token: jsonSchema.string({ description: 'Access token or API key' }),
});

const SubscriptionConnectBodySchema: JsonSchemaObject = jsonSchema.object({
  templateId: jsonSchema.string({ description: 'Subscription template identifier' }),
  subscriberAttested: jsonSchema.boolean({ description: 'Must be true confirming subscription ownership' }),
  scope: jsonSchema.string({ description: 'Subscription scope', enum: ['factory', 'personal'] }),
  name: jsonSchema.string({ description: 'Display name for the subscription connection' }),
  ownerPrincipalId: jsonSchema.string({ description: 'Owner principal ID for personal subscriptions' }),
}, { required: ['templateId', 'subscriberAttested'] });

const SubscriptionReconnectBodySchema: JsonSchemaObject = jsonSchema.object({
  subscriberAttested: jsonSchema.boolean({ description: 'Confirm re-attestation of subscription terms' }),
});

const SubscriptionModelAdmitBodySchema: JsonSchemaObject = jsonSchema.object({
  model: jsonSchema.string({ description: 'Model identifier' }),
  displayName: jsonSchema.string({ description: 'Display name for model' }),
  price: jsonSchema.object({
    inputPerMillion: jsonSchema.number({ description: 'Input token cost' }),
    outputPerMillion: jsonSchema.number({ description: 'Output token cost' }),
  }),
}, { required: ['model'] });

const SubscriptionUpdateBodySchema: JsonSchemaObject = jsonSchema.object({
  name: jsonSchema.string({ description: 'Updated display name for subscription connection' }),
}, { required: ['name'] });

const IdentityLinkBodySchema: JsonSchemaObject = jsonSchema.object({
  actor: jsonSchema.string({ description: 'Internal principal actor string' }),
  name: jsonSchema.string({ description: 'External display name' }),
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Global roles mapped to this identity' }),
  agentRoles: jsonSchema.object({}, { description: 'Agent-scoped role mappings' }),
}, { required: ['actor'] });

const ApiKeyCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  name: jsonSchema.string({ description: 'Human-readable description or label' }),
  owner: jsonSchema.string({ description: 'Principal ID who owns the key (defaults to caller)' }),
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Roles granted to service API key' }),
  deviceFamily: jsonSchema.string({ description: 'Device family or client class (e.g. cli, mcp:<client_id>)' }),
  scopes: jsonSchema.object({
    readOnly: jsonSchema.boolean({ description: 'Whether key is restricted to read-only operations' }),
    toolsets: jsonSchema.array(jsonSchema.string(), { description: 'Permitted MCP toolset names' }),
  }, { description: 'Key scopes bounding authority' }),
  expiresAt: {
    type: ['string', 'null'],
    format: 'date-time',
    description: 'ISO-8601 expiration timestamp or null for non-expiring',
  },
});

const ApiKeyRotateBodySchema: JsonSchemaObject = jsonSchema.object({
  expiresAt: jsonSchema.string({ description: 'Updated ISO-8601 expiration timestamp' }),
});

const IdpSetupBodySchema: JsonSchemaObject = jsonSchema.object({
  providers: jsonSchema.array(jsonSchema.object({
    id: jsonSchema.string({ description: 'Provider identifier' }),
    issuer: jsonSchema.string({ description: 'OIDC issuer URL' }),
    clientId: jsonSchema.string({ description: 'OIDC client ID' }),
    clientSecret: jsonSchema.string({ description: 'OIDC client secret' }),
    name: jsonSchema.string({ description: 'Display name' }),
  }, { required: ['id', 'issuer', 'clientId'] }), { description: 'Identity provider configurations' }),
}, { required: ['providers'] });

const AuthMigrationImportBodySchema: JsonSchemaObject = jsonSchema.object({
  reissueKeys: jsonSchema.boolean({ description: 'Whether to reissue API keys during migration' }),
});

const RuntimeRolloutBodySchema: JsonSchemaObject = jsonSchema.object({
  repo: jsonSchema.string({ description: 'Git repository URL' }),
  commit: jsonSchema.string({ description: 'Pinned 40-character commit SHA' }),
  image: jsonSchema.string({ description: 'Pinned container image digest (image@sha256:...)' }),
}, { required: ['repo', 'commit', 'image'] });

const AgentImportBodySchema: JsonSchemaObject = jsonSchema.object({
  bundle: jsonSchema.object({}, { description: 'Agent bundle archive or manifest' }),
  agent: jsonSchema.object({}, { description: 'Agent definition' }),
});

const RoleAssignmentBodySchema: JsonSchemaObject = jsonSchema.object({
  role: jsonSchema.string({ description: 'Role name assigned to subject on agent' }),
}, { required: ['role'] });

const SkillDefaultsBodySchema: JsonSchemaObject = jsonSchema.object({
  defaults: jsonSchema.array(jsonSchema.object({
    id: jsonSchema.string({ description: 'Skill package ID' }),
    version: jsonSchema.string({ description: 'Semantic version' }),
    holds: jsonSchema.object({}, { description: 'Hold overrides' }),
  }, { required: ['id', 'version'] })),
}, { required: ['defaults'] });

const SkillRegisterBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Skill package identifier' }),
  version: jsonSchema.string({ description: 'Semantic version string' }),
  manifest: jsonSchema.object({}, { description: 'Skill manifest specification' }),
  repo: jsonSchema.string({ description: 'Repository URL' }),
  commit: jsonSchema.string({ description: 'Commit SHA' }),
}, { required: ['id', 'version'] });

const DecisionReasonBodySchema: JsonSchemaObject = jsonSchema.object({
  reason: jsonSchema.string({ description: 'Administrative justification' }),
});

const TrainingCapBodySchema: JsonSchemaObject = jsonSchema.object({
  capUsd: jsonSchema.number({ description: 'Training account budget limit in USD', minimum: 0 }),
}, { required: ['capUsd'] });

const TrainingBaselineBodySchema: JsonSchemaObject = jsonSchema.object({
  cases: jsonSchema.array(jsonSchema.object({}, { description: 'Evaluation benchmark test cases' })),
}, { required: ['cases'] });

const TrainingRunBodySchema: JsonSchemaObject = jsonSchema.object({
  model: jsonSchema.string({ description: 'AI model used for training run' }),
  costUsd: jsonSchema.number({ description: 'Training run spend' }),
  outputs: jsonSchema.object({}, { description: 'Training evaluation metrics and outputs' }),
});

const SkillModelBodySchema: JsonSchemaObject = jsonSchema.object({
  model: jsonSchema.string({ description: 'Offered model identifier, or null to clear' }),
});

const SkillGroupBodySchema: JsonSchemaObject = jsonSchema.object({
  groupId: jsonSchema.string({ description: 'Target group ID' }),
}, { required: ['groupId'] });

const PublishRequestBodySchema: JsonSchemaObject = jsonSchema.object({
  notes: jsonSchema.string({ description: 'Publication justification' }),
});

const GroupCreateBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Group slug identifier (1-64 lowercase alphanumeric, dot, hyphen or underscore)' }),
  name: jsonSchema.string({ description: 'Human-readable group name (1-255 characters)' }),
  description: jsonSchema.string({ description: 'Group description (up to 1000 characters)' }),
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Scoped skill roles assigned to group' }),
  members: jsonSchema.array(jsonSchema.string(), { description: 'Initial member principal IDs' }),
}, { required: ['id', 'name'] });

const GroupUpdateBodySchema: JsonSchemaObject = jsonSchema.object({
  name: jsonSchema.string({ description: 'Updated group name (1-255 characters)' }),
  description: jsonSchema.string({ description: 'Updated description (up to 1000 characters)' }),
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Updated scoped skill roles' }),
});

const GroupMemberAddBodySchema: JsonSchemaObject = jsonSchema.object({
  member: jsonSchema.string({ description: 'Principal ID to add to group' }),
}, { required: ['member'] });

const SubagentRegisterBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'Subagent identifier' }),
  name: jsonSchema.string({ description: 'Subagent display name' }),
  description: jsonSchema.string({ description: 'Task specialization description' }),
  prompt: jsonSchema.string({ description: 'Subagent system prompt instructions' }),
  skills: jsonSchema.array(jsonSchema.string(), { description: 'Required skills' }),
}, { required: ['id'] });

const SubagentModelsBodySchema: JsonSchemaObject = jsonSchema.object({
  approvedModels: jsonSchema.array(jsonSchema.string(), { description: 'List of offered models allowed for subagent' }),
}, { required: ['approvedModels'] });

const SystemProposalBodySchema: JsonSchemaObject = jsonSchema.object({
  id: jsonSchema.string({ description: 'System identifier' }),
  name: jsonSchema.string({ description: 'System display name' }),
  upstream: jsonSchema.string({ description: 'Upstream base URL' }),
  routes: jsonSchema.array(jsonSchema.string(), { description: 'Routes provided by this system' }),
  credential: jsonSchema.object({
    secret: jsonSchema.string({ description: 'Platform secret name bound to system' }),
  }),
}, { required: ['id'] });

const SystemDecisionBodySchema: JsonSchemaObject = jsonSchema.object({
  version: jsonSchema.integer({ description: 'Proposal version being decided' }),
  reason: jsonSchema.string({ description: 'Administrative decision notes' }),
});

// Internal Mutating Schemas
const CliTokenExchangeBodySchema: JsonSchemaObject = jsonSchema.object({
  token: jsonSchema.string({ description: 'One-time CLI token from browser sign-in' }),
});

const SubagentSpawnBodySchema: JsonSchemaObject = jsonSchema.object({
  subagentId: jsonSchema.string({ description: 'Subagent identifier to spawn' }),
  input: jsonSchema.object({}, { description: 'Initial input for subagent' }),
});

const RunWakeTargetBodySchema: JsonSchemaObject = jsonSchema.object({
  input: jsonSchema.object({}, { description: 'Input payload' }),
});

const RunReplyBodySchema: JsonSchemaObject = jsonSchema.object({
  content: jsonSchema.string({ description: 'Reply text from agent turn' }),
  turnId: jsonSchema.string({ description: 'Associated turn ID' }),
}, { required: ['content'] });

const RunRoleRequestsBodySchema: JsonSchemaObject = jsonSchema.object({
  roles: jsonSchema.array(jsonSchema.string(), { description: 'Roles requested by run' }),
}, { required: ['roles'] });

const LedgerEventBodySchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent associated with ledger event' }),
  type: jsonSchema.string({ description: 'Event category type' }),
}, { required: ['agentId', 'type'] });

const EgressApprovalBodySchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Requesting agent ID' }),
  route: jsonSchema.string({ description: 'Target egress route' }),
}, { required: ['agentId', 'route'] });

const EgressHoldBodySchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Requesting agent ID' }),
  skillId: jsonSchema.string({ description: 'Skill holding action' }),
  action: jsonSchema.string({ description: 'Held action name' }),
}, { required: ['agentId', 'skillId', 'action'] });

const SecretCheckoutBodySchema: JsonSchemaObject = jsonSchema.object({
  credential: jsonSchema.string({ description: 'Name of credential to checkout' }),
}, { required: ['credential'] });

const McpRpcBodySchema: JsonSchemaObject = jsonSchema.object({
  method: jsonSchema.string({ description: 'JSON-RPC MCP method name' }),
  params: jsonSchema.object({}, { description: 'JSON-RPC parameters object' }),
}, { required: ['method'] });

const ConnectionTokenBodySchema: JsonSchemaObject = jsonSchema.object({
  connection: jsonSchema.string({ description: 'Connection ID' }),
}, { required: ['connection'] });

const SubscriptionTokenBodySchema: JsonSchemaObject = jsonSchema.object({
  connection: jsonSchema.string({ description: 'Subscription connection ID' }),
}, { required: ['connection'] });

const GatekeeperRoutesBodySchema: JsonSchemaObject = jsonSchema.object({
  routes: jsonSchema.array(jsonSchema.string(), { description: 'Route names' }),
}, { required: ['routes'] });

const MintGitHubTokenBodySchema: JsonSchemaObject = jsonSchema.object({
  agentId: jsonSchema.string({ description: 'Agent ID' }),
}, { required: ['agentId'] });

const GenericObjectBodySchema: JsonSchemaObject = jsonSchema.object({
  payload: jsonSchema.object({}, { description: 'Generic payload' }),
});

// Reusable Query Schemas
const LedgerQuerySchema: JsonSchemaObject = jsonSchema.object({
  agent: jsonSchema.string({ description: 'Filter by agent ID' }),
  agentId: jsonSchema.string({ description: 'Filter by agent ID (alias)' }),
  from: jsonSchema.string({ description: 'Start ISO timestamp' }),
  to: jsonSchema.string({ description: 'End ISO timestamp' }),
  limit: jsonSchema.integer({ description: 'Max events to return (1-1000)', minimum: 1, maximum: 1000 }),
  offset: jsonSchema.integer({ description: 'Pagination offset', minimum: 0 }),
});

const RunsQuerySchema: JsonSchemaObject = jsonSchema.object({
  agent: jsonSchema.string({ description: 'Filter by agent ID' }),
  active: jsonSchema.boolean({ description: 'Filter only active (non-terminal) runs' }),
  limit: jsonSchema.integer({ description: 'Max runs to return (1-1000)', minimum: 1, maximum: 1000 }),
  offset: jsonSchema.integer({ description: 'Pagination offset', minimum: 0 }),
});

const AuthzCheckQuerySchema: JsonSchemaObject = jsonSchema.object({
  privilege: jsonSchema.string({ description: 'Bouncer privilege name to test' }),
  agentId: jsonSchema.string({ description: 'Optional agent ID scope for check' }),
  skillId: jsonSchema.string({ description: 'Optional skill ID scope for check' }),
}, { required: ['privilege'] });

const RepliesQuerySchema: JsonSchemaObject = jsonSchema.object({
  after: jsonSchema.integer({ description: 'Return console replies after sequence number' }),
});

const GrantsQuerySchema: JsonSchemaObject = jsonSchema.object({
  subject: jsonSchema.string({ description: 'Filter by subject principal or group' }),
  scopeKind: jsonSchema.string({ description: 'Filter by scope kind (fleet, agent, skill)' }),
  scopeId: jsonSchema.string({ description: 'Filter by scope entity ID' }),
  includeExpired: jsonSchema.boolean({ description: 'Include expired grants' }),
});

const KeysQuerySchema: JsonSchemaObject = jsonSchema.object({
  owner: jsonSchema.string({ description: 'Filter keys by owner principal ID' }),
});

const SchedulesQuerySchema: JsonSchemaObject = jsonSchema.object({
  agent: jsonSchema.string({ description: 'Filter schedules by agent ID' }),
  agentId: jsonSchema.string({ description: 'Filter schedules by agent ID (alias)' }),
});

const GroupsQuerySchema: JsonSchemaObject = jsonSchema.object({
  member: jsonSchema.string({ description: 'Filter groups by member principal ID' }),
});

const PackageFileQuerySchema: JsonSchemaObject = jsonSchema.object({
  path: jsonSchema.string({ description: 'Relative file path inside skill package' }),
}, { required: ['path'] });

const SpendReportQuerySchema: JsonSchemaObject = jsonSchema.object({
  period: jsonSchema.string({ description: 'Accounting period: current or last', enum: ['current', 'last'] }),
});

const HealthResponseSchema: JsonSchemaObject = jsonSchema.object({
  status: jsonSchema.string({ description: 'Service health status' }),
}, { required: ['status'] });

const RolesQuerySchema: JsonSchemaObject = jsonSchema.object({
  held: jsonSchema.string({ description: 'Filter by held role name' }),
});

const ApprovalsQuerySchema: JsonSchemaObject = jsonSchema.object({
  state: jsonSchema.string({ description: 'Filter approvals by state (pending, approved, rejected)' }),
  kind: jsonSchema.string({ description: 'Filter approvals by kind', enum: ['tool', 'held', 'change', 'decision'] }),
});

const ConnectionsStartQuerySchema: JsonSchemaObject = jsonSchema.object({
  scopes: jsonSchema.string({ description: 'Optional space- or comma-delimited OAuth scopes' }),
});

const SubscriptionsQuerySchema: JsonSchemaObject = jsonSchema.object({
  scope: jsonSchema.string({ description: 'Filter by scope: factory or personal', enum: ['factory', 'personal'] }),
});

const StreamQuerySchema: JsonSchemaObject = jsonSchema.object({
  agent: jsonSchema.string({ description: 'Filter events by agent ID' }),
});

export const RAW_CONTROL_PLANE_ROUTES: readonly ControlPlaneRoute[] = [
  {
    operationId: "get_ui",
    method: "GET",
    pattern: "/ui",
    summary: "Factory web UI HTML",
    description: "Factory web UI HTML (session-gated, S12)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "ui-session",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_login_page",
    method: "GET",
    pattern: "/login",
    summary: "Factory login page",
    description: "Factory login page (S12)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "login-page",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "start_idp_login",
    method: "GET",
    pattern: "/api/v1/auth/:idp/start",
    summary: "Begin IdP sign-in",
    description: "Begin IdP sign-in (S12)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "login-start",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "callback_idp_login",
    method: "GET",
    pattern: "/api/v1/auth/:idp/callback",
    summary: "IdP sign-in callback",
    description: "IdP sign-in callback (S12)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "login-callback",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "exchange_cli_token",
    method: "POST",
    pattern: "/api/v1/auth/cli/token",
    summary: "CLI key exchange after browser sign-in",
    description: "CLI key exchange after browser sign-in (S13)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "login-cli-token",
    requestBodySchema: CliTokenExchangeBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "logout_session",
    method: "POST",
    pattern: "/api/v1/auth/logout",
    summary: "Sign out",
    description: "Sign out (S12)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "logout",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_root_health_or_login",
    method: "GET",
    pattern: "/",
    summary: "Root endpoint (health or login)",
    description: "Login page for browsers; health for verified principals",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "login-page",
    responseSchema: HealthResponseSchema,
  },
  {
    operationId: "get_healthz",
    method: "GET",
    pattern: "/healthz",
    summary: "Liveness probe",
    staff: "inspector",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "healthz_probe",
    exception: "health-probe",
    responseSchema: HealthResponseSchema,
  },
  {
    operationId: "get_health",
    method: "GET",
    pattern: "/api/v1/health",
    summary: "Health check probe",
    staff: "inspector",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "health_check",
    exception: "health-probe",
    responseSchema: HealthResponseSchema,
  },
  {
    operationId: "whoami",
    method: "GET",
    pattern: "/api/v1/whoami",
    summary: "Caller identity and roles probe",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "whoami",
    inCoreToolset: true,
    exception: "identity-whoami",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_setup_status",
    method: "GET",
    pattern: "/api/v1/setup/status",
    summary: "Setup status and break-glass alert",
    description: "Setup status and break-glass alert (S6)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_setup_status",
    inCoreToolset: true,
    exception: "setup-status",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_idp_config",
    method: "GET",
    pattern: "/api/v1/setup/idp",
    summary: "Read IdP configuration",
    description: "Read IdP configuration (S6)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_idp_config",
    privilege: "grants.manage",
    responseSchema: IdpSetupBodySchema,
  },
  {
    operationId: "set_idp_config",
    method: "PUT",
    pattern: "/api/v1/setup/idp",
    summary: "Set IdP configuration",
    description: "Set IdP configuration (S6)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "set_idp_config",
    privilege: "grants.manage",
    requestBodySchema: IdpSetupBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_api_keys",
    method: "GET",
    pattern: "/api/v1/keys",
    summary: "List API keys",
    description: "List API keys (S5)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "list_api_keys",
    exception: "keys-self-list",
    querySchema: KeysQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_api_key",
    method: "POST",
    pattern: "/api/v1/keys",
    summary: "Issue API key",
    description: "Issue API key (S5)",
    staff: "bouncer",
    mcpExposure: "console-or-cli-only",
    exception: "keys-self-create",
    requestBodySchema: ApiKeyCreateBodySchema,
    responseSchema: ApiKeyRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "rotate_api_key",
    method: "POST",
    pattern: "/api/v1/keys/:id/rotate",
    summary: "Rotate API key",
    description: "Rotate API key (S5)",
    staff: "bouncer",
    mcpExposure: "console-or-cli-only",
    exception: "keys-self-rotate",
    requestBodySchema: ApiKeyRotateBodySchema,
    responseSchema: ApiKeyRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "revoke_api_key",
    method: "DELETE",
    pattern: "/api/v1/keys/:id",
    summary: "Revoke API key",
    description: "Revoke API key (S5)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "revoke_api_key",
    exception: "keys-self-revoke",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "authz_check",
    method: "GET",
    pattern: "/api/v1/authz/check",
    summary: "Authorization preflight",
    description: "Authorization preflight (S3)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "authz_check",
    inCoreToolset: true,
    exception: "authz-check",
    querySchema: AuthzCheckQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "import_auth_migration",
    method: "POST",
    pattern: "/api/v1/auth-migration/import",
    summary: "Import legacy env and link roles",
    description: "Import legacy env and link roles (S8)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "import_auth_migration",
    privilege: "grants.manage",
    requestBodySchema: AuthMigrationImportBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_auth_migration_readiness",
    method: "GET",
    pattern: "/api/v1/auth-migration/readiness",
    summary: "Shadow-mode readiness",
    description: "Shadow-mode readiness (S8)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_auth_migration_readiness",
    privilege: "grants.manage",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "cutover_auth_migration",
    method: "POST",
    pattern: "/api/v1/auth-migration/cutover",
    summary: "Cut over to grants-only",
    description: "Cut over to grants-only (S8)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "danger",
    mcpToolName: "cutover_auth_migration",
    privilege: "grants.manage",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 409],
  },
  {
    operationId: "list_principals",
    method: "GET",
    pattern: "/api/v1/principals",
    summary: "List principals",
    description: "List principals (S3)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "list_principals",
    privilege: "grants.manage",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_principal",
    method: "POST",
    pattern: "/api/v1/principals",
    summary: "Create principal",
    description: "Create principal (S3)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "create_principal",
    privilege: "grants.manage",
    requestBodySchema: PrincipalCreateBodySchema,
    responseSchema: PrincipalRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "get_principal",
    method: "GET",
    pattern: "/api/v1/principals/:id",
    summary: "Get principal",
    description: "Get principal (S3)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_principal",
    privilege: "grants.manage",
    responseSchema: PrincipalRecordResponseSchema,
  },
  {
    operationId: "revoke_principal_access",
    method: "POST",
    pattern: "/api/v1/principals/:id/revoke-access",
    summary: "Revoke all access for principal",
    description: "Revoke all access: grants, groups, sessions, CLI login tokens; API keys stay (#436)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "danger",
    mcpToolName: "revoke_principal_access",
    privilege: "grants.manage",
    requestBodySchema: PrincipalRevokeBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "update_principal",
    method: "PATCH",
    pattern: "/api/v1/principals/:id",
    summary: "Rename principal (display name)",
    description: "Rename principal (display name; #434)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "update_principal",
    privilege: "grants.manage",
    requestBodySchema: PrincipalUpdateBodySchema,
    responseSchema: PrincipalRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "add_principal_email",
    method: "POST",
    pattern: "/api/v1/principals/:id/emails",
    summary: "Add principal email",
    description: "Add principal email (S3)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "add_principal_email",
    privilege: "grants.manage",
    requestBodySchema: PrincipalEmailBodySchema,
    responseSchema: PrincipalRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "remove_principal_email",
    method: "DELETE",
    pattern: "/api/v1/principals/:id/emails/:email",
    summary: "Remove principal email",
    description: "Remove principal email (S3)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "remove_principal_email",
    privilege: "grants.manage",
    responseSchema: PrincipalRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_grants",
    method: "GET",
    pattern: "/api/v1/grants",
    summary: "List grants",
    description: "List grants (S3)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "list_grants",
    inCoreToolset: true,
    exception: "grants-scoped-list",
    querySchema: GrantsQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_grant",
    method: "POST",
    pattern: "/api/v1/grants",
    summary: "Create grant",
    description: "Create grant (S3)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "create_grant",
    inCoreToolset: true,
    exception: "grants-scoped-create",
    requestBodySchema: GrantCreateBodySchema,
    responseSchema: GrantRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "revoke_grant",
    method: "DELETE",
    pattern: "/api/v1/grants/:id",
    summary: "Revoke grant",
    description: "Revoke grant (S3)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "revoke_grant",
    inCoreToolset: true,
    exception: "grants-scoped-revoke",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_metrics",
    method: "GET",
    pattern: "/api/v1/metrics",
    summary: "Platform metrics",
    staff: "inspector",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "get_metrics",
    inCoreToolset: true,
    privilege: "metrics.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_prometheus_metrics",
    method: "GET",
    pattern: "/metrics",
    summary: "Prometheus metrics endpoint",
    staff: "inspector",
    mcpExposure: "internal",
    privilege: "metrics.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_fleet_spend",
    method: "GET",
    pattern: "/api/v1/spend",
    summary: "Fleet spend summary",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "spend",
    mcpToolName: "get_fleet_spend",
    inCoreToolset: true,
    privilege: "spend.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_spend_report",
    method: "GET",
    pattern: "/api/v1/spend/report",
    summary: "Spend breakdown report",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "spend",
    mcpToolName: "get_spend_report",
    inCoreToolset: true,
    privilege: "spend.read",
    querySchema: SpendReportQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_compute_spend",
    method: "GET",
    pattern: "/api/v1/spend/compute",
    summary: "Compute costs report",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "spend",
    mcpToolName: "get_compute_spend",
    privilege: "spend.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_spend_budgets",
    method: "GET",
    pattern: "/api/v1/spend/budgets",
    summary: "Spend budgets query",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "spend",
    mcpToolName: "get_spend_budgets",
    inCoreToolset: true,
    privilege: "spend.read",
    responseSchema: SpendBudgetsGetResponseSchema,
  },
  {
    operationId: "set_spend_budgets",
    method: "PUT",
    pattern: "/api/v1/spend/budgets",
    summary: "Set spend budgets",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "spend",
    mcpToolName: "set_spend_budgets",
    inCoreToolset: true,
    privilege: "spend.budget.set",
    requestBodySchema: SpendBudgetsBodySchema,
    responseSchema: SpendBudgetVersionResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_triage_queue",
    method: "GET",
    pattern: "/api/v1/triage",
    summary: "Triage queue query",
    staff: "inspector",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "get_triage_queue",
    inCoreToolset: true,
    privilege: "triage.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "webhook_github_release",
    method: "POST",
    pattern: "/api/v1/hooks/github",
    summary: "GitHub release webhook",
    description: "GitHub release webhook (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-github",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "webhook_github_release_alias1",
    method: "POST",
    pattern: "/hooks/github",
    summary: "GitHub release webhook alias",
    description: "GitHub release webhook alias (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-github",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "webhook_github_release_alias2",
    method: "POST",
    pattern: "/api/v1/webhooks/github",
    summary: "GitHub release webhook alias",
    description: "GitHub release webhook alias (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-github",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "webhook_github_release_alias3",
    method: "POST",
    pattern: "/webhooks/github",
    summary: "GitHub release webhook alias",
    description: "GitHub release webhook alias (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-github",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "webhook_cartridge_trigger",
    method: "POST",
    pattern: "/api/v1/hooks/:id",
    summary: "Cartridge webhook trigger, or the agent GitHub App events (HMAC signature)",
    description: "Cartridge webhook trigger, or the agent GitHub App events (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-hooks",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "webhook_cartridge_trigger_alias",
    method: "POST",
    pattern: "/hooks/:id",
    summary: "Cartridge webhook trigger alias",
    description: "Cartridge webhook trigger alias (HMAC signature)",
    staff: "gatekeeper",
    mcpExposure: "internal",
    exception: "webhook-hooks",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_agents",
    method: "GET",
    pattern: "/api/v1/agents",
    summary: "List registered agents",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "list_agents",
    inCoreToolset: true,
    privilege: "agents.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_agent",
    method: "POST",
    pattern: "/api/v1/agents",
    summary: "Create configuration-hosted agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "create_agent",
    inCoreToolset: true,
    privilege: "agents.create",
    requestBodySchema: AgentCreateBodySchema,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "import_agent_bundle",
    method: "POST",
    pattern: "/api/v1/agents/import",
    summary: "Import agent bundle",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "import_agent_bundle",
    privilege: "agents.create",
    requestBodySchema: AgentImportBodySchema,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "get_runtime_info",
    method: "GET",
    pattern: "/api/v1/runtime",
    summary: "Read runtime version info",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_runtime_info",
    privilege: "agents.read",
    responseSchema: RuntimeResponseSchema,
  },
  {
    operationId: "rollout_runtime_update",
    method: "PUT",
    pattern: "/api/v1/runtime",
    summary: "Roll out runtime update",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "rollout_runtime_update",
    privilege: "runtime.set",
    requestBodySchema: RuntimeRolloutBodySchema,
    responseSchema: RuntimeResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "start_agent_run",
    method: "POST",
    pattern: "/api/v1/agents/:id/runs",
    summary: "Start run on agent",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "runs",
    mcpToolName: "start_agent_run",
    inCoreToolset: true,
    privilege: "agents.wake",
    requestBodySchema: RunStartBodySchema,
    responseSchema: RunRecordResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "wake_agent",
    method: "POST",
    pattern: "/api/v1/agents/:id/wake",
    summary: "Wake agent with optional requester attestation",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "wake_agent",
    inCoreToolset: true,
    privilege: ["agents.wake","runs.attest-requester"],
    requestBodySchema: RunWakeBodySchema,
    responseSchema: RunRecordResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "pause_agent",
    method: "POST",
    pattern: "/api/v1/agents/:id/pause",
    summary: "Pause agent execution",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "pause_agent",
    inCoreToolset: true,
    privilege: "agents.pause",
    noRequestBody: true,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "resume_agent",
    method: "POST",
    pattern: "/api/v1/agents/:id/resume",
    summary: "Resume agent execution",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "resume_agent",
    inCoreToolset: true,
    privilege: "agents.resume",
    noRequestBody: true,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "isolate_agent",
    method: "POST",
    pattern: "/api/v1/agents/:id/isolate",
    summary: "Isolate agent network access",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "danger",
    mcpToolName: "isolate_agent",
    privilege: "agents.isolate",
    noRequestBody: true,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "reset_agent",
    method: "POST",
    pattern: "/api/v1/agents/:id/reset",
    summary: "Reset agent container state",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "danger",
    mcpToolName: "reset_agent",
    privilege: "agents.reset",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "check_agent_updates",
    method: "POST",
    pattern: "/api/v1/agents/:id/updates/check",
    summary: "Check for agent updates",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "check_agent_updates",
    privilege: "agents.update.read",
    noRequestBody: true,
    responseSchema: UpdateCheckResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "install_agent_update",
    method: "POST",
    pattern: "/api/v1/agents/:id/updates/install",
    summary: "Install agent update",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "install_agent_update",
    privilege: "agents.update.install",
    requestBodySchema: AgentUpdateInstallBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "convert_agent_to_config",
    method: "POST",
    pattern: "/api/v1/agents/:id/convert",
    summary: "Convert repository agent to configuration",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "convert_agent_to_config",
    privilege: "agents.settings.set",
    requestBodySchema: AgentConvertBodySchema,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_agent_settings",
    method: "GET",
    pattern: "/api/v1/agents/:id/settings",
    summary: "Read agent settings",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_settings",
    privilege: "agents.settings.read",
    responseSchema: AgentSettingsResponseSchema,
  },
  {
    operationId: "update_agent_settings",
    method: "PUT",
    pattern: "/api/v1/agents/:id/settings",
    summary: "Update agent settings",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "update_agent_settings",
    privilege: "agents.settings.set",
    requestBodySchema: AgentSettingsBodySchema,
    responseSchema: AgentSettingsResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "rename_agent",
    method: "PUT",
    pattern: "/api/v1/agents/:id/name",
    summary: "Rename agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "rename_agent",
    privilege: "agents.settings.set",
    requestBodySchema: AgentRenameBodySchema,
    responseSchema: AgentRenameResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_agent_roles",
    method: "GET",
    pattern: "/api/v1/agents/:id/roles",
    summary: "Read agent roles",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_roles",
    privilege: "agents.roles.read",
    querySchema: RolesQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_agent_role_assignments",
    method: "GET",
    pattern: "/api/v1/agents/:id/role-assignments",
    summary: "Read agent role assignments",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_role_assignments",
    privilege: "agents.roles.assign",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "assign_agent_role",
    method: "PUT",
    pattern: "/api/v1/agents/:id/role-assignments/:provider/:subject",
    summary: "Assign agent role to subject",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "assign_agent_role",
    privilege: "agents.roles.assign",
    requestBodySchema: RoleAssignmentBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "export_agent_bundle",
    method: "GET",
    pattern: "/api/v1/agents/:id/bundle",
    summary: "Export agent bundle",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "export_agent_bundle",
    privilege: "config.export.agent",
    responseSchema: AgentRecordResponseSchema,
  },
  {
    operationId: "get_agent_models",
    method: "GET",
    pattern: "/api/v1/agents/:id/models",
    summary: "Read agent models policy",
    staff: "executive",
    mcpExposure: "tool",
    toolset: "models",
    mcpToolName: "get_agent_models",
    inCoreToolset: true,
    privilege: "agents.models.read",
    responseSchema: AgentModelsResponseSchema,
  },
  {
    operationId: "set_agent_models",
    method: "PUT",
    pattern: "/api/v1/agents/:id/models",
    summary: "Set agent models policy",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "set_agent_models",
    inCoreToolset: true,
    privilege: "agents.models.set",
    requestBodySchema: AgentModelsBodySchema,
    responseSchema: AgentModelsResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_agent_policy",
    method: "GET",
    pattern: "/api/v1/agents/:id/policy",
    summary: "Read agent egress policy",
    staff: "gatekeeper",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_policy",
    inCoreToolset: true,
    privilege: "policy.read",
    responseSchema: AgentPolicyResponseSchema,
  },
  {
    operationId: "set_agent_policy",
    method: "PUT",
    pattern: "/api/v1/agents/:id/policy",
    summary: "Update agent egress policy",
    staff: "gatekeeper",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "set_agent_policy",
    inCoreToolset: true,
    privilege: "policy.set",
    requestBodySchema: AgentPolicyBodySchema,
    responseSchema: AgentPolicyResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_agent_owners",
    method: "PUT",
    pattern: "/api/v1/agents/:id/owners",
    summary: "Set agent owners",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "set_agent_owners",
    privilege: "agents.owners.set",
    requestBodySchema: AgentOwnersBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_agent_config",
    method: "GET",
    pattern: "/api/v1/agents/:id/config",
    summary: "Read agent configuration",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_config",
    inCoreToolset: true,
    privilege: "config.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_agent_config_history",
    method: "GET",
    pattern: "/api/v1/agents/:id/config/history",
    summary: "Read agent configuration history",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_config_history",
    privilege: "config.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_agent_config_version",
    method: "GET",
    pattern: "/api/v1/agents/:id/config/versions/:version",
    summary: "Read agent configuration version",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_config_version",
    privilege: "config.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "list_agent_skills",
    method: "GET",
    pattern: "/api/v1/agents/:id/skills",
    summary: "List agent adopted skills",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "list_agent_skills",
    inCoreToolset: true,
    privilege: "config.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "adopt_agent_skill",
    method: "POST",
    pattern: "/api/v1/agents/:id/skills",
    summary: "Adopt skill for agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "adopt_agent_skill",
    inCoreToolset: true,
    privilege: "skills.adopt.request",
    requestBodySchema: AgentSkillAdoptBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "remove_agent_skill",
    method: "DELETE",
    pattern: "/api/v1/agents/:id/skills/:skillId",
    summary: "Remove adopted skill from agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "remove_agent_skill",
    inCoreToolset: true,
    privilege: "skills.adopt.remove",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "merge_agent_skill_holds",
    method: "PATCH",
    pattern: "/api/v1/agents/:id/skills/:skillId",
    summary: "Merge skill action hold overrides",
    description: "Merge skill action hold overrides (S23)",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "merge_agent_skill_holds",
    privilege: "skills.adopt.request",
    requestBodySchema: AgentSkillPatchBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "replace_agent_skill_holds",
    method: "PUT",
    pattern: "/api/v1/agents/:id/skills/:skillId/holds",
    summary: "Replace skill action hold overrides",
    description: "Replace skill action hold overrides (S23)",
    staff: "registrar",
    mcpExposure: "internal",
    privilege: "skills.adopt.request",
    requestBodySchema: AgentSkillHoldsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "patch_agent_skill_holds",
    method: "PATCH",
    pattern: "/api/v1/agents/:id/skills/:skillId/holds",
    summary: "Merge skill action hold overrides alias",
    description: "Merge skill action hold overrides (S23)",
    staff: "registrar",
    mcpExposure: "internal",
    privilege: "skills.adopt.request",
    requestBodySchema: AgentSkillHoldsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "approve_agent_skill_adoption",
    method: "POST",
    pattern: "/api/v1/agents/:id/skills/:skillId/adoption/approve",
    summary: "Approve skill adoption",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "skills",
    mcpToolName: "approve_agent_skill_adoption",
    privilege: "skills.adopt.decide",
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "reject_agent_skill_adoption",
    method: "POST",
    pattern: "/api/v1/agents/:id/skills/:skillId/adoption/reject",
    summary: "Reject skill adoption",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "skills",
    mcpToolName: "reject_agent_skill_adoption",
    privilege: "skills.adopt.decide",
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "agents_converse",
    method: "POST",
    pattern: "/api/v1/agents/:id/conversation",
    summary: "Deliver conversation turn to agent",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "agents-converse",
    mcpToolName: "agents_converse",
    inCoreToolset: true,
    privilege: "agents.converse",
    requestBodySchema: ConversationTurnBodySchema,
    responseSchema: ConversationTurnResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "manage_conversation_requests",
    method: "POST",
    pattern: "/api/v1/agents/:id/conversation-requests",
    summary: "Manage conversation sessions",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "agents-converse",
    mcpToolName: "manage_conversation_requests",
    privilege: ["agents.converse","conversations.read-others"],
    requestBodySchema: ConversationRequestsBodySchema,
    responseSchema: ConversationRequestsResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "poll_conversation_replies",
    method: "GET",
    pattern: "/api/v1/agents/:id/replies",
    summary: "Poll conversation replies",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "agents-converse",
    mcpToolName: "poll_conversation_replies",
    privilege: "agents.converse",
    querySchema: RepliesQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "list_runs",
    method: "GET",
    pattern: "/api/v1/runs",
    summary: "List active and recent runs",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "runs",
    mcpToolName: "list_runs",
    inCoreToolset: true,
    privilege: "runs.read",
    querySchema: RunsQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_run",
    method: "GET",
    pattern: "/api/v1/runs/:id",
    summary: "Get run details",
    staff: "property-manager",
    mcpExposure: "tool",
    toolset: "runs",
    mcpToolName: "get_run",
    inCoreToolset: true,
    privilege: "runs.read",
    responseSchema: RunRecordResponseSchema,
  },
  {
    operationId: "cancel_run",
    method: "POST",
    pattern: "/api/v1/runs/:id/cancel",
    summary: "Cancel active run",
    staff: "property-manager",
    mcpExposure: "tool-confirm",
    toolset: "runs",
    mcpToolName: "cancel_run",
    inCoreToolset: true,
    privilege: "runs.cancel",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_fleet_ops_state",
    method: "PUT",
    pattern: "/api/v1/fleet/state/ops",
    summary: "Report the fleet's deploy state (an ops agent's live run token, GAP-268)",
    staff: "executive",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: FleetStateOpsBodySchema,
    responseSchema: FleetStateRecordResponseSchema,
    statusCodes: [200, 409],
  },
  {
    operationId: "run_get_approved_models",
    method: "GET",
    pattern: "/api/v1/runs/:id/approved-models",
    summary: "Read approved models list (run token)",
    staff: "executive",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_get_subagents",
    method: "GET",
    pattern: "/api/v1/runs/:id/subagents",
    summary: "List allowed subagents (run token)",
    staff: "registrar",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_spawn_subagent",
    method: "POST",
    pattern: "/api/v1/runs/:id/subagents/spawn",
    summary: "Spawn subagent run (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: SubagentSpawnBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_get_subagent_run",
    method: "GET",
    pattern: "/api/v1/runs/:id/subagents/runs/:subagentRunId",
    summary: "Get subagent run state (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_wake_agent",
    method: "POST",
    pattern: "/api/v1/runs/:id/wake/:targetAgentId",
    summary: "Wake target agent (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: RunWakeTargetBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_get_models",
    method: "GET",
    pattern: "/api/v1/runs/:id/models",
    summary: "Read agent model configuration (run token)",
    staff: "executive",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_set_models",
    method: "PUT",
    pattern: "/api/v1/runs/:id/models",
    summary: "Set agent model configuration (run token)",
    staff: "executive",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: SubagentModelsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_get_input",
    method: "GET",
    pattern: "/api/v1/runs/:id/input",
    summary: "Fetch run input payload (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_post_result",
    method: "POST",
    pattern: "/api/v1/runs/:id/result",
    summary: "Post run terminal result (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_post_heartbeat",
    method: "POST",
    pattern: "/api/v1/runs/:id/heartbeat",
    summary: "Post run heartbeat (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: HeartbeatBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_poll_mailbox",
    method: "GET",
    pattern: "/api/v1/runs/:id/mailbox",
    summary: "Poll mailbox messages (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_post_training",
    method: "POST",
    pattern: "/api/v1/runs/:id/training",
    summary: "Post run training results (run token)",
    staff: "accountant",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_post_reply",
    method: "POST",
    pattern: "/api/v1/runs/:id/reply",
    summary: "Post conversational turn reply (run token)",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: RunReplyBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_get_agent_config",
    method: "GET",
    pattern: "/api/v1/runs/:id/agent-config",
    summary: "Read agent config snapshot (run token)",
    staff: "registrar",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "run_post_role_request",
    method: "POST",
    pattern: "/api/v1/runs/:id/role-requests",
    summary: "Post role assignment request (run token)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: RunRoleRequestsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "run_agent_builder",
    method: "POST",
    pattern: "/api/v1/runs/:id/builder",
    summary: "Agent builder conversational assistant (run token)",
    staff: "registrar",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "run_stream_events",
    method: "GET",
    pattern: "/api/v1/runs/:id/events",
    summary: "Stream run progress events (run token)",
    staff: "inspector",
    mcpExposure: "internal",
    exception: "run-token",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "query_ledger",
    method: "GET",
    pattern: "/api/v1/ledger",
    summary: "Query audit ledger events",
    staff: "auditor",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "query_ledger",
    inCoreToolset: true,
    privilege: "ledger.read",
    querySchema: LedgerQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "verify_ledger",
    method: "GET",
    pattern: "/api/v1/ledger/verify",
    summary: "Verify ledger hash chain",
    staff: "auditor",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "verify_ledger",
    inCoreToolset: true,
    privilege: "ledger.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "ingest_ledger_event",
    method: "POST",
    pattern: "/api/v1/ledger",
    summary: "Ingest ledger event",
    staff: "auditor",
    mcpExposure: "internal",
    privilege: "ledger.ingest",
    requestBodySchema: LedgerEventBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "list_models",
    method: "GET",
    pattern: "/api/v1/models",
    summary: "List available models",
    staff: "executive",
    mcpExposure: "tool",
    toolset: "models",
    mcpToolName: "list_models",
    inCoreToolset: true,
    privilege: "models.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_internal_models_catalog",
    method: "GET",
    pattern: "/api/v1/models/internal/catalog",
    summary: "Internal models catalog for egress proxy",
    staff: "executive",
    mcpExposure: "internal",
    privilege: "egress.models.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "scan_models",
    method: "POST",
    pattern: "/api/v1/models/scan",
    summary: "Scan provider for available models",
    staff: "executive",
    mcpExposure: "tool",
    toolset: "models",
    mcpToolName: "scan_models",
    privilege: "models.manage",
    requestBodySchema: ModelScanBodySchema,
    responseSchema: ModelScanResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "admit_catalog_model",
    method: "POST",
    pattern: "/api/v1/models/admit",
    summary: "Admit model into factory catalog",
    description: "Admit model into factory catalog (or personal BYOM subscription entry)",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "admit_catalog_model",
    privilege: ["models.manage","subscriptions.own"],
    requestBodySchema: ModelAdmitBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "set_model_pricing",
    method: "PUT",
    pattern: "/api/v1/models/:model/pricing",
    summary: "Set model pricing",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "set_model_pricing",
    privilege: "models.manage",
    requestBodySchema: ModelPricingBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_default_model",
    method: "PUT",
    pattern: "/api/v1/models/default",
    summary: "Set default factory model",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "set_default_model",
    inCoreToolset: true,
    privilege: "models.manage",
    requestBodySchema: ModelDefaultBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "remove_catalog_model",
    method: "DELETE",
    pattern: "/api/v1/models/:model",
    summary: "Remove model from catalog",
    description: "Remove model from catalog (or retire own personal BYOM entry)",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "remove_catalog_model",
    privilege: ["models.manage","subscriptions.own"],
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_fleet_state",
    method: "GET",
    pattern: "/api/v1/fleet/state",
    summary: "Fleet go/stop state (a live run by run token, or a reader)",
    staff: "executive",
    mcpExposure: "tool",
    toolset: "systems",
    mcpToolName: "get_fleet_state",
    privilege: "agents.read",
    responseSchema: FleetStateRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_fleet_state",
    method: "PUT",
    pattern: "/api/v1/fleet/state",
    summary: "Set the fleet go/stop state (admin)",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "systems",
    mcpToolName: "set_fleet_state",
    privilege: "fleet.state.set",
    requestBodySchema: FleetStateSetBodySchema,
    responseSchema: FleetStateRecordResponseSchema,
    statusCodes: [200, 409],
  },
  {
    operationId: "list_approvals",
    method: "GET",
    pattern: "/api/v1/approvals",
    summary: "List pending tool approvals",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "list_approvals",
    inCoreToolset: true,
    privilege: "approvals.read",
    querySchema: ApprovalsQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_approval_details",
    method: "GET",
    pattern: "/api/v1/approvals/:id",
    summary: "Read one approval",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "get_approval_details",
    privilege: "approvals.read",
    responseSchema: ApprovalRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "decide_approval",
    method: "POST",
    pattern: "/api/v1/approvals/:id",
    summary: "Decide an approval (capUsd when approving a decision hold)",
    description: "Decide an approval (capUsd when approving a decision hold)",
    staff: "bouncer",
    mcpExposure: "human-decision",
    toolset: "observe",
    mcpToolName: "decide_approval",
    inCoreToolset: true,
    privilege: "approvals.decide",
    requestBodySchema: ApprovalDecideBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "publish_decision_hold",
    method: "PUT",
    pattern: "/api/v1/agents/:id/holds/:requestKey",
    summary: "Agent publishes a decision hold (run token, idempotent)",
    staff: "bouncer",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: DecisionHoldPublishBodySchema,
    responseSchema: DecisionHoldRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "get_agent_decision_hold",
    method: "GET",
    pattern: "/api/v1/agents/:id/holds/:requestKey",
    summary: "Read a decision hold (its agent by run token, or a reader)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_agent_decision_hold",
    privilege: "approvals.read",
    responseSchema: DecisionHoldRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "send_approval_prompt",
    method: "POST",
    pattern: "/api/v1/ingress/approval-prompts",
    summary: "Send approval prompt to channel",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "approvals.channel",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "record_approval_prompt_asked",
    method: "POST",
    pattern: "/api/v1/ingress/approvals/:id/asked",
    summary: "Record approval prompt sent",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "approvals.channel",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "record_channel_approval_decision",
    method: "POST",
    pattern: "/api/v1/ingress/approvals/decision",
    summary: "Record channel approval decision",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "approvals.channel",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "mcp_protocol_endpoint",
    method: "POST",
    pattern: "/mcp",
    summary: "Model Context Protocol JSON-RPC endpoint",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "mcp.use",
    requestBodySchema: McpRpcBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "invoke_run_mcp",
    method: "POST",
    pattern: "/mcp/run",
    summary: "Container Run Token Model Context Protocol JSON-RPC endpoint",
    staff: "property-manager",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: McpRpcBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "list_registry_agents",
    method: "GET",
    pattern: "/api/v1/registry/agents",
    summary: "List agent catalog",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "list_registry_agents",
    privilege: "agents.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "register_agent_cartridge",
    method: "POST",
    pattern: "/api/v1/registry/agents",
    summary: "Register new cartridge agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "register_agent_cartridge",
    privilege: "registry.register",
    requestBodySchema: RegistryAgentBodySchema,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "get_registry_agent",
    method: "GET",
    pattern: "/api/v1/registry/agents/:id",
    summary: "Get agent catalog entry",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_registry_agent",
    privilege: "agents.read",
    responseSchema: AgentRecordResponseSchema,
  },
  {
    operationId: "get_interview_questions",
    method: "GET",
    pattern: "/api/v1/submissions/interview",
    summary: "Interview questions",
    description: "Interview questions (S21)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "submissions",
    mcpToolName: "get_interview_questions",
    privilege: "content.submit",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "submit_interview_draft",
    method: "POST",
    pattern: "/api/v1/submissions/interview",
    summary: "Preview or finalize an interview draft into an S20 submission",
    description: "Preview or finalize an interview draft into an S20 submission (S21)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "submissions",
    mcpToolName: "submit_interview_draft",
    privilege: "content.submit",
    requestBodySchema: InterviewSubmitBodySchema,
    responseSchema: SubmissionRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "submit_content_draft",
    method: "POST",
    pattern: "/api/v1/submissions",
    summary: "Submit an agent or skill draft",
    description: "Submit an agent or skill draft (S20)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "submissions",
    mcpToolName: "submit_content_draft",
    privilege: "content.submit",
    requestBodySchema: SubmissionCreateBodySchema,
    responseSchema: SubmissionRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "list_submissions",
    method: "GET",
    pattern: "/api/v1/submissions",
    summary: "List submissions",
    description: "List own (or, for approvers, all) submissions (S20)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "submissions",
    mcpToolName: "list_submissions",
    privilege: "content.submit",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_submission",
    method: "GET",
    pattern: "/api/v1/submissions/:id",
    summary: "Read a submission",
    description: "Read a submission (S20)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "submissions",
    mcpToolName: "get_submission",
    privilege: "content.submit",
    responseSchema: SubmissionRecordResponseSchema,
  },
  {
    operationId: "admit_submission",
    method: "POST",
    pattern: "/api/v1/submissions/:id/admit",
    summary: "Admit a submission once all gates pass",
    description: "Admit a submission once all gates pass (S20)",
    staff: "bouncer",
    mcpExposure: "human-decision",
    toolset: "submissions",
    mcpToolName: "admit_submission",
    privilege: "content.admit",
    noRequestBody: true,
    responseSchema: SubmissionRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "allocate_submission_budget",
    method: "PUT",
    pattern: "/api/v1/budget/submissions/:id",
    summary: "Allocate budget to an agent submission",
    description: "Allocate budget to an agent submission (S20)",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "submissions",
    mcpToolName: "allocate_submission_budget",
    privilege: "budget.allocate",
    requestBodySchema: BudgetUsdBodySchema,
    responseSchema: SubmissionRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "allocate_agent_budget",
    method: "PUT",
    pattern: "/api/v1/budget/agents/:id",
    summary: "Allocate agent AI model budget",
    description: "Allocate agent AI model budget (S19)",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "spend",
    mcpToolName: "allocate_agent_budget",
    inCoreToolset: true,
    privilege: "budget.allocate",
    requestBodySchema: BudgetUsdBodySchema,
    responseSchema: BudgetUsdBodySchema,
    statusCodes: [200],
  },
  {
    operationId: "set_registry_agent_budget",
    method: "PUT",
    pattern: "/api/v1/registry/agents/:id/budget",
    summary: "Set agent budget limit",
    staff: "accountant",
    mcpExposure: "internal",
    privilege: "registry.budget.set",
    requestBodySchema: BudgetUsdBodySchema,
    responseSchema: BudgetUsdBodySchema,
    statusCodes: [200],
  },
  {
    operationId: "retire_agent",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/retire",
    summary: "Retire agent cartridge",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "retire_agent",
    privilege: "registry.retire",
    noRequestBody: true,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "reinstate_agent",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/reinstate",
    summary: "Reinstate retired agent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "reinstate_agent",
    privilege: "registry.reinstate",
    noRequestBody: true,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "purge_agent",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/purge",
    summary: "Purge retired agent data",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "danger",
    mcpToolName: "purge_agent",
    privilege: "registry.purge",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "deploy_agent",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/deploy",
    summary: "Deploy agent image update",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "deploy_agent",
    privilege: "registry.deploy",
    requestBodySchema: AgentDeployBodySchema,
    responseSchema: AgentRecordResponseSchema,
    statusCodes: [200, 202],
  },
  {
    operationId: "post_registry_agent_model",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/model",
    summary: "Set agent preferred model",
    staff: "executive",
    mcpExposure: "internal",
    privilege: "registry.model.set",
    requestBodySchema: ModelDefaultBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_registry_agent_model",
    method: "PUT",
    pattern: "/api/v1/registry/agents/:id/model",
    summary: "Set agent preferred model",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "set_registry_agent_model",
    privilege: "registry.model.set",
    requestBodySchema: ModelDefaultBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "post_approve_registry_agent_models",
    method: "POST",
    pattern: "/api/v1/registry/agents/:id/models/approve",
    summary: "Approve agent models",
    staff: "executive",
    mcpExposure: "internal",
    privilege: "registry.model.set",
    requestBodySchema: SubagentModelsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "approve_registry_agent_models",
    method: "PUT",
    pattern: "/api/v1/registry/agents/:id/models/approve",
    summary: "Approve agent models",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "approve_registry_agent_models",
    privilege: "registry.model.set",
    requestBodySchema: SubagentModelsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_system_budget_policy",
    method: "PUT",
    pattern: "/api/v1/policies/budget",
    summary: "Set system budget policy",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "spend",
    mcpToolName: "set_system_budget_policy",
    privilege: "policy.budget.set",
    requestBodySchema: GlobalPolicyBodySchema,
    responseSchema: AgentPolicyResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_get_run_policy",
    method: "GET",
    pattern: "/api/v1/gatekeeper-egress/runs/:id",
    summary: "Egress read active run policy",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.run.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "egress_record_failover",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/runs/:id/failover",
    summary: "Record model failover event",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.models.failover",
    requestBodySchema: EgressFailoverBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_request_approval",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/approvals",
    summary: "Egress request tool approval",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.approvals.request",
    requestBodySchema: EgressApprovalBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "egress_create_hold",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/holds",
    summary: "Egress create tool hold",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.holds.create",
    requestBodySchema: EgressHoldBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "egress_consume_approval",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/approvals/:id/consume",
    summary: "Egress consume granted approval",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.approvals.consume",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 409],
  },
  {
    operationId: "egress_report_progress",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/progress",
    summary: "Egress report turn progress",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.progress.report",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_query_routes",
    method: "GET",
    pattern: "/api/v1/gatekeeper-egress/routes",
    summary: "Egress query route declarations",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.routes.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "egress_get_connection_token",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/connections/token",
    summary: "Egress fetch connection OAuth token",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.connections.token",
    requestBodySchema: ConnectionTokenBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_get_github_app_token",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/github-app/token",
    summary: "Egress fetch GitHub App token",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.connections.token",
    requestBodySchema: MintGitHubTokenBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_get_subscription_token",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/subscriptions/token",
    summary: "Egress fetch subscription connection access token",
    description: "Egress fetch a subscription connection access token (M5(6))",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.connections.token",
    requestBodySchema: SubscriptionTokenBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_get_subscription_windows",
    method: "GET",
    pattern: "/api/v1/gatekeeper-egress/subscription-windows",
    summary: "Egress read open subscription plan-limit windows",
    description: "Egress read open subscription plan-limit windows (M5(7))",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.subscription-windows.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "egress_update_subscription_window",
    method: "PUT",
    pattern: "/api/v1/gatekeeper-egress/subscription-windows/:connection",
    summary: "Egress open or close subscription plan-limit window",
    description: "Egress open or close a subscription plan-limit window, or claim the probe slot (M5(7))",
    staff: "gatekeeper",
    mcpExposure: "internal",
    privilege: "egress.subscription-windows.write",
    requestBodySchema: GenericObjectBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "checkout_platform_secret",
    method: "POST",
    pattern: "/api/v1/keymaster/checkout",
    summary: "Checkout platform secret",
    staff: "keymaster",
    mcpExposure: "internal",
    exception: "run-token",
    requestBodySchema: SecretCheckoutBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "egress_checkout_platform_secret",
    method: "POST",
    pattern: "/api/v1/gatekeeper-egress/keymaster/checkout",
    summary: "Egress checkout platform secret",
    staff: "keymaster",
    mcpExposure: "internal",
    privilege: "egress.keymaster.checkout",
    requestBodySchema: SecretCheckoutBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_outstanding_credentials",
    method: "GET",
    pattern: "/api/v1/keymaster/outstanding",
    summary: "Read outstanding checked-out secrets",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "get_outstanding_credentials",
    privilege: "credentials.outstanding.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "list_platform_credentials",
    method: "GET",
    pattern: "/api/v1/keymaster/platform/credentials",
    summary: "Read platform credentials list",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "list_platform_credentials",
    privilege: "credentials.platform.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_platform_credential",
    method: "POST",
    pattern: "/api/v1/keymaster/platform/credentials/:name",
    summary: "Set platform credential",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "set_platform_credential",
    privilege: "credentials.platform.set",
    requestBodySchema: CredentialValueBodySchema,
    responseSchema: CredentialSetResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "update_platform_credential_alias",
    method: "PUT",
    pattern: "/api/v1/keymaster/platform/credentials/:name",
    summary: "Update platform credential alias",
    description: "Update platform credential",
    staff: "keymaster",
    mcpExposure: "internal",
    privilege: "credentials.platform.set",
    requestBodySchema: CredentialValueBodySchema,
    responseSchema: CredentialSetResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "list_agent_credentials",
    method: "GET",
    pattern: "/api/v1/keymaster/agents/:id/credentials",
    summary: "Read agent credentials",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "list_agent_credentials",
    privilege: "credentials.agent.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_agent_credential",
    method: "POST",
    pattern: "/api/v1/keymaster/agents/:id/credentials/:name",
    summary: "Set agent credential",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "set_agent_credential",
    privilege: "credentials.agent.set",
    requestBodySchema: CredentialValueBodySchema,
    responseSchema: CredentialSetResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "update_agent_credential_alias",
    method: "PUT",
    pattern: "/api/v1/keymaster/agents/:id/credentials/:name",
    summary: "Update agent credential alias",
    description: "Update agent credential",
    staff: "keymaster",
    mcpExposure: "internal",
    privilege: "credentials.agent.set",
    requestBodySchema: CredentialValueBodySchema,
    responseSchema: CredentialSetResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "get_provider_client_credential",
    method: "GET",
    pattern: "/api/v1/keymaster/providers/:provider/client",
    summary: "Read provider client credential",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "get_provider_client_credential",
    privilege: "credentials.provider.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_provider_client_credential",
    method: "POST",
    pattern: "/api/v1/keymaster/providers/:provider/client",
    summary: "Set provider client credential",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "set_provider_client_credential",
    privilege: "credentials.provider.set",
    requestBodySchema: OAuthClientCredentialsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "get_agent_app_setup",
    method: "GET",
    pattern: "/api/v1/keymaster/agents/:id/app-setup",
    summary: "Read agent app-setup status",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "get_agent_app_setup",
    privilege: "credentials.agent.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "execute_agent_app_setup_step",
    method: "POST",
    pattern: "/api/v1/keymaster/agents/:id/app-setup/:provider/:step",
    summary: "Execute app-setup step",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "execute_agent_app_setup_step",
    privilege: "credentials.agent.set",
    requestBodySchema: AppSetupStepBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_discord_app_credential",
    method: "GET",
    pattern: "/api/v1/keymaster/agents/:id/discord-app",
    summary: "Read Discord app credential",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "get_discord_app_credential",
    privilege: "credentials.agent.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_discord_app_token",
    method: "POST",
    pattern: "/api/v1/keymaster/agents/:id/discord-app/token",
    summary: "Set Discord bot token",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "set_discord_app_token",
    privilege: "credentials.agent.set",
    requestBodySchema: DiscordTokenBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "start_github_app_flow",
    method: "POST",
    pattern: "/api/v1/keymaster/agents/:id/github-app/start",
    summary: "Start GitHub App creation flow",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "start_github_app_flow",
    privilege: "credentials.agent.set",
    requestBodySchema: GitHubAppStartBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "github_app_oauth_callback",
    method: "GET",
    pattern: "/api/v1/keymaster/github-app/callback",
    summary: "GitHub App manifest callback",
    description: "GitHub App manifest callback (OAuth state)",
    staff: "keymaster",
    mcpExposure: "internal",
    exception: "oauth-github-app-callback",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "save_github_app_installations",
    method: "POST",
    pattern: "/api/v1/keymaster/agents/:id/github-app/installations",
    summary: "Save GitHub App installations",
    staff: "keymaster",
    mcpExposure: "tool-confirm",
    toolset: "credentials",
    mcpToolName: "save_github_app_installations",
    privilege: "credentials.agent.set",
    requestBodySchema: GitHubAppInstallationsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "connections_oauth_callback",
    method: "GET",
    pattern: "/api/v1/connections/:provider/callback",
    summary: "OAuth connection callback",
    description: "OAuth connection callback (OAuth state)",
    staff: "keymaster",
    mcpExposure: "internal",
    exception: "oauth-connections-callback",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_agent_transfer",
    method: "GET",
    pattern: "/api/v1/agents/:id/transfer",
    summary: "Read pending agent ownership transfer",
    description: "Read pending agent ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_agent_transfer",
    exception: "agent-transfer-read",
    responseSchema: TransferResponseSchema,
  },
  {
    operationId: "start_agent_transfer",
    method: "POST",
    pattern: "/api/v1/agents/:id/transfer",
    summary: "Start agent ownership transfer",
    description: "Start agent ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "start_agent_transfer",
    exception: "agent-transfer-start",
    requestBodySchema: TransferStartBodySchema,
    responseSchema: TransferResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "accept_agent_transfer",
    method: "POST",
    pattern: "/api/v1/agents/:id/transfer/accept",
    summary: "Accept agent ownership transfer",
    description: "Accept agent ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "accept_agent_transfer",
    exception: "agent-transfer-accept",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "decline_agent_transfer",
    method: "POST",
    pattern: "/api/v1/agents/:id/transfer/decline",
    summary: "Decline agent ownership transfer",
    description: "Decline agent ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "decline_agent_transfer",
    exception: "agent-transfer-decline",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "cancel_agent_transfer",
    method: "POST",
    pattern: "/api/v1/agents/:id/transfer/cancel",
    summary: "Cancel agent ownership transfer",
    description: "Cancel agent ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "cancel_agent_transfer",
    exception: "agent-transfer-cancel",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_skill_transfer",
    method: "GET",
    pattern: "/api/v1/skills/:id/transfer",
    summary: "Read pending skill ownership transfer",
    description: "Read pending skill ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill_transfer",
    exception: "skill-transfer-read",
    responseSchema: TransferResponseSchema,
  },
  {
    operationId: "decline_skill_transfer",
    method: "POST",
    pattern: "/api/v1/skills/:id/transfer/decline",
    summary: "Decline skill ownership transfer",
    description: "Decline skill ownership transfer (S3b)",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "decline_skill_transfer",
    exception: "skill-transfer-decline",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "start_connection_oauth",
    method: "GET",
    pattern: "/api/v1/connections/:id/:provider/start",
    summary: "Start OAuth user connection",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "start_connection_oauth",
    privilege: "connections.start",
    querySchema: ConnectionsStartQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "import_connection_credentials",
    method: "POST",
    pattern: "/api/v1/connections/:id/:provider/import",
    summary: "Import connection credentials",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "import_connection_credentials",
    privilege: "connections.import",
    requestBodySchema: ConnectionImportBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "list_agent_connections",
    method: "GET",
    pattern: "/api/v1/connections/:id",
    summary: "List agent active connections",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "list_agent_connections",
    privilege: "connections.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "list_subscriptions",
    method: "GET",
    pattern: "/api/v1/subscriptions",
    summary: "List subscription connections",
    description: "List subscription connections (all for subscriptions.read, own personal for subscriptions.own), templates and instructions",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "list_subscriptions",
    privilege: ["subscriptions.own","subscriptions.read"],
    querySchema: SubscriptionsQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_subscription_spend",
    method: "GET",
    pattern: "/api/v1/subscriptions/spend",
    summary: "Read subscription token usage",
    description: "Read subscription token usage per connection and per agent (M5(8))",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "spend",
    mcpToolName: "get_subscription_spend",
    privilege: ["subscriptions.own","subscriptions.read"],
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "connect_subscription",
    method: "POST",
    pattern: "/api/v1/subscriptions",
    summary: "Start a subscription sign-in with subscriber attestation",
    description: "Start a subscription sign-in (device code) with the subscriber attestation",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "connect_subscription",
    privilege: ["subscriptions.own","subscriptions.manage"],
    requestBodySchema: SubscriptionConnectBodySchema,
    responseSchema: SubscriptionConnectResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "connect_subscription_alias",
    method: "POST",
    pattern: "/api/v1/subscriptions/connect",
    summary: "Start subscription sign-in alias",
    description: "Start a subscription sign-in (device code) with the subscriber attestation",
    staff: "keymaster",
    mcpExposure: "internal",
    privilege: ["subscriptions.own","subscriptions.manage"],
    requestBodySchema: SubscriptionConnectBodySchema,
    responseSchema: SubscriptionConnectResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "poll_subscription_sign_in",
    method: "GET",
    pattern: "/api/v1/subscriptions/sign-ins/:id",
    summary: "Poll a subscription sign-in",
    description: "Poll a subscription sign-in; connects when the subscriber has signed in",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "poll_subscription_sign_in",
    privilege: ["subscriptions.own","subscriptions.manage"],
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "reconnect_subscription",
    method: "POST",
    pattern: "/api/v1/subscriptions/:id/reconnect",
    summary: "Start a sign-in that reconnects subscription",
    description: "Start a sign-in that reconnects a subscription connection",
    staff: "keymaster",
    mcpExposure: "handoff",
    toolset: "credentials",
    mcpToolName: "reconnect_subscription",
    privilege: ["subscriptions.own","subscriptions.manage"],
    requestBodySchema: SubscriptionReconnectBodySchema,
    responseSchema: SubscriptionConnectResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "discover_subscription_models",
    method: "POST",
    pattern: "/api/v1/subscriptions/:id/discover",
    summary: "Trigger subscription model discovery",
    description: "Trigger subscription model discovery via gatekeeper-egress (M5(4a))",
    staff: "keymaster",
    mcpExposure: "tool",
    toolset: "credentials",
    mcpToolName: "discover_subscription_models",
    privilege: ["subscriptions.own","subscriptions.manage"],
    noRequestBody: true,
    responseSchema: SubscriptionDiscoverResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "admit_subscription_model",
    method: "POST",
    pattern: "/api/v1/subscriptions/:id/models",
    summary: "Admit a subscription model catalog entry",
    description: "Admit a subscription model catalog entry on a connection (M5(1))",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "admit_subscription_model",
    privilege: ["subscriptions.own","models.manage"],
    requestBodySchema: SubscriptionModelAdmitBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "retire_subscription_model",
    method: "DELETE",
    pattern: "/api/v1/subscriptions/:id/models/:model",
    summary: "Retire a subscription model catalog entry",
    description: "Retire a subscription model catalog entry on a connection (M5(1))",
    staff: "executive",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "retire_subscription_model",
    privilege: ["subscriptions.own","models.manage"],
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "update_subscription_connection",
    method: "PATCH",
    pattern: "/api/v1/subscriptions/:id",
    summary: "Rename or set per-agent daily token cap",
    description: "Rename or set per-agent daily token cap on a subscription connection (M5(4), M5(7))",
    staff: "keymaster",
    mcpExposure: "tool-confirm",
    toolset: "credentials",
    mcpToolName: "update_subscription_connection",
    privilege: ["subscriptions.own","subscriptions.manage"],
    requestBodySchema: SubscriptionUpdateBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "rename_subscription_connection_alias",
    method: "POST",
    pattern: "/api/v1/subscriptions/:id/rename",
    summary: "Rename a subscription connection alias",
    description: "Rename a subscription connection",
    staff: "keymaster",
    mcpExposure: "internal",
    privilege: ["subscriptions.own","subscriptions.manage"],
    requestBodySchema: SubscriptionUpdateBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "disconnect_subscription",
    method: "DELETE",
    pattern: "/api/v1/subscriptions/:id",
    summary: "Disconnect a subscription connection",
    staff: "keymaster",
    mcpExposure: "tool-confirm",
    toolset: "credentials",
    mcpToolName: "disconnect_subscription",
    privilege: ["subscriptions.own","subscriptions.manage"],
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "export_factory_config",
    method: "GET",
    pattern: "/api/v1/config/export",
    summary: "Export full factory configuration",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "export_factory_config",
    privilege: ["config.export","config.export.agent"],
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "list_identity_links",
    method: "GET",
    pattern: "/api/v1/identity-links",
    summary: "List channel identity links",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "list_identity_links",
    privilege: "identity.links.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_identity_link",
    method: "PUT",
    pattern: "/api/v1/identity-links/:provider/:id",
    summary: "Create or update identity link",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "set_identity_link",
    privilege: "identity.links.set",
    requestBodySchema: IdentityLinkBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "delete_identity_link",
    method: "DELETE",
    pattern: "/api/v1/identity-links/:provider/:id",
    summary: "Delete identity link",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "delete_identity_link",
    privilege: "identity.links.set",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_schedules",
    method: "GET",
    pattern: "/api/v1/schedules",
    summary: "List scheduled tasks",
    staff: "timekeeper",
    mcpExposure: "tool",
    toolset: "schedules",
    mcpToolName: "list_schedules",
    inCoreToolset: true,
    privilege: "schedules.read",
    querySchema: SchedulesQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_schedule",
    method: "POST",
    pattern: "/api/v1/schedules",
    summary: "Create scheduled task",
    staff: "timekeeper",
    mcpExposure: "tool-confirm",
    toolset: "schedules",
    mcpToolName: "create_schedule",
    privilege: "schedules.write",
    requestBodySchema: ScheduleCreateBodySchema,
    responseSchema: ScheduleRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "post_update_schedule_alias",
    method: "POST",
    pattern: "/api/v1/schedules/:id",
    summary: "Update scheduled task alias",
    description: "Update scheduled task",
    staff: "timekeeper",
    mcpExposure: "internal",
    privilege: "schedules.write",
    requestBodySchema: ScheduleUpdateBodySchema,
    responseSchema: ScheduleRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "update_schedule",
    method: "PATCH",
    pattern: "/api/v1/schedules/:id",
    summary: "Update scheduled task",
    staff: "timekeeper",
    mcpExposure: "tool-confirm",
    toolset: "schedules",
    mcpToolName: "update_schedule",
    privilege: "schedules.write",
    requestBodySchema: ScheduleUpdateBodySchema,
    responseSchema: ScheduleRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "replace_schedule_alias",
    method: "PUT",
    pattern: "/api/v1/schedules/:id",
    summary: "Replace scheduled task alias",
    description: "Replace scheduled task",
    staff: "timekeeper",
    mcpExposure: "internal",
    privilege: "schedules.write",
    requestBodySchema: ScheduleUpdateBodySchema,
    responseSchema: ScheduleRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "delete_schedule",
    method: "DELETE",
    pattern: "/api/v1/schedules/:id",
    summary: "Delete scheduled task",
    staff: "timekeeper",
    mcpExposure: "tool-confirm",
    toolset: "schedules",
    mcpToolName: "delete_schedule",
    privilege: "schedules.write",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_skills",
    method: "GET",
    pattern: "/api/v1/skills",
    summary: "List catalog skills",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "list_skills",
    privilege: "skills.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_default_skills",
    method: "GET",
    pattern: "/api/v1/skills/defaults",
    summary: "Get default skills",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_default_skills",
    privilege: "skills.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_default_skills",
    method: "PUT",
    pattern: "/api/v1/skills/defaults",
    summary: "Set default skills",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "set_default_skills",
    privilege: "skills.defaults.set",
    requestBodySchema: SkillDefaultsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_skill",
    method: "GET",
    pattern: "/api/v1/skills/:id",
    summary: "Get skill details",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill",
    privilege: "skills.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_skill_version",
    method: "GET",
    pattern: "/api/v1/skills/:id/versions/:version",
    summary: "Get skill version metadata",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill_version",
    privilege: "skills.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "register_skill",
    method: "POST",
    pattern: "/api/v1/registry/skills",
    summary: "Register skill or add version",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "register_skill",
    privilege: ["skills.register","skills.version.add"],
    requestBodySchema: SkillRegisterBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "run_skill_checks",
    method: "POST",
    pattern: "/api/v1/registry/skills/:id/versions/:version/checks",
    summary: "Run skill offline validation checks",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "run_skill_checks",
    privilege: "skills.checks.run",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [202],
  },
  {
    operationId: "approve_skill_version",
    method: "POST",
    pattern: "/api/v1/registry/skills/:id/versions/:version/approve",
    summary: "Approve skill version",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "skills",
    mcpToolName: "approve_skill_version",
    privilege: ["skills.decide","skills.decide.private","content.admit"],
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "reject_skill_version",
    method: "POST",
    pattern: "/api/v1/registry/skills/:id/versions/:version/reject",
    summary: "Reject skill version",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "skills",
    mcpToolName: "reject_skill_version",
    privilege: ["skills.decide","skills.decide.private","content.admit"],
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "retire_skill_version",
    method: "POST",
    pattern: "/api/v1/registry/skills/:id/retire",
    summary: "Retire skill version",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "retire_skill_version",
    privilege: ["skills.retire","skills.retire.force"],
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_skill_adopters",
    method: "GET",
    pattern: "/api/v1/skills/:id/adopters",
    summary: "List agents adopting skill",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "list_skill_adopters",
    privilege: "skills.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_skill_training",
    method: "GET",
    pattern: "/api/v1/skills/:id/training",
    summary: "Read skill training state",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill_training",
    privilege: "skills.training.run",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "fund_skill_training_account",
    method: "PUT",
    pattern: "/api/v1/skills/:id/training-account",
    summary: "Fund skill training account",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "fund_skill_training_account",
    privilege: "skills.training.fund",
    requestBodySchema: TrainingCapBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "set_skill_training_baseline",
    method: "PUT",
    pattern: "/api/v1/skills/:id/training-baseline",
    summary: "Set skill training baseline",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "set_skill_training_baseline",
    privilege: "skills.training.run",
    requestBodySchema: TrainingBaselineBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "start_skill_training_run",
    method: "POST",
    pattern: "/api/v1/skills/:id/training-runs",
    summary: "Execute skill training run",
    staff: "accountant",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "start_skill_training_run",
    privilege: "skills.training.run",
    requestBodySchema: TrainingRunBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_skill_training_recommendation",
    method: "POST",
    pattern: "/api/v1/skills/:id/training-recommendation",
    summary: "Generate skill training recommendation",
    staff: "accountant",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill_training_recommendation",
    privilege: "skills.training.run",
    noRequestBody: true,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_skill_model",
    method: "GET",
    pattern: "/api/v1/skills/:id/model",
    summary: "Read skill model binding",
    description: "Read skill model binding (S24)",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "get_skill_model",
    privilege: "skills.package.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_skill_model",
    method: "PUT",
    pattern: "/api/v1/skills/:id/model",
    summary: "Bind or swap skill model",
    description: "Bind or swap skill model (S24)",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "set_skill_model",
    privilege: "skills.version.add",
    requestBodySchema: SkillModelBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "start_skill_transfer",
    method: "POST",
    pattern: "/api/v1/skills/:id/transfer",
    summary: "Initiate skill ownership transfer",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "start_skill_transfer",
    privilege: "skills.transfer",
    requestBodySchema: TransferStartBodySchema,
    responseSchema: TransferResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "accept_skill_transfer",
    method: "POST",
    pattern: "/api/v1/skills/:id/transfer/accept",
    summary: "Accept skill ownership transfer",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "accept_skill_transfer",
    privilege: "skills.register",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "cancel_skill_transfer",
    method: "POST",
    pattern: "/api/v1/skills/:id/transfer/cancel",
    summary: "Cancel skill ownership transfer",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "cancel_skill_transfer",
    privilege: "skills.transfer",
    noRequestBody: true,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "admin_transfer_skill",
    method: "POST",
    pattern: "/api/v1/skills/:id/transfer/admin",
    summary: "Admin force-transfer skill",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "admin_transfer_skill",
    privilege: "skills.decide",
    requestBodySchema: TransferStartBodySchema,
    responseSchema: TransferResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "assign_skill_group",
    method: "PUT",
    pattern: "/api/v1/skills/:id/group",
    summary: "Assign skill to group",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "assign_skill_group",
    privilege: "skills.assign",
    requestBodySchema: SkillGroupBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "unassign_skill_group",
    method: "DELETE",
    pattern: "/api/v1/skills/:id/group",
    summary: "Unassign skill from group",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "unassign_skill_group",
    privilege: "skills.assign",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_skill_package_files",
    method: "GET",
    pattern: "/api/v1/skills/:id/versions/:version/package/files",
    summary: "List package archive files",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "list_skill_package_files",
    privilege: "skills.package.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "download_skill_package_file",
    method: "GET",
    pattern: "/api/v1/skills/:id/versions/:version/package/file",
    summary: "Download package file",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "skills",
    mcpToolName: "download_skill_package_file",
    privilege: "skills.package.read",
    querySchema: PackageFileQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "request_skill_publish",
    method: "POST",
    pattern: "/api/v1/skills/:id/publish",
    summary: "Request skill publishing",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "request_skill_publish",
    privilege: "skills.publish.request",
    requestBodySchema: PublishRequestBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "decide_skill_publish",
    method: "POST",
    pattern: "/api/v1/skills/:id/publish/decide",
    summary: "Admin decide skill publishing",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "skills",
    mcpToolName: "decide_skill_publish",
    privilege: "skills.decide",
    requestBodySchema: ApprovalDecideBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "unpublish_skill",
    method: "POST",
    pattern: "/api/v1/skills/:id/unpublish",
    summary: "Unpublish published skill",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "unpublish_skill",
    privilege: "skills.unpublish",
    requestBodySchema: SkillUnpublishBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "retire_skill",
    method: "POST",
    pattern: "/api/v1/skills/:id/retire",
    summary: "Retire skill",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "skills",
    mcpToolName: "retire_skill",
    privilege: ["skills.retire","skills.retire.force"],
    requestBodySchema: DecisionReasonBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "list_groups",
    method: "GET",
    pattern: "/api/v1/groups",
    summary: "List user groups",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "list_groups",
    privilege: "groups.manage",
    querySchema: GroupsQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "create_group",
    method: "POST",
    pattern: "/api/v1/groups",
    summary: "Create user group",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "create_group",
    privilege: "groups.manage",
    requestBodySchema: GroupCreateBodySchema,
    responseSchema: GroupRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "get_group",
    method: "GET",
    pattern: "/api/v1/groups/:id",
    summary: "Get group details",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "access",
    mcpToolName: "get_group",
    privilege: "groups.manage",
    responseSchema: GroupRecordResponseSchema,
  },
  {
    operationId: "update_group",
    method: "PUT",
    pattern: "/api/v1/groups/:id",
    summary: "Update group details",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "update_group",
    privilege: "groups.manage",
    requestBodySchema: GroupUpdateBodySchema,
    responseSchema: GroupRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "delete_group",
    method: "DELETE",
    pattern: "/api/v1/groups/:id",
    summary: "Delete user group",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "delete_group",
    privilege: "groups.manage",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "add_group_member",
    method: "POST",
    pattern: "/api/v1/groups/:id/members",
    summary: "Add group member",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "add_group_member",
    privilege: "groups.manage",
    requestBodySchema: GroupMemberAddBodySchema,
    responseSchema: GroupRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "post_add_group_member_alias",
    method: "POST",
    pattern: "/api/v1/groups/:id/members/:member",
    summary: "Add group member alias",
    description: "Add group member (note: path :member is ignored in favor of body.member)",
    staff: "bouncer",
    mcpExposure: "internal",
    privilege: "groups.manage",
    requestBodySchema: GroupMemberAddBodySchema,
    responseSchema: GroupRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "remove_group_member",
    method: "DELETE",
    pattern: "/api/v1/groups/:id/members",
    summary: "Remove group member",
    staff: "bouncer",
    mcpExposure: "tool-confirm",
    toolset: "access",
    mcpToolName: "remove_group_member",
    privilege: "groups.manage",
    requestBodySchema: GroupMemberAddBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "delete_remove_group_member_alias",
    method: "DELETE",
    pattern: "/api/v1/groups/:id/members/:member",
    summary: "Remove group member by path alias",
    description: "Remove group member by path",
    staff: "bouncer",
    mcpExposure: "internal",
    privilege: "groups.manage",
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "register_subagent",
    method: "POST",
    pattern: "/api/v1/registry/subagents",
    summary: "Register subagent",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "agents",
    mcpToolName: "register_subagent",
    privilege: "registry.register",
    requestBodySchema: SubagentRegisterBodySchema,
    responseSchema: SubagentRecordResponseSchema,
    statusCodes: [200, 201],
  },
  {
    operationId: "list_registry_subagents",
    method: "GET",
    pattern: "/api/v1/registry/subagents",
    summary: "List registered subagents",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "list_registry_subagents",
    privilege: "agents.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "set_subagent_models",
    method: "PUT",
    pattern: "/api/v1/registry/subagents/:id/models",
    summary: "Set subagent model allowlist",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "models",
    mcpToolName: "set_subagent_models",
    privilege: "registry.register",
    requestBodySchema: SubagentModelsBodySchema,
    responseSchema: SuccessResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "get_registry_subagent",
    method: "GET",
    pattern: "/api/v1/registry/subagents/:id",
    summary: "Get subagent details",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "agents",
    mcpToolName: "get_registry_subagent",
    privilege: "agents.read",
    responseSchema: SubagentRecordResponseSchema,
  },
  {
    operationId: "list_systems",
    method: "GET",
    pattern: "/api/v1/systems",
    summary: "List registered external systems",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "systems",
    mcpToolName: "list_systems",
    privilege: "systems.read",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "propose_system",
    method: "POST",
    pattern: "/api/v1/systems",
    summary: "Propose new external system",
    staff: "registrar",
    mcpExposure: "tool-confirm",
    toolset: "systems",
    mcpToolName: "propose_system",
    privilege: "systems.propose",
    requestBodySchema: SystemProposalBodySchema,
    responseSchema: SystemRecordResponseSchema,
    statusCodes: [201],
  },
  {
    operationId: "get_system",
    method: "GET",
    pattern: "/api/v1/systems/:id",
    summary: "Get system details",
    staff: "registrar",
    mcpExposure: "tool",
    toolset: "systems",
    mcpToolName: "get_system",
    privilege: "systems.read",
    responseSchema: SystemRecordResponseSchema,
  },
  {
    operationId: "approve_system",
    method: "POST",
    pattern: "/api/v1/systems/:id/approve",
    summary: "Approve proposed external system",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "systems",
    mcpToolName: "approve_system",
    privilege: "systems.decide",
    requestBodySchema: SystemDecisionBodySchema,
    responseSchema: SystemRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "reject_system",
    method: "POST",
    pattern: "/api/v1/systems/:id/reject",
    summary: "Reject proposed external system",
    staff: "registrar",
    mcpExposure: "human-decision",
    toolset: "systems",
    mcpToolName: "reject_system",
    privilege: "systems.decide",
    requestBodySchema: SystemDecisionBodySchema,
    responseSchema: SystemRecordResponseSchema,
    statusCodes: [200],
  },
  {
    operationId: "ws_events_stream",
    method: "GET",
    pattern: "/api/v1/events",
    summary: "WebSocket event stream upgrade",
    staff: "inspector",
    mcpExposure: "internal",
    privilege: "events.subscribe",
    querySchema: StreamQuerySchema,
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_openapi_spec",
    method: "GET",
    pattern: "/api/v1/openapi.json",
    summary: "Export OpenAPI 3.1.0 specification",
    description: "Returns complete OpenAPI 3.1.0 JSON document covering all canonical control-plane routes (CL11, GAP-249)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "get_openapi_spec",
    exception: "schema-openapi",
    responseSchema: SuccessResponseSchema,
  },
  {
    operationId: "get_mcp_schema_catalog",
    method: "GET",
    pattern: "/api/v1/mcp/schema.json",
    summary: "Export MCP tools schema catalog",
    description: "Returns complete MCP tools catalog and JSON schemas for headless AI client integration (CL11, GAP-249)",
    staff: "bouncer",
    mcpExposure: "tool",
    toolset: "observe",
    mcpToolName: "get_mcp_schema_catalog",
    exception: "schema-mcp",
    responseSchema: SuccessResponseSchema,
  },
];

export const CONTROL_PLANE_ROUTES: readonly ControlPlaneRoute[] = RAW_CONTROL_PLANE_ROUTES.map((r) => {
  const derived = derivePathParamsSchema(r.pattern);
  return derived && !r.pathParamsSchema ? { ...r, pathParamsSchema: derived } : r;
});

/**
 * Finds the declared control-plane route for an incoming method and URL path.
 */
export function matchRoute(method: string, path: string): ControlPlaneRoute | undefined {
  const cleanPath = path.split('?')[0];
  // Most specific wins regardless of declaration order: fewer :params first, then more literal segments
  let best: ControlPlaneRoute | undefined;
  let bestScore: [number, number] | undefined;
  for (const r of CONTROL_PLANE_ROUTES) {
    if (r.method !== method || !pathToRegex(r.pattern).test(cleanPath)) continue;
    const params = (r.pattern.match(/:[a-zA-Z0-9_]+/g) ?? []).length;
    const literal = r.pattern.replace(/:[a-zA-Z0-9_]+/g, '').length;
    if (!bestScore || params < bestScore[0] || (params === bestScore[0] && literal > bestScore[1])) {
      best = r;
      bestScore = [params, literal];
    }
  }
  return best;
}

/** Canonical form for duplicate detection: :id and :agentId name the same route. */
export function canonicalRoutePattern(pattern: string): string {
  return pattern.replace(/:[a-zA-Z0-9_]+/g, ':param');
}

/**
 * Returns true if the route is protected by standard Bouncer privileges.
 */
export function isRoutePrivileged(route: ControlPlaneRoute): boolean {
  return route.privilege !== undefined && route.exception === undefined;
}

/**
 * Returns declared Bouncer privilege(s) for a route, or an empty array if unprivileged/exception.
 */
export function getRoutePrivileges(route: ControlPlaneRoute): readonly Privilege[] {
  if (!route.privilege) return [];
  if (Array.isArray(route.privilege)) return route.privilege as readonly Privilege[];
  return [route.privilege as Privilege];
}

/**
 * Returns the RouteException associated with a route, if any.
 */
export function getRouteException(
  route: ControlPlaneRoute,
  exceptions: Record<string, RouteException> = ROUTE_EXCEPTIONS,
): RouteException | undefined {
  if (!route.exception) return undefined;
  return exceptions[route.exception];
}

/**
 * Validates route registry integrity, completeness, uniqueness, valid references,
 * and operation contract schemas.
 */
export function validateRouteRegistry(
  routes: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
  exceptions: Record<string, RouteException> = ROUTE_EXCEPTIONS,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const knownPrivileges = new Set<string>(PRIVILEGES);
  const seenPairs = new Set<string>();
  const seenOperationIds = new Set<string>();
  const seenToolNames = new Set<string>();
  let coreToolCount = 0;

  const STORY_ID_PATTERN = /^S\d+[a-z]?$/;

  // 1. Validate ROUTE_EXCEPTIONS registry entries
  for (const [key, exc] of Object.entries(exceptions)) {
    if (!exc.id || exc.id !== key) {
      errors.push(`Exception key '${key}' does not match its id '${exc.id}'`);
    }
    if (!exc.protection || !ROUTE_PROTECTION_MECHANISMS.includes(exc.protection)) {
      errors.push(`Exception '${key}' has invalid protection mechanism '${exc.protection}'`);
    }
    if (!exc.rationale || typeof exc.rationale !== 'string' || !exc.rationale.trim()) {
      errors.push(`Exception '${key}' is missing required rationale`);
    }
    if (exc.protection === 'transitional') {
      if (!exc.retiringStory || !exc.retiringStory.trim()) {
        errors.push(`Transitional exception '${key}' must specify a retiringStory`);
      } else if (!STORY_ID_PATTERN.test(exc.retiringStory.trim())) {
        errors.push(`Transitional exception '${key}' has invalid retiringStory '${exc.retiringStory}'`);
      }
    }
    if (exc.plannedIn && !STORY_ID_PATTERN.test(exc.plannedIn.trim())) {
      errors.push(`Exception '${key}' has invalid plannedIn '${exc.plannedIn}'`);
    }
  }

  // Check for unreferenced exceptions that lack plannedIn, and enforce 1-to-1 scope on transitional exceptions
  const exceptionRefCounts = new Map<string, number>();
  for (const route of routes) {
    if (route.exception) {
      exceptionRefCounts.set(route.exception, (exceptionRefCounts.get(route.exception) ?? 0) + 1);
    }
  }
  for (const [key, exc] of Object.entries(exceptions)) {
    const count = exceptionRefCounts.get(key) ?? 0;
    if (!exc.plannedIn && count === 0) {
      errors.push(`Exception '${key}' without plannedIn is not referenced by any route in routes`);
    }
    if (exc.protection === 'transitional' && count > 1) {
      errors.push(`Transitional exception '${key}' may only cover a single route, but is referenced by ${count} routes`);
    }
  }

  // 2. Validate CONTROL_PLANE_ROUTES and Operation Contracts
  for (const route of routes) {
    const key = `${route.method} ${canonicalRoutePattern(route.pattern)}`;
    if (seenPairs.has(key)) {
      errors.push(`Duplicate route registration: '${route.method} ${route.pattern}' (canonical '${key}')`);
    }
    seenPairs.add(key);

    const hasPrivilege = route.privilege !== undefined;
    const hasException = route.exception !== undefined;

    if (!hasPrivilege && !hasException) {
      errors.push(`Route '${key}' must declare either a Bouncer privilege or reference an entry in ROUTE_EXCEPTIONS`);
    }

    if (hasPrivilege && hasException) {
      errors.push(`Route '${key}' cannot declare both a privilege and an exception`);
    }

    if (hasPrivilege) {
      const privs = getRoutePrivileges(route);
      if (privs.length === 0) {
        errors.push(`Route '${key}' declared an empty privilege list`);
      }
      for (const p of privs) {
        if (!knownPrivileges.has(p)) {
          errors.push(`Route '${key}' references unknown Privilege '${p}'`);
        }
      }
    }

    if (hasException) {
      const exc = exceptions[route.exception!];
      if (!exc) {
        errors.push(`Route '${key}' references unknown exception '${route.exception}'`);
      }
    }

    // Operation contract validation
    const opValidation = validateOperationContract(route);
    if (!opValidation.valid) {
      errors.push(...opValidation.errors.map((e) => `Route '${key}': ${e}`));
    }

    if (seenOperationIds.has(route.operationId)) {
      errors.push(`Duplicate operationId detected: '${route.operationId}' on route '${key}'`);
    }
    seenOperationIds.add(route.operationId);

    const isMcpExposed =
      route.mcpExposure === 'tool' ||
      route.mcpExposure === 'tool-confirm' ||
      route.mcpExposure === 'human-decision' ||
      route.mcpExposure === 'handoff';

    if (isMcpExposed) {
      const toolName = route.mcpToolName ?? route.operationId;
      if (seenToolNames.has(toolName)) {
        errors.push(`Duplicate MCP tool name detected: '${toolName}' on route '${key}'`);
      }
      seenToolNames.add(toolName);

      if (route.inCoreToolset) {
        coreToolCount++;
      }
    }
  }

  if (coreToolCount > 40) {
    errors.push(`Core MCP toolset count exceeds bounded limit: ${coreToolCount} > 40`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Asserts registry validity; throws an Error with details if validation fails.
 */
export function assertValidRouteRegistry(
  routes: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
  exceptions: Record<string, RouteException> = ROUTE_EXCEPTIONS,
): void {
  const result = validateRouteRegistry(routes, exceptions);
  if (!result.valid) {
    throw new Error(`Route registry validation failed:\n  ${result.errors.join('\n  ')}`);
  }
}

let cachedOpenApiDoc: OpenApiDocument | undefined;
let cachedMcpCatalog: McpSchemaCatalog | undefined;

/**
 * Returns the cached OpenAPI 3.1.0 document generated from CONTROL_PLANE_ROUTES.
 */
export function getOpenApiDocument(): OpenApiDocument {
  if (!cachedOpenApiDoc) {
    cachedOpenApiDoc = buildOpenApiDocument(CONTROL_PLANE_ROUTES, CONTROL_PLANE_ROUTES);
  }
  return cachedOpenApiDoc;
}

/**
 * Returns the cached MCP Schema Catalog generated from CONTROL_PLANE_ROUTES.
 */
export function getMcpSchemaCatalog(): McpSchemaCatalog {
  if (!cachedMcpCatalog) {
    cachedMcpCatalog = buildMcpSchemaCatalog(CONTROL_PLANE_ROUTES, CONTROL_PLANE_ROUTES);
  }
  return cachedMcpCatalog;
}
