import type { AgentRecord } from './catalog.js';

/** Minimal 5-field cron: star or star-slash-n on each field. */
export function cronMatches(schedule: string, date = new Date()): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  return (
    fieldMatches(minute, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(day, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) &&
    fieldMatches(weekday, date.getDay())
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
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
