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
import { AGENT_ID, BUILTIN_AGENT_IDS, FULL_SHA, applySettingsChange, beginAdmission, changedParts, registryOf, loadSharedRuntime, saveSharedRuntime, visibilityOf, ownerOf, type SharedRuntimePin, type AgentRecord } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { applyConfig, buildSkillsFor, runDeploy } from './apply.js';
import { changeReason, configOf, ledgerVersion, ownersOf, recordConfig, removeConfig } from './config-store.js';
import { SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, type BuildSkill, type Run } from '@beercanlabs/factory-property-manager';
import { runActivationSmoke } from './smoke.js';
import { skillRegistry } from './skills.js';

export { loadSharedRuntime, saveSharedRuntime, type SharedRuntimePin };

/** Why registering `agentId` from a repository is refused, or undefined when it is allowed (CF6). */
export function registrationRefusal(state: FactoryState, agentId: string): { status: number; error: string; message: string } | undefined {
  // An agent created from a configuration has no repository to re-register from, whatever the rule says about new ids.
  if (state.agents.get(agentId)?.createdFrom === 'configuration') {
    return { status: 409, error: 'configuration_agent', message: `${agentId} was created from a configuration and has no repository; change it with PUT /api/v1/agents/${agentId}/settings` };
  }
  if (!state.newAgentsFromConfigurationOnly) return undefined;
  // An id the factory has registered and not purged keeps its repository flow: retired and reinstated agents, and every
  // agent running today. Ids the operator names as admitted from source (L2, FACTORY_REPOSITORY_AGENT_IDS) are exempt. A purged id is new.
  if (state.agents.has(agentId) || state.repositoryAgentIds?.has(agentId) || BUILTIN_AGENT_IDS.has(agentId)) return undefined;
  return {
    status: 422,
    error: 'new_agents_use_configuration',
    message: `${agentId} is a new agent. New agents are created from a configuration, not registered from a repository: POST /api/v1/agents with { id, name, memory: { archetype }, soul, roles } (docs/CREATING_AGENTS.md). Agents that are already registered keep their repository.`,
  };
}

/** The run's own agent's configuration, for the shared runtime. Only an agent created from a configuration has one. */
export function agentConfigForRun(state: FactoryState, run: Run, res: http.ServerResponse): void {
  const agent = state.agents.get(run.agentId);
  const current = (agent as any)?.pendingConfig ?? state.configs?.current(run.agentId);
  if (!agent || agent.createdFrom !== 'configuration' || !current?.agent) {
    json(res, 404, { error: 'no_agent_configuration' });
    return;
  }
  json(res, 200, {
    soul: current.agent.soul ?? '',
    memory: current.agent.memory ?? {},
    skills: current.skills ?? [],
    version: current.version ?? 1,
    ...(agent.warmDownSeconds ? { warmDownSeconds: agent.warmDownSeconds } : {}),
  });
}

/** Nothing of a failed creation is left behind: neither the agent, its registry file nor its configuration, so the id can be tried again. */
export async function discardCreated(state: FactoryState, id: string, actor: string, reason: string): Promise<void> {
  state.agents.delete(id);
  try {
    registryOf(state).remove(id);
  } catch {
    // the record may not have been written
  }
  await removeConfig(state, id, { actor, reason }).catch(() => undefined);
}

export type NewConfiguredAgent = {
  id: unknown;
  name?: unknown;
  role?: unknown;
  model?: unknown;
  soul?: unknown;
  roles?: unknown;
  memory?: unknown;
  /** Skill ids a role may name although the agent has not adopted them yet: an import's skills are adopted afterwards, by an admin (CF3, CF5). */
  rolesMayNameSkills?: ReadonlySet<string>;
  reason?: string;
};
export type Created = { status: number; body: Record<string, unknown>; record?: AgentRecord };

