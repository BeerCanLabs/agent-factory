import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toLedgerEvent, type LedgerEvent } from './sanitize.js';

export type { LedgerEvent } from './sanitize.js';
export {
  LEDGER_TYPES,
  canonicalJson,
  payloadHash,
  redactSecrets,
  secretValuesFromEnv,
  toLedgerEvent,
} from './sanitize.js';

export type LedgerStore = {
  append(event: Record<string, unknown>): LedgerEvent;
  query(filter?: { agent?: string | null; from?: string | null; to?: string | null }): LedgerEvent[];
};

export type LedgerOptions = {
  secrets?: Iterable<string> | (() => Iterable<string>);
};

function secretsOf(opts?: LedgerOptions): Iterable<string> {
  const s = opts?.secrets;
  if (!s) return [];
  return typeof s === 'function' ? s() : s;
}

/** Append-only JSONL. Schema + redaction run before flush; no update/delete API. */
export class FileLedger implements LedgerStore {
  constructor(
    private readonly filePath: string,
    private readonly opts: LedgerOptions = {},
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(event: Record<string, unknown>): LedgerEvent {
    const full = toLedgerEvent(event, secretsOf(this.opts));
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
  constructor(private readonly opts: LedgerOptions = {}) {}

  append(event: Record<string, unknown>): LedgerEvent {
    const full = toLedgerEvent(event, secretsOf(this.opts));
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
