import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLedger } from './index.js';
import { archiveAndStartSegment, readSegment, segmentGenesis, segmentWormUri } from './segment.js';

describe('ledger segments (LG2: archive, never repair)', () => {
  const damaged = () => {
    const dir = mkdtempSync(join(tmpdir(), 'seg-'));
    const path = join(dir, 'ledger.jsonl');
    const l = new FileLedger(path);
    l.append({ agentId: 'a', type: 'action', action: 'ONE' });
    l.append({ agentId: 'a', type: 'action', action: 'TWO' });
    writeFileSync(path, readFileSync(path, 'utf8') + '{"seq":3,"torn\n}\n'); // a torn row, as concurrent writers produce
    return { dir, path, bytes: readFileSync(path) };
  };

  it('loading a damaged ledger never rewrites the file', () => {
    const { path, bytes } = damaged();
    new FileLedger(path);
    assert.deepEqual(readFileSync(path), bytes);
  });

  it('an unreadable line fails verification instead of being skipped', () => {
    const { path } = damaged();
    const res = new FileLedger(path).verify([]);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.firstBadSeq, 3);
  });

  it('archives the file byte-for-byte and starts a segment whose genesis commits to it', () => {
    const { dir, path, bytes } = damaged();
    const rec = archiveAndStartSegment(path, { failedAtSeq: 3, failure: 'seq gap', reason: 'concurrent writers (GAP-043)' });
    const archive = join(dir, rec.previous.archive);
    assert.deepEqual(readFileSync(archive), bytes, 'archive must be unchanged');
    assert.equal(rec.previous.archiveSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(rec.segment, 2);
    assert.equal(existsSync(path), false);
    const { genesis, ...base } = rec;
    assert.equal(genesis, segmentGenesis(base));
    assert.deepEqual(readSegment(path), rec);

    const next = new FileLedger(path, { genesis });
    const first = next.append({ agentId: 'factory', type: 'action', action: 'LEDGER_RECOVERY', payloadSha256: genesis });
    assert.equal(first.seq, 1);
    assert.equal(first.prevHash, genesis);
    assert.equal(next.verify([]).ok, true);
    // Reopening continues the same segment and still verifies.
    assert.equal(new FileLedger(path, { genesis }).verify([]).ok, true);
  });

  it('refuses without a reason and never overwrites an archive', () => {
    const { path } = damaged();
    assert.throws(() => archiveAndStartSegment(path, { failedAtSeq: 3, failure: 'x', reason: ' ' }));
    archiveAndStartSegment(path, { failedAtSeq: 3, failure: 'x', reason: 'r' });
    writeFileSync(path, 'x\n');
    const rec3 = archiveAndStartSegment(path, { failedAtSeq: 1, failure: 'x', reason: 'r' });
    assert.equal(rec3.segment, 3, 'a second recovery archives segment 2 under its own name');
  });

  it('checkpoints for later segments live under their own prefix', () => {
    const rec = { segment: 2 } as never;
    assert.equal(segmentWormUri('s3://b/ledger', rec), 's3://b/ledger/segment-2');
    assert.equal(segmentWormUri('s3://b/ledger', undefined), 's3://b/ledger');
  });
});
