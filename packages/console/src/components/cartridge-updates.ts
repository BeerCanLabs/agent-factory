/** Configuration-hosted agents run the pinned shared runtime. Cartridge releases are not their version source. */
export function isConfigurationHostedAgent(agent: { createdFrom?: string | null }): boolean {
  return agent.createdFrom === 'configuration';
}

export type CartridgeUpdateBuckets<T> = {
  /** Agents whose versions come from a repository release. */
  updatesAvailable: T[];
  upToDate: T[];
  /** Agents that must not be offered a GitHub cartridge release, even if stale fields remain. */
  configurationHosted: T[];
};

/**
 * Splits the fleet for the cartridge-update drawer. Configuration-hosted agents are kept out of
 * both release lists so a leftover `installedVersion` or `releaseNotes` (for example SM-finley 1.1.0
 * on Chuck) is not shown as a cartridge version.
 */
export function cartridgeUpdateBuckets<T extends { updateAvailable?: boolean; createdFrom?: string | null }>(
  agents: readonly T[],
): CartridgeUpdateBuckets<T> {
  const configurationHosted: T[] = [];
  const updatesAvailable: T[] = [];
  const upToDate: T[] = [];
  for (const agent of agents) {
    if (isConfigurationHostedAgent(agent)) {
      configurationHosted.push(agent);
      continue;
    }
    if (agent.updateAvailable) updatesAvailable.push(agent);
    else upToDate.push(agent);
  }
  return { updatesAvailable, upToDate, configurationHosted };
}
