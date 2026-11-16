// GAP-263: a mind prefix is an agent's whole storage grant (`<bucket>/<prefix>/*`), so it must name exactly one agent.
type Rec = { id: string; memoryPrefix?: string };

export class MindPrefixRefusedError extends Error {
  name = 'MindPrefixRefusedError';
}

/** One plain key segment: no `/` (it cannot contain or sit inside another agent's prefix), no wildcard, no `..`. */
export function checkMindPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prefix) || prefix.includes('..')) {
    throw new MindPrefixRefusedError(`invalid mind prefix ${JSON.stringify(prefix)}: one key segment (letters, digits, . _ -)`);
  }
  return prefix;
}

/** As registerCompute uses it: `memoryPrefix`, else the id. */
export const effectiveMindPrefix = (a: Rec): string => a.memoryPrefix || a.id;

/** The other registered agent holding `prefix`, if any. */
export function mindPrefixHolder(agents: Iterable<Rec>, agentId: string, prefix: string): string | undefined {
  for (const a of agents) if (a.id !== agentId && effectiveMindPrefix(a) === prefix) return a.id;
  return undefined;
}

/** Prefixes more than one registered agent holds, with their holders. */
export function duplicateMindPrefixes(agents: Iterable<Rec>): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const a of agents) by.set(effectiveMindPrefix(a), [...(by.get(effectiveMindPrefix(a)) ?? []), a.id]);
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** The prefix to grant `agent`: valid, and held by no other registered agent. Else MindPrefixRefusedError. */
export function ownMindPrefix(agents: Iterable<Rec>, agent: Rec): string {
  const prefix = checkMindPrefix(effectiveMindPrefix(agent));
  const holder = mindPrefixHolder(agents, agent.id, prefix);
  if (holder) throw new MindPrefixRefusedError(`mind prefix ${JSON.stringify(prefix)} already belongs to agent ${holder}`);
  return prefix;
}
