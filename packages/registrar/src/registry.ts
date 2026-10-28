import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRecord } from './catalog.js';

/** Where a failed write is reported; a failed write never fails the request that caused it. */
export type RegistryWarn = (message: string, err: unknown) => void;

/** The runtime version the factory pins new agents to (RT1): its repository and commit, and the image that runs it. */
export type SharedRuntimePin = {
  repo: string;
  commit: string;
  image: string;
  updatedAt?: string;
  updatedBy?: string;
};

export function saveSharedRuntime(registryDir: string | undefined, pin: SharedRuntimePin): void {
  if (!registryDir) return;
  try {
    mkdirSync(registryDir, { recursive: true });
    const file = join(registryDir, '_runtime.json');
    writeFileSync(file, JSON.stringify(pin, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[registrar] failed to persist shared runtime:`, err);
  }
}

export function loadSharedRuntime(registryDir: string | undefined, env: NodeJS.ProcessEnv = process.env): SharedRuntimePin | undefined {
  if (registryDir) {
    const file = join(registryDir, '_runtime.json');
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as SharedRuntimePin;
        if (parsed && typeof parsed === 'object' && typeof parsed.repo === 'string' && typeof parsed.commit === 'string' && typeof parsed.image === 'string') {
          return parsed;
        }
      } catch (err) {
        console.warn(`[registrar] failed to parse ${file}:`, err);
      }
    }
  }
  const image = env.FACTORY_RUNTIME_IMAGE || env.FACTORY_AGENT_RUNTIME_IMAGE;
  const commit = env.FACTORY_RUNTIME_COMMIT;
  if (image && commit) {
    return {
      repo: env.FACTORY_RUNTIME_REPO || 'https://github.com/BeerCanLabs/agent-factory',
      commit,
      image,
    };
  }
  return undefined;
}

/**
 * The agent registry's records on disk: one `<dir>/<agentId>.json` per registered agent, written as
 * `JSON.stringify(agent, null, 2)` so a record survives a restart (and, being a registry record, wins over the static
 * catalog; `loadDynamicRegistry` reads them back). With no directory every method does nothing. A failed write is
 * handed to `warn` and does not throw.
 */
export class AgentRegistry {
  constructor(
    private readonly dir: string | undefined,
    private readonly warn: RegistryWarn = (message, err) => console.warn(`[registrar] ${message}`, err),
  ) {}

  /** Creates or replaces the agent's record, creating the directory when needed. */
  save(agent: AgentRecord): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
    } catch (err) {
      this.warn(`failed to persist dynamic agent ${agent.id}:`, err);
    }
  }

  /** Rewrites the record of an agent that already has one (a state change); a built-in or static agent has none, so nothing is written. */
  update(agent: AgentRecord): void {
    if (!this.dir) return;
    try {
      const filePath = join(this.dir, `${agent.id}.json`);
      if (existsSync(filePath)) writeFileSync(filePath, JSON.stringify(agent, null, 2), 'utf8');
    } catch (err) {
      this.warn(`failed to persist dynamic agent state ${agent.id}:`, err);
    }
  }

  /** Deletes the agent's record when it has one. */
  remove(agentId: string): void {
    if (!this.dir) return;
    try {
      const filePath = join(this.dir, `${agentId}.json`);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      this.warn(`failed to delete dynamic agent file ${agentId}:`, err);
    }
  }
}

/** The agent registry's records on disk (`registryDir`); with none configured nothing is written. */
export function registryOf(state: { registryDir?: string }): AgentRegistry {
  return new AgentRegistry(state.registryDir, (message, err) => console.warn(`[control-plane] ${message}`, err));
}
