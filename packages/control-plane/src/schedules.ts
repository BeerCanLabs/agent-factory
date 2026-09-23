import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cronMatches, type ZonedTimeParts } from './scheduler.js';

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
  lastRunAt?: string;
  lastRunMinute?: string;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getZonedTimeParts(date = new Date(), timeZone = 'America/Los_Angeles'): ZonedTimeParts {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    const parts = formatter.formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hour: parseInt(map.hour, 10),
      minute: parseInt(map.minute, 10),
      weekday: WEEKDAYS[map.weekday] ?? 0,
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
}

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
