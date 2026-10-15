import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  /** Optional: reads all chained row JSON lines in sequence order to hydrate an ephemeral local ledger file on boot. */
  readAllRows?(): Promise<string[]>;
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

function extractRowsFromCheckpointBodies(bodies: string[]): string[] {
  const bySeq = new Map<number, string>();
  for (const text of bodies) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    // First line is the checkpoint header ({ fromSeq, toSeq, prevHash, hash }); subsequent lines are ChainedEvent rows.
    for (let i = 1; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as { seq?: number; hash?: string };
        if (typeof parsed.seq === 'number' && typeof parsed.hash === 'string') {
          bySeq.set(parsed.seq, lines[i]);
        }
      } catch {
        // ignore malformed line
      }
    }
  }
  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
}

/**
 * Hydrates `filePath` from `sink` when `filePath` does not exist yet (or is empty), such as `/tmp/ledger.jsonl`
 * on a cold Cloud Run container boot where WORM checkpoints are stored in GCS.
 */
export async function hydrateLedgerFromSink(filePath: string, sink: CheckpointSink | undefined): Promise<number> {
  if (!sink?.readAllRows) return 0;
  if (existsSync(filePath) && statSync(filePath).size > 0) return 0;
  const rows = await sink.readAllRows();
  if (!rows.length) return 0;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.join('\n')}\n`, { encoding: 'utf8' });
  return rows.length;
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

  async readAllRows(): Promise<string[]> {
    const refs = await this.list();
    const bodies = refs.map((r) => readFileSync(join(this.dir, keyFor(r)), 'utf8'));
    return extractRowsFromCheckpointBodies(bodies);
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

export type GcsCheckpointOptions = {
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  apiEndpoint?: string;
};

let cachedGcsToken: { token: string; expiresAt: number } | undefined;

async function defaultGcsAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  if (cachedGcsToken && Date.now() < cachedGcsToken.expiresAt - 60_000) return cachedGcsToken.token;
  try {
    const res = await fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      if (data.access_token) {
        cachedGcsToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
        return data.access_token;
      }
    }
  } catch {
    // Fall back to gcloud CLI on local developer machines
  }
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  return stdout.trim();
}

/**
 * GCS bucket with Retention Policy. Objects written here are protected
 * from deletion or modification by the bucket's retention period.
 * Uses native GCS JSON API in production (no `gcloud` binary required in containers, GAP-023),
 * or an injected `cli` runner for unit tests.
 */
export class GcsCheckpointSink implements CheckpointSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cli?: GcsCli;
  private readonly fetchFn: typeof fetch;
  private readonly tokenFn: () => Promise<string>;
  private readonly endpoint: string;

  constructor(uri: string, private readonly retentionDays: number, cli?: GcsCli, options?: GcsCheckpointOptions) {
    const m = uri.match(/^(?:gcs|gs):\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not a gcs:// or gs:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/$/, '')}/` : '';
    this.cli = cli;
    this.fetchFn = options?.fetch ?? fetch;
    this.tokenFn = options?.getAccessToken ?? (() => defaultGcsAccessToken(this.fetchFn));
    this.endpoint = (options?.apiEndpoint ?? process.env.GCS_API_ENDPOINT ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  }

  async write(c: Checkpoint): Promise<void> {
    const content = body(c);
    if (this.cli) {
      const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
      const file = join(dir, 'body.jsonl');
      writeFileSync(file, content);
      try {
        const dest = `gs://${this.bucket}/${this.prefix}${keyFor(c)}`;
        await this.cli(['cp', file, dest]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    }
    const token = await this.tokenFn();
    const objectName = `${this.prefix}${keyFor(c)}`;
    // ifGenerationMatch=0 guarantees write-once semantics even before bucket retention lock
    const url = `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(objectName)}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: content,
    });
    if (!res.ok) {
      throw new Error(`GCS checkpoint write failed (${res.status})`);
    }
  }

  async list(): Promise<CheckpointRef[]> {
    const refs: CheckpointRef[] = [];
    if (this.cli) {
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

    const token = await this.tokenFn();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ prefix: `${this.prefix}ckpt-` });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.fetchFn(
        `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`GCS checkpoint list failed (${res.status})`);
      const json = (await res.json()) as { items?: Array<{ name?: string }>; nextPageToken?: string };
      for (const item of json.items ?? []) {
        const r = parseKey(item.name ?? '');
        if (r) refs.push(r);
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return refs.sort((a, b) => a.toSeq - b.toSeq);
  }

  async readAllRows(): Promise<string[]> {
    const refs = await this.list();
    if (!refs.length) return [];
    const bodies: string[] = [];
    if (this.cli) {
      for (const r of refs) {
        const out = await this.cli(['cat', `gs://${this.bucket}/${this.prefix}${keyFor(r)}`]);
        bodies.push(out);
      }
      return extractRowsFromCheckpointBodies(bodies);
    }
    const token = await this.tokenFn();
    for (const r of refs) {
      const objectName = `${this.prefix}${keyFor(r)}`;
      const res = await this.fetchFn(
        `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`GCS checkpoint download failed (${res.status})`);
      bodies.push(await res.text());
    }
    return extractRowsFromCheckpointBodies(bodies);
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


