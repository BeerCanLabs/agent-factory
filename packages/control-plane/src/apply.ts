/**
 * Applying an agent's configuration (DESIGN_AUTHORITY.md §6.14 SK4, §6.8 L3/L4; the Landlord's side).
 *
 * What runs is exactly the configuration: an image built from the agent's source at its commit plus each adopted skill
 * at its approved version's pinned commit, admitted and deployed. `runDeploy` is the one place that does it: the deploy
 * route calls it for a source change, and `applyConfig` calls it when the adopted skills change (an adoption, a removal,
 * a retirement). No code is ever loaded at runtime, and nothing needs a pull request.
 *
 * The Registrar decides what is admitted (`admit`) and the provider builds and provisions; this file sequences them and
 * records the outcome on the agent and in the ledger. The control plane is one process, so the "apply again" flags below
 * are in memory.
 */
import { BUILTIN_AGENT_IDS, admissionOf, admit, beginAdmission, pinSource, stateAfterRefusal, type AgentRecord } from '@beercanlabs/factory-registrar';
import { redactSecrets } from '@beercanlabs/factory-ledger';
import { AdmissionRefusedError, SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, type BuildSkill, type SourceRef } from './runtime.js';
import { registryOf, type FactoryState } from './app.js';
import { skillRegistry } from './skills.js';

/** SK4: the skills to build into the agent's image: its configuration's adopted skills, each approved, unretired and pinned. */
export function buildSkillsFor(state: FactoryState, agentId: string): { ok: true; skills: BuildSkill[] } | { ok: false; error: 'skill_unavailable'; message: string } {
  const registry = skillRegistry(state);
  const skills: BuildSkill[] = [];
  for (const adopted of state.configs?.current(agentId)?.skills ?? []) {
    const rec = registry.get(adopted.id, adopted.version);
    if (!rec || rec.status !== 'approved' || rec.retired) {
      const why = !rec ? 'is not registered' : rec.retired ? 'is retired' : `is ${rec.status}`;
      return { ok: false, error: 'skill_unavailable', message: `${adopted.id}@${adopted.version} ${why}; an agent can be built only with approved, unretired skills (SK1, SK6)` };
    }
    skills.push({ id: rec.id, version: rec.version, repo: rec.repo, path: rec.path, commit: rec.commit });
  }
  return { ok: true, skills };
}

const pins = (skills: ReadonlyArray<{ id: string; version: string }>): string =>
  [...skills].map((s) => `${s.id}@${s.version}`).sort().join(',');

/** True when the deployed image already contains exactly these skills. */
export const sameSkills = (a: ReadonlyArray<{ id: string; version: string }>, b: ReadonlyArray<{ id: string; version: string }>): boolean => pins(a) === pins(b);

export type DeployJob = {
  agent: AgentRecord;
  actor: string;
  source: SourceRef;
  skills: BuildSkill[];
  /** The agent's state before this deploy: what a refused build leaves it in. */
  previousState: AgentRecord['state'];
  /**
   * True when this deploy applies a skills change to a running agent (`applyConfig`), false for the deploy route.
   * An apply must not unpause an agent that someone paused for another reason, so the state it had is put back; and if
   * it fails after a good build, the agent goes back to that state too, because the image and compute it was running
   * are still in place. The deploy route keeps its old behavior: a deploy of a paused agent brings it online, and a
   * failure after the build leaves the agent in `ERROR`.
   */
  isApply: boolean;
};

export type DeployResult = 'deployed' | 'refused' | 'failed';

/** A pause or isolation set while a deploy ran: the agent's state is `DEPLOYING` from the start, so anything else was set since. */
const stoppedDuring = (agent: AgentRecord): boolean => agent.state === 'PAUSED' || agent.state === 'ISOLATED';

function row(state: FactoryState, agentId: string, action: string, actor: string, commit?: string, requestId?: string): void {
  state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action, actor, ...(commit ? { commit } : {}), ...(requestId ? { requestId } : {}) });
}

/**
 * Admits, builds, provisions and registers one agent's image (L3, L4), and records the outcome. The caller has already set
 * the agent `DEPLOYING` and saved it. Never throws: a refusal or a failure is recorded on the agent and in the ledger.
 */
/**
 * Agents with a deploy running. The agent's `state` says `DEPLOYING` too, but a pause or isolation set meanwhile replaces
 * it, and a second deploy must not start beside the first, so this is the record of whether one is running.
 */
