import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayEnv, pullMind, pushMind, type MindStore } from '@beercanlabs/factory-hydrate';
import type { AgentRecord } from './catalog.js';

/** `runEnv` is non-secret run metadata (FACTORY_RUN_ID, FACTORY_URL, ...) plus the short-lived run token. */
export type RunContext = { runId: string; runEnv: Record<string, string> };

export type TaskStatus =
  | { state: 'running' }
  | { state: 'stopped'; exitCode: number | null; reason?: string }
  | { state: 'unknown' };

export type Runtime = {
  /** Start compute for one run. `secrets` are the bound values of the cartridge's declared names. */
  start(agent: AgentRecord, secrets: Record<string, string>, ctx: RunContext): Promise<{ handle?: string }>;
  stop(agent: AgentRecord, handle?: string): Promise<number | null>;
  running(id: string): boolean;
  deliver(agent: AgentRecord, payload: unknown): Promise<void>;
  /** Present when tasks outlive the control plane, so runs can be reconciled after a restart. */
  status?(handle: string): Promise<TaskStatus>;
};

export function memoryRuntime(opts: {
  store: MindStore;
  ephemeralRoot: string;
  workerCommand?: (agent: AgentRecord) => { cmd: string; args: string[] } | undefined;
  onExit?: (agent: AgentRecord, code: number | null, ctx: RunContext) => void;
}): Runtime {
  const procs = new Map<string, ChildProcess>();

  return {
    running(id) {
      return procs.has(id);
    },
    async start(agent, secrets, ctx) {
      if (procs.has(agent.id)) return {};
      const dest = join(opts.ephemeralRoot, agent.id);
      mkdirSync(dest, { recursive: true });
      if (agent.memoryPrefix) pullMind(opts.store, agent.memoryPrefix, dest);
      const spec = opts.workerCommand?.(agent);
      if (!spec) return {};
      const child = spawn(spec.cmd, spec.args, {
        cwd: agent.dir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...secrets,
          ...ctx.runEnv,
          ...gatewayEnv(ctx.runEnv),
          MEMORY_DIR: dest,
          AGENT_ID: agent.id,
        },
        stdio: 'inherit',
      });
      procs.set(agent.id, child);
      child.on('exit', (code) => {
        procs.delete(agent.id);
        if (agent.memoryPrefix) pushMind(opts.store, agent.memoryPrefix, dest);
        opts.onExit?.(agent, code, ctx);
      });
      return { handle: `pid:${child.pid}` };
    },
    async deliver(agent, payload) {
      const dest = join(opts.ephemeralRoot, agent.id);
      mkdirSync(dest, { recursive: true });
      appendFileSync(join(dest, 'inbox.jsonl'), `${JSON.stringify(payload)}\n`);
    },
    async stop(agent) {
      const dest = join(opts.ephemeralRoot, agent.id);
      const child = procs.get(agent.id);
      if (!child) {
        if (agent.memoryPrefix) pushMind(opts.store, agent.memoryPrefix, dest);
        return null;
      }
      procs.delete(agent.id);
      child.kill('SIGTERM');
      return 0;
    },
  };
}

export type NoopStart = { agentId: string; secrets: Record<string, string>; runEnv: Record<string, string> };

export function noopRuntime(): Runtime & { started: NoopStart[] } {
  const ids = new Set<string>();
  const started: NoopStart[] = [];
  return {
    started,
    running: (id) => ids.has(id),
    async start(agent, secrets, ctx) {
      ids.add(agent.id);
      started.push({ agentId: agent.id, secrets, runEnv: ctx.runEnv });
      return { handle: `noop:${ctx.runId}` };
    },
    async stop(agent) {
      ids.delete(agent.id);
      return 0;
    },
    async deliver() {},
  };
}

/**
 * Provider-specific infrastructure provisioning for the /deploy lifecycle.
 * The kernel dispatches through this interface; implementations live in
 * provider-specific deploy repos (submind-aws, submind-gcp) or in
 * landing-zone reference code.
 */
export type DeployProvider = {
  /** Build the agent's container image from source. Returns the image URI. */
  buildImage(agentId: string, sourceRef: string): Promise<string>;
  /** Provision IAM / roles / service accounts for the agent. */
  provisionIdentity(agentId: string, secrets: string[]): Promise<{ identity: string; executionIdentity?: string }>;
  /** Register the agent's compute definition (ECS task def, Cloud Run job, etc.). */
  registerCompute(agentId: string, imageUri: string, secrets: string[], identity: string, executionIdentity?: string): Promise<void>;
};
