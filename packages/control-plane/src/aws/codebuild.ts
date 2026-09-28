import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand, type Build } from '@aws-sdk/client-codebuild';
import { AdmissionRefusedError, imageTagFor, type AdmissionRefusal, type SourceRef } from '../runtime.js';

const TERMINAL_FAILURES = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED']);

/**
 * Exit codes the `factory-agent-builder` buildspec (landing-zones/aws/codebuild.tf) uses to say why it refused
 * a commit. Keep the two in step.
 */
const EXIT_REASONS: Record<number, AdmissionRefusal> = {
  3: 'no_tests',
  4: 'tests_failed',
  5: 'source_unavailable',
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
