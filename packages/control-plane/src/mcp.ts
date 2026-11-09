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
  visibleModelsForPrincipal,
  type FactoryState,
} from './app.js';
import { ModelCatalogError } from './models.js';
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

type ToolSpec = {
  name: string;
  description: string;
  privilege: Privilege;
  scopedDelegation?: boolean;
  args: Record<string, { type: string; items?: { type: string } }>;
  required?: string[];
};

const TOOLS: ToolSpec[] = [
  {
    name: 'whoami',
    description: 'Return the verified caller principal, mapped emails, effective grants, and live privileges',
    privilege: 'mcp.use',
    args: { actAs: { type: 'string' } },
  },
  {
    name: 'authz_check',
    description: 'Side-effect-free authorization preflight check returning { allowed, requiredRole } without ledger denial noise',
    privilege: 'mcp.use',
    args: {
      privilege: { type: 'string' },
      agentId: { type: 'string' },
      skillId: { type: 'string' },
      actAs: { type: 'string' },
    },
    required: ['privilege'],
  },
  {
    name: 'list_principals',
    description: 'List canonical human principals and their mapped verified emails (or fetch one by id; admin only)',
    privilege: 'grants.manage',
    args: { id: { type: 'string' }, actAs: { type: 'string' } },
  },
  {
    name: 'create_principal',
    description: 'Pre-create a canonical user:<id> principal with 1..N globally unique lowercased emails (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      displayName: { type: 'string' },
      emails: { type: 'array', items: { type: 'string' } },
      actAs: { type: 'string' },
    },
    required: ['displayName', 'emails'],
  },
  {
    name: 'add_principal_email',
    description: 'Add a globally unique lowercased verified email alias to an existing principal (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      email: { type: 'string' },
      actAs: { type: 'string' },
    },
    required: ['id', 'email'],
  },
  {
    name: 'remove_principal_email',
    description: 'Remove an email alias from a principal while preserving at least one mapped email (admin only)',
    privilege: 'grants.manage',
    args: {
      id: { type: 'string' },
      email: { type: 'string' },
      actAs: { type: 'string' },
    },
    required: ['id', 'email'],
  },
  {
    name: 'list_grants',
    description: 'List grants (admin fleet-wide, or scoped content-owner / accountable-lead on their own agent or skill)',
    privilege: 'grants.manage',
    scopedDelegation: true,
    args: {
      subject: { type: 'string' },
      scopeKind: { type: 'string' },
      scopeId: { type: 'string' },
      includeExpired: { type: 'boolean' },
      actAs: { type: 'string' },
    },
  },
  {
    name: 'grant_role',
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
      actAs: { type: 'string' },
    },
    required: ['subject', 'scope', 'role'],
  },
  {
    name: 'revoke_grant',
    description: 'Revoke a grant by id subject to delegation ceilings and last-human-admin protection',
    privilege: 'grants.manage',
    scopedDelegation: true,
    args: {
      id: { type: 'string' },
      grantId: { type: 'string' },
      actAs: { type: 'string' },
    },
  },
  {
    name: 'revoke_all_access',
    description: 'Remove every grant and group membership of a principal and end its sign-in sessions and CLI login tokens (API keys stay) (confirm must equal its id); refused 409 for the last admin',
    privilege: 'grants.manage',
    args: { id: { type: 'string' }, confirm: { type: 'string' } },
    required: ['id', 'confirm'],
  },
  { name: 'list_agents', description: 'List factory cartridges', privilege: 'agents.read', args: {} },
  { name: 'query_ledger', description: 'Read the execution ledger', privilege: 'ledger.read', args: { agent: { type: 'string' } } },
  { name: 'get_run', description: 'Get a run by id', privilege: 'runs.read', args: { runId: { type: 'string' } }, required: ['runId'] },
  {
    name: 'wake_agent',
    description: 'Start a run (202 semantics: returns the queued/started run). Optional model pins the run; optional input is passed to it, the same as POST /api/v1/agents/:id/runs.',
    privilege: 'agents.wake',
    args: { id: { type: 'string' }, model: { type: 'string' }, input: { type: 'object' } },
    required: ['id'],
  },
  { name: 'pause_agent', description: 'Pause agent egress', privilege: 'agents.pause', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'resume_agent', description: 'Resume agent egress', privilege: 'agents.resume', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'isolate_agent', description: 'Isolate agent egress', privilege: 'agents.isolate', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'list_approvals', description: 'List pending tool-call approvals', privilege: 'approvals.read', args: {} },
  {
    name: 'decide_approval',
    description: 'Approve or reject a held tool call',
    privilege: 'approvals.decide',
    args: { approvalId: { type: 'string' }, decision: { type: 'string' }, notes: { type: 'string' } },
    required: ['approvalId', 'decision'],
  },
  {
    name: 'check_agent_update',
    description: 'Check for available cartridge updates from git repository',
    privilege: 'agents.update.read',
    args: { id: { type: 'string' } },
    required: ['id'],
  },
  {
    name: 'install_agent_update',
    description: 'Install an available cartridge update (mode: drain or restart_now)',
    privilege: 'agents.update.install',
    args: { id: { type: 'string' }, mode: { type: 'string' } },
    required: ['id'],
  },
  {
    name: 'list_model_catalog',
    description: 'List offered and staged models in the factory',
    privilege: 'models.read',
    args: {},
  },
  {
    name: 'scan_vendor_models',
    description: 'Scan an AI vendor endpoint to discover available models',
    privilege: 'models.manage',
    args: { vendorId: { type: 'string' } },
    required: ['vendorId'],
  },
  {
    name: 'admit_model',
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
  },
  {
    name: 'update_model_pricing',
    description: 'Update token pricing per million tokens for an admitted model',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
      inputPerMTok: { type: 'string' },
      outputPerMTok: { type: 'string' },
    },
    required: ['name', 'inputPerMTok', 'outputPerMTok'],
  },
  {
    name: 'retire_vendor_or_model',
    description: 'Retire an admitted model from the factory offering',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
    },
    required: ['name'],
  },
  {
    name: 'set_default_model',
    description: 'Set the factory default model granted to agents whose policy specifies no models (requires models.manage)',
    privilege: 'models.manage',
    args: {
      model: { type: 'string' },
    },
    required: ['model'],
  },
  {
    name: 'get_agent_models',
    description: 'Get the effective and configured model slots and approved models for an agent',
    privilege: 'agents.models.read',
    args: { id: { type: 'string' } },
    required: ['id'],
  },
  {
    name: 'set_agent_models',
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
  },
];

