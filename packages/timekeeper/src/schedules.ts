import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cronMatches, getZonedTimeParts } from './cron.js';

/** How a schedule came to be: an agent called the API with its run token, an operator used the console, or a direct API call. */
export type ScheduleOrigin = 'agent' | 'console' | 'api';

/**
 * Whose authority a schedule's runs carry (DESIGN_AUTHORITY.md E12, GAP-131): an external identity, a Cloudflare
 * principal, or the factory itself. The Timekeeper only stores it; the factory derives it and decides what it allows.
 */
export type ScheduleRequester =
  | { kind: 'identity'; provider: string; id: string }
  | { kind: 'principal'; actor: string }
  | { kind: 'system' };

export type ScheduledAction = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  timezone?: string; // Default: 'America/Los_Angeles'
  channelId?: string; // Discord channel ID for delivery
  prompt: string;
  enabled: boolean;
  createdAt: string;
  /** How it was created. Absent on a schedule saved before this was recorded. */
  createdVia?: ScheduleOrigin;
  /** Whose authority its runs carry. Absent on a schedule saved before this was recorded, which reads as `system`. */
  requestedBy?: ScheduleRequester;
  lastRunAt?: string;
  lastRunMinute?: string;
};

export class ScheduleStore {
  private schedules: Map<string, ScheduledAction> = new Map();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load();
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const items = JSON.parse(raw) as ScheduledAction[];
      for (const item of items) {
        if (item && item.id) {
          this.schedules.set(item.id, item);
        }
      }
    } catch (err) {
      console.warn('[schedules] Failed to load schedules from disk:', err);
    }
  }

  private persist() {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.schedules.values()], null, 2), 'utf8');
    } catch (err) {
      console.warn('[schedules] Failed to persist schedules to disk:', err);
    }
  }

  list(filter?: { agentId?: string }): ScheduledAction[] {
    const all = [...this.schedules.values()];
    if (filter?.agentId) {
      return all.filter((s) => s.agentId === filter.agentId);
    }
    return all;
  }

  get(id: string): ScheduledAction | undefined {
    return this.schedules.get(id);
  }

  save(action: ScheduledAction): void {
    this.schedules.set(action.id, action);
    this.persist();
  }

  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  checkDue(date = new Date()): ScheduledAction[] {
    const due: ScheduledAction[] = [];
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      const tz = schedule.timezone || 'America/Los_Angeles';
      const zoned = getZonedTimeParts(date, tz);
      const minuteKey = `${zoned.year}-${zoned.month}-${zoned.day} ${zoned.hour}:${zoned.minute}`;

      if (schedule.lastRunMinute === minuteKey) {
        continue; // Already ran this minute
      }

      if (cronMatches(schedule.cron, zoned)) {
        schedule.lastRunMinute = minuteKey;
        schedule.lastRunAt = date.toISOString();
        due.push(schedule);
      }
    }
    if (due.length > 0) {
      this.persist();
    }
    return due;
  }
}
