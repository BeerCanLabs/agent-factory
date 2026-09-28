import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Ledger segments (DESIGN_AUTHORITY.md LG2). A ledger that fails verification is never repaired: it is archived
 * unchanged and recording continues in a new segment whose genesis hash commits to the archive and the reason.
 * Segment 1 is the original ledger (no segment file). The record lives next to the ledger as `<ledger>.segment.json`.
 */
export type SegmentRecord = {
  segment: number;
  /** Chain genesis for this segment: sha256 of the canonical record without this field. */
  genesis: string;
  startedAt: string;
  previous: {
    segment: number;
    archive: string;
    archiveSha256: string;
    failedAtSeq: number;
    failure: string;
    reason: string;
  };
};

const recordPath = (ledgerPath: string) => `${ledgerPath}.segment.json`;

export function readSegment(ledgerPath: string): SegmentRecord | undefined {
  const p = recordPath(ledgerPath);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SegmentRecord) : undefined;
}

export function segmentGenesis(record: Omit<SegmentRecord, 'genesis'>): string {
  const { segment, startedAt, previous } = record;
  return createHash('sha256').update(JSON.stringify({ segment, startedAt, previous }), 'utf8').digest('hex');
}

/**
 * Move the current ledger file aside byte-for-byte and start the next segment. Throws rather than overwrite an
 * existing archive. Returns the new segment record; the caller opens a FileLedger with `genesis: record.genesis`.
 */
export function archiveAndStartSegment(
  ledgerPath: string,
  failure: { failedAtSeq: number; failure: string; reason: string },
  now: () => Date = () => new Date(),
): SegmentRecord {
  if (!failure.reason.trim()) throw new Error('a recovery reason is required');
  const current = readSegment(ledgerPath)?.segment ?? 1;
  const archive = join(dirname(ledgerPath), `${basename(ledgerPath, '.jsonl')}.segment-${current}.archived.jsonl`);
  if (existsSync(archive)) throw new Error(`refusing to overwrite existing archive ${archive}`);
  const bytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.alloc(0);
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
  if (existsSync(ledgerPath)) renameSync(ledgerPath, archive);
  const base = {
    segment: current + 1,
    startedAt: now().toISOString(),
    previous: { segment: current, archive: basename(archive), archiveSha256, ...failure },
  };
  const record: SegmentRecord = { ...base, genesis: segmentGenesis(base) };
  const tmp = `${recordPath(ledgerPath)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, recordPath(ledgerPath));
  return record;
}

/** Checkpoints of segment N > 1 live under `<worm uri>/segment-N` so they never mix with another segment's. */
export function segmentWormUri(uri: string | undefined, record: SegmentRecord | undefined): string | undefined {
  if (!uri || !record || record.segment <= 1) return uri;
  return `${uri.replace(/\/$/, '')}/segment-${record.segment}`;
}
