/**
 * Skill Package Store provider abstraction and implementations (A4, A21, S3).
 *
 * Implements content-addressed immutable storage for verified skill packages.
 * Packages are stored by their SHA-256 hash. A version's package is immutable:
 * once written, it cannot be modified or replaced with different content.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface SkillPackageStoreRecord {
  sha256: string;
  size: number;
  storedAt: string;
  quarantined?: boolean;
  quarantineReason?: string;
  quarantinedAt?: string;
}

export interface SkillPackageStore {
  /**
   * Stores a skill package buffer by its SHA-256 hash (A4, S3).
   * Verifies that the buffer's hash matches sha256.
   * If a package with this sha256 already exists, this operation is an idempotent no-op.
   */
  put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord>;

  /**
   * Retrieves the raw package buffer by sha256. Returns null if not found.
   * Verifies that the retrieved bytes match sha256 (A4, S3). Throws if corrupted.
   */
  get(sha256: string): Promise<Buffer | null>;

  /**
   * Retrieves metadata record for a stored package, or null if not found.
   */
  getRecord(sha256: string): Promise<SkillPackageStoreRecord | null>;

  /**
   * Checks whether a package with this sha256 exists in the store.
   */
  has(sha256: string): Promise<boolean>;

  /**
   * Marks a package as quarantined (A21: failed checks or security quarantine).
   * Throws if the package is not present in the store.
   * Idempotent: repeated calls keep the initial quarantine timestamp and reason.
   */
  quarantine(sha256: string, reason: string): Promise<void>;

  /**
   * Checks whether a package is currently quarantined.
   */
  isQuarantined(sha256: string): Promise<boolean>;

  /**
   * Deletes a package from the store (e.g. after quarantine retention expires).
   */
  delete(sha256: string): Promise<boolean>;
}

/**
 * Local filesystem-backed SkillPackageStore (A21).
 * Suitable for Docker Compose, local testing, and single-host deployments.
 * Stores packages atomically in `<dir>/packages/<sha256>.tar.gz`.
 */
export class LocalSkillPackageStore implements SkillPackageStore {
  private readonly dir: string;
  private readonly quarantineDir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'packages');
    this.quarantineDir = join(baseDir, 'quarantine');
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.quarantineDir, { recursive: true });
  }

  private packagePath(sha256: string): string {
    return join(this.dir, `${sha256}.tar.gz`);
  }

  private quarantineMarkerPath(sha256: string): string {
    return join(this.quarantineDir, `${sha256}.json`);
  }

  async put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }

    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`package buffer sha256 mismatch (expected ${sha256}, got ${actualHash}) (A4, S3)`);
    }

    const target = this.packagePath(sha256);
    if (existsSync(target)) {
      // Re-verify existing file bytes against sha256 (A4, S3)
      const existingBuffer = readFileSync(target);
      const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
      if (existingHash !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${existingHash}) (A4, S3)`);
      }
      const rec = await this.getRecord(sha256);
      if (!rec) {
        throw new Error(`store inconsistency: package ${sha256} exists on disk but getRecord returned null`);
      }
      return rec;
    }

    // Atomic write via temp file with cleanup on failure
    const tempFile = join(this.dir, `.tmp-${sha256}-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(tempFile, buffer);
      renameSync(tempFile, target);
    } catch (err) {
      if (existsSync(tempFile)) {
        try { unlinkSync(tempFile); } catch {}
      }
      throw err;
    }

    const rec = await this.getRecord(sha256);
    if (!rec) {
      throw new Error(`store inconsistency: package ${sha256} written to disk but getRecord returned null`);
    }
    return rec;
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const target = this.packagePath(sha256);
    try {
      if (!existsSync(target)) return null;
      const buf = readFileSync(target);
      const actualHash = createHash('sha256').update(buf).digest('hex');
      if (actualHash !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${actualHash}) (A4, S3)`);
      }
      return buf;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async getRecord(sha256: string): Promise<SkillPackageStoreRecord | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const target = this.packagePath(sha256);
    try {
      if (!existsSync(target)) return null;
      const stat = statSync(target);
      const storedAt = stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString();
      const markerPath = this.quarantineMarkerPath(sha256);
      let quarantined = false;
      let quarantineReason: string | undefined;
      let quarantinedAt: string | undefined;

      if (existsSync(markerPath)) {
        try {
          const raw = readFileSync(markerPath, 'utf8');
          const parsed = JSON.parse(raw);
          quarantined = true;
          quarantineReason = parsed.reason;
          quarantinedAt = parsed.quarantinedAt;
        } catch {
          quarantined = true;
        }
      }

      return {
        sha256,
        size: stat.size,
        storedAt,
        quarantined,
        ...(quarantineReason ? { quarantineReason } : {}),
        ...(quarantinedAt ? { quarantinedAt } : {}),
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return existsSync(this.packagePath(sha256));
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    if (!(await this.has(sha256))) {
      throw new Error(`cannot quarantine non-existent package: ${sha256}`);
    }

    const marker = this.quarantineMarkerPath(sha256);
    // Idempotent: keep initial marker so retention clock and initial reason are preserved (A21)
    if (existsSync(marker)) {
      return;
    }

    const data = {
      sha256,
      reason,
      quarantinedAt: new Date().toISOString(),
    };
    const tempMarker = join(this.quarantineDir, `.tmp-${sha256}-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(tempMarker, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tempMarker, marker);
    } catch (err) {
      if (existsSync(tempMarker)) {
        try { unlinkSync(tempMarker); } catch {}
      }
      throw err;
    }
  }

  async isQuarantined(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return existsSync(this.quarantineMarkerPath(sha256));
  }

  async delete(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    let deleted = false;
    const target = this.packagePath(sha256);
    if (existsSync(target)) {
      unlinkSync(target);
      deleted = true;
    }
    const marker = this.quarantineMarkerPath(sha256);
    if (existsSync(marker)) {
      unlinkSync(marker);
    }
    return deleted;
  }
}

