import { agentsDueForCron } from './cron.js';
import type { ScheduleStore, ScheduledAction } from './schedules.js';

/** What the Timekeeper needs to know about a cartridge: its id and its triggers. */
export type CronAgent = { id: string; triggers: ReadonlyArray<{ type: string; schedule?: string }> };

/** What the Timekeeper asks the Landlord to fire. It never starts a run itself. */
export type FireRequest =
  | { kind: 'cartridge'; agentId: string }
  | { kind: 'schedule'; schedule: ScheduledAction };

export type TimekeeperOptions = {
  agents: () => Iterable<CronAgent>;
  schedules: ScheduleStore;
  fire: (request: FireRequest) => void | Promise<void>;
  now?: () => Date;
};

export type Timekeeper = {
  /** Ask what is due now and call `fire` for each. A `fire` that throws or rejects does not stop the others. */
  tick(): Promise<void>;
  /** Run `tick` every `intervalMs` (default 60 000). Returns the function that stops it. */
  start(intervalMs?: number): () => void;
};

export function createTimekeeper(options: TimekeeperOptions): Timekeeper {
  const now = options.now ?? (() => new Date());

  const fireOne = async (request: FireRequest): Promise<void> => {
    try {
      await options.fire(request);
    } catch (err) {
      const what = request.kind === 'cartridge' ? `cartridge ${request.agentId}` : `schedule ${request.schedule.id}`;
      console.warn(`[timekeeper] fire failed for ${what}:`, err);
    }
  };

  const tick = async (): Promise<void> => {
    const date = now();
    const requests: FireRequest[] = [];
    // 1. Static cartridge crons
    for (const agent of agentsDueForCron(options.agents(), date)) {
      requests.push({ kind: 'cartridge', agentId: agent.id });
    }
    // 2. Dynamic action schedules
    for (const schedule of options.schedules.checkDue(date)) {
      requests.push({ kind: 'schedule', schedule });
    }
    await Promise.all(requests.map(fireOne));
  };

  const start = (intervalMs = 60_000): (() => void) => {
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
  };

  return { tick, start };
}
