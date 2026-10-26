/**
 * Skill Package Store provider abstraction and implementations (A4, A21, S3).
 *
 * Implements content-addressed immutable storage for verified skill packages.
 * Packages are stored by their SHA-256 hash. A version's package is immutable:
 * once written, it cannot be modified or replaced with different content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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
      return (await this.getRecord(sha256)) ?? {
        sha256,
        size: existingBuffer.length,
        storedAt: new Date().toISOString(),
        quarantined: false,
      };
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

    return (await this.getRecord(sha256)) ?? {
      sha256,
      size: buffer.length,
      storedAt: new Date().toISOString(),
      quarantined: false,
    };
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