interface MemoryEntry {
  buffer: Buffer;
  storedAt: string;
}

interface QuarantineEntry {
  reason: string;
  quarantinedAt: string;
}

/**
 * In-memory SkillPackageStore implementation for unit tests and ephemeral environments.
 */
export class MemorySkillPackageStore implements SkillPackageStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly quarantineMarkers = new Map<string, QuarantineEntry>();

  async put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }

    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`package buffer sha256 mismatch (expected ${sha256}, got ${actualHash}) (A4, S3)`);
    }

    let entry = this.store.get(sha256);
    if (!entry) {
      entry = {
        buffer: Buffer.from(buffer),
        storedAt: new Date().toISOString(),
      };
      this.store.set(sha256, entry);
    } else {
      // Re-verify existing buffer to detect tampering (A4, S3)
      const existingHash = createHash('sha256').update(entry.buffer).digest('hex');
      if (existingHash !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${existingHash}) (A4, S3)`);
      }
    }

    return (await this.getRecord(sha256)) ?? {
      sha256,
      size: entry.buffer.length,
      storedAt: entry.storedAt,
      quarantined: false,
    };
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const entry = this.store.get(sha256);
    if (!entry) return null;
    const actualHash = createHash('sha256').update(entry.buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${actualHash}) (A4, S3)`);
    }
    return Buffer.from(entry.buffer);
  }

  async getRecord(sha256: string): Promise<SkillPackageStoreRecord | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const entry = this.store.get(sha256);
    if (!entry) return null;
    const q = this.quarantineMarkers.get(sha256);
    return {
      sha256,
      size: entry.buffer.length,
      storedAt: entry.storedAt,
      quarantined: Boolean(q),
      ...(q?.reason ? { quarantineReason: q.reason } : {}),
      ...(q?.quarantinedAt ? { quarantinedAt: q.quarantinedAt } : {}),
    };
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return this.store.has(sha256);
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    if (!this.store.has(sha256)) {
      throw new Error(`cannot quarantine non-existent package: ${sha256}`);
    }
    // Idempotent: keep initial marker so retention clock and initial reason are preserved (A21)
    if (this.quarantineMarkers.has(sha256)) {
      return;
    }
    this.quarantineMarkers.set(sha256, {
      reason,
      quarantinedAt: new Date().toISOString(),
    });
  }

  async isQuarantined(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return this.quarantineMarkers.has(sha256);
  }

  async delete(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    const existed = this.store.delete(sha256);
    this.quarantineMarkers.delete(sha256);
    return existed;
  }
}

import type { AwsCli } from './config-store.js';
export type { AwsCli };

const defaultAwsCli: AwsCli = async (args) => {
  const { stdout } = await execFileAsync('aws', args, { encoding: 'utf8' });
  return stdout;
};