function formatOutcomeForMcp(id: unknown, out: RouteOutcome): unknown {
  if (out.status === 403) {
    const reqRole = String(out.body.requiredRole ?? out.body.required ?? 'admin');
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32001,
        message: `forbidden: requires ${reqRole}`,
        data: out.body,
      },
    };
  }
  if (out.status === 503) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32003,
        message: String(out.body.error ?? 'store_unavailable'),
        data: out.body,
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(out.body) }],
      ...(out.status >= 400 ? { isError: true } : {}),
    },
  };
}

async function dispatchSharedRouteTool(
  state: FactoryState,
  name: string,
  args: Record<string, unknown>,
  principal: Principal,
): Promise<RouteOutcome | null> {
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
  if (name === 'list_approvals') return visibleApprovals(state, principal, state.approvals.list({ state: 'pending' }));
  if (name === 'decide_approval') return (await decideApproval(state, String(args.approvalId), String(args.decision), principal, typeof args.notes === 'string' ? args.notes : undefined)).body;
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
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
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
    const evalPrincipal: Principal = { actor: evalActor, roles: evalRoles };
    const ownsAny = checkOwnsAnyAgent(state, evalActor);
    const ownsPersonal = checkOwnsPersonalAgent(state, evalActor);
    const canDelegateScoped = callerMayUseScopedGrantTools(state, evalPrincipal, grantRes.grants);
    const agentGrantList = grantRes.grants?.filter((eg) => eg.grant.scope.kind === 'agent') ?? [];

    const tools = TOOLS.filter((t) => {
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
      description: t.description,
      inputSchema: { type: 'object', properties: t.args, ...(t.required ? { required: t.required } : {}) },
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const grantRes = effectiveGrantsForActor(state, principal.actor);
    if (!grantRes.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32003, message: grantRes.error } };
    }
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const spec = TOOLS.find((t) => t.name === params.name);
    if (!spec) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    }
    const rawArgs = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};

    let effectivePrincipal = principal;
    const rawActAs = rawArgs.actAs !== undefined ? rawArgs.actAs : rawArgs.onBehalfOf;
    if (rawActAs !== undefined && rawActAs !== null) {
      const resolvedActAs = resolveActAsForPrincipal(state, principal, rawActAs);
      if (!resolvedActAs.ok) {
        if (resolvedActAs.status === 403) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32001,
              message: 'forbidden: requires admin',
              data: resolvedActAs.body,
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: resolvedActAs.status === 503 ? -32003 : -32602,
            message: String(resolvedActAs.body.message ?? resolvedActAs.body.error ?? 'invalid actAs'),
            data: resolvedActAs.body,
          },
        };
      }
      if (principal.onBehalfOf && principal.onBehalfOf !== resolvedActAs.onBehalfOf) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'tool actAs argument conflicts with X-Factory-Act-As header',
          },
        };
      }
      effectivePrincipal = { ...principal, onBehalfOf: resolvedActAs.onBehalfOf };
    }

    const executeCall = async (): Promise<unknown> => {
      if (spec.scopedDelegation) {
        const sharedOut = await dispatchSharedRouteTool(state, spec.name, rawArgs, effectivePrincipal);
        if (sharedOut) return formatOutcomeForMcp(id, sharedOut);
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
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: `forbidden: requires ${decision.required}`,
            data: { error: 'forbidden', required: decision.required, requiredRole },
          },
        };
      }

      const sharedOut = await dispatchSharedRouteTool(state, spec.name, rawArgs, effectivePrincipal);
      if (sharedOut) {
        return formatOutcomeForMcp(id, sharedOut);
      }

      const legacyResult = await dispatchLegacyTool(state, spec.name, rawArgs, effectivePrincipal);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(legacyResult) }] },
      };
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
