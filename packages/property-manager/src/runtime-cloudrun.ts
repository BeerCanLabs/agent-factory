import { GoogleAuth } from 'google-auth-library';
import type { Runtime, TaskStatus } from './runtime.js';

export type CloudRunExecutionDesc = {
  name?: string;
  completionTime?: string;
  succeededCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  conditions?: Array<{
    type?: string;
    state?: string;
    reason?: string;
    message?: string;
  }>;
};

export type CloudRunApi = {
  runJob(
    jobName: string,
    containerName: string,
    env: Array<{ name: string; value: string }>,
  ): Promise<{ executionName: string }>;
  cancelExecution(executionName: string): Promise<void>;
  getExecution(executionName: string): Promise<CloudRunExecutionDesc | null>;
};

export function defaultCloudRunApi(opts: { projectId: string; region: string }): CloudRunApi {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const parent = `projects/${opts.projectId}/locations/${opts.region}`;

  async function token(): Promise<string> {
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    const t = typeof res === 'string' ? res : res?.token;
    if (!t) throw new Error('Unable to acquire GCP access token for Cloud Run Jobs API');
    return t;
  }

  return {
    async runJob(jobName, containerName, env) {
      const t = await token();
      const fullJob = jobName.startsWith('projects/') ? jobName : `${parent}/jobs/${jobName}`;
      const res = await fetch(`https://run.googleapis.com/v2/${fullJob}:run`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                name: containerName,
                env,
              },
            ],
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloud Run runJob(${jobName}) failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        name?: string;
        metadata?: { name?: string };
        response?: { name?: string };
      };
      const executionName = data.metadata?.name || data.response?.name || data.name;
      if (!executionName) {
        throw new Error(`Cloud Run runJob(${jobName}) returned no execution name`);
      }
      return { executionName };
    },

    async cancelExecution(executionName) {
      const t = await token();
      const res = await fetch(`https://run.googleapis.com/v2/${executionName}:cancel`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (res.status === 404 || res.status === 400 || res.status === 409) {
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloud Run cancelExecution(${executionName}) failed (${res.status}): ${text.slice(0, 300)}`);
      }
    },

    async getExecution(executionName) {
      const t = await token();
      const res = await fetch(`https://run.googleapis.com/v2/${executionName}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${t}`,
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloud Run getExecution(${executionName}) failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return (await res.json()) as CloudRunExecutionDesc;
    },
  };
}

/**
 * Agents on GCP run as Cloud Run Job executions started from zero.
 * Secret values are never passed in `runJob` overrides (they are bound from Secret Manager on the
 * Job template); overrides carry only non-secret run metadata and the short-lived run token.
 */
export function cloudRunRuntime(opts: {
  projectId: string;
  region: string;
  jobMap: Record<string, string>;
  workerContainer?: string;
  api?: CloudRunApi;
}): Runtime {
  const api = opts.api ?? defaultCloudRunApi({ projectId: opts.projectId, region: opts.region });
  const container = opts.workerContainer ?? 'worker';
  const running = new Map<string, string>();

  return {
    running: (id) => running.has(id),
    async start(agent, _secrets, ctx) {
      const deployed = Boolean(agent.deployedCommit);
      const mapped = deployed ? undefined : opts.jobMap[agent.id];
      const jobName =
        mapped ??
        (deployed || agent.provider === 'cloud' || agent.provider === 'gcp'
          ? `factory-agent-${agent.id}`
          : undefined);
      if (!jobName) throw new Error(`no Cloud Run Job mapped for ${agent.id}`);

      const env = Object.entries(ctx.runEnv).map(([name, value]) => ({ name, value }));
      const { executionName } = await api.runJob(jobName, container, env);
      running.set(agent.id, executionName);
      return { handle: executionName };
    },
    async stop(agent, handle) {
      const executionName = handle ?? running.get(agent.id);
      if (!executionName) return null;
      await api.cancelExecution(executionName);
      running.delete(agent.id);
      return 0;
    },
    async status(handle): Promise<TaskStatus> {
      const exec = await api.getExecution(handle);
      if (!exec) return { state: 'unknown' };
      const completedCond = exec.conditions?.find((c) => c.type === 'Completed');
      const condTerminal =
        completedCond?.state === 'CONDITION_SUCCEEDED' || completedCond?.state === 'CONDITION_FAILED';
      if (!exec.completionTime && !condTerminal) {
        return { state: 'running' };
      }
      for (const [id, execName] of running) {
        if (execName === handle) running.delete(id);
      }
      const succeeded =
        (exec.succeededCount ?? 0) > 0 &&
        (exec.failedCount ?? 0) === 0 &&
        (exec.cancelledCount ?? 0) === 0 &&
        completedCond?.state !== 'CONDITION_FAILED';
      return {
        state: 'stopped',
        exitCode: succeeded ? 0 : 1,
        reason: completedCond?.message || completedCond?.reason,
      };
    },
    async deliver() {
      /* conversation handoff is HTTP to a running task; mailbox is control plane */
    },
  };
}

export function parseJobMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [id, job] = pair.split(':').map((s) => s.trim());
    if (id && job) out[id] = job;
  }
  return out;
}