/**
 * AWS S3-backed SkillPackageStore (A21, S3).
 * Stores packages by hash in `s3://<bucket>/<prefix><sha256>.tar.gz`.
 * Uses AWS CLI (`aws s3api`) to keep the kernel free of cloud SDK dependencies (GAP-014).
 */
export class S3SkillPackageStore implements SkillPackageStore {
  readonly description: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly quarantinePrefix: string;
  private readonly cli: AwsCli;

  constructor(uri: string, cli?: AwsCli) {
    const m = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not an s3:// uri: ${uri}`);
    this.bucket = m[1];
    const rawPrefix = m[2] ? `${m[2].replace(/\/+$/, '')}/` : '';
    this.prefix = `${rawPrefix}packages/`;
    this.quarantinePrefix = `${rawPrefix}quarantine/`;
    this.description = `s3://${this.bucket}/${rawPrefix}`;
    this.cli = cli ?? defaultAwsCli;
  }

  async put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`package buffer sha256 mismatch (expected ${sha256}, got ${actualHash}) (A4, S3)`);
    }

    const key = `${this.prefix}${sha256}.tar.gz`;
    const existing = await this.getRecord(sha256);
    if (existing) {
      const existingBuf = await this.get(sha256);
      if (!existingBuf || createHash('sha256').update(existingBuf).digest('hex') !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (A4, S3)`);
      }
      return existing;
    }

    const dir = mkdtempSync(join(tmpdir(), 's3-pkg-put-'));
    const tempFile = join(dir, `${sha256}.tar.gz`);
    try {
      writeFileSync(tempFile, buffer);
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', key,
        '--body', tempFile,
        '--content-type', 'application/gzip',
        '--checksum-algorithm', 'SHA256',
        '--if-none-match', '*',
      ]);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // PreconditionFailed means another concurrent put won the race: re-verify winner
      if (msg.includes('PreconditionFailed') || msg.includes('412')) {
        const existingBuf = await this.get(sha256);
        if (!existingBuf || createHash('sha256').update(existingBuf).digest('hex') !== sha256) {
          throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (A4, S3)`);
        }
        return (await this.getRecord(sha256))!;
      }
      throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const rec = await this.getRecord(sha256);
    if (!rec) {
      throw new Error(`store inconsistency: package ${sha256} written to S3 but getRecord returned null`);
    }
    return rec;
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const key = `${this.prefix}${sha256}.tar.gz`;
    const dir = mkdtempSync(join(tmpdir(), 's3-pkg-get-'));
    const tempFile = join(dir, `${sha256}.tar.gz`);
    try {
      try {
        await this.cli([
          's3api', 'get-object',
          '--bucket', this.bucket,
          '--key', key,
          tempFile,
        ]);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes('NoSuchKey') || msg.includes('404') || msg.includes('Not Found')) {
          return null;
        }
        throw err;
      }
      if (!existsSync(tempFile)) return null;
      const buf = readFileSync(tempFile);
      const actualHash = createHash('sha256').update(buf).digest('hex');
      if (actualHash !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${actualHash}) (A4, S3)`);
      }
      return buf;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async getRecord(sha256: string): Promise<SkillPackageStoreRecord | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const key = `${this.prefix}${sha256}.tar.gz`;
    let stdout: string;
    try {
      stdout = await this.cli([
        's3api', 'head-object',
        '--bucket', this.bucket,
        '--key', key,
      ]);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('404') || msg.includes('NotFound') || msg.includes('NoSuchKey')) {
        return null;
      }
      throw err;
    }
    const meta = JSON.parse(stdout || '{}') as { ContentLength?: number; LastModified?: string };
    const size = meta.ContentLength ?? 0;
    const storedAt = meta.LastModified ? new Date(meta.LastModified).toISOString() : new Date().toISOString();

    const qKey = `${this.quarantinePrefix}${sha256}.json`;
    let quarantined = false;
    let quarantineReason: string | undefined;
    let quarantinedAt: string | undefined;
    const dir = mkdtempSync(join(tmpdir(), 's3-pkg-qcheck-'));
    const tempFile = join(dir, 'marker.json');
    try {
      await this.cli([
        's3api', 'get-object',
        '--bucket', this.bucket,
        '--key', qKey,
        tempFile,
      ]);
      if (existsSync(tempFile)) {
        const parsed = JSON.parse(readFileSync(tempFile, 'utf8'));
        quarantined = true;
        quarantineReason = parsed.reason;
        quarantinedAt = parsed.quarantinedAt;
      }
    } catch {
      quarantined = false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    return {
      sha256,
      size,
      storedAt,
      quarantined,
      ...(quarantineReason ? { quarantineReason } : {}),
      ...(quarantinedAt ? { quarantinedAt } : {}),
    };
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    try {
      await this.cli([
        's3api', 'head-object',
        '--bucket', this.bucket,
        '--key', `${this.prefix}${sha256}.tar.gz`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    if (!(await this.has(sha256))) {
      throw new Error(`cannot quarantine non-existent package: ${sha256}`);
    }
    if (await this.isQuarantined(sha256)) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 's3-pkg-quarantine-'));
    const tempMarker = join(dir, `${sha256}.json`);
    try {
      const data = { sha256, reason, quarantinedAt: new Date().toISOString() };
      writeFileSync(tempMarker, JSON.stringify(data, null, 2), 'utf8');
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', `${this.quarantinePrefix}${sha256}.json`,
        '--body', tempMarker,
        '--content-type', 'application/json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async isQuarantined(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    try {
      await this.cli([
        's3api', 'head-object',
        '--bucket', this.bucket,
        '--key', `${this.quarantinePrefix}${sha256}.json`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    const exists = await this.has(sha256);
    if (!exists) return false;
    await this.cli([
      's3api', 'delete-object',
      '--bucket', this.bucket,
      '--key', `${this.prefix}${sha256}.tar.gz`,
    ]);
    try {
      await this.cli([
        's3api', 'delete-object',
        '--bucket', this.bucket,
        '--key', `${this.quarantinePrefix}${sha256}.json`,
      ]);
    } catch {}
    return true;
  }
}

let cachedPackageStoreGcsToken: { token: string; expiresAt: number } | undefined;

async function defaultPackageStoreGcsToken(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  if (cachedPackageStoreGcsToken && Date.now() < cachedPackageStoreGcsToken.expiresAt - 60_000) return cachedPackageStoreGcsToken.token;
  try {
    const res = await fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      if (data.access_token) {
        cachedPackageStoreGcsToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
        return data.access_token;
      }
    }
  } catch {}
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  return stdout.trim();
}

export type GcsSkillPackageStoreOptions = {
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  apiEndpoint?: string;
};

/**
 * GCP Cloud Storage-backed SkillPackageStore (A21).
 * Stores packages by hash in `gs://<bucket>/<prefix><sha256>.tar.gz`.
 * Uses native fetch against GCS JSON/upload API without cloud SDKs (GAP-014).
 */
