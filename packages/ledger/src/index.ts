import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, toLedgerEvent, type LedgerEvent } from './sanitize.js';

export type { LedgerEvent } from './sanitize.js';
export {
  LEDGER_TYPES,
  canonicalJson,
  payloadHash,
  redactSecrets,
  secretValuesFromEnv,
  toLedgerEvent,
} from './sanitize.js';
export { FileCheckpointSink, S3CheckpointSink, GcsCheckpointSink, checkpointSinkFromEnv } from './checkpoints.js';
export type { Checkpoint, CheckpointRef, CheckpointSink } from './checkpoints.js';
import type { CheckpointSink } from './checkpoints.js';

/** A stored row: the sanitized event plus its position and hash in the chain. */
export type ChainedEvent = LedgerEvent & { seq: number; prevHash: string; hash: string };

export type LedgerFilter = { agent?: string | null; from?: string | null; to?: string | null };

export type VerifyResult =
  | { ok: true; rows: number; head: string; checkpointsChecked: number }
  | { ok: false; rows: number; firstBadSeq: number; reason: string };

export type LedgerStore = {
  append(event: Record<string, unknown>): ChainedEvent;
  query(filter?: LedgerFilter): ChainedEvent[];
  head(): { seq: number; hash: string };
  verify(checkpoints?: Array<{ toSeq: number; hash: string }>): VerifyResult;
};

export type LedgerOptions = {
  secrets?: Iterable<string> | (() => Iterable<string>);
};

export const GENESIS = '0'.repeat(64);

function secretsOf(opts?: LedgerOptions): Iterable<string> {
  const s = opts?.secrets;
  if (!s) return [];
  return typeof s === 'function' ? s() : s;
}

/** hash = sha256(prevHash + "\n" + canonical(event without hash)). */
export function rowHash(prevHash: string, row: LedgerEvent & { seq: number; prevHash: string }): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(row)}`, 'utf8').digest('hex');
}

function chain(prev: { seq: number; hash: string }, event: LedgerEvent): ChainedEvent {
  const body = { ...event, seq: prev.seq + 1, prevHash: prev.hash };
  return { ...body, hash: rowHash(prev.hash, body) };
}

function matches(e: LedgerEvent, f: LedgerFilter): boolean {
  if (f.agent && e.agentId !== f.agent) return false;
  if (f.from && e.timestamp < f.from) return false;
  if (f.to && e.timestamp > f.to) return false;
  return true;
}

/**
 * If multiple writers appended concurrent branches (e.g. during a service deployment race),
 * extract the unbroken, linearly incrementing canonical chain that reaches the highest valid sequence.
 */
export function canonicalChain(rows: ChainedEvent[], genesis: string): ChainedEvent[] {
  if (rows.length <= 1) return rows;

  const seenSeqs = new Set<number>();
  let hasDuplicates = false;
  for (const r of rows) {
    if (seenSeqs.has(r.seq)) {
      hasDuplicates = true;
      break;
    }
    seenSeqs.add(r.seq);
  }

  if (!hasDuplicates) return rows;

  const byHash = new Map<string, ChainedEvent>();
  for (const r of rows) byHash.set(r.hash, r);

  const maxSeq = Math.max(...rows.map((r) => r.seq));
  const candidates = rows.filter((r) => r.seq === maxSeq);
  for (const tip of candidates) {
    const chain: ChainedEvent[] = [];
    let curr: ChainedEvent | undefined = tip;
    let valid = true;

    while (curr) {
      chain.unshift(curr);
      if (curr.prevHash === genesis) {
        if (curr.seq !== 1) valid = false;
        break;
      }
      const parent = byHash.get(curr.prevHash);
      if (!parent || parent.seq !== curr.seq - 1) {
        valid = false;
        break;
      }
      curr = parent;
    }

    if (valid && chain.length === tip.seq && chain[0]?.prevHash === genesis) {
      return chain;
    }
  }

  return rows;
}

/** Recompute the chain from `genesis`, then confirm each externally held checkpoint lands on it. */
export function verifyChain(
  rows: ChainedEvent[],
  genesis: string,
  checkpoints: Array<{ toSeq: number; hash: string }> = [],
): VerifyResult {
  const chain = canonicalChain(rows, genesis);
  let prev = genesis;
  for (let i = 0; i < chain.length; i++) {
    const { hash, ...body } = chain[i];
    if (body.seq !== i + 1) return { ok: false, rows: chain.length, firstBadSeq: i + 1, reason: `seq gap: found ${body.seq}` };
    if (body.prevHash !== prev) return { ok: false, rows: chain.length, firstBadSeq: body.seq, reason: 'prevHash does not link' };
    if (rowHash(prev, body) !== hash) return { ok: false, rows: chain.length, firstBadSeq: body.seq, reason: 'row content altered' };
    prev = hash;
  }
  if (!checkpoints.length) {
    return { ok: true, rows: chain.length, head: prev, checkpointsChecked: 0 };
  }

  // Find checkpoints that match rows on disk.
  const confirmedSeqs = new Set<number>();
  for (const c of checkpoints) {
    if (chain[c.toSeq - 1]?.hash === c.hash) {
      confirmedSeqs.add(c.toSeq);
    }
  }

  const maxConfirmedSeq = confirmedSeqs.size > 0 ? Math.max(...confirmedSeqs) : 0;
  const maxCheckpointSeq = Math.max(...checkpoints.map((c) => c.toSeq));

  // The ledger must cover all checkpoints up to the highest one.
  if (chain.length < maxCheckpointSeq) {
    return { ok: false, rows: chain.length, firstBadSeq: chain.length + 1, reason: `rows missing: checkpoint covers seq ${maxCheckpointSeq}` };
  }

  // If the highest checkpoint has not been confirmed, the head has diverged.
  if (!confirmedSeqs.has(maxCheckpointSeq)) {
    return { ok: false, rows: chain.length, firstBadSeq: maxCheckpointSeq, reason: 'chain diverges from WORM checkpoint' };
  }

  // Any checkpoint whose toSeq > maxConfirmedSeq has diverged.
  // Checkpoints with toSeq <= maxConfirmedSeq that do not match are abandoned forks,
  // because a later checkpoint on the verified unbroken chain already mathematically seals earlier rows.
  for (const c of checkpoints) {
    if (c.toSeq > maxConfirmedSeq) {
      return { ok: false, rows: chain.length, firstBadSeq: c.toSeq, reason: 'chain diverges from WORM checkpoint' };
    }
  }

  return { ok: true, rows: chain.length, head: prev, checkpointsChecked: confirmedSeqs.size };
}

/**
 * Append-only, hash-chained JSONL with one writer. Schema and redaction run before the row is
 * hashed, so no prompt text or secret value is ever part of the chain. There is no update or delete.
 */
export class FileLedger implements LedgerStore {
  private rows: ChainedEvent[] = [];
  private readonly genesis: string;

  constructor(
    private readonly filePath: string,
    private readonly opts: LedgerOptions = {},
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    let legacy = '';
    const rawRows: ChainedEvent[] = [];
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line) as ChainedEvent;
        if (typeof row.hash !== 'string') {
          if (rawRows.length) throw new Error(`${filePath}: unchained row after chained rows`);
          legacy += `${line}\n`;
          continue;
        }
        rawRows.push(row);
      }
    }
    // Rows written before chaining existed are sealed under the genesis hash.
    this.genesis = legacy ? createHash('sha256').update(legacy, 'utf8').digest('hex') : GENESIS;
    this.rows = canonicalChain(rawRows, this.genesis);
    if (this.rows.length !== rawRows.length) {
      writeFileSync(filePath, `${legacy}${this.rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { encoding: 'utf8' });
    }
  }

  head() {
    const last = this.rows.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: this.genesis };
  }

  append(event: Record<string, unknown>): ChainedEvent {
    const row = chain(this.head(), toLedgerEvent(event, secretsOf(this.opts)));
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, { encoding: 'utf8' });
    this.rows.push(row);
    return row;
  }

  query(filter: LedgerFilter = {}): ChainedEvent[] {
    return this.rows.filter((e) => matches(e, filter));
  }

  since(seq: number): ChainedEvent[] {
    return this.rows.slice(seq);
  }

  /** Verifies what is on disk now, not the in-memory copy. */
  verify(checkpoints: Array<{ toSeq: number; hash: string }> = []): VerifyResult {
    const onDisk = existsSync(this.filePath)
      ? readFileSync(this.filePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as ChainedEvent)
          .filter((r) => typeof r.hash === 'string')
      : [];
    return verifyChain(onDisk, this.genesis, checkpoints);
  }
}

