import type { AgentRecord } from './catalog.js';

export type ZonedTimeParts = {
  year?: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

/** Minimal 5-field cron: star, comma, range, or star-slash-n on each field. */
export function cronMatches(schedule: string, dateOrParts: Date | ZonedTimeParts = new Date()): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  const time = 'minute' in dateOrParts && 'hour' in dateOrParts
    ? dateOrParts
    : {
        minute: dateOrParts.getMinutes(),
        hour: dateOrParts.getHours(),
        day: dateOrParts.getDate(),
        month: dateOrParts.getMonth() + 1,
        weekday: dateOrParts.getDay(),
      };
  return (
    fieldMatches(minute, time.minute) &&
    fieldMatches(hour, time.hour) &&
    fieldMatches(day, time.day) &&
    fieldMatches(month, time.month) &&
    (fieldMatches(weekday, time.weekday) || (weekday === '7' && time.weekday === 0))
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.includes(',')) {
    return field.split(',').some((f) => fieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }
  if (field.startsWith('*/')) {
    const n = Number(field.slice(2));
    return n > 0 && value % n === 0;
  }
  return Number(field) === value;
}

export function agentsDueForCron(agents: Iterable<AgentRecord>, date = new Date()): AgentRecord[] {
  const due: AgentRecord[] = [];
  for (const agent of agents) {
    for (const trigger of agent.triggers) {
      if (trigger.type === 'cron' && cronMatches(trigger.schedule, date)) due.push(agent);
    }
  }
  return due;
}
