import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRecord } from './catalog.js';
import type { Runtime } from './runtime.js';

const execFileAsync = promisify(execFile);

export type EcsCli = (args: string[]) => Promise<string>;

export function defaultEcsCli(region?: string): EcsCli {
  return async (args) => {
    const extra = region ? ['--region', region] : [];
    const { stdout } = await execFileAsync('aws', [...args, ...extra], { encoding: 'utf8' });
    return stdout;
  };
}

export function ecsRuntime(opts: {
  cluster: string;
  taskMap: Record<string, string>;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
  cli?: EcsCli;
}): Runtime {
  const cli = opts.cli ?? defaultEcsCli(process.env.AWS_REGION);
  const running = new Map<string, string>();

  return {
    running: (id) => running.has(id),
    async start(agent) {
      if (running.has(agent.id)) return;
      const family = opts.taskMap[agent.id];
      if (!family) {
        throw new Error(`no ECS task definition mapped for ${agent.id}`);
      }
      const net = JSON.stringify({
        awsvpcConfiguration: {
          subnets: opts.subnets,
          securityGroups: opts.securityGroups,
          assignPublicIp: opts.assignPublicIp === false ? 'DISABLED' : 'ENABLED',
        },
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
      ]);
      const parsed = JSON.parse(out || '{}') as { tasks?: Array<{ taskArn?: string }> };
      const arn = parsed.tasks?.[0]?.taskArn;
      if (arn) running.set(agent.id, arn);
    },
    async stop(agent) {
      const arn = running.get(agent.id);
      if (!arn) return null;
      await cli(['ecs', 'stop-task', '--cluster', opts.cluster, '--task', arn]);
      running.delete(agent.id);
      return 0;
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
