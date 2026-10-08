import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRecord } from './catalog.js';

/** Where a failed write is reported; a failed write never fails the request that caused it. */
export type RegistryWarn = (message: string, err: unknown) => void;

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
