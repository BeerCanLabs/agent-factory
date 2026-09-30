import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Directory stand-in or object storage (`uri: s3://bucket`, `uri: gcs://bucket`, `uri: gs://bucket`). */
export type MindStore = {
  root: string;
  uri?: string;
};

export type SyncExecutor = (cmd: string, args: string[]) => void;

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

/**
 * Environment for the shim's own mind sync. Mind sync is platform traffic (DESIGN_AUTHORITY.md E6): it uses the
 * private object-storage endpoint with the agent's own role, so it must not go through the gatekeeper-egress proxy that the
 * agent's code is pointed at. The agent process itself keeps the proxy.
 */
export function platformEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
}

function defaultSync(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit', env: platformEnv(process.env) });
}

function s3Prefix(store: MindStore, prefix: string): string {
  const base = (store.uri ?? '').replace(/\/$/, '');
  return `${base}/${prefix}`;
}

function gcsPrefix(store: MindStore, prefix: string): string {
  const base = (store.uri ?? '').replace(/\/$/, '').replace(/^gcs:\/\//, 'gs://');
  return `${base}/${prefix}`;
}

export function pullMind(store: MindStore, prefix: string, dest: string, sync: SyncExecutor = defaultSync): void {
  mkdirSync(dest, { recursive: true });
  if (store.uri?.startsWith('s3://')) {
    try {
      sync('aws', ['s3', 'sync', s3Prefix(store, prefix), dest]);
    } catch {
      /* empty prefix on first wake */
    }
    return;
  }
  if (store.uri?.startsWith('gcs://') || store.uri?.startsWith('gs://')) {
    try {
      sync('gcloud', ['storage', 'rsync', '-r', gcsPrefix(store, prefix), dest]);
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

export function pushMind(store: MindStore, prefix: string, src: string, sync: SyncExecutor = defaultSync): void {
  if (store.uri?.startsWith('s3://')) {
    if (!existsSync(src)) return;
    sync('aws', ['s3', 'sync', src, s3Prefix(store, prefix)]);
    return;
  }
  if (store.uri?.startsWith('gcs://') || store.uri?.startsWith('gs://')) {
    if (!existsSync(src)) return;
    sync('gcloud', ['storage', 'rsync', '-r', src, gcsPrefix(store, prefix)]);
    return;
  }
  const dest = join(store.root, prefix);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  // Clear contents, not the directory: in containers `dest` is often a mount point.
  for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

export { gatekeeperEgressEnv } from './gatekeeper-egress-env.js';
