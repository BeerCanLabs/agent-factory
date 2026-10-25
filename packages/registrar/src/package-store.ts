import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HASH_REGEX = /^[0-9a-f]{64}$/;

export function assertValidPackageHash(hash: string): void {
  if (!HASH_REGEX.test(hash)) {
    throw new Error(`invalid package hash: must be exactly 64 lowercase hex characters, got "${hash}"`);
  }
}

/**
 * A21: Package storage is a provider abstraction. A SkillPackageStore per landing zone
 * (object storage on AWS, Azure, GCP; a volume/directory on Compose) holds packages by sha256.
 */
export interface SkillPackageStore {
  put(hash: string, data: Buffer): Promise<void>;
  get(hash: string): Promise<Buffer | null>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}

export class MemorySkillPackageStore implements SkillPackageStore {
  private readonly store = new Map<string, Buffer>();

  async put(hash: string, data: Buffer): Promise<void> {
    assertValidPackageHash(hash);
    const computed = createHash('sha256').update(data).digest('hex');
    if (computed !== hash) {
      throw new Error(`package hash mismatch: expected ${hash}, computed ${computed}`);
    }
    // A4: Packages are immutable and write-once
    if (this.store.has(hash)) {
      return;
    }
    this.store.set(hash, Buffer.from(data));
  }

  async get(hash: string): Promise<Buffer | null> {
    assertValidPackageHash(hash);
    const data = this.store.get(hash);
    return data ? Buffer.from(data) : null;
  }

  async has(hash: string): Promise<boolean> {
    assertValidPackageHash(hash);
    return this.store.has(hash);
  }

  async delete(hash: string): Promise<void> {
    assertValidPackageHash(hash);
    this.store.delete(hash);
  }
}

export class FileSkillPackageStore implements SkillPackageStore {
  constructor(readonly baseDir: string) {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  private filePath(hash: string): string {
    assertValidPackageHash(hash);
    return join(this.baseDir, `${hash}.tar.gz`);
  }

  async put(hash: string, data: Buffer): Promise<void> {
    assertValidPackageHash(hash);
    const computed = createHash('sha256').update(data).digest('hex');
    if (computed !== hash) {
      throw new Error(`package hash mismatch: expected ${hash}, computed ${computed}`);
    }
    const target = this.filePath(hash);
    // A4: Packages are immutable and write-once
    if (existsSync(target)) {
      return;
    }
    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const temp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, target);
  }

  async get(hash: string): Promise<Buffer | null> {
    assertValidPackageHash(hash);
    const target = this.filePath(hash);
    try {
      if (!existsSync(target)) return null;
      return readFileSync(target);
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    assertValidPackageHash(hash);
    const target = this.filePath(hash);
    return existsSync(target);
  }

  async delete(hash: string): Promise<void> {
    assertValidPackageHash(hash);
    const target = this.filePath(hash);
    try {
      if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch {
      // ignore
    }
  }
}
