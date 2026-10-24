/**
 * Creating an agent from a configuration (DESIGN_AUTHORITY.md §6.18 CF6, RT1), and serving that configuration to the
 * run on the shared runtime that reads it.
 *
 *   POST /api/v1/agents                         create a new agent from a configuration (admin)
 *   GET  /api/v1/runs/:id/agent-config          the run's own agent's configuration (run token)
 *
 * A new agent has no repository and no cartridge: its pinned source is the pinned runtime version, its egress is nothing
 * until an admin grants it (E7), its roles may name only skills it has adopted, and it is owned by whoever created it.
 * Existing agents are untouched. The factory refuses to register a new agent id the old way (`registrationRefusal`).
 */
import http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { AGENT_ID, BUILTIN_AGENT_IDS, FULL_SHA, applySettingsChange, changedParts, registryOf, type AgentRecord } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { buildSkillsFor } from './apply.js';
import { changeReason, configOf, ledgerVersion, recordConfig } from './config-store.js';
import type { Run } from '@beercanlabs/factory-property-manager';

/** The runtime version the factory pins new agents to (RT1): its repository and commit, and the image that runs it. */
export type SharedRuntimePin = { repo: string; commit: string; image: string };

/** Why registering `agentId` from a repository is refused, or undefined when it is allowed (CF6). */
export function registrationRefusal(state: FactoryState, agentId: string): { error: string; message: string } | undefined {
  if (!state.newAgentsFromConfigurationOnly) return undefined;
  // An id the factory has registered and not purged keeps its repository flow: retired and reinstated agents, and every
  // agent running today. Ids the operator names as admitted from source (L2, FACTORY_REPOSITORY_AGENT_IDS) are exempt. A purged id is new.
  if (state.agents.has(agentId) || state.repositoryAgentIds?.has(agentId) || BUILTIN_AGENT_IDS.has(agentId)) return undefined;
  return {
    error: 'new_agents_use_configuration',
    message: `${agentId} is a new agent. New agents are created from a configuration, not registered from a repository: POST /api/v1/agents with { id, name, memory: { archetype }, soul, roles } (docs/CREATING_AGENTS.md). Agents that are already registered keep their repository.`,
  };
}

/** The run's own agent's configuration, for the shared runtime. Only an agent created from a configuration has one. */
export function agentConfigForRun(state: FactoryState, run: Run, res: http.ServerResponse): void {
  const agent = state.agents.get(run.agentId);
  const current = state.configs?.current(run.agentId);
  if (!agent || agent.createdFrom !== 'configuration' || !current?.agent) {
    json(res, 404, { error: 'no_agent_configuration' });
    return;
  }
  json(res, 200, {
    soul: current.agent.soul ?? '',
    memory: current.agent.memory ?? {},
    skills: current.skills,
    version: current.version,
    ...(agent.warmDownSeconds ? { warmDownSeconds: agent.warmDownSeconds } : {}),
  });
}

