import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand, type Build } from '@aws-sdk/client-codebuild';
import { AdmissionRefusedError, imageTagFor, type AdmissionRefusal, type SourceRef } from '../runtime.js';
import { cleanFailure, parseSkillCheckResult, skillCheckEnv, type SkillChecker, type SkillCheckOutcome } from '../skill-checks.js';

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

/**
 * Admission build for one pinned commit: the buildspec clones the repo, checks out GIT_COMMIT, refuses a repo
 * without tests, runs them, builds, and pushes `<ecr>:<agentId>-<commit[:12]>`. Polls until the build ends.
 */
export async function buildAgentImage(
  agentId: string,
  source: SourceRef,
  opts: { client?: Pick<CodeBuildClient, 'send'>; pollMs?: number; projectName?: string } = {},
): Promise<string> {
  const ecrRepoUri = process.env.FACTORY_ECR_REPO_URI;
  if (!ecrRepoUri) throw new Error('FACTORY_ECR_REPO_URI environment variable is required');
  const client = opts.client ?? new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const tag = imageTagFor(agentId, source.commit);
  const env = { AGENT_ID: agentId, REPO_URL: source.repo, GIT_COMMIT: source.commit, IMAGE_TAG: tag };

  const startRes = await client.send(
    new StartBuildCommand({
      projectName: opts.projectName ?? process.env.FACTORY_AGENT_BUILDER_PROJECT ?? 'factory-agent-builder',
      environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
    }),
  );
  const buildId = startRes.build?.id;
  if (!buildId) throw new Error('Failed to start CodeBuild: build ID not returned');

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 5000));
    const batchRes = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = batchRes.builds?.[0];
    if (!build) throw new Error(`Build ${buildId} not found in CodeBuild`);
    if (build.buildStatus === 'SUCCEEDED') return `${ecrRepoUri}:${tag}`;
    if (build.buildStatus && TERMINAL_FAILURES.has(build.buildStatus)) throw admissionFailure(build);
  }
}

/**
 * SK1 skill checks (TSK-054): the `factory-skill-checker` CodeBuild project (landing-zones/aws/codebuild.tf) clones the
 * skill's repository at the pinned commit, runs `SKILL_CHECK_SCRIPT` in the skill's folder and exports its result as
 * SKILL_CHECK_RESULT. The control plane learns the outcome as admission does, by polling the build (BatchGetBuilds) in
 * the background until it ends; no API request polls.
 */
export function codeBuildSkillChecker(
  opts: { client?: Pick<CodeBuildClient, 'send'>; pollMs?: number; projectName?: string } = {},
): SkillChecker {
  const client = opts.client ?? new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const projectName = opts.projectName ?? process.env.FACTORY_SKILL_CHECKER_PROJECT ?? 'factory-skill-checker';
  return {
    name: 'codebuild',
    async start(req) {
      const env = skillCheckEnv(req);
      const res = await client.send(
        new StartBuildCommand({
          projectName,
          environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
        }),
      );
      const id = res.build?.id;
      if (!id) throw new Error('CodeBuild did not return a build id');
      return id;
    },
    async result(runId) {
      let errors = 0;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 10_000));
        let res;
        try {
          res = await client.send(new BatchGetBuildsCommand({ ids: [runId] }));
          errors = 0;
        } catch (err) {
          // A throttled or failed poll is retried; only a run that cannot be read for a long while is given up on.
          if (++errors >= 30) throw err;
          continue;
        }
        const build = res.builds?.[0];
        if (!build) return { passed: false, failures: [`checks: build ${runId} not found in CodeBuild; re-run the checks`] };
        if (build.buildStatus === 'SUCCEEDED') return skillCheckOutcome(build);
        if (build.buildStatus && TERMINAL_FAILURES.has(build.buildStatus)) return skillCheckOutcome(build);
      }
    },
  };
}

/** A finished skill-check build: its exported result, or why the run ended without one. */
export function skillCheckOutcome(build: Build): SkillCheckOutcome {
  const exported = build.exportedEnvironmentVariables?.find((v) => v.name === 'SKILL_CHECK_RESULT')?.value;
  if (build.buildStatus === 'SUCCEEDED' && exported) return parseSkillCheckResult(exported);
  const failed = build.phases?.find((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED' && p.phaseType !== 'COMPLETED');
  const message = failed?.contexts?.map((c) => c.message).filter(Boolean).join('; ') || '';
  const detail = message ? `: ${message}` : '';
  return { passed: false, failures: [cleanFailure(`checks: the check run ended ${build.buildStatus ?? 'UNKNOWN'} in ${failed?.phaseType ?? 'an unknown phase'} without a result${detail}`)] };
}
