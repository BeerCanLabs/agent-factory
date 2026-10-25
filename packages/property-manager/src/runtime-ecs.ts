import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRecord } from '@beercanlabs/factory-registrar';
import type { Runtime, TaskStatus } from './runtime.js';

const execFileAsync = promisify(execFile);

export type EcsCli = (args: string[]) => Promise<string>;

export function defaultEcsCli(region?: string): EcsCli {
  const resolvedRegion = region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  return async (args) => {
    const { stdout } = await execFileAsync('aws', [...args, '--region', resolvedRegion, '--output', 'json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return stdout;
  };
}

/**
 * A role created moments before its first RunTask is not yet assumable everywhere: IAM is eventually consistent, and
 * ECS answers with a ClientException ("ECS was unable to assume the role ... verify that the role being passed has the
 * proper trust relationship") even though the trust policy is right. Only that error is retried.
 */
export function isRoleNotYetAssumable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECS was unable to assume the role/i.test(msg);
}

export const ASSUME_ROLE_RETRY_WINDOW_MS = 90_000;
export const ASSUME_ROLE_RETRY_DELAY_MS = 5_000;

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
  /** How long RunTask is retried while a just-created task role propagates (default 90s). */
  assumeRoleRetryWindowMs?: number;
  assumeRoleRetryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Runtime {
  const cli = opts.cli ?? defaultEcsCli(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1');
  const container = opts.workerContainer ?? 'worker';
  const windowMs = opts.assumeRoleRetryWindowMs ?? ASSUME_ROLE_RETRY_WINDOW_MS;
  const delayMs = opts.assumeRoleRetryDelayMs ?? ASSUME_ROLE_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const running = new Map<string, string>();

  return {
    running: (id) => running.has(id),
    async start(agent, _secrets, ctx) {
      // An agent deployed through admission (§6.8 L4) runs the task definition the deploy registered for its
      // admitted commit, never a statically mapped one.
      const deployed = Boolean(agent.deployedCommit);
      const mapped = deployed ? undefined : opts.taskMap[agent.id];
      const family = mapped ?? (deployed || agent.provider === 'cloud' ? `agent-${agent.id}` : undefined);
      if (!family) throw new Error(`no ECS task definition mapped for ${agent.id}`);
      // The container name follows where the task definition came from: landing-zone mapped tasks use the
      // configured worker container; task definitions the factory registers (aws/ecs.ts) use 'agent-container'.
      const workerName = mapped ? container : 'agent-container';
      const net = JSON.stringify({
        awsvpcConfiguration: {
          subnets: opts.subnets,
          securityGroups: opts.securityGroups,
          assignPublicIp: opts.assignPublicIp === false ? 'DISABLED' : 'ENABLED',
        },
      });
      const overrides = JSON.stringify({
        containerOverrides: [
          { name: workerName, environment: Object.entries(ctx.runEnv).map(([name, value]) => ({ name, value })) },
        ],
      });
      const runTaskArgs = [
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
      ];
      const deadline = now() + windowMs;
      let attempts = 0;
      let out: string;
      for (;;) {
        attempts += 1;
        try {
          out = await cli(runTaskArgs);
          break;
        } catch (err) {
          if (!isRoleNotYetAssumable(err)) throw err;
          if (ctx.abandoned?.()) throw new Error('RunTask abandoned: the run was cancelled or the agent paused while waiting for its task role');
          if (now() + delayMs > deadline) {
            // Only ECS's own answer: the command line carries the run token and egress environment.
            const full = err instanceof Error ? err.message : String(err);
            const detail = full.startsWith('Command failed:') ? full.slice(full.indexOf('\n') + 1).trim() : full;
            throw new Error(
              `RunTask failed: ECS could not assume the task role after ${attempts} attempts over ${Math.round(windowMs / 1000)}s ` +
                `(IAM propagation of a new role did not finish, or the role's trust policy is wrong): ${detail}`,
            );
          }
          await sleep(delayMs);
          if (ctx.abandoned?.()) throw new Error('RunTask abandoned: the run was cancelled or the agent paused while waiting for its task role');
        }
      }
      const parsed = JSON.parse(out || '{}') as { tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> };
      const arn = parsed.tasks?.[0]?.taskArn;
      if (!arn) throw new Error(`RunTask failed: ${parsed.failures?.map((f) => f.reason).join(', ') || 'no task returned'}`);
      running.set(agent.id, arn);
      return { handle: arn };
    },
    async stop(agent, handle) {
      const arn = handle ?? running.get(agent.id);
      if (!arn) return null;
      try {
        await cli(['ecs', 'stop-task', '--cluster', opts.cluster, '--task', arn, '--reason', 'factory scale-to-zero']);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('task was not found') && !msg.includes('referenced task was not found')) {
          throw err;
        }
      }
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

