import { cronMatches } from '@beercanlabs/factory-timekeeper';
import type { AgentRecord } from './catalog.js';

export function agentsDueForCron(agents: Iterable<AgentRecord>, date = new Date()): AgentRecord[] {
  const due: AgentRecord[] = [];
  for (const agent of agents) {
    for (const trigger of agent.triggers) {
      if (trigger.type === 'cron' && cronMatches(trigger.schedule, date)) due.push(agent);
    }
  }
  return due;
}
