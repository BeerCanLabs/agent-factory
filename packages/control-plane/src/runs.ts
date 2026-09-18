import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TERMINAL_STATES = [
  'DONE',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'PRE_FLIGHT_MISSING_SECRET',
] as const;

export type RunState =
  | 'QUEUED'
  | 'STARTING'
  | 'WORKING'
  | 'BLOCKED_BUDGET_EXCEEDED'
  | 'BLOCKED_FOR_HUMAN'
  | 'BLOCKED_UNHEALTHY'
  | (typeof TERMINAL_STATES)[number];

export type Run = {
  runId: string;
  agentId: string;
  state: RunState;
  actor: string;
  trigger: string;
  createdAt: string;
  updatedAt: string;
  input?: unknown;
  callbackUrl?: string;
  taskHandle?: string;
  exitCode?: number | null;
  result?: unknown;
  error?: string;
  missing?: string[];
};

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export type RunStore = {
  create(fields: Omit<Run, 'runId' | 'createdAt' | 'updatedAt'>): Run;
  get(runId: string): Run | undefined;
  update(runId: string, patch: Partial<Omit<Run, 'runId' | 'agentId' | 'createdAt'>>): Run;
  list(filter?: { agentId?: string | null; active?: boolean }): Run[];
};

function stamp(): string {
  return new Date().toISOString();
}

export class MemoryRunStore implements RunStore {
  protected readonly runs = new Map<string, Run>();

  create(fields: Omit<Run, 'runId' | 'createdAt' | 'updatedAt'>): Run {
    const now = stamp();
    const run: Run = { ...fields, runId: randomUUID(), createdAt: now, updatedAt: now };
    this.runs.set(run.runId, run);
    this.persist(run);
    return { ...run };
  }

  get(runId: string): Run | undefined {
    const r = this.runs.get(runId);
    return r ? { ...r } : undefined;
  }

  update(runId: string, patch: Partial<Omit<Run, 'runId' | 'agentId' | 'createdAt'>>): Run {
    const cur = this.runs.get(runId);
    if (!cur) throw new Error(`unknown run ${runId}`);
    const next: Run = { ...cur, ...patch, updatedAt: stamp() };
    this.runs.set(runId, next);
    this.persist(next);
    return { ...next };
  }

  list(filter: { agentId?: string | null; active?: boolean } = {}): Run[] {
    return [...this.runs.values()]
      .filter((r) => (!filter.agentId || r.agentId === filter.agentId) && (!filter.active || !isTerminal(r.state)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }));
  }

  protected persist(_run: Run): void {}
}

/** One JSON document per run, replaced atomically. Survives control-plane restarts. */
export class FileRunStore extends MemoryRunStore {
  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const run = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Run;
      this.runs.set(run.runId, run);
    }
  }

  protected persist(run: Run): void {
    const path = join(this.dir, `${run.runId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(run));
    renameSync(tmp, path);
  }
}

export { RunTokens } from '@beercanlabs/factory-auth';
