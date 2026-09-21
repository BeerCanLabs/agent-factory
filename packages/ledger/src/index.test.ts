import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpointer, FileCheckpointSink, FileLedger, MemoryLedger, S3CheckpointSink, GcsCheckpointSink, checkpointSinkFromEnv, payloadHash, redactSecrets, toLedgerEvent } from './index.js';

describe('toLedgerEvent', () => {
  it('drops prompt/content and stores a payload hash', () => {
    const event = toLedgerEvent({
      agentId: 'echo',
      type: 'llm',
      prompt: 'SSN 123-45-6789 and a long secret thought',
      inputTokens: 3,
    });
    assert.equal(event.inputTokens, 3);
    assert.equal('prompt' in event, false);
    assert.equal(event.payloadSha256, payloadHash('SSN 123-45-6789 and a long secret thought'));
  });

  it('redacts known secret strings before flush', () => {
    const event = toLedgerEvent(
      { agentId: 'echo', type: 'action', action: 'used sk-live-super-secret' },
      ['sk-live-super-secret'],
    );
    assert.equal(event.action, 'used ***');
    assert.equal(JSON.stringify(event).includes('sk-live-super-secret'), false);
  });
});

describe('FileLedger', () => {
  it('appends and never rewrites prior rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new FileLedger(path);
    ledger.append({ timestamp: '', agentId: 'a', type: 'llm', inputTokens: 1 });
    const before = readFileSync(path, 'utf8');
    ledger.append({ timestamp: '', agentId: 'a', type: 'mcp', mcpName: 'tool' });
    const after = readFileSync(path, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal(ledger.query({ agent: 'a' }).length, 2);
    rmSync(dir, { recursive: true });
  });

  it('never writes extra keys or secret plaintext to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const secret = 'sk-live-do-not-store';
    const ledger = new FileLedger(path, { secrets: [secret] });
    ledger.append({
      agentId: 'echo',
      type: 'llm',
      prompt: `hello ${secret}`,
      content: 'user email a@b.c',
      extra: 'drop me',
    });
    const disk = readFileSync(path, 'utf8');
    assert.equal(disk.includes(secret), false);
    assert.equal(disk.includes('"prompt"'), false);
    assert.equal(disk.includes('"content"'), false);
    assert.equal(disk.includes('"extra"'), false);
    assert.equal(
      disk.includes(payloadHash({ prompt: `hello ${secret}`, content: 'user email a@b.c' })),
      true,
    );
    rmSync(dir, { recursive: true });
  });
});

describe('redactSecrets', () => {
  it('masks the longest match first', () => {
    assert.equal(redactSecrets('id token-long and token-longer', ['token-long', 'token-longer']), 'id *** and ***');
  });
});