const deploying = new WeakMap<FactoryState, Set<string>>();
export const isDeploying = (state: FactoryState, agentId: string): boolean => deploying.get(state)?.has(agentId) === true;

export async function runDeploy(state: FactoryState, job: DeployJob): Promise<DeployResult> {
  let running = deploying.get(state);
  if (!running) deploying.set(state, (running = new Set()));
  running.add(job.agent.id);
  try {
    return await deploy(state, job);
  } finally {
    running.delete(job.agent.id);
    // A skills change that arrived while this deploy ran (from either entry point) is applied now, so it is never dropped.
    const next = applyAgain.get(state)?.get(job.agent.id);
    if (next) {
      applyAgain.get(state)!.delete(job.agent.id);
      triggerApply(state, job.agent.id, next.actor, `${next.reason} (queued)`);
    }
  }
}

async function deploy(state: FactoryState, job: DeployJob): Promise<DeployResult> {
  const { agent, actor, source, skills, previousState } = job;
  const agentId = agent.id;
  const commit = source.commit;
  const dp = state.deployProvider!;
  const withSkills = skills.length > 0 ? ` with ${skills.length} skill(s)` : '';
  console.log(`[control-plane] Admission build for ${agentId} at ${commit}${withSkills}...`);
  const outcome = await admit(source, {
    build: (src) => dp.buildImage(agentId, src, skills.length ? skills : undefined),
    isRefusal: (err): err is AdmissionRefusedError => err instanceof AdmissionRefusedError,
    redact: (message) => redactSecrets(message, state.secretValues ?? []),
  });
  if (outcome.status === 'refused') {
    console.error(`[control-plane] Admission refused ${agentId}@${commit}: ${outcome.reason}: ${outcome.message}`);
    agent.admission = admissionOf(outcome);
    // A refused new version leaves the running version in place (and a pause set while it built stays).
    if (!stoppedDuring(agent)) agent.state = stateAfterRefusal(agent, previousState);
    registryOf(state).save(agent);
    row(state, agentId, `AGENT_ADMISSION_REFUSED:${outcome.reason}`, actor, commit);
    return 'refused';
  }
  const imageUri = outcome.imageUri;
  try {
    agent.admission = admissionOf(outcome);
    row(state, agentId, 'AGENT_ADMITTED', actor, commit);
    console.log(`[control-plane] Provisioning identity for ${agentId}...`);
    const { identity, executionIdentity } = await dp.provisionIdentity(agentId, agent.requires);
    console.log(`[control-plane] Registering compute for ${agentId} with ${imageUri}...`);
    // SK4: the Landlord names where the skills manifest is; what the cartridge does with it is the cartridge's.
    const launchEnv = skills.length ? { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH } : undefined;
    await dp.registerCompute(agentId, imageUri, agent.requires, identity, executionIdentity, agent.memoryPrefix ?? agentId, launchEnv);

    agent.artifact = imageUri;
    agent.deployedCommit = commit;
    agent.deployedSkills = skills.map(({ id, version }) => ({ id, version }));
    agent.provider = 'cloud';
    // SK6: an agent paused because it ran a skill is resumed once the image no longer has it.
    const resumed = agent.pausedForSkill !== undefined && !agent.deployedSkills.some((s) => s.id === agent.pausedForSkill);
    if (resumed) delete agent.pausedForSkill;
    // The state the deploy ends in. A pause set while it ran stays (the image may still have the skill; the queued apply
    // that follows rebuilds it). An apply puts back the pause the agent had. Otherwise the agent is online.
    const stoppedNow = stoppedDuring(agent);
    const heldBefore = job.isApply && (previousState === 'PAUSED' || previousState === 'ISOLATED');
    if (resumed) agent.state = previousState === 'ISOLATED' || agent.state === 'ISOLATED' ? 'ISOLATED' : 'SLEEPING';
    else if (!stoppedNow) agent.state = heldBefore ? previousState : 'SLEEPING'; // Officially online; a pause set meanwhile stays
    registryOf(state).save(agent);
    row(state, agentId, 'AGENT_DEPLOYED', actor, commit);
    if (resumed) row(state, agentId, 'AGENT_RESUMED_AFTER_SKILL_CHANGE', actor, commit);
    return 'deployed';
  } catch (err) {
    console.error(`[control-plane] Deploy failed for ${agentId}:`, err);
    // An apply that fails after a good build leaves the agent as it was: its image and compute are still in place.
    // The deploy route keeps `ERROR`.
    if (!job.isApply) agent.state = 'ERROR';
    else if (!stoppedDuring(agent)) agent.state = previousState;
    registryOf(state).save(agent);
    row(state, agentId, 'AGENT_DEPLOY_FAILED', actor, commit);
    return 'failed';
  }
}

