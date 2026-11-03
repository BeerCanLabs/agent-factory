// DESIGN_AUTHORITY.md §6.15 (Bouncer), plans/factory-auth.md (D4, D18, D22, S14), #355
import { PRIVILEGES, type Privilege } from '@beercanlabs/factory-bouncer';

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
    rationale: 'Generic agent webhook endpoint verified fail-closed via HMAC signature against agent cartridge secret (D18, D22, S15)',
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
    rationale: 'CLI loopback exchange: a one-time code minted after a verified browser sign-in plus the CLI PKCE verifier yields the person\'s own cli key (S13)',
  },
  'logout': {
    id: 'logout',
    protection: 'login-page',
    rationale: 'Ends the caller\'s own session and clears the cookie; a cookie from another origin is refused; without a session it only clears the cookie (S12)',
  },
  'login-page': {
    id: 'login-page',
    protection: 'login-page',
    rationale: 'Login page HTML served without credentials at `/` to unauthenticated browsers; names no status (D18, D19, S16; full flow S12)',
  },
} as const satisfies Record<string, RouteException>;

export type RouteExceptionId = keyof typeof ROUTE_EXCEPTIONS;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type ControlPlaneRoute =
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
    };

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
 * Declarative CONTROL_PLANE_ROUTES privilege table covering every HTTP route handled by the control plane.
 */
