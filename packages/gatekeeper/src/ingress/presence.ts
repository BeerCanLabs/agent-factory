/**
 * The presence an agent's Discord surface starts with, from the factory's agent list (GAP-176): available only while a
 * run is live, so a message to an agent with no run wakes it instead of being handed to a mailbox nobody reads. The
 * stored agent `state` is not evidence of a run (it can outlive one); the list reports `RUNNING` for a live run.
 */
export function initialPresence(agent: { liveRun?: unknown; state?: unknown }): 'available' | 'offline' {
  if (typeof agent.liveRun === 'boolean') return agent.liveRun ? 'available' : 'offline';
  return agent.state === 'RUNNING' ? 'available' : 'offline';
}
