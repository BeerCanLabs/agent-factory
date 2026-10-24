import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand, type Build } from '@aws-sdk/client-codebuild';
import { AdmissionRefusedError, imageTagFor, type AdmissionRefusal, type BuildSkill, type SourceRef } from '../runtime.js';

const TERMINAL_FAILURES = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED']);

/**
 * Exit codes the `factory-agent-builder` buildspec (landing-zones/aws/codebuild.tf) uses to say why it refused
 * a commit. Keep the two in step.
 */
const EXIT_REASONS: Record<number, AdmissionRefusal> = {
  3: 'no_tests',
  4: 'tests_failed',
  5: 'source_unavailable',
  6: 'hardcoded_secret',
  7: 'archetype_required',
};

const PHASE_REASONS: Record<string, AdmissionRefusal> = {
  INSTALL: 'source_unavailable',
  PRE_BUILD: 'tests_failed',
  BUILD: 'build_failed',
  POST_BUILD: 'push_failed',
};

/** Maps a failed CodeBuild build to the admission refusal reason and the failed phase. */
export function admissionFailure(build: Build): AdmissionRefusedError {
  const failed = build.phases?.find((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED' && p.phaseType !== 'COMPLETED');
  const phase = failed?.phaseType;
  const message = failed?.contexts?.map((c) => c.message).filter(Boolean).join('; ') || '';
  const exit = Number(message.match(/exit status (\d+)/)?.[1]);
  const reason: AdmissionRefusal = EXIT_REASONS[exit] ?? (phase ? PHASE_REASONS[phase] : undefined) ?? 'build_failed';
  const detail = message ? `: ${message}` : '';
  return new AdmissionRefusedError(reason, `CodeBuild ${build.buildStatus} in ${phase ?? 'unknown phase'}${detail}`, phase);
}

/** CodeBuild limits an environment variable's value; a build with this many skills is refused rather than truncated. */
export const MAX_SKILLS_ENV_CHARS = 3500;

/**
 * The `SKILLS` value the buildspec reads (SK4): the pins to fetch, as JSON. Only what the build needs: never a manifest
 * body, a requirement or a credential.
 */
export function skillsEnv(skills: readonly BuildSkill[]): string {
  return JSON.stringify([...skills].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, version, repo, path, commit }) => ({ id, version, repo, path, commit })));
}

/**
 * Admission build for one pinned commit: the buildspec clones the repo, checks out GIT_COMMIT, refuses a repo
 * without tests, runs them, builds, and pushes `<ecr>:<agentId>-<commit[:12]>`. Polls until the build ends.
 *
 * With `opts.skills` (SK4) the buildspec also fetches each adopted skill at its pinned commit, checks it, and adds one
 * layer holding the skills and their manifest on top of the agent's own image; the tag then carries a hash of the pins
 * (`imageTagFor`). The agent's Dockerfile is not read for them.
 */
export async function buildAgentImage(
  agentId: string,
  source: SourceRef,
  opts: { client?: Pick<CodeBuildClient, 'send'>; pollMs?: number; projectName?: string; skills?: readonly BuildSkill[] } = {},
): Promise<string> {
  const ecrRepoUri = process.env.FACTORY_ECR_REPO_URI;
  if (!ecrRepoUri) throw new Error('FACTORY_ECR_REPO_URI environment variable is required');
  const client = opts.client ?? new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const skills = opts.skills ?? [];
  const tag = imageTagFor(agentId, source.commit, skills);
  const skillsValue = skills.length ? skillsEnv(skills) : '';
  if (skillsValue.length > MAX_SKILLS_ENV_CHARS) {
    throw new AdmissionRefusedError('build_failed', `${skills.length} skills do not fit the build's environment (${skillsValue.length} > ${MAX_SKILLS_ENV_CHARS} characters)`);
  }
  // Only set when there are skills: the project defines no SKILLS of its own, and an empty override may be refused.
  const env = { AGENT_ID: agentId, REPO_URL: source.repo, GIT_COMMIT: source.commit, IMAGE_TAG: tag, ...(skillsValue ? { SKILLS: skillsValue } : {}) };

  await runBuild(client, opts.projectName ?? process.env.FACTORY_AGENT_BUILDER_PROJECT ?? 'factory-agent-builder', env, opts.pollMs);
  return `${ecrRepoUri}:${tag}`;
}

/** Starts one CodeBuild build with these variables and polls until it ends: returns on success, throws the admission failure otherwise. */
async function runBuild(client: Pick<CodeBuildClient, 'send'>, projectName: string, env: Record<string, string>, pollMs = 5000): Promise<void> {
  const startRes = await client.send(
    new StartBuildCommand({
      projectName,
      environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
    }),
  );
  const buildId = startRes.build?.id;
  if (!buildId) throw new Error('Failed to start CodeBuild: build ID not returned');

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const batchRes = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = batchRes.builds?.[0];
    if (!build) throw new Error(`Build ${buildId} not found in CodeBuild`);
    if (build.buildStatus === 'SUCCEEDED') return;
    if (build.buildStatus && TERMINAL_FAILURES.has(build.buildStatus)) throw admissionFailure(build);
  }
}

/**
 * The image of an agent created from a configuration that has adopted skills (CF6, SK4, TSK-272): the pinned shared
 * runtime image (`base`, built from `base.commit`) plus one layer holding the skills and their manifest, built by the
 * `factory-skills-builder` project (landing-zones/aws/codebuild.tf). There is no agent source to clone or test. The tag
 * is `<agentId>-<runtime commit[:12]>-<skills hash[:12]>` (`imageTagFor`), so a new runtime or other skills is another
 * image, and the same pins are the same bytes; the build refuses a base that is not in the runtime's registry.
 */
export async function buildSkillsImage(
  agentId: string,
  base: { image: string; commit: string },
  skills: readonly BuildSkill[],
  opts: { client?: Pick<CodeBuildClient, 'send'>; pollMs?: number; projectName?: string } = {},
): Promise<string> {
  const ecrRepoUri = process.env.FACTORY_ECR_REPO_URI;
  if (!ecrRepoUri) throw new Error('FACTORY_ECR_REPO_URI environment variable is required');
  if (skills.length === 0) throw new Error('buildSkillsImage needs at least one skill; an agent without skills runs the runtime image itself');
  const skillsValue = skillsEnv(skills);
  if (skillsValue.length > MAX_SKILLS_ENV_CHARS) {
    throw new AdmissionRefusedError('build_failed', `${skills.length} skills do not fit the build's environment (${skillsValue.length} > ${MAX_SKILLS_ENV_CHARS} characters)`);
  }
  const client = opts.client ?? new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const tag = imageTagFor(agentId, base.commit, skills);
  const env = { AGENT_ID: agentId, BASE_IMAGE: base.image, RUNTIME_COMMIT: base.commit, IMAGE_TAG: tag, SKILLS: skillsValue };
  await runBuild(client, opts.projectName ?? process.env.FACTORY_SKILLS_BUILDER_PROJECT ?? 'factory-skills-builder', env, opts.pollMs);
  return `${ecrRepoUri}:${tag}`;
}
