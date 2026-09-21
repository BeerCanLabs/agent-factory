import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LedgerEvent } from './sanitize.js';

const execFileAsync = promisify(execFile);

export type Checkpoint = {
  fromSeq: number;
  toSeq: number;
  prevHash: string;
  hash: string;
  rows: Array<LedgerEvent & { seq: number; prevHash: string; hash: string }>;
};

export type CheckpointRef = { toSeq: number; hash: string };

export type CheckpointSink = {
  write(c: Checkpoint): Promise<void>;
  list(): Promise<CheckpointRef[]>;
};

/** `ckpt-<toSeq zero-padded>-<hash>.jsonl`: listing alone yields every anchor, no reads needed. */
function keyFor(c: Pick<Checkpoint, 'toSeq' | 'hash'>): string {
  return `ckpt-${String(c.toSeq).padStart(12, '0')}-${c.hash}.jsonl`;
}

function parseKey(name: string): CheckpointRef | undefined {
  const m = name.match(/ckpt-(\d{12})-([0-9a-f]{64})\.jsonl$/);
  return m ? { toSeq: Number(m[1]), hash: m[2] } : undefined;
}

function body(c: Checkpoint): string {
  return `${JSON.stringify({ fromSeq: c.fromSeq, toSeq: c.toSeq, prevHash: c.prevHash, hash: c.hash })}\n${c.rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

/** Local directory. For Compose and tests; not write-once unless the volume is. */
export class FileCheckpointSink implements CheckpointSink {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async write(c: Checkpoint): Promise<void> {
    writeFileSync(join(this.dir, keyFor(c)), body(c), { flag: 'wx' });
  }

  async list(): Promise<CheckpointRef[]> {
    return readdirSync(this.dir)
      .map(parseKey)
      .filter((r): r is CheckpointRef => Boolean(r))
      .sort((a, b) => a.toSeq - b.toSeq);
  }
}

export type AwsCli = (args: string[]) => Promise<string>;

/**
 * S3 bucket with Object Lock. Each checkpoint is written in COMPLIANCE mode, so nobody — including
 * the account root — can delete or overwrite it before the retention date.
 */
export class S3CheckpointSink implements CheckpointSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cli: AwsCli;

  constructor(uri: string, private readonly retentionDays: number, cli?: AwsCli) {
    const m = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not an s3:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/$/, '')}/` : '';
    this.cli =
      cli ??
      (async (args) => {
        const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
        return (await execFileAsync('aws', [...args, ...region, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
      });
  }

  async write(c: Checkpoint): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const file = join(dir, 'body.jsonl');
    writeFileSync(file, body(c));
    const until = new Date(Date.now() + this.retentionDays * 86_400_000).toISOString();
    try {
      await this.cli([
        's3api',
        'put-object',
        '--bucket',
        this.bucket,
        '--key',
        `${this.prefix}${keyFor(c)}`,
        '--body',
        file,
        '--checksum-algorithm',
        'SHA256',
        '--object-lock-mode',
        'COMPLIANCE',
        '--object-lock-retain-until-date',
        until,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(): Promise<CheckpointRef[]> {
    const refs: CheckpointRef[] = [];
    let token: string | undefined;
    do {
      const out = JSON.parse(
        await this.cli([
          's3api',
          'list-objects-v2',
          '--bucket',
          this.bucket,
          '--prefix',
          `${this.prefix}ckpt-`,
          ...(token ? ['--continuation-token', token] : []),
        ]) || '{}',
      ) as { Contents?: Array<{ Key: string }>; NextContinuationToken?: string };
      for (const o of out.Contents ?? []) {
        const r = parseKey(o.Key);
        if (r) refs.push(r);
      }
      token = out.NextContinuationToken;
    } while (token);
    return refs.sort((a, b) => a.toSeq - b.toSeq);
  }
}

export type GcsCli = (args: string[]) => Promise<string>;

/**
 * GCS bucket with Retention Policy. Objects written here are protected
 * from deletion or modification by the bucket's retention period.
 */
export class GcsCheckpointSink implements CheckpointSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cli: GcsCli;

  constructor(uri: string, private readonly retentionDays: number, cli?: GcsCli) {
    const m = uri.match(/^(?:gcs|gs):\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not a gcs:// or gs:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/$/, '')}/` : '';
    this.cli =
      cli ??
      (async (args) => {
        return (await execFileAsync('gcloud', ['storage', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
      });
  }

  async write(c: Checkpoint): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    const file = join(dir, 'body.jsonl');
    writeFileSync(file, body(c));
    try {
      const dest = `gs://${this.bucket}/${this.prefix}${keyFor(c)}`;
      await this.cli(['cp', file, dest]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(): Promise<CheckpointRef[]> {
    const refs: CheckpointRef[] = [];
    try {
      const out = await this.cli(['ls', `gs://${this.bucket}/${this.prefix}ckpt-*`]);
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const r = parseKey(trimmed);
        if (r) refs.push(r);
      }
    } catch {
      /* Empty listing or non-existent prefix returns empty */
    }
    return refs.sort((a, b) => a.toSeq - b.toSeq);
  }
}

export function checkpointSinkFromEnv(env: NodeJS.ProcessEnv = process.env): CheckpointSink | undefined {
  const uri = env.FACTORY_LEDGER_WORM_URI;
  if (!uri) return undefined;
  if (uri.startsWith('s3://')) return new S3CheckpointSink(uri, Number(env.FACTORY_LEDGER_RETENTION_DAYS || '365'));
  if (uri.startsWith('gcs://') || uri.startsWith('gs://')) return new GcsCheckpointSink(uri, Number(env.FACTORY_LEDGER_RETENTION_DAYS || '365'));
  if (uri.startsWith('file://')) return new FileCheckpointSink(uri.slice('file://'.length));
  throw new Error(`FACTORY_LEDGER_WORM_URI must be s3://, gcs://, gs:// or file://, got ${uri}`);
}

