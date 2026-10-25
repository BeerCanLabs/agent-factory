import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    this.store.set(hash.toLowerCase(), Buffer.from(data));
  }

  async get(hash: string): Promise<Buffer | null> {
    const data = this.store.get(hash.toLowerCase());
    return data ? Buffer.from(data) : null;
  }

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash.toLowerCase());
  }

  async delete(hash: string): Promise<void> {
    this.store.delete(hash.toLowerCase());
  }
}

export class FileSkillPackageStore implements SkillPackageStore {
  constructor(readonly baseDir: string) {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  private filePath(hash: string): string {
    const safeHash = hash.toLowerCase().replace(/[^a-f0-9]/g, '');
    return join(this.baseDir, `${safeHash}.tar.gz`);
  }

  async put(hash: string, data: Buffer): Promise<void> {
    const target = this.filePath(hash);
    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const temp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, target);
  }

  async get(hash: string): Promise<Buffer | null> {
    const target = this.filePath(hash);
    try {
      if (!existsSync(target)) return null;
      return readFileSync(target);
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    const target = this.filePath(hash);
    return existsSync(target);
  }

  async delete(hash: string): Promise<void> {
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
