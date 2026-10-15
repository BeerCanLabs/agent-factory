import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cloudRunRuntime, parseJobMap, type CloudRunExecutionDesc } from './runtime-cloudrun.js';
import { admissionFailure, buildAgentImage, type GcpBuild } from './gcp/cloudbuild.js';
import { agentEnvironment, registerAgentJob, resolveGcpSecretId } from './gcp/cloudrun.js';
import { provisionAgentServiceAccount } from './gcp/iam.js';
import { AdmissionRefusedError, SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, type AdmissionRefusal } from './runtime.js';
import type { AgentRecord } from '@beercanlabs/factory-registrar';

const echo: AgentRecord = {
  id: 'echo-agent',
  name: 'Echo',
  role: 'echo',
  state: 'IDLE',
  provider: 'gcp',
  artifact: 'oci://x',
  requires: [],
  triggers: [{ type: 'http', path: '/wake' }],
  dir: '/tmp',
};

describe('parseJobMap', () => {
  it('parses id:job pairs', () => {
    assert.deepEqual(parseJobMap('echo-agent:factory-prod-agent-echo'), {
      'echo-agent': 'factory-prod-agent-echo',
    });
  });
});

describe('cloudRunRuntime', () => {
  function fake() {
    const runs: Array<{ jobName: string; containerName: string; env: Array<{ name: string; value: string }> }> = [];
    const cancelled: string[] = [];
    let execState: CloudRunExecutionDesc = {};
    const rt = cloudRunRuntime({
      projectId: 'bcl-factory',
      region: 'us-central1',
      jobMap: { 'echo-agent': 'factory-prod-agent-echo' },
      api: {
        async runJob(jobName, containerName, env) {
          runs.push({ jobName, containerName, env });
          return { executionName: `projects/bcl-factory/locations/us-central1/jobs/${jobName}/executions/exec-1` };
        },
        async cancelExecution(executionName) {
          cancelled.push(executionName);
        },
        async getExecution() {
          return execState;
        },
      },
    });
    return {
      rt,
      runs,
      cancelled,
      complete: (ok: boolean, message?: string) => {
        execState = {
          completionTime: '2026-10-15T00:00:00Z',
          succeededCount: ok ? 1 : 0,
          failedCount: ok ? 0 : 1,
          conditions: [
            {
              type: 'Completed',
              state: ok ? 'CONDITION_SUCCEEDED' : 'CONDITION_FAILED',
              message,
            },
          ],
        };
      },
    };
  }

  it('runJob carries run metadata but never secret values', async () => {
    const { rt, runs } = fake();
    const { handle } = await rt.start(
      echo,
      { ECHO_WEBHOOK_SECRET: 'super-secret-value' },
      { runId: 'run-1', runEnv: { FACTORY_RUN_ID: 'run-1', FACTORY_RUN_TOKEN: 'tok' } },
    );
    assert.equal(handle, 'projects/bcl-factory/locations/us-central1/jobs/factory-prod-agent-echo/executions/exec-1');
    const serialized = JSON.stringify(runs[0]);
    assert.ok(serialized.includes('FACTORY_RUN_ID'));
    assert.equal(serialized.includes('super-secret-value'), false);
    assert.equal(serialized.includes('ECHO_WEBHOOK_SECRET'), false);
  });

  it('runs an admitted deploy from factory-agent-<id>, not the static job map', async () => {
    const { rt, runs } = fake();
    await rt.start({ ...echo, deployedCommit: 'a'.repeat(40) }, {}, { runId: 'run-2', runEnv: {} });
    assert.equal(runs[0].jobName, 'factory-agent-echo-agent');
  });

  it('stops by durable handle and reports completion via getExecution', async () => {
    const { rt, cancelled, complete } = fake();
    const { handle } = await rt.start(echo, {}, { runId: 'run-3', runEnv: {} });
    assert.deepEqual(await rt.status!(handle!), { state: 'running' });
    complete(false, 'Container exited with code 4');
    const s = await rt.status!(handle!);
    assert.equal(s.state, 'stopped');
    if (s.state === 'stopped') {
      assert.equal(s.exitCode, 1);
      assert.equal(s.reason, 'Container exited with code 4');
    }
    await rt.stop(echo, 'projects/bcl-factory/locations/us-central1/jobs/x/executions/exec-9');
    assert.deepEqual(cancelled, ['projects/bcl-factory/locations/us-central1/jobs/x/executions/exec-9']);
  });
});