/** Creates an agent from a configuration (CF6): the one place that does it, for `POST /agents` and for an import (CF3). */
export async function createFromConfiguration(state: FactoryState, principal: { actor: string }, spec: NewConfiguredAgent): Promise<Created> {
  const pin = state.sharedRuntime;
  if (!state.configs || !pin || !FULL_SHA.test(pin.commit) || !pin.image) return { status: 503, body: { error: 'shared_runtime_not_configured', message: 'this factory has no pinned shared runtime (FACTORY_RUNTIME_IMAGE, FACTORY_RUNTIME_COMMIT)' } };

  const id = typeof spec.id === 'string' ? spec.id : '';
  if (!AGENT_ID.test(id) || id.startsWith('__')) return { status: 400, body: { error: 'invalid_id', message: 'id must be 1 to 128 letters, digits, dot, dash or underscore, starting with a letter or digit' } };
  // The id is taken before anything is awaited, so two creations of one id cannot both succeed.
  if (state.agents.has(id) || BUILTIN_AGENT_IDS.has(id) || state.repositoryAgentIds?.has(id)) return { status: 409, body: { error: 'agent_exists', message: `${id} already exists (or is reserved)` } };
  if (state.configs.current(id)) return { status: 409, body: { error: 'configuration_exists', message: `a configuration for ${id} is still stored` } };
  const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim().slice(0, 120) : id;
  const role = typeof spec.role === 'string' && spec.role.trim() ? spec.role.trim().slice(0, 120) : 'Agent';

  const given: Record<string, unknown> = { soul: spec.soul, roles: spec.roles, memory: spec.memory };
  const settings = applySettingsChange(undefined, Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)));
  if (!settings.ok) return { status: 400, body: { error: 'invalid_settings', message: settings.error } };
  if (!settings.settings.memory?.archetype) return { status: 422, body: { error: 'archetype_required', message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)' } };
  // No skills are adopted yet, so a role can name none (CF2): they are adopted afterwards, then named.
  for (const r of settings.settings.roles ?? []) {
    for (const skill of Object.keys(r.skills)) {
      if (skill !== '*' && !spec.rolesMayNameSkills?.has(skill)) return { status: 422, body: { error: 'unknown_skill', role: r.name, skill, message: `role "${r.name}" names skill "${skill}", which a new agent has not adopted` } };
    }
  }
  const model = typeof spec.model === 'string' && spec.model ? spec.model : (state.defaultModel ?? 'gemini-2.0-flash');

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
      { updatedBy: principal.actor, reason: spec.reason ?? 'created from a configuration' },
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
    return { status: 201, body: { ...record, owners: stored.owners ?? [], configurationVersion: stored.version }, record };
  } catch (err) {
    await discardCreated(state, id, principal.actor, 'creation failed');
    console.error(`[control-plane] agent ${id} not created: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 500, body: { error: 'agent_not_created' } };
  }
}

export async function handleAgentCreation(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/agents' || req.method !== 'POST') return false;
  const principal = await requirePrivilege(req, res, state, 'agents.create');
  if (!principal) return true;
  const body = (await readJson(req)) as Record<string, unknown>;
  const out = await createFromConfiguration(state, principal, { id: body.id, name: body.name, role: body.role, model: body.model, soul: body.soul, roles: body.roles, memory: body.memory });
  json(res, out.status, out.body);
  return true;
}

/**
 * Deploys an agent created from a configuration (CF6): there is no repository to build, so the agent's compute is
 * registered on the pinned shared runtime image and nothing else. The image is built only when the agent adopts skills
 * (SK4, TSK-272): the provider layers the approved skills on the runtime image, and the deploy then runs in the background
 * as a repository agent's does. A provider that cannot build it refuses here, rather than deploy the agent without them.
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
    // SK4, TSK-272: the runtime image with the skills layered on, built by the provider; slow, so it runs after the answer
    // as a repository agent's deploy does. A provider that cannot build it refuses, rather than deploy without the skills.
    if (!dp.buildSkillsImage) {
      return json(res, 409, { error: 'skills_image_not_supported', message: 'this deployment cannot build an image with an agent\'s adopted skills on the shared runtime (SK4)' });
    }
    const previousState = agent.state;
    const source = { repo: pin.repo, commit: pin.commit };
    agent.state = 'DEPLOYING';
    agent.admission = beginAdmission(pin.commit);
    registryOf(state).save(agent);
    await recordConfig(state, agent.id, { actor, reason: changeReason(req, `deploy of runtime ${pin.commit} with ${built.skills.length} skill(s)`) });
    json(res, 202, agent);
    void runDeploy(state, { agent, actor, source, skills: built.skills, previousState, isApply: false });
    return;
  }
  const previous = agent.state;
  const prevArtifact = agent.artifact;
  const prevDeployedCommit = agent.deployedCommit;
  const prevDeployedSkills = agent.deployedSkills ? [...agent.deployedSkills] : undefined;
  const prevDeployedRuntime = agent.deployedRuntime ? { ...agent.deployedRuntime } : undefined;
  const prevRepo = agent.repo;
  const prevCommit = agent.commit;
  const prevLaunchEnv = prevDeployedSkills?.length ? { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH } : undefined;
  agent.state = 'DEPLOYING';
  registryOf(state).save(agent);
  try {
    const { identity, executionIdentity } = await dp.provisionIdentity(agent.id, []);
    await dp.registerCompute(agent.id, pin.image, [], identity, executionIdentity, agent.memoryPrefix ?? agent.id);
    agent.artifact = pin.image;
    agent.deployedCommit = pin.commit;
    agent.deployedSkills = [];
    agent.deployedRuntime = { repo: pin.repo, commit: pin.commit, image: pin.image };

    // Activation smoke gate (L4, TSK-281)
    const smokeRes = await runActivationSmoke(state, agent, [], pin.commit, actor);
    if (!smokeRes.ok) {
      console.error(`[control-plane] Activation smoke failed for configured ${agent.id}@${pin.commit}: ${smokeRes.error}`);
      if (prevDeployedCommit && prevArtifact) {
        try {
          await dp.registerCompute(agent.id, prevArtifact, [], identity, executionIdentity, agent.memoryPrefix ?? agent.id, prevLaunchEnv);
        } catch (rbErr) {
          console.error(`[control-plane] Rollback registerCompute failed for ${agent.id}:`, rbErr);
        }
        agent.artifact = prevArtifact;
        agent.deployedCommit = prevDeployedCommit;
        agent.deployedSkills = prevDeployedSkills;
        agent.deployedRuntime = prevDeployedRuntime;
        agent.repo = prevRepo;
        agent.commit = prevCommit;
        agent.state = previous;
      } else {
        agent.artifact = '';
        delete agent.deployedCommit;
        delete agent.deployedSkills;
        delete agent.deployedRuntime;
        agent.state = 'ERROR';
      }
      registryOf(state).save(agent);
      return json(res, 502, { error: 'smoke_failed', message: smokeRes.error });
    }

    agent.state = 'SLEEPING';
    agent.repo = pin.repo;
    agent.commit = pin.commit;
    agent.deployedCommit = pin.commit;
    agent.deployedRuntime = { repo: pin.repo, commit: pin.commit, image: pin.image };
    registryOf(state).save(agent);
    await recordConfig(state, agent.id, { actor, reason: changeReason(req, `deploy of runtime ${pin.commit}`) });
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, type: 'action', action: 'AGENT_DEPLOYED', actor, commit: pin.commit });
    json(res, 200, { ...agent, smoke: smokeRes });
  } catch (err) {
    agent.state = previous;
    registryOf(state).save(agent);
    console.error(`[control-plane] deploy of ${agent.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, type: 'action', action: 'AGENT_DEPLOY_FAILED', actor, commit: pin.commit });
    json(res, 502, { error: 'deploy_failed' });
  }
}

