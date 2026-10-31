/**
 * E1.1 (#292): helper (subagent) records on disk, `<registryDir>/subagents/<id>.json`, beside the agent records, so a
 * helper survives a restart. A record that no longer validates is skipped on load, never trusted. With no directory
 * nothing is read or written.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSubagent, type SubagentDefinition } from '@beercanlabs/factory-contract';

export type SubagentRecord = SubagentDefinition & { kind: 'subagent'; registeredBy: string; registeredAt: string };

export class SubagentStore {
  private readonly dir: string | undefined;
  constructor(registryDir: string | undefined, private readonly warn: (message: string, err?: unknown) => void = (m, e) => console.warn(`[registrar] ${m}`, e ?? '')) {
    this.dir = registryDir ? join(registryDir, 'subagents') : undefined;
  }

  load(): Map<string, SubagentRecord> {
    const map = new Map<string, SubagentRecord>();
    if (!this.dir || !existsSync(this.dir)) return map;
    for (const f of readdirSync(this.dir).filter((n) => n.endsWith('.json'))) {
      try {
        const { kind: _kind, registeredBy, registeredAt, ...definition } = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Record<string, unknown>;
        const v = validateSubagent(definition);
        if (v.ok && typeof registeredBy === 'string' && typeof registeredAt === 'string') map.set(v.value.id, { ...v.value, kind: 'subagent', registeredBy, registeredAt });
        else this.warn(`skipped invalid helper record ${f}`);
      } catch (err) {
        this.warn(`failed to read helper record ${f}`, err);
      }
    }
    return map;
  }

  /** Writes the record; throws when it cannot, so the caller can refuse the registration. */
  save(record: SubagentRecord): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
  }
}