describe('GCP Cloud Build admission (L3, L4, SK4, K1, S1)', () => {
  const C = 'e3410b53beb5bfb037ff1444e1778acd32c39530';
  const AR = 'us-central1-docker.pkg.dev/bcl-factory/factory-prod-agents/dynamic';

  afterEach(() => {
    delete process.env.FACTORY_GCP_PROJECT;
    delete process.env.FACTORY_ARTIFACT_REGISTRY;
    delete process.env.FACTORY_SECRETS_GCP_PREFIX;
    delete process.env.FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS;
  });

  it('maps step exit codes and step IDs to AdmissionRefusedError', () => {
    const cases: Array<[string, string, AdmissionRefusal, string]> = [
      ['test', 'step exited with non-zero status: 3', 'no_tests', 'PRE_BUILD'],
      ['test', 'step exited with non-zero status: 4', 'tests_failed', 'PRE_BUILD'],
      ['test', 'step exited with non-zero status: 6', 'hardcoded_secret', 'PRE_BUILD'],
      ['clone', 'step exited with non-zero status: 5', 'source_unavailable', 'INSTALL'],
      ['build', 'step exited with non-zero status: 1', 'build_failed', 'BUILD'],
      ['push', 'step exited with non-zero status: 1', 'push_failed', 'POST_BUILD'],
    ];
    for (const [stepId, detail, reason, phase] of cases) {
      const b: GcpBuild = {
        status: 'FAILURE',
        steps: [{ id: stepId, status: 'FAILURE' }],
        failureInfo: { detail },
      };
      const err = admissionFailure(b);
      assert.equal(err.reason, reason, detail);
      assert.equal(err.phase, phase);
    }
  });

  it('starts the pinned Cloud Build with clone/test/build/push steps and returns the immutable image URI', async () => {
    process.env.FACTORY_GCP_PROJECT = 'bcl-factory';
    process.env.FACTORY_ARTIFACT_REGISTRY = AR;
    let created: GcpBuild | undefined;
    let polls = 0;
    const client = {
      async createBuild(req: { projectId?: string; build?: GcpBuild }) {
        created = req.build;
        return [{ metadata: { build: { id: 'cb-1' } } }] as any;
      },
      async getBuild() {
        polls += 1;
        return [{ id: 'cb-1', status: polls < 2 ? 'WORKING' : 'SUCCESS' }] as any;
      },
    };
    const uri = await buildAgentImage(
      'donna',
      { repo: 'https://github.com/BeerCanLabs/donna-agent.git', commit: C },
      { client, pollMs: 1 },
    );
    assert.equal(uri, `${AR}:donna-e3410b53beb5`);
    assert.deepEqual(
      created?.steps?.map((s) => s.id),
      ['clone', 'test', 'build', 'push'],
    );
    assert.equal(polls, 2);
  });

  it('registers Cloud Run Job with S1 secret filtering, prefix encoding, and gcs:// mind store', async () => {
    process.env.FACTORY_GCP_PROJECT = 'bcl-factory';
    process.env.FACTORY_GCP_REGION = 'us-central1';
    process.env.FACTORY_MIND_BUCKET = 'factory-prod-mind-bcl-factory';
    process.env.FACTORY_SECRETS_GCP_PREFIX = 'factory-prod-';
    process.env.FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS = 'ANTHROPIC_API_KEY,NOTION_API_KEY';

    assert.equal(
      resolveGcpSecretId('connections/notion/token'),
      'factory-prod-connections---notion---token',
    );
    assert.deepEqual(
      agentEnvironment('factory-prod-mind-bcl-factory', 'donna', {
        [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH,
      }),
      [
        { name: 'FACTORY_MIND_BUCKET', value: 'factory-prod-mind-bcl-factory' },
        { name: 'MEMORY_STORE_URI', value: 'gcs://factory-prod-mind-bcl-factory' },
        { name: 'MEMORY_PREFIX', value: 'donna' },
        { name: 'MEMORY_DIR', value: '/tmp/mind' },
        { name: 'FACTORY_SKILLS_MANIFEST', value: '/opt/factory/skills.json' },
      ],
    );

    let capturedJob: any;
    const jobName = await registerAgentJob(
      'donna',
      `${AR}:donna-e3410b53beb5`,
      ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN'],
      'factory-agent-donna@bcl-factory.iam.gserviceaccount.com',
      'donna',
      { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH },
      {
        client: {
          async createJob(req: any) {
            capturedJob = req.job;
            return [{ promise: async () => {} }] as any;
          },
          async updateJob() {
            return [{ promise: async () => {} }] as any;
          },
        },
      },
    );
    assert.equal(jobName, 'factory-agent-donna');
    const envVars: Array<{ name: string; value?: string; valueSource?: any }> =
      capturedJob.template.template.containers[0].env;
    const names = envVars.map((e) => e.name);
    assert.ok(names.includes('DISCORD_BOT_TOKEN'));
    assert.equal(names.includes('ANTHROPIC_API_KEY'), false, 'gatekeeper-held secret must not be injected');
    const discordSecret = envVars.find((e) => e.name === 'DISCORD_BOT_TOKEN');
    assert.equal(discordSecret?.valueSource?.secretKeyRef?.secret, 'factory-prod-DISCORD_BOT_TOKEN');
  });

  it('provisions agent SA with idempotent GCS condition binding and S1 secret filtering', async () => {
    process.env.FACTORY_GCP_PROJECT = 'bcl-factory';
    process.env.FACTORY_MIND_BUCKET = 'factory-prod-mind-bcl-factory';
    process.env.FACTORY_SECRETS_GCP_PREFIX = 'factory-prod-';
    process.env.FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS = 'ANTHROPIC_API_KEY';

    const requests: Array<{ url: string; method: string; data?: any }> = [];
    const saEmail = await provisionAgentServiceAccount('donna', ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN'], {
      client: {
        async request(req) {
          requests.push(req);
          if (req.url.endsWith('/iam') && req.method === 'GET') {
            return {
              data: {
                bindings: [
                  {
                    role: 'roles/storage.objectAdmin',
                    members: ['serviceAccount:factory-agent-donna@bcl-factory.iam.gserviceaccount.com'],
                    condition: { title: 'own-mind-prefix-donna' },
                  },
                ],
              },
            };
          }
          if (req.url.endsWith(':getIamPolicy')) {
            return { data: { bindings: [] } };
          }
          return { data: {} };
        },
      },
    });
    assert.equal(saEmail, 'factory-agent-donna@bcl-factory.iam.gserviceaccount.com');
    const iamPut = requests.find((r) => r.url.endsWith('/iam') && r.method === 'PUT');
    assert.equal(iamPut?.data.bindings.length, 1, 'idempotent condition binding on redeploy');
    const secretPost = requests.filter((r) => r.url.endsWith(':setIamPolicy'));
    assert.equal(secretPost.length, 1);
    assert.ok(secretPost[0].url.includes('secrets/factory-prod-DISCORD_BOT_TOKEN'));
  });
});
