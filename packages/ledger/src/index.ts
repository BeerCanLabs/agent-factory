import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerEvent = {
  timestamp: string;
  agentId: string;
  type: string;
  actor?: string;
  requestId?: string;
  [k: string]: unknown;
};

export type LedgerStore = {
  append(event: LedgerEvent): LedgerEvent;
  query(filter?: { agent?: string | null; from?: string | null; to?: string | null }): LedgerEvent[];
};

/** Append-only JSONL. No update/delete API — that is the immutability guarantee. */
export class FileLedger implements LedgerStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(event: LedgerEvent): LedgerEvent {
    const full = { ...event, timestamp: event.timestamp || new Date().toISOString() };
    appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, { encoding: 'utf8' });
    return full;
  }

  query(filter: { agent?: string | null; from?: string | null; to?: string | null } = {}): LedgerEvent[] {
    if (!existsSync(this.filePath)) return [];
    const rows = readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
    return rows.filter((e) => {
      if (filter.agent && e.agentId !== filter.agent) return false;
      if (filter.from && e.timestamp < filter.from) return false;
      if (filter.to && e.timestamp > filter.to) return false;
      return true;
    });
  }
}

export class MemoryLedger implements LedgerStore {
  readonly events: LedgerEvent[] = [];
  append(event: LedgerEvent): LedgerEvent {
    const full = { ...event, timestamp: event.timestamp || new Date().toISOString() };
    this.events.push(full);
    return full;
  }
  query(filter: { agent?: string | null; from?: string | null; to?: string | null } = {}): LedgerEvent[] {
    return this.events.filter((e) => {
      if (filter.agent && e.agentId !== filter.agent) return false;
      if (filter.from && e.timestamp < filter.from) return false;
      if (filter.to && e.timestamp > filter.to) return false;
      return true;
    });
  }
}