/**
 * Admin-approved runtime rollout and runtime census (RT1, GAP-206, TSK-280):
 *   GET /api/v1/runtime               current runtime pin and configuration agents status (agents.read)
 *   PUT /api/v1/runtime               set pinned runtime and roll out to configuration agents (runtime.set)
 */
export async function handleRuntimeRoutes(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/runtime') return false;

  if (req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'agents.read');
    if (!principal) return true;

    const agents = [];
    for (const a of state.agents.values()) {
      if (a.createdFrom === 'configuration' && a.state !== 'RETIRED_PENDING_PURGE' && a.state !== 'PURGED') {
        const deployedRuntime = a.deployedRuntime ?? (a.deployedCommit ? { repo: a.repo ?? '', commit: a.deployedCommit, image: a.artifact } : null);
        const upToDate = Boolean(
          state.sharedRuntime &&
          deployedRuntime &&
          deployedRuntime.repo === state.sharedRuntime.repo &&
          deployedRuntime.commit === state.sharedRuntime.commit &&
          deployedRuntime.image === state.sharedRuntime.image
        );
        agents.push({
          id: a.id,
          name: a.name,
          state: a.state,
          deployedRuntime,
          upToDate,
        });
      }
    }
    agents.sort((a, b) => a.id.localeCompare(b.id));

    json(res, 200, { ok: true, runtime: state.sharedRuntime ?? null, agents });
    return true;
  }

  if (req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'runtime.set');
    if (!principal) return true;

    const body = (await readJson(req)) as Record<string, unknown>;
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    const commit = typeof body.commit === 'string' ? body.commit.trim() : '';
    const image = typeof body.image === 'string' ? body.image.trim() : '';

    if (!repo) {
      json(res, 400, { error: 'invalid_runtime', message: 'repo is required' });
      return true;
    }
    if (!FULL_SHA.test(commit)) {
      json(res, 400, { error: 'invalid_runtime', message: 'commit must be a 40-character hex sha' });
      return true;
    }
    if (!/^[^\s]+@sha256:[0-9a-f]{64}$/i.test(image)) {
      json(res, 400, { error: 'invalid_runtime', message: 'image must be pinned by sha256 digest (image@sha256:...)' });
      return true;
    }

    const nextPin: SharedRuntimePin = {
      repo,
      commit,
      image,
      updatedAt: new Date().toISOString(),
      updatedBy: principal.actor,
    };

    state.sharedRuntime = nextPin;
    saveSharedRuntime(state.registryDir, nextPin);

    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'factory',
      type: 'action',
      action: 'RUNTIME_VERSION_SET',
      actor: principal.actor,
      commit: nextPin.commit,
      payloadSha256: payloadHash({ repo: nextPin.repo, commit: nextPin.commit, image: nextPin.image }),
    });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'factory',
      type: 'action',
      action: 'SHARED_RUNTIME_UPDATED',
      actor: principal.actor,
      commit: nextPin.commit,
    });

    const dones: Promise<void>[] = [];
    for (const a of state.agents.values()) {
      if (a.createdFrom === 'configuration' && a.state !== 'RETIRED_PENDING_PURGE' && a.state !== 'PURGED') {
        if (!a.deployedCommit) {
          a.repo = nextPin.repo;
          a.commit = nextPin.commit;
          registryOf(state).save(a);
          if (state.configs?.current(a.id)) {
            await recordConfig(state, a.id, { actor: principal.actor, reason: 'runtime-upgrade' });
          }
        } else {
          const out = applyConfig(state, a.id, principal.actor, 'runtime-upgrade');
          if (out.status === 'started') {
            dones.push(out.done);
          }
        }
      }
    }

    await Promise.allSettled(dones);

    for (const a of state.agents.values()) {
      if (a.createdFrom === 'configuration' && a.deployedCommit && a.deployedRuntime?.commit === nextPin.commit) {
        if (state.configs?.current(a.id)?.source?.commit !== nextPin.commit) {
          await recordConfig(state, a.id, { actor: principal.actor, reason: 'runtime-upgrade' });
        }
      }
    }

    const agents = [];
    for (const a of state.agents.values()) {
      if (a.createdFrom === 'configuration' && a.state !== 'RETIRED_PENDING_PURGE' && a.state !== 'PURGED') {
        const deployedRuntime = a.deployedRuntime ?? (a.deployedCommit ? { repo: a.repo ?? '', commit: a.deployedCommit, image: a.artifact } : null);
        const upToDate = Boolean(
          state.sharedRuntime &&
          deployedRuntime &&
          deployedRuntime.repo === state.sharedRuntime.repo &&
          deployedRuntime.commit === state.sharedRuntime.commit &&
          deployedRuntime.image === state.sharedRuntime.image
        );
        agents.push({
          id: a.id,
          name: a.name,
          state: a.state,
          deployedRuntime,
          upToDate,
        });
      }
    }
    agents.sort((a, b) => a.id.localeCompare(b.id));

    const results = agents.map((a) => ({
      id: a.id,
      status: a.upToDate ? 'updated' : 'smoke_failed',
    }));

    json(res, 200, { ok: true, runtime: state.sharedRuntime, pin: state.sharedRuntime, agents, results });
    return true;
  }

  json(res, 405, { error: 'method_not_allowed' });
  return true;
}