export class GcsSkillPackageStore implements SkillPackageStore {
  readonly description: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly quarantinePrefix: string;
  private readonly fetchFn: typeof fetch;
  private readonly tokenFn: () => Promise<string>;
  private readonly endpoint: string;

  constructor(uri: string, options?: GcsSkillPackageStoreOptions) {
    const m = uri.match(/^(?:gs|gcs):\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not a gs:// or gcs:// uri: ${uri}`);
    this.bucket = m[1];
    const rawPrefix = m[2] ? `${m[2].replace(/\/+$/, '')}/` : '';
    this.prefix = `${rawPrefix}packages/`;
    this.quarantinePrefix = `${rawPrefix}quarantine/`;
    this.description = `gs://${this.bucket}/${rawPrefix}`;
    this.fetchFn = options?.fetch ?? fetch;
    this.tokenFn = options?.getAccessToken ?? (() => defaultPackageStoreGcsToken(this.fetchFn));
    this.endpoint = (options?.apiEndpoint ?? process.env.GCS_API_ENDPOINT ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  }

  async put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`package buffer sha256 mismatch (expected ${sha256}, got ${actualHash}) (A4, S3)`);
    }

    const key = `${this.prefix}${sha256}.tar.gz`;
    const token = await this.tokenFn();
    const existing = await this.getRecord(sha256);
    if (existing) {
      const existingBuf = await this.get(sha256);
      if (!existingBuf || createHash('sha256').update(existingBuf).digest('hex') !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (A4, S3)`);
      }
      return existing;
    }

    const res = await this.fetchFn(
      `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/gzip',
        },
        body: new Uint8Array(buffer),
      },
    );
    if (!res.ok && res.status !== 412) {
      throw new Error(`GCS package write failed (${res.status})`);
    }

    if (res.status === 412) {
      const existingBuf = await this.get(sha256);
      if (!existingBuf || createHash('sha256').update(existingBuf).digest('hex') !== sha256) {
        throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (A4, S3)`);
      }
      return (await this.getRecord(sha256))!;
    }

    const rec = await this.getRecord(sha256);
    if (!rec) {
      throw new Error(`store inconsistency: package ${sha256} written to GCS but getRecord returned null`);
    }
    return rec;
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const key = `${this.prefix}${sha256}.tar.gz`;
    const token = await this.tokenFn();
    const res = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GCS package download failed (${res.status})`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const actualHash = createHash('sha256').update(buf).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`stored package corrupted: sha256 mismatch for ${sha256} (got ${actualHash}) (A4, S3)`);
    }
    return buf;
  }

  async getRecord(sha256: string): Promise<SkillPackageStoreRecord | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const key = `${this.prefix}${sha256}.tar.gz`;
    const token = await this.tokenFn();
    const res = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GCS package metadata failed (${res.status})`);
    const data = (await res.json()) as { size?: string | number; updated?: string; timeCreated?: string };
    const size = Number(data.size ?? 0);
    const storedAt = data.timeCreated || data.updated || new Date().toISOString();

    const qKey = `${this.quarantinePrefix}${sha256}.json`;
    const qRes = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(qKey)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    let quarantined = false;
    let quarantineReason: string | undefined;
    let quarantinedAt: string | undefined;
    if (qRes.ok) {
      try {
        const qData = (await qRes.json()) as { reason?: string; quarantinedAt?: string };
        quarantined = true;
        quarantineReason = qData.reason;
        quarantinedAt = qData.quarantinedAt;
      } catch {
        quarantined = true;
      }
    }

    return {
      sha256,
      size,
      storedAt,
      quarantined,
      ...(quarantineReason ? { quarantineReason } : {}),
      ...(quarantinedAt ? { quarantinedAt } : {}),
    };
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    const key = `${this.prefix}${sha256}.tar.gz`;
    const token = await this.tokenFn();
    const res = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return res.status === 200;
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    if (!(await this.has(sha256))) {
      throw new Error(`cannot quarantine non-existent package: ${sha256}`);
    }
    if (await this.isQuarantined(sha256)) return;
    const qKey = `${this.quarantinePrefix}${sha256}.json`;
    const token = await this.tokenFn();
    const data = JSON.stringify({ sha256, reason, quarantinedAt: new Date().toISOString() });
    const res = await this.fetchFn(
      `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(qKey)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: data,
      },
    );
    if (!res.ok && res.status !== 412) {
      throw new Error(`GCS quarantine write failed (${res.status})`);
    }
  }

  async isQuarantined(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    const qKey = `${this.quarantinePrefix}${sha256}.json`;
    const token = await this.tokenFn();
    const res = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(qKey)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return res.status === 200;
  }

  async delete(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    const key = `${this.prefix}${sha256}.tar.gz`;
    const token = await this.tokenFn();
    const res = await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    const qKey = `${this.quarantinePrefix}${sha256}.json`;
    await this.fetchFn(
      `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(qKey)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {});
    return res.status === 200 || res.status === 204;
  }
}

/**
 * Creates a SkillPackageStore for any supported URI scheme (A21):
 * - `s3://bucket/prefix/`: S3SkillPackageStore (AWS)
 * - `gs://bucket/prefix/` or `gcs://bucket/prefix/`: GcsSkillPackageStore (GCP)
 * - `file:///dir` or a directory path: LocalSkillPackageStore
 */
export function skillPackageStoreFromUri(
  uri: string,
  opts?: {
    awsCli?: AwsCli;
    fetch?: typeof fetch;
    getGcsAccessToken?: () => Promise<string>;
    gcsEndpoint?: string;
  },
): SkillPackageStore {
  if (uri.startsWith('s3://')) {
    return new S3SkillPackageStore(uri, opts?.awsCli);
  }
  if (uri.startsWith('gs://') || uri.startsWith('gcs://')) {
    return new GcsSkillPackageStore(uri, {
      fetch: opts?.fetch,
      getAccessToken: opts?.getGcsAccessToken,
      apiEndpoint: opts?.gcsEndpoint,
    });
  }
  const fileDir = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  return new LocalSkillPackageStore(fileDir);
}

