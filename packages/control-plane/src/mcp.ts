import { type Principal } from '@beercanlabs/factory-auth';
import {
  AGENT_SCOPED,
  authorize,
  requiredRoleForPrivilege,
  type Privilege,
} from '@beercanlabs/factory-bouncer';
import { effectiveAgentModels } from '@beercanlabs/factory-gatekeeper/policy';
import { applyKillSwitch, createRun } from '@beercanlabs/factory-property-manager';
import { registryOf } from '@beercanlabs/factory-registrar';
import {
  actAsStorage,
  admitModel,
  agentKindOf,
  attachCallerToRunResult,
  badRunModel,
  checkOwnsAnyAgent,
  checkOwnsPersonalAgent,
  decideApproval,
  defaultModelOf,
  discoverViaEgress,
  effectiveGrantsForActor,
  enrichAgent,
  enrichedCatalogModelsForNames,
  parseModelPriceInput,
  resolveActAsForPrincipal,
  resolvePrincipalCaller,
  retireCatalogModel,
  setAgentModels,
  stageDiscovered,
  vendorTarget,
  visibleApprovals,
  APPROVAL_KINDS,
  type ApprovalKind,
  visibleModelsForPrincipal,
  type FactoryState,
} from './app.js';
import { ModelCatalogError } from './models.js';
import { fleetStateOf, setFleetState } from './fleet-state.js';
import { ownersOf } from './config-store.js';
import {
  addPrincipalEmail,
  callerMayUseScopedGrantTools,
  checkAuthz,
  createPrincipal,
  getPrincipal,
  getWhoami,
  grantRole,
  listGrants,
  listPrincipals,
  removePrincipalEmail,
  revokeGrant,
  revokeAllAccess,
  rolesForSubjectActor,
  type RouteOutcome,
} from './grants-routes.js';
import { checkAgentUpdate } from './updates.js';

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

type ToolSpec = {
  name: string;
  title: string;
  description: string;
  privilege: Privilege;
  scopedDelegation?: boolean;
  args: Record<string, { type: string; items?: { type: string } }>;
  required?: string[];
  annotations: ToolAnnotations;
};