export type ApplyOutcome =
  | { status: 'started'; done: Promise<void> }
  | { status: 'pending' }
  | { status: 'unchanged' | 'skipped' | 'failed'; reason: string };

/** Agents whose configuration changed while a deploy was running: applied again when it ends. */
const applyAgain = new WeakMap<FactoryState, Map<string, { actor: string; reason: string }>>();

/**
 * Applies the agent's current configuration (SK4): when the skills it should run differ from the ones in the deployed
 * image, builds and deploys the new image. Does nothing for an agent that was never deployed (its first deploy builds
 * the skills in), for a built-in agent, or when the image already matches. A change that arrives during a deploy is
 * applied when that deploy ends, so it is never dropped.
 */
export function applyConfig(state: FactoryState, agentId: string, actor: string, reason: string): ApplyOutcome {
  const agent = state.agents.get(agentId);
  if (!agent) return { status: 'skipped', reason: 'unknown_agent' };
  if (agent.isBuiltin || BUILTIN_AGENT_IDS.has(agent.id)) return { status: 'skipped', reason: 'builtin_agent' };
  if (!agent.deployedCommit) return { status: 'skipped', reason: 'not_deployed' };
  if (agent.state === 'RETIRED_PENDING_PURGE' || agent.state === 'PURGED') return { status: 'skipped', reason: `agent_${agent.state.toLowerCase()}` };
  const requestId = `config:${agentId}:v${state.configs?.current(agentId)?.version ?? 0}`;

  if (agent.state === 'DEPLOYING' || isDeploying(state, agentId)) {
    let flags = applyAgain.get(state);
    if (!flags) applyAgain.set(state, (flags = new Map()));
    flags.set(agentId, { actor, reason });
    return { status: 'pending' };
  }

  const built = buildSkillsFor(state, agentId);
  if (!built.ok) {
    row(state, agentId, 'AGENT_CONFIG_APPLY_FAILED', actor, undefined, requestId);
    console.error(`[control-plane] cannot apply ${agentId}: ${built.message}`);
    return { status: 'failed', reason: built.error };
  }
  if (sameSkills(agent.deployedSkills ?? [], built.skills)) return { status: 'unchanged', reason: 'image_matches' };

  if (!state.deployProvider) {
    row(state, agentId, 'AGENT_CONFIG_APPLY_SKIPPED', actor, undefined, requestId);
    return { status: 'skipped', reason: 'deploy_provider_not_configured' };
  }
  // L4 / E7: a policy owner must have set this agent's own policy, with a route, before it deploys.
  if (!state.policies.has(agentId) || state.policies.get(agentId).routes.length === 0) {
    row(state, agentId, 'AGENT_CONFIG_APPLY_SKIPPED', actor, undefined, requestId);
    return { status: 'skipped', reason: 'policy_required' };
  }
  const pin = pinSource(agent, {});
  if (!pin.ok) {
    row(state, agentId, 'AGENT_CONFIG_APPLY_SKIPPED', actor, undefined, requestId);
    return { status: 'skipped', reason: pin.error };
  }

  const previousState = agent.state;
  agent.state = 'DEPLOYING';
  agent.admission = beginAdmission(pin.source.commit);
  registryOf(state).save(agent);
  row(state, agentId, 'AGENT_CONFIG_APPLY_STARTED', actor, pin.source.commit, requestId);

  const done = runDeploy(state, { agent, actor, source: pin.source, skills: built.skills, previousState, isApply: true })
    .then((result) => {
      row(state, agentId, result === 'deployed' ? 'AGENT_CONFIG_APPLIED' : 'AGENT_CONFIG_APPLY_FAILED', actor, pin.source.commit, requestId);
    })
    .catch((err) => console.error(`[control-plane] apply of ${agentId} failed:`, err));
  return { status: 'started', done };
}

/** Applies in the background after a configuration change; a failure is logged and ledgered, never raised at the caller. */
export function triggerApply(state: FactoryState, agentId: string, actor: string, reason: string): void {
  try {
    const out = applyConfig(state, agentId, actor, reason);
    if (out.status === 'started') void out.done;
  } catch (err) {
    console.error(`[control-plane] could not start applying ${agentId}:`, err);
  }
}

