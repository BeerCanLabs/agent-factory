import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Directory stand-in or object storage (`uri: s3://bucket`). */
export type MindStore = {
  root: string;
  uri?: string;
};

function s3Prefix(store: MindStore, prefix: string): string {
  const base = (store.uri ?? '').replace(/\/$/, '');
  return `${base}/${prefix}`;
}

export function pullMind(store: MindStore, prefix: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (store.uri?.startsWith('s3://')) {
    try {
      execFileSync('aws', ['s3', 'sync', s3Prefix(store, prefix), dest], { stdio: 'inherit' });
    } catch {
      /* empty prefix on first wake */
    }
    return;
  }
  const src = join(store.root, prefix);
  if (!existsSync(src)) {
    mkdirSync(src, { recursive: true });
    return;
  }
  cpSync(src, dest, { recursive: true });
}

export function pushMind(store: MindStore, prefix: string, src: string): void {
  if (store.uri?.startsWith('s3://')) {
    if (!existsSync(src)) return;
    execFileSync('aws', ['s3', 'sync', src, s3Prefix(store, prefix)], { stdio: 'inherit' });
    return;
  }
  const dest = join(store.root, prefix);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  // Clear contents, not the directory: in containers `dest` is often a mount point.
  for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

export { gatewayEnv } from './gateway-env.js';
