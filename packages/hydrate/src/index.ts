import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Object-storage stand-in: a directory of prefixes (S3/GCS in production). */
export type MindStore = {
  root: string;
};

export function pullMind(store: MindStore, prefix: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const src = join(store.root, prefix);
  if (!existsSync(src)) {
    mkdirSync(src, { recursive: true });
    return;
  }
  cpSync(src, dest, { recursive: true });
}

export function pushMind(store: MindStore, prefix: string, src: string): void {
  const dest = join(store.root, prefix);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(store.root), { recursive: true });
  cpSync(src, dest, { recursive: true });
}