describe('hash chain', () => {
  function ledgerWith(n: number) {
    const dir = mkdtempSync(join(tmpdir(), 'chain-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new FileLedger(path);
    for (let i = 0; i < n; i++) ledger.append({ agentId: 'a', type: 'action', action: `A${i}`, actor: 'token:t' });
    return { dir, path, ledger };
  }

  it('links every row to the one before it and verifies clean', () => {
    const { dir, ledger } = ledgerWith(5);
    const rows = ledger.query();
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prevHash, rows[i - 1].hash);
    const v = ledger.verify();
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.head, rows[4].hash);
    rmSync(dir, { recursive: true });
  });

  it('detects an edited row on disk', () => {
    const { dir, path, ledger } = ledgerWith(5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[2]);
    row.actor = 'oidc:someone-else@example.com';
    lines[2] = JSON.stringify(row);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const v = ledger.verify();
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.firstBadSeq, 3);
      assert.match(v.reason, /altered/);
    }
    rmSync(dir, { recursive: true });
  });

  it('detects a deleted middle row', () => {
    const { dir, path, ledger } = ledgerWith(5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines.splice(1, 1);
    writeFileSync(path, `${lines.join('\n')}\n`);
    assert.equal(ledger.verify().ok, false);
    rmSync(dir, { recursive: true });
  });

  it('truncation or a rebuilt chain is caught by the WORM checkpoints', async () => {
    const { dir, path, ledger } = ledgerWith(4);
    const sink = new FileCheckpointSink(join(dir, 'worm'));
    const cp = new Checkpointer(ledger, sink);
    await cp.init();
    const anchor = await cp.flush();
    assert.equal(anchor?.toSeq, 4);
    assert.equal((await cp.flush()), null, 'nothing new to ship');
    assert.equal(ledger.verify(await sink.list()).ok, true);

    // Drop the last two rows: the chain alone still verifies, the checkpoint does not.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines.slice(0, 2).join('\n')}\n`);
    assert.equal(ledger.verify().ok, true);
    const truncated = ledger.verify(await sink.list());
    assert.equal(truncated.ok, false);
    if (!truncated.ok) assert.match(truncated.reason, /rows missing/);

    // Rewrite history consistently from genesis: still diverges from the WORM anchor.
    const forged = new FileLedger(join(dir, 'forged.jsonl'));
    for (let i = 0; i < 4; i++) forged.append({ agentId: 'a', type: 'action', action: `FORGED${i}`, actor: 'token:t' });
    const v = forged.verify(await sink.list());
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /WORM/);
    rmSync(dir, { recursive: true });
  });

  it('checkpoints carry the rows themselves and are never overwritten', async () => {
    const { dir, ledger } = ledgerWith(2);
    const sink = new FileCheckpointSink(join(dir, 'worm'));
    const rows = ledger.query();
    const c = { fromSeq: 1, toSeq: 2, prevHash: rows[0].prevHash, hash: rows[1].hash, rows };
    await sink.write(c);
    await assert.rejects(sink.write(c), /EEXIST/);
    rmSync(dir, { recursive: true });
  });

  it('seals pre-chain rows under the genesis hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, '{"timestamp":"t","agentId":"a","type":"action"}\n');
    const ledger = new FileLedger(path);
    ledger.append({ agentId: 'a', type: 'action', action: 'NEW' });
    assert.equal(ledger.verify().ok, true);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"agentId":"a","type":"action"}', '"agentId":"b","type":"action"}'));
    assert.equal(new FileLedger(path).verify().ok, false, 'editing a legacy row breaks the chain');
    rmSync(dir, { recursive: true });
  });

  it('memory ledger chains too', () => {
    const m = new MemoryLedger();
    m.append({ agentId: 'a', type: 'action' });
    m.append({ agentId: 'a', type: 'action' });
    assert.equal(m.verify().ok, true);
    (m.events[0] as { action?: string }).action = 'X';
    assert.equal(m.verify().ok, false);
  });
});

describe('S3 object-lock sink', () => {
  it('writes in COMPLIANCE mode with a retention date and lists anchors from keys', async () => {
    const calls: string[][] = [];
    const hash = 'a'.repeat(64);
    const sink = new S3CheckpointSink('s3://ledger-bucket/prod', 365, async (args) => {
      calls.push(args);
      if (args[1] === 'list-objects-v2') return JSON.stringify({ Contents: [{ Key: `prod/ckpt-000000000007-${hash}.jsonl` }, { Key: 'prod/other' }] });
      return '{}';
    });
    await sink.write({ fromSeq: 1, toSeq: 7, prevHash: '0'.repeat(64), hash, rows: [] });
    const put = calls[0];
    assert.equal(put[put.indexOf('--object-lock-mode') + 1], 'COMPLIANCE');
    const until = new Date(put[put.indexOf('--object-lock-retain-until-date') + 1]).getTime();
    assert.ok(until > Date.now() + 364 * 86_400_000);
    assert.equal(put[put.indexOf('--key') + 1], `prod/ckpt-000000000007-${hash}.jsonl`);
    assert.deepEqual(await sink.list(), [{ toSeq: 7, hash }]);
  });
});

describe('GCS checkpoint sink', () => {
  it('writes to GCS and parses ckpt keys from listing', async () => {
    const calls: string[][] = [];
    const hash = 'b'.repeat(64);
    const sink = new GcsCheckpointSink('gcs://my-gcp-bucket/ledger', 365, async (args) => {
      calls.push(args);
      if (args[0] === 'ls') {
        return `gs://my-gcp-bucket/ledger/ckpt-000000000012-${hash}.jsonl\ngs://my-gcp-bucket/ledger/other.txt\n`;
      }
      return '';
    });
    await sink.write({ fromSeq: 1, toSeq: 12, prevHash: '0'.repeat(64), hash, rows: [] });
    assert.equal(calls[0][0], 'cp');
    assert.equal(calls[0][2], `gs://my-gcp-bucket/ledger/ckpt-000000000012-${hash}.jsonl`);
    assert.deepEqual(await sink.list(), [{ toSeq: 12, hash }]);
  });

  it('instantiates GcsCheckpointSink from gcs:// and gs:// environment variable', () => {
    const s1 = checkpointSinkFromEnv({ FACTORY_LEDGER_WORM_URI: 'gcs://bucket/path' });
    assert.ok(s1 instanceof GcsCheckpointSink);
    const s2 = checkpointSinkFromEnv({ FACTORY_LEDGER_WORM_URI: 'gs://bucket/path' });
    assert.ok(s2 instanceof GcsCheckpointSink);
  });
});

