/**
 * Skill Package Store provider abstraction and implementations (A4, A21, S3).
 *
 * Implements content-addressed immutable storage for verified skill packages.
 * Packages are stored by their SHA-256 hash. A version's package is immutable:
 * once written, it cannot be modified or replaced with different content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface SkillPackageStoreRecord {
  sha256: string;
  size: number;
  storedAt: string;
  quarantined?: boolean;
  quarantineReason?: string;
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
   */
  get(sha256: string): Promise<Buffer | null>;

  /**
   * Checks whether a package with this sha256 exists in the store.
   */
  has(sha256: string): Promise<boolean>;

  /**
   * Marks a package as quarantined (A21: failed checks or security quarantine).
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
 * Stores packages atomically in `<dir>/<sha256>.tar.gz`.
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
      // Already exists: immutable content-addressed storage (A4, S3)
      return {
        sha256,
        size: buffer.length,
        storedAt: new Date().toISOString(),
        quarantined: await this.isQuarantined(sha256),
      };
    }

    // Atomic write via temp file
    const tempFile = join(this.dir, `.tmp-${sha256}-${randomBytes(8).toString('hex')}`);
    writeFileSync(tempFile, buffer);
    renameSync(tempFile, target);

    return {
      sha256,
      size: buffer.length,
      storedAt: new Date().toISOString(),
      quarantined: false,
    };
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const target = this.packagePath(sha256);
    if (!existsSync(target)) return null;
    return readFileSync(target);
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return existsSync(this.packagePath(sha256));
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    const marker = this.quarantineMarkerPath(sha256);
    const data = {
      sha256,
      reason,
      quarantinedAt: new Date().toISOString(),
    };
    writeFileSync(marker, JSON.stringify(data, null, 2), 'utf8');
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

/**
 * In-memory SkillPackageStore implementation for unit tests and ephemeral environments.
 */
export class MemorySkillPackageStore implements SkillPackageStore {
  private readonly store = new Map<string, Buffer>();
  private readonly quarantineMarkers = new Map<string, string>();

  async put(sha256: string, buffer: Buffer): Promise<SkillPackageStoreRecord> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }

    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== sha256) {
      throw new Error(`package buffer sha256 mismatch (expected ${sha256}, got ${actualHash}) (A4, S3)`);
    }

    if (!this.store.has(sha256)) {
      this.store.set(sha256, Buffer.from(buffer));
    }

    return {
      sha256,
      size: buffer.length,
      storedAt: new Date().toISOString(),
      quarantined: this.quarantineMarkers.has(sha256),
      quarantineReason: this.quarantineMarkers.get(sha256),
    };
  }

  async get(sha256: string): Promise<Buffer | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const buf = this.store.get(sha256);
    return buf ? Buffer.from(buf) : null;
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    return this.store.has(sha256);
  }

  async quarantine(sha256: string, reason: string): Promise<void> {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`invalid sha256 format: ${sha256}`);
    }
    this.quarantineMarkers.set(sha256, reason);
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