export function redactMcpSecretText(text: string, secrets?: Iterable<string>): string {
  let out = text;
  if (secrets) {
    const list = [...secrets].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
    for (const secret of list) {
      if (!out.includes(secret)) continue;
      out = out.split(secret).join('[REDACTED]');
    }
  }
  // Sanitize common credential patterns
  out = out.replace(/\bfk_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  return out;
}

export function redactMcpResponse<T>(res: T, secrets?: Iterable<string>): T {
  if (!res || typeof res !== 'object') return res;
  const obj = res as Record<string, unknown>;
  if (obj.result && typeof obj.result === 'object') {
    const r = { ...(obj.result as Record<string, unknown>) };
    if (Array.isArray(r.content)) {
      r.content = r.content.map((c) => {
        if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
          return { ...c, text: redactMcpSecretText(c.text, secrets) };
        }
        return c;
      });
    }
    if (r.structuredContent !== undefined) {
      try {
        const jsonStr = JSON.stringify(r.structuredContent);
        r.structuredContent = JSON.parse(redactMcpSecretText(jsonStr, secrets));
      } catch {
        // preserve unparsed
      }
    }
    return { ...obj, result: r } as T;
  }
  return res;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'whoami',
    title: 'Whoami',
    description: 'Return the verified caller principal, mapped emails, effective grants, and live privileges',
    privilege: 'mcp.use',
    args: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'authz_check',
    title: 'Authorization Check',
    description: 'Side-effect-free authorization preflight check returning { allowed, requiredRole } without ledger denial noise',
    privilege: 'mcp.use',
    args: {
      privilege: { type: 'string' },
      agentId: { type: 'string' },
      skillId: { type: 'string' },
    },
    required: ['privilege'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_principals',
    title: 'List Principals',
    description: 'List canonical human principals and their mapped verified emails (or fetch one by id; admin only)',
    privilege: 'grants.manage',
    args: { id: { type: 'string' } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_principal',
    title: 'Create Principal',
    description: 'Pre-create a canonical user:<id> principal with 1..N globally unique lowercased emails (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      displayName: { type: 'string' },
      emails: { type: 'array', items: { type: 'string' } },
    },
    required: ['displayName', 'emails'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_principal_email',
    title: 'Add Principal Email',
    description: 'Add a globally unique lowercased verified email alias to an existing principal (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['id', 'email'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'remove_principal_email',
    title: 'Remove Principal Email',
    description: 'Remove an email alias from a principal while preserving at least one mapped email (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['id', 'email'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_grants',
    title: 'List Grants',
    description: 'List grants (admin fleet-wide, or scoped content-owner / accountable-lead on their own agent or skill)',
    privilege: 'grants.manage',
    scopedDelegation: true,
    args: {
      subject: { type: 'string' },
      scopeKind: { type: 'string' },
      scopeId: { type: 'string' },
      includeExpired: { type: 'boolean' },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'grant_role',
    title: 'Grant Role',
    description: 'Create a fleet, agent, or skill role grant subject to delegation ceilings',
    privilege: 'grants.manage',
    scopedDelegation: true,
    args: {
      id: { type: 'string' },
      subject: { type: 'string' },
      subjectDisplayName: { type: 'string' },
      scope: { type: 'object' },
      role: { type: 'string' },
      expiresAt: { type: 'string' },
      replaceExisting: { type: 'boolean' },
    },
    required: ['subject', 'scope', 'role'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'revoke_grant',
    title: 'Revoke Grant',
    description: 'Revoke a grant by id subject to delegation ceilings and last-human-admin protection',
    privilege: 'grants.manage',
    scopedDelegation: true,
    args: {
      id: { type: 'string' },
      grantId: { type: 'string' },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'revoke_all_access',
    title: 'Revoke All Access',
    description: 'Remove every grant and group membership of a principal and end its sign-in sessions and CLI login tokens (API keys stay) (confirm must equal its id); refused 409 for the last admin',
    privilege: 'grants.manage',
    args: { id: { type: 'string' }, confirm: { type: 'string' } },
    required: ['id', 'confirm'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_agents',
    title: 'List Agents',
    description: 'List factory cartridges',
    privilege: 'agents.read',
    args: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'query_ledger',
    title: 'Query Ledger',
    description: 'Read the execution ledger',
    privilege: 'ledger.read',
    args: { agent: { type: 'string' } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_run',
    title: 'Get Run',
    description: 'Get a run by id',
    privilege: 'runs.read',
    args: { runId: { type: 'string' } },
    required: ['runId'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'wake_agent',
    title: 'Wake Agent',
    description: 'Start a run (202 semantics: returns the queued/started run). Optional model pins the run; optional input is passed to it, the same as POST /api/v1/agents/:id/runs.',
    privilege: 'agents.wake',
    args: { id: { type: 'string' }, model: { type: 'string' }, input: { type: 'object' } },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'pause_agent',
    title: 'Pause Agent',
    description: 'Pause agent egress',
    privilege: 'agents.pause',
    args: { id: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'resume_agent',
    title: 'Resume Agent',
    description: 'Resume agent egress',
    privilege: 'agents.resume',
    args: { id: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'isolate_agent',
    title: 'Isolate Agent',
    description: 'Isolate agent egress',
    privilege: 'agents.isolate',
    args: { id: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_approvals',
    title: 'List Approvals',
    description: 'List pending approvals; kind narrows to tool, held, change or decision (a decision an agent asked for)',
    privilege: 'approvals.read',
    args: { kind: { type: 'string' } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_approval',
    title: 'Get Approval',
    description: 'Read one approval by id, pending or decided',
    privilege: 'approvals.read',
    args: { approvalId: { type: 'string' } },
    required: ['approvalId'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_fleet_state',
    title: 'Get Fleet State',
    description: "Read the fleet's go/stop state (status, coder_app_ready, reason)",
    privilege: 'agents.read',
    args: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_fleet_state',
    title: 'Set Fleet State',
    description: "Set the fleet's go/stop state: status is running, paused or deploy-freeze; opsAgents lists the registered agents that report deploy state; ops (null or {state, reason}) sets or clears that report, rolled-back included, and needs force: true while the deploying run is live",
    privilege: 'fleet.state.set',
    args: { status: { type: 'string' }, coder_app_ready: { type: 'boolean' }, reason: { type: 'string' }, opsAgents: { type: 'array', items: { type: 'string' } }, ops: { type: 'object' }, force: { type: 'boolean' } },
    required: ['status'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'decide_approval',
    title: 'Decide Approval',
    description: 'Approve or reject a pending approval; capUsd sets a spending cap when approving a decision hold',
    privilege: 'approvals.decide',
    args: { approvalId: { type: 'string' }, decision: { type: 'string' }, notes: { type: 'string' }, capUsd: { type: 'string' } },
    required: ['approvalId', 'decision'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'check_agent_update',
    title: 'Check Agent Update',
    description: 'Check for available cartridge updates from git repository',
    privilege: 'agents.update.read',
    args: { id: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'install_agent_update',
    title: 'Install Agent Update',
    description: 'Install an available cartridge update (mode: drain or restart_now)',
    privilege: 'agents.update.install',
    args: { id: { type: 'string' }, mode: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_model_catalog',
    title: 'List Model Catalog',
    description: 'List offered and staged models in the factory',
    privilege: 'models.read',
    args: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'scan_vendor_models',
    title: 'Scan Vendor Models',
    description: 'Scan an AI vendor endpoint to discover available models',
    privilege: 'models.manage',
    args: { vendorId: { type: 'string' } },
    required: ['vendorId'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'admit_model',
    title: 'Admit Model',
    description: 'Admit a model to the factory offering with token pricing. Name its vendor (vendorId): provider, endpoint and credential come from the vendor. provider/region only for cloud model services (bedrock-converse, vertex-*).',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
      id: { type: 'string' },
      vendorId: { type: 'string' },
      provider: { type: 'string' },
      region: { type: 'string' },
      inputPerMTok: { type: 'string' },
      outputPerMTok: { type: 'string' },
    },
    required: ['name', 'id'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_model_pricing',
    title: 'Update Model Pricing',
    description: 'Update token pricing per million tokens for an admitted model',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
      inputPerMTok: { type: 'string' },
      outputPerMTok: { type: 'string' },
    },
    required: ['name', 'inputPerMTok', 'outputPerMTok'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'retire_vendor_or_model',
    title: 'Retire Vendor or Model',
    description: 'Retire an admitted model from the factory offering',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
    },
    required: ['name'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_default_model',
    title: 'Set Default Model',
    description: 'Set the factory default model granted to agents whose policy specifies no models (requires models.manage)',
    privilege: 'models.manage',
    args: {
      model: { type: 'string' },
    },
    required: ['model'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_agent_models',
    title: 'Get Agent Models',
    description: 'Get the effective and configured model slots and approved models for an agent',
    privilege: 'agents.models.read',
    args: { id: { type: 'string' } },
    required: ['id'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_agent_models',
    title: 'Set Agent Models',
    description: 'Configure approved models and current, primary, and secondary model slots for an agent',
    privilege: 'agents.models.set',
    args: {
      id: { type: 'string' },
      approvedModels: { type: 'array', items: { type: 'string' } },
      currentModel: { type: 'string' },
      primaryModel: { type: 'string' },
      secondaryModel: { type: 'string' },
    },
    required: ['id'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function formatOutcomeForMcp(id: unknown, out: RouteOutcome): unknown {
  const isErr = out.status >= 400;
  const structured = typeof out.body === 'object' && out.body !== null ? (out.body as Record<string, unknown>) : { value: out.body };
  let refusalText: string;
  if (out.status === 403) {
    const reqRole = String(out.body.requiredRole ?? out.body.required ?? 'admin');
    refusalText = `forbidden: requires ${reqRole}`;
  } else if (out.status === 503) {
    refusalText = String(out.body.error ?? 'store_unavailable');
  } else {
    refusalText = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  }
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: refusalText }],
      structuredContent: structured,
      ...(isErr ? { isError: true } : {}),
    },
  };
}

async function dispatchSharedRouteTool(
  state: FactoryState,
  name: string,
  args: Record<string, unknown>,
  principal: Principal,
): Promise<RouteOutcome | null> {
  // GAP-259: a refused decision (not an approver, no cap where one is required, not pending) is an MCP error.
  if (name === 'decide_approval') {
    const notes = typeof args.notes === 'string' ? args.notes : undefined;
    return (await decideApproval(state, String(args.approvalId), String(args.decision), principal, notes, undefined, args.capUsd)) as RouteOutcome;
  }
  // GAP-260: a refused change (an unknown status, a bad flag) is an MCP error, never a result that reads as success.
  if (name === 'set_fleet_state') return setFleetState(state, args, principal) as RouteOutcome;
  if (name === 'whoami') {
    return getWhoami(state, principal);
  }
  if (name === 'authz_check') {
    return checkAuthz(state, principal, {
      privilege: args.privilege,
      agentId: args.agentId,
      skillId: args.skillId,
    });
  }
  if (name === 'list_principals') {
    if (typeof args.id === 'string' && args.id.trim()) {
      return getPrincipal(state, args.id);
    }
    return listPrincipals(state);
  }
  if (name === 'create_principal') {
    return createPrincipal(state, principal, args);
  }
  if (name === 'add_principal_email') {
    if (typeof args.id !== 'string' || !args.id.trim()) {
      return { status: 400, body: { error: 'invalid_principal', message: 'id is required' } };
    }
    return addPrincipalEmail(state, principal, args.id, args);
  }
  if (name === 'remove_principal_email') {
    if (typeof args.id !== 'string' || !args.id.trim()) {
      return { status: 400, body: { error: 'invalid_principal', message: 'id is required' } };
    }
    if (typeof args.email !== 'string' || !args.email.trim()) {
      return { status: 400, body: { error: 'invalid_email', message: 'email is required' } };
    }
    return removePrincipalEmail(state, principal, args.id, args.email);
  }
  if (name === 'list_grants') {
    return listGrants(state, principal, {
      subject: args.subject,
      scopeKind: args.scopeKind,
      scopeId: args.scopeId,
      includeExpired: args.includeExpired,
    });
  }
  if (name === 'grant_role') {
    return grantRole(state, principal, args);
  }
  if (name === 'revoke_all_access') {
    if (typeof args.id !== 'string' || !args.id.trim()) return { status: 400, body: { error: 'invalid_principal', message: 'id is required' } };
    return revokeAllAccess(state, principal, args.id, { confirm: args.confirm });
  }
  if (name === 'revoke_grant') {
    const grantId = typeof args.grantId === 'string' && args.grantId.trim()
      ? args.grantId
      : typeof args.id === 'string' && args.id.trim()
        ? args.id
        : '';
    if (!grantId) {
      return { status: 400, body: { error: 'invalid_grant', message: 'id or grantId is required' } };
    }
    return revokeGrant(state, principal, grantId);
  }
  return null;
}

async function dispatchLegacyTool(
  state: FactoryState,
  name: string,
  args: Record<string, unknown>,
  principal: Principal,
): Promise<unknown> {
  const actor = principal.actor;
  if (name === 'list_agents') return [...state.agents.values()].filter((a) => !a.ephemeral).map((a) => enrichAgent(state, a));
  if (name === 'query_ledger') return state.ledger.query({ agent: typeof args.agent === 'string' ? args.agent : undefined });
  if (name === 'get_run') return (typeof args.runId === 'string' ? state.runs.get(args.runId) : undefined) ?? { error: 'not_found' };
  if (name === 'get_fleet_state') return fleetStateOf(state, principal);
  if (name === 'list_approvals') {
    const kind = typeof args.kind === 'string' && args.kind ? args.kind : undefined;
    if (kind && !APPROVAL_KINDS.includes(kind as ApprovalKind)) return { error: `kind must be one of ${APPROVAL_KINDS.join(', ')}` };
    return visibleApprovals(state, principal, state.approvals.list({ state: 'pending', ...(kind ? { kind: kind as ApprovalKind } : {}) }));
  }
  if (name === 'get_approval') {
    const a = typeof args.approvalId === 'string' ? state.approvals.get(args.approvalId) : undefined;
    return a ? visibleApprovals(state, principal, [a])[0] : { error: 'not_found' };
  }
  if (name === 'list_model_catalog') {
    return {
      offered: visibleModelsForPrincipal(state, principal),
      staged: state.modelStore?.listStaged() ?? [],
      default: defaultModelOf(state) ?? null,
    };
  }
  if (name === 'scan_vendor_models') {
    const vendorId = typeof args.vendorId === 'string' ? args.vendorId : undefined;
    if (!vendorId) return { error: 'vendorId is required' };
    const target = vendorTarget(state, vendorId);
    if ('error' in target) return target;
    try {
      const discovered = await discoverViaEgress(state, target);
      const staged = stageDiscovered(state, vendorId, discovered, actor);
      return { ok: true, count: staged.length, staged };
    } catch (err: unknown) {
      const e = err as { message?: string; status?: number };
      const code = e?.message === 'credential_unbound' ? 'credential_unbound' : e?.status === 503 ? 'discovery_unavailable' : 'discovery_failed';
      return { error: code, message: `Model discovery failed for vendor ${vendorId}` };
    }
  }
  if (name === 'admit_model') {
    let price: { inputPerMTok: number; outputPerMTok: number } | undefined;
    if (args.inputPerMTok !== undefined && args.outputPerMTok !== undefined) {
      const parsed = parseModelPriceInput({
        inputPerMTok: parseFloat(String(args.inputPerMTok)),
        outputPerMTok: parseFloat(String(args.outputPerMTok)),
      });
      if (!parsed.ok) return { error: 'invalid_price', message: parsed.error };
      price = parsed.price;
    }
    const out = admitModel(state, {
      name: typeof args.name === 'string' ? args.name : undefined,
      id: typeof args.id === 'string' ? args.id : undefined,
      vendorId: typeof args.vendorId === 'string' ? args.vendorId : undefined,
      provider: typeof args.provider === 'string' ? args.provider : undefined,
      region: typeof args.region === 'string' ? args.region : undefined,
      price,
    }, actor);
    return out.ok
      ? { ok: true, model: state.modelStore ? state.modelStore.enrich(out.model) : out.model }
      : { error: out.error, ...(out.message ? { message: out.message } : {}) };
  }
  if (name === 'update_model_pricing') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const parsed = parseModelPriceInput({
      inputPerMTok: parseFloat(String(args.inputPerMTok)),
      outputPerMTok: parseFloat(String(args.outputPerMTok)),
    });
    if (!parsed.ok) return { error: 'invalid_price', message: parsed.error };
    const price = parsed.price;
    try {
      const model = state.modelStore.updatePricing(String(args.name), price, actor);
      state.modelCatalog = state.modelStore.toEgressCatalog();
      state.ledger.append({
        action: 'MODEL_PRICING_UPDATED',
        actor,
        model: String(args.name),
        price,
        timestamp: new Date().toISOString(),
      });
      return { ok: true, model: state.modelStore.enrich(model) };
    } catch (err: unknown) {
      if (err instanceof ModelCatalogError) return { error: err.code, message: err.message };
      return { error: 'not_found', message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (name === 'retire_vendor_or_model') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const modelName = String(args.name);
    const out = await retireCatalogModel(state, modelName, actor);
    if (!out.retired) return { error: 'not_found' };
    return { ok: true, retired: modelName, affectedAgents: out.affectedAgents };
  }
  if (name === 'set_default_model') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const model = args.model;
    if (!model || typeof model !== 'string') return { error: 'model is required' };
    try {
      state.modelStore.setDefault(model, actor);
      state.defaultModel = model;
      state.ledger.append({
        action: 'MODEL_DEFAULT_UPDATED',
        actor,
        model,
        timestamp: new Date().toISOString(),
      });
      return { ok: true, default: model };
    } catch (err: unknown) {
      if (err instanceof ModelCatalogError) return { error: err.code, message: err.message };
      return { error: 'invalid_request', message: err instanceof Error ? err.message : String(err) };
    }
  }

  const id = typeof args.id === 'string' ? args.id : undefined;
  if (!id) return { error: 'id required' };
  if (name === 'get_agent_models') {
    const agent = state.agents.get(id);
    if (!agent) return { error: 'not_found' };
    const pol = state.policies.get(id);
    const eff = effectiveAgentModels(pol ?? {}, defaultModelOf(state));
    return {
      agentId: id,
      ...eff,
      models: enrichedCatalogModelsForNames(state, eff.approvedModels),
      defaultModel: defaultModelOf(state) ?? null,
    };
  }
  if (name === 'set_agent_models') {
    const out = await setAgentModels(
      state,
      id,
      {
        approvedModels: Array.isArray(args.approvedModels) ? (args.approvedModels as string[]) : undefined,
        currentModel: args.currentModel as string | null | undefined,
        primaryModel: args.primaryModel as string | null | undefined,
        secondaryModel: args.secondaryModel as string | null | undefined,
      },
      actor,
    );
    return out.body;
  }
  if (name === 'wake_agent') {
    const bad = badRunModel(args.model);
    if (bad) return { error: bad };
    const resolved = resolvePrincipalCaller(state, principal, id, 'agents.wake');
    if (!resolved.ok) return { error: resolved.error };
    const out = await createRun(state, id, {
      actor,
      trigger: 'mcp',
      ...(args.input !== undefined ? { input: args.input } : {}),
      ...(typeof args.model === 'string' ? { model: args.model } : {}),
    });
    attachCallerToRunResult(state, out, resolved.caller);
    return out.body;
  }
  if (name === 'pause_agent') return (await applyKillSwitch(state, id, 'PAUSE', actor)).body;
  if (name === 'resume_agent') return (await applyKillSwitch(state, id, 'RESUME', actor)).body;
  if (name === 'isolate_agent') return (await applyKillSwitch(state, id, 'ISOLATE', actor)).body;
  if (name === 'check_agent_update') {
    const agent = state.agents.get(id);
    if (!agent) return { error: 'not_found' };
    if (agent.createdFrom === 'configuration') return { error: 'configuration_agent' };
    const res = await checkAgentUpdate(agent, process.env.FACTORY_AGENT_SOURCE_TOKEN);
    Object.assign(agent, res);
    registryOf(state).save(agent);
    return res;
  }
  if (name === 'install_agent_update') {
    const agent = state.agents.get(id);
    if (!agent) return { error: 'not_found' };
    if (agent.createdFrom === 'configuration') return { error: 'configuration_agent' };
    const mode = (args.mode === 'restart_now' ? 'restart_now' : 'drain') as 'drain' | 'restart_now';
    const targetCommit = agent.offeredCommit ?? agent.commit;
    const targetVersion = agent.offeredVersion;
    if (!targetCommit) return { error: 'no_commit_available' };
    if (agent.state === 'WORKING' && mode === 'drain') {
      agent.stagedCommit = targetCommit;
      agent.stagedVersion = targetVersion;
      agent.pendingDrain = true;
      registryOf(state).save(agent);
      return { ok: true, status: 'staged_drain', agentId: id, commit: targetCommit, version: targetVersion };
    }
    agent.commit = targetCommit;
    agent.deployedCommit = targetCommit;
    if (targetVersion) agent.installedVersion = targetVersion;
    agent.updateAvailable = false;
    delete agent.pendingDrain;
    delete agent.stagedCommit;
    delete agent.stagedVersion;
    registryOf(state).save(agent);
    return { ok: true, status: 'applied', agentId: id, commit: targetCommit, version: targetVersion };
  }
  return { error: `unknown tool ${name}` };
}

export async function handleMcp(
  state: FactoryState,
  payload: Record<string, unknown>,
  principal: Principal,
): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  if (method === 'initialize') {
    const params = payload.params as { protocolVersion?: string } | undefined;
    const clientVer = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const negotiatedVersion = (clientVer && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVer))
      ? clientVer
      : '2025-11-25';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-factory', version: state.version },
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    const evalActor = principal.onBehalfOf ?? principal.actor;
    const grantRes = effectiveGrantsForActor(state, evalActor);
    if (!grantRes.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32003, message: grantRes.error } };
    }
    const evalRoles = principal.onBehalfOf
      ? rolesForSubjectActor(state, evalActor, grantRes.grants)
      : rolesForSubjectActor(state, evalActor, grantRes.grants, principal.roles);
    const evalPrincipal: Principal = {
      actor: evalActor,
      roles: evalRoles,
      ...(principal.keyScopes ? { keyScopes: principal.keyScopes } : {}),
    };
    const ownsAny = checkOwnsAnyAgent(state, evalActor);
    const ownsPersonal = checkOwnsPersonalAgent(state, evalActor);
    const canDelegateScoped = callerMayUseScopedGrantTools(state, evalPrincipal, grantRes.grants);
    const agentGrantList = grantRes.grants?.filter((eg) => eg.grant.scope.kind === 'agent') ?? [];

    const hasAgentScopes = Boolean(evalPrincipal.keyScopes?.agents && evalPrincipal.keyScopes.agents.length > 0);
    const scopedAgentIds = hasAgentScopes ? evalPrincipal.keyScopes!.agents! : [];

    const tools = TOOLS.filter((t) => {
      if (hasAgentScopes) {
        // Agent-scoped key: check if permitted fleet-wide (e.g. mcp.use tools whoami/authz_check)
        if (
          authorize({
            principal: evalPrincipal,
            privilege: t.privilege,
            resource: {
              ownsAnyAgent: ownsAny,
              ownsPersonalAgent: ownsPersonal,
              ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
            },
          }).allowed
        ) {
          return true;
        }
        // If not permitted fleet-wide, check if permitted on any of the key's scoped agent(s)
        if (AGENT_SCOPED.has(t.privilege)) {
          for (const aid of scopedAgentIds) {
            if (
              authorize({
                principal: evalPrincipal,
                privilege: t.privilege,
                resource: {
                  agentId: aid,
                  agentKind: agentKindOf(state, aid),
                  owners: ownersOf(state, aid),
                  grants: grantRes.grants,
                  ownsAnyAgent: ownsAny,
                  ownsPersonalAgent: ownsPersonal,
                },
              }).allowed
            ) {
              return true;
            }
          }
        }
        return false;
      }

      if (
        authorize({
          principal: evalPrincipal,
          privilege: t.privilege,
          resource: {
            ownsAnyAgent: ownsAny,
            ownsPersonalAgent: ownsPersonal,
            ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
          },
        }).allowed
      ) {
        return true;
      }
      if (t.scopedDelegation && canDelegateScoped) {
        return true;
      }
      if (AGENT_SCOPED.has(t.privilege)) {
        if (ownsAny) return true;
        for (const eg of agentGrantList) {
          if (eg.grant.scope.kind !== 'agent') continue;
          const aid = eg.grant.scope.id;
          if (
            authorize({
              principal: evalPrincipal,
              privilege: t.privilege,
              resource: {
                agentId: aid,
                agentKind: agentKindOf(state, aid),
                owners: ownersOf(state, aid),
                grants: grantRes.grants,
              },
            }).allowed
          ) {
            return true;
          }
        }
      }
      return false;
    }).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties: t.args, ...(t.required ? { required: t.required } : {}) },
      annotations: t.annotations,
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const grantRes = effectiveGrantsForActor(state, principal.actor);
    if (!grantRes.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32003, message: grantRes.error } };
    }
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (!params || typeof params.name !== 'string' || !params.name.trim()) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool name is required and must be a string' } };
    }
    const spec = TOOLS.find((t) => t.name === params.name);
    if (!spec) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    }
    const rawArgs = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};

    // CL6, GAP-248: actAs and onBehalfOf impersonation arguments are strictly forbidden over MCP
    if (rawArgs.actAs !== undefined || rawArgs.onBehalfOf !== undefined) {
      return redactMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'actAs and onBehalfOf impersonation arguments are forbidden over MCP (CL6, GAP-248)' }],
          structuredContent: { error: 'act_as_forbidden_over_mcp', message: 'actAs and onBehalfOf impersonation arguments are forbidden over MCP' },
          isError: true,
        },
      }, state.secretValues);
    }

    const effectivePrincipal = principal;

    const executeCall = async (): Promise<unknown> => {
      if (spec.scopedDelegation) {
        const sharedOut = await dispatchSharedRouteTool(state, spec.name, rawArgs, effectivePrincipal);
        if (sharedOut) return redactMcpResponse(formatOutcomeForMcp(id, sharedOut), state.secretValues);
      }

      const targetAgentId =
        typeof rawArgs.id === 'string'
          ? rawArgs.id
          : typeof rawArgs.agentId === 'string'
            ? rawArgs.agentId
            : undefined;
      const ownsAny =
        spec.privilege === 'mcp.use' || spec.privilege === 'models.read'
          ? checkOwnsAnyAgent(state, effectivePrincipal.onBehalfOf ?? effectivePrincipal.actor)
          : false;
      const ownsPersonal =
        spec.privilege === 'subscriptions.own'
          ? checkOwnsPersonalAgent(state, effectivePrincipal.onBehalfOf ?? effectivePrincipal.actor)
          : undefined;
      const resource =
        targetAgentId || grantRes.grants !== undefined || ownsAny || ownsPersonal !== undefined
          ? {
              ...(targetAgentId
                ? {
                    agentId: targetAgentId,
                    agentKind: agentKindOf(state, targetAgentId),
                    owners: ownersOf(state, targetAgentId),
                  }
                : {}),
              ownsAnyAgent: ownsAny,
              ...(ownsPersonal !== undefined ? { ownsPersonalAgent: ownsPersonal } : {}),
              ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
            }
          : undefined;
      const decision = authorize({ principal: effectivePrincipal, privilege: spec.privilege, resource });
      if (!decision.allowed) {
        const requiredRole = requiredRoleForPrivilege(spec.privilege, resource, decision.required);
        if (state.grants || state.principals) {
          state.ledger.append({
            timestamp: new Date().toISOString(),
            agentId: targetAgentId ?? 'control-plane',
            type: 'action',
            action: 'AUTHZ_DENIED',
            privilege: spec.privilege,
            scope: targetAgentId ? { kind: 'agent', id: targetAgentId } : { kind: 'fleet' },
            actor: effectivePrincipal.actor,
            ...(effectivePrincipal.onBehalfOf ? { onBehalfOf: effectivePrincipal.onBehalfOf } : {}),
            reason: `mcp:${spec.name}:requires:${requiredRole}`,
          });
        }
        const refusalText = `forbidden: requires ${decision.required}`;
        return redactMcpResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: refusalText }],
            structuredContent: { error: 'forbidden', required: decision.required, requiredRole },
            isError: true,
          },
        }, state.secretValues);
      }

      const sharedOut = await dispatchSharedRouteTool(state, spec.name, rawArgs, effectivePrincipal);
      if (sharedOut) {
        return redactMcpResponse(formatOutcomeForMcp(id, sharedOut), state.secretValues);
      }

      const legacyResult = await dispatchLegacyTool(state, spec.name, rawArgs, effectivePrincipal);
      const isErr = Boolean(legacyResult && typeof legacyResult === 'object' && ('error' in (legacyResult as Record<string, unknown>)));
      const text = typeof legacyResult === 'string' ? legacyResult : JSON.stringify(legacyResult);
      const structured = (legacyResult && typeof legacyResult === 'object') ? (legacyResult as Record<string, unknown>) : { value: legacyResult };
      return redactMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: structured,
          ...(isErr ? { isError: true } : {}),
        },
      }, state.secretValues);
    };

    if (effectivePrincipal.onBehalfOf) {
      return actAsStorage.run(
        { actor: effectivePrincipal.actor, onBehalfOf: effectivePrincipal.onBehalfOf },
        executeCall,
      );
    }
    return executeCall();
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}
