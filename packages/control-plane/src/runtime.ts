import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pullMind, pushMind, type MindStore } from '@beercanlabs/factory-hydrate';
import type { AgentRecord } from './catalog.js';

export type Runtime = {
  start(agent: AgentRecord, env: Record<string, string>): Promise<void>;
  stop(agent: AgentRecord): Promise<number | null>;
  running(id: string): boolean;
  deliver(agent: AgentRecord, payload: unknown): Promise<void>;
};

export function memoryRuntime(opts: {
  store: MindStore;
  ephemeralRoot: string;
  workerCommand?: (agent: AgentRecord) => { cmd: string; args: string[] } | undefined;
  onExit?: (agent: AgentRecord, code: number | null) => void;
}): Runtime {
  const procs = new Map<string, ChildProcess>();

  return {
    running(id) {
      return procs.has(id);
    },
    async start(agent, env) {
      if (procs.has(agent.id)) return;
      const dest = join(opts.ephemeralRoot, agent.id);
      mkdirSync(dest, { recursive: true });
      if (agent.memoryPrefix) pullMind(opts.store, agent.memoryPrefix, dest);
      const spec = opts.workerCommand?.(agent);
      if (!spec) return;
      const child = spawn(spec.cmd, spec.args, {
        cwd: agent.dir,
        env: {
          ...process.env,
          ...env,
          MEMORY_DIR: dest,
          AGENT_ID: agent.id,
          FACTORY_TRACE_PROMPTS: process.env.FACTORY_TRACE_PROMPTS ?? '',
          FACTORY_TRACE_TTL_SECONDS: process.env.FACTORY_TRACE_TTL_SECONDS ?? '',
        },
        stdio: 'inherit',
      });
      procs.set(agent.id, child);
      child.on('exit', (code) => {
        procs.delete(agent.id);
        if (agent.memoryPrefix) pushMind(opts.store, agent.memoryPrefix, dest);
        opts.onExit?.(agent, code);
      });
    },
    async deliver(agent, payload) {
      const dest = join(opts.ephemeralRoot, agent.id);
      mkdirSync(dest, { recursive: true });
      appendFileSync(join(dest, 'inbox.jsonl'), `${JSON.stringify(payload)}\n`);
    },
    async stop(agent) {
      const child = procs.get(agent.id);
      if (!child) {
        const dest = join(opts.ephemeralRoot, agent.id);
        if (agent.memoryPrefix) pushMind(opts.store, agent.memoryPrefix, dest);
        return null;
      }
      const dest = join(opts.ephemeralRoot, agent.id);
      if (agent.memoryPrefix) pushMind(opts.store, agent.memoryPrefix, dest);
      child.kill('SIGTERM');
      procs.delete(agent.id);
      return 0;
    },
  };
}

export function noopRuntime(): Runtime {
  const ids = new Set<string>();
  return {
    running: (id) => ids.has(id),
    async start(agent) {
      ids.add(agent.id);
    },
    async stop(agent) {
      ids.delete(agent.id);
      return 0;
    },
    async deliver() {},
  };
}
