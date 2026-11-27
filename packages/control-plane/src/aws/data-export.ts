/**
 * Read the factory's AWS Data Export from S3 (DESIGN_AUTHORITY §6.15, issue #457).
 *
 * The caller supplies the Accountant role's credentials. This module lists and gets objects under one prefix.
 * It does not call bcm-data-exports, and it does not write, delete, or tag anything.
 */
import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { rowsFromDataExport, snapshotFromRows, type ExportRow } from '@beercanlabs/factory-budget';
import type { CloudCostSnapshot } from '@beercanlabs/factory-budget';

export type DataExportLocation = { bucket: string; prefix: string };

/** One object, or a page of keys. Tests pass a fake with the same command names. */
export type DataExportClient = {
  send(command: ListObjectsV2Command | GetObjectCommand): Promise<{
    Contents?: Array<{ Key?: string; Size?: number }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
    Body?: { transformToByteArray: () => Promise<Uint8Array> };
    ContentLength?: number;
  }>;
};

const MAX_OBJECTS = 40;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class DataExportReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataExportReadError';
  }
}

/**
 * `s3://bucket/prefix` with a non-empty prefix. An unset variable is "no export configured".
 * A present but malformed variable is an error the caller logs; Cost Explorer stays the source.
 */
export function dataExportLocationFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true; location: DataExportLocation } | { ok: false; error?: string } {
  const uri = (env.FACTORY_AWS_DATA_EXPORT_URI ?? '').trim();
  if (!uri) return { ok: false };
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/([a-z0-9][a-z0-9./_-]{0,200})$/.exec(uri);
  if (!m || m[2].includes('..')) return { ok: false, error: 'FACTORY_AWS_DATA_EXPORT_URI must be s3://bucket/prefix' };
  const prefix = m[2].replace(/\/+$/, '');
  if (!prefix) return { ok: false, error: 'FACTORY_AWS_DATA_EXPORT_URI must include a prefix' };
  return { ok: true, location: { bucket: m[1], prefix: `${prefix}/` } };
}

function isDataFile(key: string): boolean {
  if (/manifest/i.test(key)) return false;
  return /\.csv(?:\.gz)?$/i.test(key);
}

/** When any key names a billing period, only that month's files are read. Undated fixtures are read whole. */
export function keysForMonth(keys: string[], month: string): string[] {
  const csv = keys.filter(isDataFile);
  const dated = csv.filter((k) => /BILLING_PERIOD=\d{4}-\d{2}/.test(k));
  if (dated.length > 0) return dated.filter((k) => k.includes(`BILLING_PERIOD=${month}`));
  return csv;
}

function decodeObject(key: string, bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new DataExportReadError(`export object exceeds ${MAX_OBJECT_BYTES} bytes`);
  const gz = key.toLowerCase().endsWith('.gz') || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
  let raw: Uint8Array = bytes;
  if (gz) {
    try {
      raw = gunzipSync(bytes);
    } catch {
      throw new DataExportReadError('export object is not gzip');
    }
  }
  if (raw.byteLength > MAX_OBJECT_BYTES) throw new DataExportReadError(`export object exceeds ${MAX_OBJECT_BYTES} bytes uncompressed`);
  return new TextDecoder().decode(raw);
}

export class DataExportReader {
  constructor(
    private readonly s3: DataExportClient,
    private readonly location: DataExportLocation,
  ) {}

  /**
   * The month's snapshot, or undefined when the prefix has no data file for it yet.
   * A file that is not a cost export throws, so the caller can keep Cost Explorer.
   */
  async load(window: { start: string; end: string }): Promise<CloudCostSnapshot | undefined> {
    const month = window.start.slice(0, 7);
    const keys = keysForMonth(await this.list(), month);
    if (keys.length === 0) return undefined;
    if (keys.length > MAX_OBJECTS) throw new DataExportReadError(`export prefix has ${keys.length} objects; the cap is ${MAX_OBJECTS}`);
    const rows: ExportRow[] = [];
    let total = 0;
    for (const key of keys) {
      const text = await this.get(key);
      total += text.length;
      if (total > MAX_TOTAL_BYTES) throw new DataExportReadError(`export prefix exceeds ${MAX_TOTAL_BYTES} bytes`);
      rows.push(...rowsFromDataExport(text));
    }
    return snapshotFromRows(rows, window);
  }

  private async list(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.location.bucket,
        Prefix: this.location.prefix,
        ContinuationToken: token,
      }));
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        if ((obj.Size ?? 0) > MAX_OBJECT_BYTES) throw new DataExportReadError(`export object exceeds ${MAX_OBJECT_BYTES} bytes`);
        keys.push(obj.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  private async get(key: string): Promise<string> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: key }));
    if ((out.ContentLength ?? 0) > MAX_OBJECT_BYTES) throw new DataExportReadError(`export object exceeds ${MAX_OBJECT_BYTES} bytes`);
    if (!out.Body) throw new DataExportReadError('export object has no body');
    return decodeObject(key, await out.Body.transformToByteArray());
  }
}

export function dataExportClient(credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>): DataExportClient {
  return new S3Client({ region: process.env.AWS_REGION, credentials }) as DataExportClient;
}