export async function handleAgentCreation(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/agents' || req.method !== 'POST') return false;
  const principal = await requirePrivilege(req, res, state, 'agents.create');
  if (!principal) return true;
  const body = (await readJson(req)) as Record<string, unknown>;
  const pin = state.sharedRuntime;
  if (!state.configs || !pin || !FULL_SHA.test(pin.commit) || !pin.image) return json(res, 503, { error: 'shared_runtime_not_configured', message: 'this factory has no pinned shared runtime (FACTORY_RUNTIME_IMAGE, FACTORY_RUNTIME_COMMIT)' }), true;

  const id = typeof body.id === 'string' ? body.id : '';
  if (!AGENT_ID.test(id) || id.startsWith('__')) return json(res, 400, { error: 'invalid_id', message: 'id must be 1 to 128 letters, digits, dot, dash or underscore, starting with a letter or digit' }), true;
  // The id is taken before anything is awaited, so two creations of one id cannot both succeed.
  if (state.agents.has(id) || BUILTIN_AGENT_IDS.has(id) || state.repositoryAgentIds?.has(id)) return json(res, 409, { error: 'agent_exists', message: `${id} already exists (or is reserved)` }), true;
  if (state.configs.current(id)) return json(res, 409, { error: 'configuration_exists', message: `a configuration for ${id} is still stored` }), true;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : id;
  const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim().slice(0, 120) : 'Agent';

  const settings = applySettingsChange(undefined, Object.fromEntries((['soul', 'roles', 'memory'] as const).filter((k) => body[k] !== undefined).map((k) => [k, body[k]])));
  if (!settings.ok) return json(res, 400, { error: 'invalid_settings', message: settings.error }), true;
  if (!settings.settings.memory?.archetype) return json(res, 422, { error: 'archetype_required', message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)' }), true;
  // No skills are adopted yet, so a role can name none (CF2): they are adopted afterwards, then named.
  for (const r of settings.settings.roles ?? []) {
    for (const skill of Object.keys(r.skills)) {
      if (skill !== '*') return json(res, 422, { error: 'unknown_skill', role: r.name, skill, message: `role "${r.name}" names skill "${skill}", which a new agent has not adopted` }), true;
    }
  }
  const model = typeof body.model === 'string' && body.model ? body.model : (state.defaultModel ?? 'gemini-2.0-flash');

  const record: AgentRecord = {
    id,
    name,
    role,
    // E7: no budget and no policy until an admin sets them; the global default is not copied to an agent that asked for nothing.
    state: 'PENDING_BUDGET',
    provider: 'cloud',
    artifact: pin.image,
    requires: [],
    ungated: [],
    gated: [],
    triggers: [],
    memoryPrefix: id,
    dir: '/tmp/' + id,
    model,
    requestedModels: [model],
    approvedModels: [model],
    repo: pin.repo,
    commit: pin.commit,
    createdFrom: 'configuration',
  };
  state.agents.set(id, record);
  try {
    const parts = changedParts(undefined, settings.settings);
    const { record: stored } = await state.configs.put(
      { ...configOf(state, id), skills: [], owners: [principal.actor.toLowerCase()], agent: settings.settings },
      { updatedBy: principal.actor, reason: 'created from a configuration' },
    );
    registryOf(state).save(record);
    ledgerVersion(state, stored, principal.actor);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: id,
      type: 'action',
      action: 'AGENT_CREATED_FROM_CONFIGURATION',
      actor: principal.actor,
      commit: pin.commit,
      requestId: `config:${id}:v${stored.version}`,
      payloadSha256: payloadHash({ parts, hash: stored.hash }),
    });
    json(res, 201, { ...record, owners: stored.owners ?? [], configurationVersion: stored.version });
  } catch (err) {
    state.agents.delete(id);
    console.error(`[control-plane] agent ${id} not created: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: 'agent_not_created' });
  }
  return true;
}

/**
 * Deploys an agent created from a configuration (CF6): there is no repository to build, so the agent's compute is
 * registered on the pinned shared runtime image and nothing else. The image is built only when the agent adopts skills
 * (SK4); that build belongs to the deployment's build service and is not provided yet, so an agent with adopted skills is
 * refused here rather than deployed without them.
 */
export async function deployConfigured(state: FactoryState, agent: AgentRecord, actor: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const dp = state.deployProvider;
  const pin = state.sharedRuntime;
  if (!state.policies.has(agent.id) || state.policies.get(agent.id).routes.length === 0) {
    return json(res, 409, { error: 'policy_required', message: 'Set the agent policy (PUT /api/v1/agents/:id/policy) with at least one route before deploying' });
  }
  if (!dp) return json(res, 501, { error: 'deploy_provider_not_configured', message: 'No deploy provider bound. Configure a DeployProvider for your target cloud.' });
  if (!pin) return json(res, 503, { error: 'shared_runtime_not_configured' });
  const built = buildSkillsFor(state, agent.id);
  if (!built.ok) return json(res, 409, { error: built.error, message: built.message });
  if (built.skills.length > 0) {
    return json(res, 409, { error: 'skills_image_not_supported', message: 'an agent created from a configuration that has adopted skills needs an image built with them (SK4); that build is not available yet' });
  }
  const previous = agent.state;
  agent.state = 'DEPLOYING';
  registryOf(state).save(agent);
  try {
    const { identity, executionIdentity } = await dp.provisionIdentity(agent.id, []);
    await dp.registerCompute(agent.id, pin.image, [], identity, executionIdentity, agent.memoryPrefix ?? agent.id);
    agent.artifact = pin.image;
    agent.deployedCommit = pin.commit;
    agent.deployedSkills = [];
    agent.state = 'SLEEPING';
    registryOf(state).save(agent);
    await recordConfig(state, agent.id, { actor, reason: changeReason(req, `deploy of runtime ${pin.commit}`) });
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, type: 'action', action: 'AGENT_DEPLOYED', actor, commit: pin.commit });
    json(res, 200, agent);
  } catch (err) {
    agent.state = previous;
    registryOf(state).save(agent);
    console.error(`[control-plane] deploy of ${agent.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, type: 'action', action: 'AGENT_DEPLOY_FAILED', actor, commit: pin.commit });
    json(res, 502, { error: 'deploy_failed' });
  }
}
