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
   * A change to the skills must not unpause an agent that someone paused for another reason, so the state it had is put
   * back after the deploy. The deploy route keeps its old behavior: a deploy of a paused agent brings it online.
   */
  keepPause: boolean;
};

function row(state: FactoryState, agentId: string, action: string, actor: string, commit?: string, requestId?: string): void {
  state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action, actor, ...(commit ? { commit } : {}), ...(requestId ? { requestId } : {}) });
}

/**
 * Admits, builds, provisions and registers one agent's image (L3, L4), and records the outcome. The caller has already set
 * the agent `DEPLOYING` and saved it. Never throws: a refusal or a failure is recorded on the agent and in the ledger.
 */
export async function runDeploy(state: FactoryState, job: DeployJob): Promise<void> {
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
    // A refused new version leaves the running version in place.
    agent.state = stateAfterRefusal(agent, previousState);
    registryOf(state).save(agent);
    row(state, agentId, `AGENT_ADMISSION_REFUSED:${outcome.reason}`, actor, commit);
    return;
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
    const stayPaused = job.keepPause && (previousState === 'PAUSED' || previousState === 'ISOLATED') && !resumed;
    agent.state = stayPaused ? previousState : 'SLEEPING'; // Officially online
    registryOf(state).save(agent);
    row(state, agentId, 'AGENT_DEPLOYED', actor, commit);
    if (resumed) row(state, agentId, 'AGENT_RESUMED_AFTER_SKILL_CHANGE', actor, commit);
  } catch (err) {
    console.error(`[control-plane] Deploy failed for ${agentId}:`, err);
    agent.state = 'ERROR';
    registryOf(state).save(agent);
    row(state, agentId, 'AGENT_DEPLOY_FAILED', actor, commit);
  }
}

export type ApplyOutcome =
  | { status: 'started'; done: Promise<void> }
  | { status: 'pending' }
  | { status: 'unchanged' | 'skipped' | 'failed'; reason: string };

/** Agents whose configuration changed while a deploy was running: applied again when it ends. */
const applyAgain = new WeakMap<FactoryState, Set<string>>();

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

  if (agent.state === 'DEPLOYING') {
    let flags = applyAgain.get(state);
    if (!flags) applyAgain.set(state, (flags = new Set()));
    flags.add(agentId);
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

  const done = runDeploy(state, { agent, actor, source: pin.source, skills: built.skills, previousState, keepPause: true })
    .then(() => {
      row(state, agentId, agent.state === 'ERROR' || agent.admission?.status === 'refused' ? 'AGENT_CONFIG_APPLY_FAILED' : 'AGENT_CONFIG_APPLIED', actor, pin.source.commit, requestId);
    })
    .catch((err) => console.error(`[control-plane] apply of ${agentId} failed:`, err))
    .then(() => {
      // A change that came in while this deploy ran.
      if (applyAgain.get(state)?.delete(agentId)) applyConfig(state, agentId, actor, `${reason} (queued)`);
    });
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