export class MemoryLedger implements LedgerStore {
  readonly events: ChainedEvent[] = [];
  constructor(private readonly opts: LedgerOptions = {}) {}

  head() {
    const last = this.events.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
  }

  append(event: Record<string, unknown>): ChainedEvent {
    const row = chain(this.head(), toLedgerEvent(event, secretsOf(this.opts)));
    this.events.push(row);
    return row;
  }

  query(filter: LedgerFilter = {}): ChainedEvent[] {
    return this.events.filter((e) => matches(e, filter));
  }

  since(seq: number): ChainedEvent[] {
    return this.events.slice(seq);
  }

  verify(checkpoints: Array<{ toSeq: number; hash: string }> = []): VerifyResult {
    return verifyChain(this.events, GENESIS, checkpoints);
  }
}

/**
 * Ship every row since the last checkpoint to write-once storage. The WORM copy is both the
 * retention copy and the anchor `verify` compares the local chain against.
 */
export class Checkpointer {
  private lastSeq = 0;
  private busy = false;

  constructor(
    private readonly ledger: LedgerStore & { since(seq: number): ChainedEvent[] },
    private readonly sink: CheckpointSink,
  ) {}

  async init(): Promise<void> {
    const refs = await this.sink.list();
    this.lastSeq = refs.reduce((m, r) => Math.max(m, r.toSeq), 0);
  }

  async flush(): Promise<{ toSeq: number; hash: string } | null> {
    if (this.busy) return null;
    const rows = this.ledger.since(this.lastSeq);
    if (!rows.length) return null;
    this.busy = true;
    try {
      const last = rows[rows.length - 1];
      await this.sink.write({ fromSeq: rows[0].seq, toSeq: last.seq, prevHash: rows[0].prevHash, hash: last.hash, rows });
      this.lastSeq = last.seq;
      return { toSeq: last.seq, hash: last.hash };
    } finally {
      this.busy = false;
    }
  }
}