export const CONTROL_PLANE_ROUTES: readonly ControlPlaneRoute[] = [
  // UI & Health (Transitional)
  { method: 'GET', pattern: '/ui', exception: 'ui-session', description: 'Factory web UI HTML (session-gated, S12)' },
  { method: 'GET', pattern: '/login', exception: 'login-page', description: 'Factory login page (S12)' },
  { method: 'GET', pattern: '/api/v1/auth/:idp/start', exception: 'login-start', description: 'Begin IdP sign-in (S12)' },
  { method: 'GET', pattern: '/api/v1/auth/:idp/callback', exception: 'login-callback', description: 'IdP sign-in callback (S12)' },
  { method: 'POST', pattern: '/api/v1/auth/cli/token', exception: 'login-cli-token', description: 'CLI key exchange after browser sign-in (S13)' },
  { method: 'POST', pattern: '/api/v1/auth/logout', exception: 'logout', description: 'Sign out (S12)' },
  { method: 'GET', pattern: '/', exception: 'login-page', description: 'Login page for browsers; health for verified principals' },
  { method: 'GET', pattern: '/healthz', exception: 'health-probe', description: 'Liveness probe' },
  { method: 'GET', pattern: '/api/v1/health', exception: 'health-probe', description: 'Health check probe' },

  // Identity probe (Authenticated principal, no elevated privilege)
  { method: 'GET', pattern: '/api/v1/whoami', exception: 'identity-whoami', description: 'Caller identity and roles probe' },
  { method: 'GET', pattern: '/api/v1/setup/status', exception: 'setup-status', description: 'Setup status and break-glass alert (S6)' },
  { method: 'GET', pattern: '/api/v1/setup/idp', privilege: 'grants.manage', description: 'Read IdP configuration (S6)' },
  { method: 'PUT', pattern: '/api/v1/setup/idp', privilege: 'grants.manage', description: 'Set IdP configuration (S6)' },
  { method: 'GET', pattern: '/api/v1/keys', exception: 'keys-self-list', description: 'List API keys (S5)' },
  { method: 'POST', pattern: '/api/v1/keys', exception: 'keys-self-create', description: 'Issue API key (S5)' },
  { method: 'POST', pattern: '/api/v1/keys/:id/rotate', exception: 'keys-self-rotate', description: 'Rotate API key (S5)' },
  { method: 'DELETE', pattern: '/api/v1/keys/:id', exception: 'keys-self-revoke', description: 'Revoke API key (S5)' },
  { method: 'GET', pattern: '/api/v1/authz/check', exception: 'authz-check', description: 'Authorization preflight (S3)' },
  { method: 'GET', pattern: '/api/v1/principals', privilege: 'grants.manage', description: 'List principals (S3)' },
  { method: 'POST', pattern: '/api/v1/principals', privilege: 'grants.manage', description: 'Create principal (S3)' },
  { method: 'GET', pattern: '/api/v1/principals/:id', privilege: 'grants.manage', description: 'Get principal (S3)' },
  { method: 'POST', pattern: '/api/v1/principals/:id/emails', privilege: 'grants.manage', description: 'Add principal email (S3)' },
  { method: 'DELETE', pattern: '/api/v1/principals/:id/emails/:email', privilege: 'grants.manage', description: 'Remove principal email (S3)' },
  { method: 'GET', pattern: '/api/v1/grants', exception: 'grants-scoped-list', description: 'List grants (S3)' },
  { method: 'POST', pattern: '/api/v1/grants', exception: 'grants-scoped-create', description: 'Create grant (S3)' },
  { method: 'DELETE', pattern: '/api/v1/grants/:id', exception: 'grants-scoped-revoke', description: 'Revoke grant (S3)' },

  // Metrics, spend & triage
  { method: 'GET', pattern: '/api/v1/metrics', privilege: 'metrics.read', description: 'Platform metrics' },
  { method: 'GET', pattern: '/metrics', privilege: 'metrics.read', description: 'Prometheus metrics endpoint' },
  { method: 'GET', pattern: '/api/v1/spend', privilege: 'spend.read', description: 'Fleet spend summary' },
  { method: 'GET', pattern: '/api/v1/spend/report', privilege: 'spend.read', description: 'Spend breakdown report' },
  { method: 'GET', pattern: '/api/v1/spend/compute', privilege: 'spend.read', description: 'Compute costs report' },
  { method: 'GET', pattern: '/api/v1/spend/budgets', privilege: 'spend.read', description: 'Spend budgets query' },
  { method: 'PUT', pattern: '/api/v1/spend/budgets', privilege: 'spend.budget.set', description: 'Set spend budgets' },
  { method: 'GET', pattern: '/api/v1/triage', privilege: 'triage.read', description: 'Triage queue query' },

  // Webhooks
  { method: 'POST', pattern: '/api/v1/hooks/github', exception: 'webhook-github', description: 'GitHub release webhook (HMAC signature)' },
  { method: 'POST', pattern: '/hooks/github', exception: 'webhook-github', description: 'GitHub release webhook alias (HMAC signature)' },
  { method: 'POST', pattern: '/api/v1/webhooks/github', exception: 'webhook-github', description: 'GitHub release webhook alias (HMAC signature)' },
  { method: 'POST', pattern: '/webhooks/github', exception: 'webhook-github', description: 'GitHub release webhook alias (HMAC signature)' },
  { method: 'POST', pattern: '/api/v1/hooks/:id', exception: 'webhook-hooks', description: 'Cartridge webhook trigger (HMAC signature)' },
  { method: 'POST', pattern: '/hooks/:id', exception: 'webhook-hooks', description: 'Cartridge webhook trigger alias (HMAC signature)' },

  // Agents & Runtime
  { method: 'GET', pattern: '/api/v1/agents', privilege: 'agents.read', description: 'List registered agents' },
  { method: 'POST', pattern: '/api/v1/agents', privilege: 'agents.create', description: 'Create configuration-hosted agent' },
  { method: 'POST', pattern: '/api/v1/agents/import', privilege: 'agents.create', description: 'Import agent bundle' },
  { method: 'GET', pattern: '/api/v1/runtime', privilege: 'agents.read', description: 'Read runtime version info' },
  { method: 'PUT', pattern: '/api/v1/runtime', privilege: 'runtime.set', description: 'Roll out runtime update' },
  { method: 'POST', pattern: '/api/v1/agents/:id/runs', privilege: 'agents.wake', description: 'Start run on agent' },
  { method: 'POST', pattern: '/api/v1/agents/:id/wake', privilege: ['agents.wake', 'runs.attest-requester'], description: 'Wake agent with optional requester attestation' },
  { method: 'POST', pattern: '/api/v1/agents/:id/pause', privilege: 'agents.pause', description: 'Pause agent execution' },
  { method: 'POST', pattern: '/api/v1/agents/:id/resume', privilege: 'agents.resume', description: 'Resume agent execution' },
  { method: 'POST', pattern: '/api/v1/agents/:id/isolate', privilege: 'agents.isolate', description: 'Isolate agent network access' },
  { method: 'POST', pattern: '/api/v1/agents/:id/reset', privilege: 'agents.reset', description: 'Reset agent container state' },
  { method: 'POST', pattern: '/api/v1/agents/:id/updates/check', privilege: 'agents.update.read', description: 'Check for agent updates' },
  { method: 'POST', pattern: '/api/v1/agents/:id/updates/install', privilege: 'agents.update.install', description: 'Install agent update' },
  { method: 'POST', pattern: '/api/v1/agents/:id/convert', privilege: 'agents.settings.set', description: 'Convert repository agent to configuration' },
  { method: 'GET', pattern: '/api/v1/agents/:id/settings', privilege: 'agents.settings.read', description: 'Read agent settings' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/settings', privilege: 'agents.settings.set', description: 'Update agent settings' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/name', privilege: 'agents.settings.set', description: 'Rename agent' },
  { method: 'GET', pattern: '/api/v1/agents/:id/roles', privilege: 'agents.roles.read', description: 'Read agent roles' },
  { method: 'GET', pattern: '/api/v1/agents/:id/role-assignments', privilege: 'agents.roles.assign', description: 'Read agent role assignments' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/role-assignments/:provider/:subject', privilege: 'agents.roles.assign', description: 'Assign agent role to subject' },
  { method: 'GET', pattern: '/api/v1/agents/:id/bundle', privilege: 'config.export.agent', description: 'Export agent bundle' },
  { method: 'GET', pattern: '/api/v1/agents/:id/models', privilege: 'agents.models.read', description: 'Read agent models policy' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/models', privilege: 'agents.models.set', description: 'Set agent models policy' },
  { method: 'GET', pattern: '/api/v1/agents/:id/policy', privilege: 'policy.read', description: 'Read agent egress policy' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/policy', privilege: 'policy.set', description: 'Update agent egress policy' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/owners', privilege: 'agents.owners.set', description: 'Set agent owners' },
  { method: 'GET', pattern: '/api/v1/agents/:id/config', privilege: 'config.read', description: 'Read agent configuration' },
  { method: 'GET', pattern: '/api/v1/agents/:id/config/history', privilege: 'config.read', description: 'Read agent configuration history' },
  { method: 'GET', pattern: '/api/v1/agents/:id/config/versions/:version', privilege: 'config.read', description: 'Read agent configuration version' },
  { method: 'GET', pattern: '/api/v1/agents/:id/skills', privilege: 'config.read', description: 'List agent adopted skills' },
  { method: 'POST', pattern: '/api/v1/agents/:id/skills', privilege: 'skills.adopt.request', description: 'Adopt skill for agent' },
  { method: 'DELETE', pattern: '/api/v1/agents/:id/skills/:skillId', privilege: 'skills.adopt.remove', description: 'Remove adopted skill from agent' },
  { method: 'PATCH', pattern: '/api/v1/agents/:id/skills/:skillId', privilege: 'skills.adopt.request', description: 'Merge skill action hold overrides (S23)' },
  { method: 'PUT', pattern: '/api/v1/agents/:id/skills/:skillId/holds', privilege: 'skills.adopt.request', description: 'Replace skill action hold overrides (S23)' },
  { method: 'PATCH', pattern: '/api/v1/agents/:id/skills/:skillId/holds', privilege: 'skills.adopt.request', description: 'Merge skill action hold overrides (S23)' },
  { method: 'POST', pattern: '/api/v1/agents/:id/skills/:skillId/adoption/approve', privilege: 'skills.adopt.decide', description: 'Approve skill adoption' },
  { method: 'POST', pattern: '/api/v1/agents/:id/skills/:skillId/adoption/reject', privilege: 'skills.adopt.decide', description: 'Reject skill adoption' },
  { method: 'POST', pattern: '/api/v1/agents/:id/conversation', privilege: 'agents.converse', description: 'Deliver conversation turn to agent' },
  { method: 'POST', pattern: '/api/v1/agents/:id/conversation-requests', privilege: ['agents.converse', 'conversations.read-others'], description: 'Manage conversation sessions' },
  { method: 'GET', pattern: '/api/v1/agents/:id/replies', privilege: 'agents.converse', description: 'Poll conversation replies' },

  // Runs
  { method: 'GET', pattern: '/api/v1/runs', privilege: 'runs.read', description: 'List active and recent runs' },
  { method: 'GET', pattern: '/api/v1/runs/:id', privilege: 'runs.read', description: 'Get run details' },
  { method: 'POST', pattern: '/api/v1/runs/:id/cancel', privilege: 'runs.cancel', description: 'Cancel active run' },

  // Run-token authenticated agent runtime endpoints (Exceptions)
  { method: 'GET', pattern: '/api/v1/runs/:id/approved-models', exception: 'run-token', description: 'Read approved models list (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/subagents', exception: 'run-token', description: 'List allowed subagents (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/subagents/spawn', exception: 'run-token', description: 'Spawn subagent run (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/subagents/runs/:subagentRunId', exception: 'run-token', description: 'Get subagent run state (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/wake/:targetAgentId', exception: 'run-token', description: 'Wake target agent (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/models', exception: 'run-token', description: 'Read agent model configuration (run token)' },
  { method: 'PUT', pattern: '/api/v1/runs/:id/models', exception: 'run-token', description: 'Set agent model configuration (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/input', exception: 'run-token', description: 'Fetch run input payload (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/result', exception: 'run-token', description: 'Post run terminal result (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/heartbeat', exception: 'run-token', description: 'Post run heartbeat (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/mailbox', exception: 'run-token', description: 'Poll mailbox messages (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/training', exception: 'run-token', description: 'Post run training results (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/reply', exception: 'run-token', description: 'Post conversational turn reply (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/agent-config', exception: 'run-token', description: 'Read agent config snapshot (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/role-requests', exception: 'run-token', description: 'Post role assignment request (run token)' },
  { method: 'POST', pattern: '/api/v1/runs/:id/builder', exception: 'run-token', description: 'Agent builder conversational assistant (run token)' },
  { method: 'GET', pattern: '/api/v1/runs/:id/events', exception: 'run-token', description: 'Stream run progress events (run token)' },

  // Ledger
  { method: 'GET', pattern: '/api/v1/ledger', privilege: 'ledger.read', description: 'Query audit ledger events' },
  { method: 'GET', pattern: '/api/v1/ledger/verify', privilege: 'ledger.read', description: 'Verify ledger hash chain' },
  { method: 'POST', pattern: '/api/v1/ledger', privilege: 'ledger.ingest', description: 'Ingest ledger event' },

  // Models catalog & management
  { method: 'GET', pattern: '/api/v1/models', privilege: 'models.read', description: 'List available models' },
  { method: 'GET', pattern: '/api/v1/models/internal/catalog', privilege: 'egress.models.read', description: 'Internal models catalog for egress proxy' },
  { method: 'POST', pattern: '/api/v1/models/scan', privilege: 'models.manage', description: 'Scan provider for available models' },
  { method: 'POST', pattern: '/api/v1/models/admit', privilege: 'models.manage', description: 'Admit model into factory catalog' },
  { method: 'PUT', pattern: '/api/v1/models/:model/pricing', privilege: 'models.manage', description: 'Set model pricing' },
  { method: 'PUT', pattern: '/api/v1/models/default', privilege: 'models.manage', description: 'Set default factory model' },
  { method: 'DELETE', pattern: '/api/v1/models/:model', privilege: 'models.manage', description: 'Remove model from catalog' },

  // Approvals & MCP
  { method: 'GET', pattern: '/api/v1/approvals', privilege: 'approvals.read', description: 'List pending tool approvals' },
  { method: 'POST', pattern: '/api/v1/approvals/:id', privilege: 'approvals.decide', description: 'Decide tool approval' },
  { method: 'POST', pattern: '/api/v1/ingress/approval-prompts', privilege: 'approvals.channel', description: 'Send approval prompt to channel' },
  { method: 'POST', pattern: '/api/v1/ingress/approvals/:id/asked', privilege: 'approvals.channel', description: 'Record approval prompt sent' },
  { method: 'POST', pattern: '/api/v1/ingress/approvals/decision', privilege: 'approvals.channel', description: 'Record channel approval decision' },
  { method: 'POST', pattern: '/mcp', privilege: 'mcp.use', description: 'Model Context Protocol JSON-RPC endpoint' },

  // Registry
  { method: 'GET', pattern: '/api/v1/registry/agents', privilege: 'agents.read', description: 'List agent catalog' },
  { method: 'POST', pattern: '/api/v1/registry/agents', privilege: 'registry.register', description: 'Register new cartridge agent' },
  { method: 'GET', pattern: '/api/v1/registry/agents/:id', privilege: 'agents.read', description: 'Get agent catalog entry' },
  { method: 'GET', pattern: '/api/v1/submissions/interview', privilege: 'content.submit', description: 'Interview questions (S21)' },
  { method: 'POST', pattern: '/api/v1/submissions/interview', privilege: 'content.submit', description: 'Preview or finalize an interview draft into an S20 submission (S21)' },
  { method: 'POST', pattern: '/api/v1/submissions', privilege: 'content.submit', description: 'Submit an agent or skill draft (S20)' },
  { method: 'GET', pattern: '/api/v1/submissions', privilege: 'content.submit', description: 'List own (or, for approvers, all) submissions (S20)' },
  { method: 'GET', pattern: '/api/v1/submissions/:id', privilege: 'content.submit', description: 'Read a submission (S20)' },
  { method: 'POST', pattern: '/api/v1/submissions/:id/admit', privilege: 'content.admit', description: 'Admit a submission once all gates pass (S20)' },
  { method: 'PUT', pattern: '/api/v1/budget/submissions/:id', privilege: 'budget.allocate', description: 'Allocate budget to an agent submission (S20)' },
  { method: 'PUT', pattern: '/api/v1/budget/agents/:id', privilege: 'budget.allocate', description: 'Allocate agent AI model budget (S19)' },
  { method: 'PUT', pattern: '/api/v1/registry/agents/:id/budget', privilege: 'registry.budget.set', description: 'Set agent budget limit' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/retire', privilege: 'registry.retire', description: 'Retire agent cartridge' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/reinstate', privilege: 'registry.reinstate', description: 'Reinstate retired agent' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/purge', privilege: 'registry.purge', description: 'Purge retired agent data' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/deploy', privilege: 'registry.deploy', description: 'Deploy agent image update' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/model', privilege: 'registry.model.set', description: 'Set agent preferred model' },
  { method: 'PUT', pattern: '/api/v1/registry/agents/:id/model', privilege: 'registry.model.set', description: 'Set agent preferred model' },
  { method: 'POST', pattern: '/api/v1/registry/agents/:id/models/approve', privilege: 'registry.model.set', description: 'Approve agent models' },
  { method: 'PUT', pattern: '/api/v1/registry/agents/:id/models/approve', privilege: 'registry.model.set', description: 'Approve agent models' },
  { method: 'PUT', pattern: '/api/v1/policies/budget', privilege: 'policy.budget.set', description: 'Set system budget policy' },

  // Gatekeeper Egress callbacks
  { method: 'GET', pattern: '/api/v1/gatekeeper-egress/runs/:id', privilege: 'egress.run.read', description: 'Egress read active run policy' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/runs/:id/failover', privilege: 'egress.models.failover', description: 'Record model failover event' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/approvals', privilege: 'egress.approvals.request', description: 'Egress request tool approval' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/holds', privilege: 'egress.holds.create', description: 'Egress create tool hold' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/approvals/:id/consume', privilege: 'egress.approvals.consume', description: 'Egress consume granted approval' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/progress', privilege: 'egress.progress.report', description: 'Egress report turn progress' },
  { method: 'GET', pattern: '/api/v1/gatekeeper-egress/routes', privilege: 'egress.routes.read', description: 'Egress query route declarations' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/connections/token', privilege: 'egress.connections.token', description: 'Egress fetch connection OAuth token' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/github-app/token', privilege: 'egress.connections.token', description: 'Egress fetch GitHub App token' },

  // Keymaster & Credentials
  { method: 'POST', pattern: '/api/v1/keymaster/checkout', exception: 'run-token', description: 'Checkout platform secret' },
  { method: 'POST', pattern: '/api/v1/gatekeeper-egress/keymaster/checkout', privilege: 'egress.keymaster.checkout', description: 'Egress checkout platform secret' },
  { method: 'GET', pattern: '/api/v1/keymaster/outstanding', privilege: 'credentials.outstanding.read', description: 'Read outstanding checked-out secrets' },
  { method: 'GET', pattern: '/api/v1/keymaster/platform/credentials', privilege: 'credentials.platform.read', description: 'Read platform credentials list' },
  { method: 'POST', pattern: '/api/v1/keymaster/platform/credentials/:name', privilege: 'credentials.platform.set', description: 'Set platform credential' },
  { method: 'PUT', pattern: '/api/v1/keymaster/platform/credentials/:name', privilege: 'credentials.platform.set', description: 'Update platform credential' },
  { method: 'GET', pattern: '/api/v1/keymaster/agents/:id/credentials', privilege: 'credentials.agent.read', description: 'Read agent credentials' },
  { method: 'POST', pattern: '/api/v1/keymaster/agents/:id/credentials/:name', privilege: 'credentials.agent.set', description: 'Set agent credential' },
  { method: 'PUT', pattern: '/api/v1/keymaster/agents/:id/credentials/:name', privilege: 'credentials.agent.set', description: 'Update agent credential' },
  { method: 'GET', pattern: '/api/v1/keymaster/providers/:provider/client', privilege: 'credentials.provider.read', description: 'Read provider client credential' },
  { method: 'POST', pattern: '/api/v1/keymaster/providers/:provider/client', privilege: 'credentials.provider.set', description: 'Set provider client credential' },
  { method: 'GET', pattern: '/api/v1/keymaster/agents/:id/app-setup', privilege: 'credentials.agent.read', description: 'Read agent app-setup status' },
  { method: 'POST', pattern: '/api/v1/keymaster/agents/:id/app-setup/:provider/:step', privilege: 'credentials.agent.set', description: 'Execute app-setup step' },
  { method: 'GET', pattern: '/api/v1/keymaster/agents/:id/discord-app', privilege: 'credentials.agent.read', description: 'Read Discord app credential' },
  { method: 'POST', pattern: '/api/v1/keymaster/agents/:id/discord-app/token', privilege: 'credentials.agent.set', description: 'Set Discord bot token' },
  { method: 'POST', pattern: '/api/v1/keymaster/agents/:id/github-app/start', privilege: 'credentials.agent.set', description: 'Start GitHub App creation flow' },
  { method: 'GET', pattern: '/api/v1/keymaster/github-app/callback', exception: 'oauth-github-app-callback', description: 'GitHub App manifest callback (OAuth state)' },
  { method: 'POST', pattern: '/api/v1/keymaster/agents/:id/github-app/installations', privilege: 'credentials.agent.set', description: 'Save GitHub App installations' },

  // Connections (OAuth)
  { method: 'GET', pattern: '/api/v1/connections/:provider/callback', exception: 'oauth-connections-callback', description: 'OAuth connection callback (OAuth state)' },
  { method: 'GET', pattern: '/api/v1/agents/:id/transfer', exception: 'agent-transfer-read', description: 'Read pending agent ownership transfer (S3b)' },
  { method: 'POST', pattern: '/api/v1/agents/:id/transfer', exception: 'agent-transfer-start', description: 'Start agent ownership transfer (S3b)' },
  { method: 'POST', pattern: '/api/v1/agents/:id/transfer/accept', exception: 'agent-transfer-accept', description: 'Accept agent ownership transfer (S3b)' },
  { method: 'POST', pattern: '/api/v1/agents/:id/transfer/decline', exception: 'agent-transfer-decline', description: 'Decline agent ownership transfer (S3b)' },
  { method: 'POST', pattern: '/api/v1/agents/:id/transfer/cancel', exception: 'agent-transfer-cancel', description: 'Cancel agent ownership transfer (S3b)' },
  { method: 'GET', pattern: '/api/v1/skills/:id/transfer', exception: 'skill-transfer-read', description: 'Read pending skill ownership transfer (S3b)' },
  { method: 'POST', pattern: '/api/v1/skills/:id/transfer/decline', exception: 'skill-transfer-decline', description: 'Decline skill ownership transfer (S3b)' },
  { method: 'GET', pattern: '/api/v1/connections/:id/:provider/start', privilege: 'connections.start', description: 'Start OAuth user connection' },
  { method: 'POST', pattern: '/api/v1/connections/:id/:provider/import', privilege: 'connections.import', description: 'Import connection credentials' },
  { method: 'GET', pattern: '/api/v1/connections/:id', privilege: 'connections.read', description: 'List agent active connections' },

  // Config store
  { method: 'GET', pattern: '/api/v1/config/export', privilege: ['config.export', 'config.export.agent'], description: 'Export full factory configuration' },

  // Identity links
  { method: 'GET', pattern: '/api/v1/identity-links', privilege: 'identity.links.read', description: 'List channel identity links' },
  { method: 'PUT', pattern: '/api/v1/identity-links/:provider/:id', privilege: 'identity.links.set', description: 'Create or update identity link' },
  { method: 'DELETE', pattern: '/api/v1/identity-links/:provider/:id', privilege: 'identity.links.set', description: 'Delete identity link' },

  // Schedules
  { method: 'GET', pattern: '/api/v1/schedules', privilege: 'schedules.read', description: 'List scheduled tasks' },
  { method: 'POST', pattern: '/api/v1/schedules', privilege: 'schedules.write', description: 'Create scheduled task' },
  { method: 'POST', pattern: '/api/v1/schedules/:id', privilege: 'schedules.write', description: 'Update scheduled task' },
  { method: 'PATCH', pattern: '/api/v1/schedules/:id', privilege: 'schedules.write', description: 'Update scheduled task' },
  { method: 'PUT', pattern: '/api/v1/schedules/:id', privilege: 'schedules.write', description: 'Replace scheduled task' },
  { method: 'DELETE', pattern: '/api/v1/schedules/:id', privilege: 'schedules.write', description: 'Delete scheduled task' },

  // Skills
  { method: 'GET', pattern: '/api/v1/skills', privilege: 'skills.read', description: 'List catalog skills' },
  { method: 'GET', pattern: '/api/v1/skills/defaults', privilege: 'skills.read', description: 'Get default skills' },
  { method: 'PUT', pattern: '/api/v1/skills/defaults', privilege: 'skills.defaults.set', description: 'Set default skills' },
  { method: 'GET', pattern: '/api/v1/skills/:id', privilege: 'skills.read', description: 'Get skill details' },
  { method: 'GET', pattern: '/api/v1/skills/:id/versions/:version', privilege: 'skills.read', description: 'Get skill version metadata' },
  { method: 'POST', pattern: '/api/v1/registry/skills', privilege: ['skills.register', 'skills.version.add'], description: 'Register skill or add version' },
  { method: 'POST', pattern: '/api/v1/registry/skills/:id/versions/:version/checks', privilege: 'skills.checks.run', description: 'Run skill offline validation checks' },
  { method: 'POST', pattern: '/api/v1/registry/skills/:id/versions/:version/approve', privilege: ['skills.decide', 'skills.decide.private', 'content.admit'], description: 'Approve skill version' },
  { method: 'POST', pattern: '/api/v1/registry/skills/:id/versions/:version/reject', privilege: ['skills.decide', 'skills.decide.private', 'content.admit'], description: 'Reject skill version' },
  { method: 'POST', pattern: '/api/v1/registry/skills/:id/retire', privilege: ['skills.retire', 'skills.retire.force'], description: 'Retire skill version' },
  { method: 'GET', pattern: '/api/v1/skills/:id/adopters', privilege: 'skills.read', description: 'List agents adopting skill' },
  { method: 'GET', pattern: '/api/v1/skills/:id/training', privilege: 'skills.training.run', description: 'Read skill training state' },
  { method: 'PUT', pattern: '/api/v1/skills/:id/training-account', privilege: 'skills.training.fund', description: 'Fund skill training account' },
  { method: 'PUT', pattern: '/api/v1/skills/:id/training-baseline', privilege: 'skills.training.run', description: 'Set skill training baseline' },
  { method: 'POST', pattern: '/api/v1/skills/:id/training-runs', privilege: 'skills.training.run', description: 'Execute skill training run' },
  { method: 'POST', pattern: '/api/v1/skills/:id/training-recommendation', privilege: 'skills.training.run', description: 'Generate skill training recommendation' },
  { method: 'GET', pattern: '/api/v1/skills/:id/model', privilege: 'skills.package.read', description: 'Read skill model binding (S24)' },
  { method: 'PUT', pattern: '/api/v1/skills/:id/model', privilege: 'skills.version.add', description: 'Bind or swap skill model (S24)' },
  { method: 'POST', pattern: '/api/v1/skills/:id/transfer', privilege: 'skills.transfer', description: 'Initiate skill ownership transfer' },
  { method: 'POST', pattern: '/api/v1/skills/:id/transfer/accept', privilege: 'skills.register', description: 'Accept skill ownership transfer' },
  { method: 'POST', pattern: '/api/v1/skills/:id/transfer/cancel', privilege: 'skills.transfer', description: 'Cancel skill ownership transfer' },
  { method: 'POST', pattern: '/api/v1/skills/:id/transfer/admin', privilege: 'skills.decide', description: 'Admin force-transfer skill' },
  { method: 'PUT', pattern: '/api/v1/skills/:id/group', privilege: 'skills.assign', description: 'Assign skill to group' },
  { method: 'DELETE', pattern: '/api/v1/skills/:id/group', privilege: 'skills.assign', description: 'Unassign skill from group' },
  { method: 'GET', pattern: '/api/v1/skills/:id/versions/:version/package/files', privilege: 'skills.package.read', description: 'List package archive files' },
  { method: 'GET', pattern: '/api/v1/skills/:id/versions/:version/package/file', privilege: 'skills.package.read', description: 'Download package file' },
  { method: 'POST', pattern: '/api/v1/skills/:id/publish', privilege: 'skills.publish.request', description: 'Request skill publishing' },
  { method: 'POST', pattern: '/api/v1/skills/:id/publish/decide', privilege: 'skills.decide', description: 'Admin decide skill publishing' },
  { method: 'POST', pattern: '/api/v1/skills/:id/unpublish', privilege: 'skills.unpublish', description: 'Unpublish published skill' },
  { method: 'POST', pattern: '/api/v1/skills/:id/retire', privilege: ['skills.retire', 'skills.retire.force'], description: 'Retire skill' },

  // Groups
  { method: 'GET', pattern: '/api/v1/groups', privilege: 'groups.manage', description: 'List user groups' },
  { method: 'POST', pattern: '/api/v1/groups', privilege: 'groups.manage', description: 'Create user group' },
  { method: 'GET', pattern: '/api/v1/groups/:id', privilege: 'groups.manage', description: 'Get group details' },
  { method: 'PUT', pattern: '/api/v1/groups/:id', privilege: 'groups.manage', description: 'Update group details' },
  { method: 'DELETE', pattern: '/api/v1/groups/:id', privilege: 'groups.manage', description: 'Delete user group' },
  { method: 'POST', pattern: '/api/v1/groups/:id/members', privilege: 'groups.manage', description: 'Add group member' },
  { method: 'POST', pattern: '/api/v1/groups/:id/members/:member', privilege: 'groups.manage', description: 'Add group member' },
  { method: 'DELETE', pattern: '/api/v1/groups/:id/members', privilege: 'groups.manage', description: 'Remove group member' },
  { method: 'DELETE', pattern: '/api/v1/groups/:id/members/:member', privilege: 'groups.manage', description: 'Remove group member by path' },

  // Subagents
  { method: 'POST', pattern: '/api/v1/registry/subagents', privilege: 'registry.register', description: 'Register subagent' },
  { method: 'GET', pattern: '/api/v1/registry/subagents', privilege: 'agents.read', description: 'List registered subagents' },
  { method: 'PUT', pattern: '/api/v1/registry/subagents/:id/models', privilege: 'registry.register', description: 'Set subagent model allowlist' },
  { method: 'GET', pattern: '/api/v1/registry/subagents/:id', privilege: 'agents.read', description: 'Get subagent details' },

  // Systems
  { method: 'GET', pattern: '/api/v1/systems', privilege: 'systems.read', description: 'List registered external systems' },
  { method: 'POST', pattern: '/api/v1/systems', privilege: 'systems.propose', description: 'Propose new external system' },
  { method: 'GET', pattern: '/api/v1/systems/:id', privilege: 'systems.read', description: 'Get system details' },
  { method: 'POST', pattern: '/api/v1/systems/:id/approve', privilege: 'systems.decide', description: 'Approve proposed external system' },
  { method: 'POST', pattern: '/api/v1/systems/:id/reject', privilege: 'systems.decide', description: 'Reject proposed external system' },

  // WebSocket Event Stream
  { method: 'GET', pattern: '/api/v1/events', privilege: 'events.subscribe', description: 'WebSocket event stream upgrade' },
];

/**
 * Finds the declared control-plane route for an incoming method and URL path.
 */
export function matchRoute(method: string, path: string): ControlPlaneRoute | undefined {
  const cleanPath = path.split('?')[0];
  // Most specific wins regardless of declaration order: fewer :params first, then more literal segments
  // (so a later static `GET /api/v1/skills/drafts` beats an earlier `GET /api/v1/skills/:id`).
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

/** Canonical form for duplicate detection: `:id` and `:agentId` name the same route. */
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
 * Validates route registry integrity, completeness, uniqueness, and valid references.
 */
export function validateRouteRegistry(
  routes: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
  exceptions: Record<string, RouteException> = ROUTE_EXCEPTIONS,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const knownPrivileges = new Set<string>(PRIVILEGES);
  const seenPairs = new Set<string>();

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

  // 2. Validate CONTROL_PLANE_ROUTES
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
