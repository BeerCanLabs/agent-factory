import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRecord } from './catalog.js';
import type { Runtime, TaskStatus } from './runtime.js';

const execFileAsync = promisify(execFile);

export type EcsCli = (args: string[]) => Promise<string>;

export function defaultEcsCli(region?: string): EcsCli {
  return async (args) => {
    const extra = region ? ['--region', region] : [];
    const { stdout } = await execFileAsync('aws', [...args, ...extra, '--output', 'json'], { encoding: 'utf8' });
    return stdout;
  };
}

/**
 * Agents run as ECS tasks started from zero. Secret values are never passed in RunTask overrides
 * (those are visible to DescribeTasks and CloudTrail): the task definition's `secrets` block injects
 * them from Secrets Manager. Overrides carry only run metadata and the short-lived run token.
 */
export function ecsRuntime(opts: {
  cluster: string;
  taskMap: Record<string, string>;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
  workerContainer?: string;
  cli?: EcsCli;
}): Runtime {
  const cli = opts.cli ?? defaultEcsCli(process.env.AWS_REGION);
  const container = opts.workerContainer ?? 'worker';
  const running = new Map<string, string>();

  return {
    running: (id) => running.has(id),
    async start(agent, _secrets, ctx) {
      const family = opts.taskMap[agent.id] || (agent.provider === 'cloud' ? `agent-${agent.id}` : undefined);
      if (!family) throw new Error(`no ECS task definition mapped for ${agent.id}`);
      const net = JSON.stringify({
        awsvpcConfiguration: {
          subnets: opts.subnets,
          securityGroups: opts.securityGroups,
          assignPublicIp: opts.assignPublicIp === false ? 'DISABLED' : 'ENABLED',
        },
      });
      const overrides = JSON.stringify({
        containerOverrides: [
          { name: agent.provider === 'cloud' ? 'agent-container' : container, environment: Object.entries(ctx.runEnv).map(([name, value]) => ({ name, value })) },
        ],
      });
      const out = await cli([
        'ecs',
        'run-task',
        '--cluster',
        opts.cluster,
        '--task-definition',
        family,
        '--launch-type',
        'FARGATE',
        '--network-configuration',
        net,
        '--overrides',
        overrides,
        '--started-by',
        `factory:${ctx.runId}`.slice(0, 36),
      ]);
      const parsed = JSON.parse(out || '{}') as { tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> };
      const arn = parsed.tasks?.[0]?.taskArn;
      if (!arn) throw new Error(`RunTask failed: ${parsed.failures?.map((f) => f.reason).join(', ') || 'no task returned'}`);
      running.set(agent.id, arn);
      return { handle: arn };
    },
    async stop(agent, handle) {
      const arn = handle ?? running.get(agent.id);
      if (!arn) return null;
      await cli(['ecs', 'stop-task', '--cluster', opts.cluster, '--task', arn, '--reason', 'factory scale-to-zero']);
      running.delete(agent.id);
      return 0;
    },
    async status(handle): Promise<TaskStatus> {
      const out = await cli(['ecs', 'describe-tasks', '--cluster', opts.cluster, '--tasks', handle]);
      const parsed = JSON.parse(out || '{}') as {
        tasks?: Array<{ lastStatus?: string; stoppedReason?: string; containers?: Array<{ name?: string; exitCode?: number }> }>;
      };
      const task = parsed.tasks?.[0];
      if (!task) return { state: 'unknown' };
      if (task.lastStatus !== 'STOPPED') return { state: 'running' };
      for (const [id, arn] of running) if (arn === handle) running.delete(id);
      const worker = task.containers?.find((c) => c.name === container || c.name === 'agent-container');
      return { state: 'stopped', exitCode: worker?.exitCode ?? null, reason: task.stoppedReason };
    },
    async deliver() {
      /* conversation handoff is HTTP to a running task; mailbox is control plane */
    },
  };
}

export function parseTaskMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [id, family] = pair.split(':').map((s) => s.trim());
    if (id && family) out[id] = family;
  }
  return out;
}