/**
 * Convert an existing repository agent to a configuration agent in place (CF6, TSK-283, GAP-209; decision 5):
 *   POST /api/v1/agents/:id/convert (agents.settings.set; admin or agent-owner)
 */
export async function handleConvertAgent(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const match = path.match(/^\/api\/v1\/agents\/([^/]+)\/convert$/);
  if (!match) return false;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  const agentId = decodeURIComponent(match[1]);
  const principal = await requirePrivilege(req, res, state, 'agents.settings.set', { agentId });
  if (!principal) return true;

  const agent = state.agents.get(agentId);
  if (!agent) {
    json(res, 404, { error: 'agent_not_found', message: `agent ${agentId} not found` });
    return true;
  }
  if (agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id)) {
    json(res, 400, { error: 'builtin_agent', message: 'built-in system agents cannot be converted' });
    return true;
  }
  if (agent.state === 'RETIRED_PENDING_PURGE' || agent.state === 'PURGED') {
    json(res, 409, { error: 'invalid_state', message: 'cannot convert a retired or purged agent' });
    return true;
  }
  if (agent.createdFrom === 'configuration') {
    json(res, 409, { error: 'already_configuration_agent', message: `${agentId} is already a configuration-mode agent` });
    return true;
  }
  if (!state.configs) {
    json(res, 503, { error: 'config_store_unavailable', message: 'configuration store is unavailable' });
    return true;
  }
  const pin = state.sharedRuntime;
  if (!pin || !FULL_SHA.test(pin.commit) || !pin.image) {
    json(res, 503, { error: 'shared_runtime_not_configured', message: 'this factory has no pinned shared runtime (FACTORY_RUNTIME_IMAGE, FACTORY_RUNTIME_COMMIT)' });
    return true;
  }
  const dp = state.deployProvider;
  if (!dp) {
    json(res, 501, { error: 'deploy_provider_not_configured', message: 'No deploy provider bound. Configure a DeployProvider for your target cloud.' });
    return true;
  }
  if (!state.policies.has(agentId) || state.policies.get(agentId).routes.length === 0) {
    json(res, 409, { error: 'policy_required', message: 'agent policy with at least one route is required' });
    return true;
  }

  const body = (await readJson(req)) as Record<string, unknown>;
  const rawRoles = body.roles;
  const normalizedRoles =
    rawRoles === undefined
      ? undefined
      : Array.isArray(rawRoles)
      ? rawRoles
      : typeof rawRoles === 'object' && rawRoles !== null
      ? Object.entries(rawRoles).map(([name, val]: [string, any]) => ({
          name,
          ...(val && typeof val === 'object' ? val : {}),
          skills: val?.skills ?? (val && !val.skills ? val : {}),
        }))
      : rawRoles;
  const given: Record<string, unknown> = {
    ...(body.soul !== undefined ? { soul: body.soul } : {}),
    ...(normalizedRoles !== undefined ? { roles: normalizedRoles } : {}),
    ...(body.memory !== undefined ? { memory: body.memory } : {}),
  };
  const settings = applySettingsChange(undefined, given);
  if (!settings.ok) {
    json(res, 400, { error: 'invalid_settings', message: settings.error });
    return true;
  }
  if (!settings.settings.memory?.archetype) {
    json(res, 422, { error: 'archetype_required', message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)' });
    return true;
  }

  // Validate skills
  const rawSkills = body.skills !== undefined ? body.skills : [];
  if (!Array.isArray(rawSkills)) {
    json(res, 400, { error: 'invalid_skills', message: 'skills must be an array' });
    return true;
  }
  const validatedSkills: Array<{ id: string; version: string }> = [];
  const registry = skillRegistry(state);
  const agentOwners = ownersOf(state, agentId);

  for (const s of rawSkills) {
    if (!s || typeof s !== 'object' || typeof (s as any).id !== 'string' || typeof (s as any).version !== 'string') {
      json(res, 400, { error: 'invalid_skills', message: 'each skill must have id and version strings' });
      return true;
    }
    const skillItem = s as { id: string; version: string };
    const rec = registry.get(skillItem.id, skillItem.version);
    if (!rec || rec.status !== 'approved' || rec.retired) {
      const why = !rec ? 'is not registered' : rec.retired ? 'is retired' : `is ${rec.status}`;
      json(res, 409, {
        error: 'skill_unavailable',
        message: `skill ${skillItem.id}@${skillItem.version} ${why}; must be approved and unretired`,
      });
      return true;
    }
    if (visibilityOf(rec) === 'private' && ownerOf(rec) !== agentId && (rec as any).ownerAgent !== agentId) {
      let groupMatches = false;
      if (rec.groupId && state.groups) {
        const userGroups = [principal.actor, ...agentOwners].flatMap((u) => (state.groups!.getUserRoles(u).length > 0 ? state.groups!.listUserGroups(u).map((g) => g.id) : []));
        if (userGroups.some((g) => g.toLowerCase() === rec.groupId!.toLowerCase())) groupMatches = true;
      }
      const ownerMatches = rec.owner && [principal.actor, ...agentOwners].some((u) => u.toLowerCase() === rec.owner!.toLowerCase());
      if (!groupMatches && !ownerMatches) {
        json(res, 403, {
          error: 'skill_private',
          message: `skill ${skillItem.id} is private to another agent or group`,
        });
        return true;
      }
    }
    validatedSkills.push({ id: skillItem.id, version: skillItem.version });
  }

  if (validatedSkills.length > 0 && !dp.buildSkillsImage) {
    json(res, 409, {
      error: 'skills_image_not_supported',
      message: "this deployment cannot build an image with an agent's adopted skills on the shared runtime (SK4)",
    });
    return true;
  }

  // Validate role skill references (CF2)
  const adoptedSkillIds = new Set(validatedSkills.map((s) => s.id));
  for (const r of settings.settings.roles ?? []) {
    for (const skill of Object.keys(r.skills)) {
      if (skill !== '*' && !adoptedSkillIds.has(skill)) {
        json(res, 422, {
          error: 'unknown_skill',
          role: r.name,
          skill,
          message: `role "${r.name}" names skill "${skill}", which is not in the adopted skills list (CF2)`,
        });
        return true;
      }
    }
  }

  // Reach coverage check (Decision 5)
  const repoRoutes = new Set<string>([
    ...(agent.egress?.routes ?? []),
    ...Object.values(agent.skillRoutes ?? {}).flat(),
    ...(state.policies.get(agentId)?.routes ?? []),
  ]);
  const coveredRoutes = new Set<string>(['models', 'discord']);
  for (const s of validatedSkills) {
    const rec = registry.get(s.id, s.version);
    for (const r of rec?.manifest?.requires?.routes ?? []) coveredRoutes.add(r);
  }
  const uncovered = [...repoRoutes].filter((r) => !coveredRoutes.has(r));
  if (uncovered.length > 0 && body.dropUncoveredRoutes !== true) {
    json(res, 422, {
      error: 'uncovered_routes',
      uncovered,
      message: `target skills do not cover repository routes: ${uncovered.join(', ')}; adopt skills covering these routes or pass dropUncoveredRoutes: true`,
    });
    return true;
  }

  // Pre-conversion snapshot
  const prevCreatedFrom = agent.createdFrom;
  const prevRepo = agent.repo;
  const prevCommit = agent.commit;
  const prevModel = agent.model;
  const prevDeployedCommit = agent.deployedCommit;
  const prevDeployedSkills = agent.deployedSkills ? [...agent.deployedSkills] : undefined;
  const prevDeployedRuntime = agent.deployedRuntime ? { ...agent.deployedRuntime } : undefined;
  const prevArtifact = agent.artifact;
  const prevState = agent.state;
  const prevRoles = agent.roles ? structuredClone(agent.roles) : undefined;
  const prevSkillIds = agent.skillIds ? [...agent.skillIds] : undefined;
  const prevSkillRoutes = agent.skillRoutes ? structuredClone(agent.skillRoutes) : undefined;
  const prevAdmission = agent.admission ? structuredClone(agent.admission) : undefined;
  const prevPolicy = state.policies.get(agentId) ? structuredClone(state.policies.get(agentId)!) : undefined;

  const restoreAgent = () => {
    delete (agent as any).pendingConfig;
    if (prevCreatedFrom === undefined) delete agent.createdFrom; else agent.createdFrom = prevCreatedFrom;
    agent.repo = prevRepo;
    agent.commit = prevCommit;
    if (prevModel === undefined) delete agent.model; else agent.model = prevModel;
    if (prevDeployedCommit === undefined) delete agent.deployedCommit; else agent.deployedCommit = prevDeployedCommit;
    if (prevDeployedSkills === undefined) delete agent.deployedSkills; else agent.deployedSkills = prevDeployedSkills;
    if (prevDeployedRuntime === undefined) delete agent.deployedRuntime; else agent.deployedRuntime = prevDeployedRuntime;
    agent.artifact = prevArtifact;
    agent.state = prevState;
    if (prevRoles === undefined) delete agent.roles; else agent.roles = prevRoles;
    if (prevSkillIds === undefined) delete agent.skillIds; else agent.skillIds = prevSkillIds;
    if (prevSkillRoutes === undefined) delete agent.skillRoutes; else agent.skillRoutes = prevSkillRoutes;
    if (prevAdmission === undefined) delete agent.admission; else agent.admission = prevAdmission;
    if (prevPolicy) state.policies.set(agentId, prevPolicy);
    registryOf(state).save(agent);
  };

  if (body.dropUncoveredRoutes === true && uncovered.length > 0) {
    const uncoveredSet = new Set(uncovered);
    const existingPolicy = state.policies.get(agentId);
    if (existingPolicy) {
      state.policies.set(agentId, {
        ...existingPolicy,
        routes: existingPolicy.routes.filter((r) => !uncoveredSet.has(r)),
      });
    }
  }

  try {
    agent.createdFrom = 'configuration';
    agent.repo = pin.repo;
    agent.commit = pin.commit;
    if (typeof body.model === 'string' && body.model.trim()) {
      agent.model = body.model.trim();
    }
    (agent as any).pendingConfig = {
      agent: settings.settings,
      skills: validatedSkills,
      version: (state.configs.current(agent.id)?.version ?? 0) + 1,
    };

    if (validatedSkills.length === 0) {
      const { identity, executionIdentity } = await dp.provisionIdentity(agent.id, agent.requires);
      await dp.registerCompute(agent.id, pin.image, agent.requires, identity, executionIdentity, agent.memoryPrefix ?? agent.id);
      agent.artifact = pin.image;
      agent.deployedCommit = pin.commit;
      agent.deployedSkills = [];
      agent.deployedRuntime = { repo: pin.repo, commit: pin.commit, image: pin.image };

      const smokeRes = await runActivationSmoke(state, agent, [], pin.commit, principal.actor);
      if (!smokeRes.ok) {
        if (prevArtifact) {
          try {
            await dp.registerCompute(
              agent.id,
              prevArtifact,
              agent.requires,
              identity,
              executionIdentity,
              agent.memoryPrefix ?? agent.id,
              prevDeployedSkills?.length ? { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH } : undefined,
            );
          } catch (rbErr) {
            console.error(`[control-plane] Rollback registerCompute failed for ${agent.id}:`, rbErr);
          }
        }
        restoreAgent();
        json(res, 502, { error: 'smoke_failed', message: smokeRes.error });
        return true;
      }
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        type: 'action',
        action: 'AGENT_DEPLOYED',
        actor: principal.actor,
        commit: pin.commit,
      });
    } else {
      const buildSkills: BuildSkill[] = [];
      for (const s of validatedSkills) {
        const rec = registry.get(s.id, s.version)!;
        if (rec.packageHash) {
          buildSkills.push({
            id: rec.id,
            version: rec.version,
            packageHash: rec.packageHash,
            repo: rec.repo || '',
            path: rec.path || '.',
            commit: rec.commit || rec.packageHash,
          });
        } else {
          buildSkills.push({ id: rec.id, version: rec.version, repo: rec.repo, path: rec.path, commit: rec.commit });
        }
      }

      agent.state = 'DEPLOYING';
      agent.admission = beginAdmission(pin.commit);
      registryOf(state).save(agent);

      const deployRes = await runDeploy(state, {
        agent,
        actor: principal.actor,
        source: { repo: pin.repo, commit: pin.commit },
        skills: buildSkills,
        previousState: prevState,
        isApply: true,
      });

      if (deployRes !== 'deployed') {
        restoreAgent();
        json(res, 502, { error: 'convert_deploy_failed', reason: deployRes });
        return true;
      }
    }

    // Once deploy + activation smoke succeeds:
    const nowIso = new Date().toISOString();
    const adoptions = validatedSkills.map((s) => ({
      id: s.id,
      version: s.version,
      requestedBy: principal.actor,
      requestedAt: nowIso,
      approvedBy: principal.actor,
      approvedAt: nowIso,
    }));

    const { record: stored } = await state.configs.put(
      {
        ...configOf(state, agent.id),
        source: { repo: pin.repo, commit: pin.commit },
        skills: validatedSkills,
        agent: settings.settings,
      },
      {
        updatedBy: principal.actor,
        reason: changeReason(req, 'converted from repository to configuration in place'),
        skillAdoptions: adoptions.length ? adoptions : undefined,
        replaces: ['agent', 'skills'],
      },
    );

    delete (agent as any).pendingConfig;
    delete agent.skillIds;
    delete agent.skillRoutes;
    delete agent.roles;
    delete agent.admission;
    agent.state = 'SLEEPING';
    registryOf(state).save(agent);

    ledgerVersion(state, stored, principal.actor);

    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      type: 'action',
      action: 'AGENT_CONVERTED',
      actor: principal.actor,
      commit: pin.commit,
      requestId: `config:${agent.id}:v${stored.version}`,
      payloadSha256: payloadHash({ fromCommit: prevCommit ?? '', toRuntimeCommit: pin.commit, skills: validatedSkills, hash: stored.hash }),
    });

    json(res, 200, {
      ok: true,
      id: agent.id,
      createdFrom: 'configuration',
      state: agent.state,
      artifact: agent.artifact,
      deployedRuntime: agent.deployedRuntime,
      configurationVersion: stored.version,
      smoke: { ok: true },
    });
    return true;
  } catch (err: any) {
    if (prevArtifact) {
      try {
        const { identity, executionIdentity } = await dp.provisionIdentity(agent.id, agent.requires);
        await dp.registerCompute(
          agent.id,
          prevArtifact,
          agent.requires,
          identity,
          executionIdentity,
          agent.memoryPrefix ?? agent.id,
          prevDeployedSkills?.length ? { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH } : undefined,
        );
      } catch (rbErr) {
        console.error(`[control-plane] Rollback registerCompute failed for ${agent.id}:`, rbErr);
      }
    }
    restoreAgent();
    json(res, 502, { error: 'convert_failed', message: err?.message ?? String(err) });
    return true;
  }
  return true;
}
