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

const GCS_SYNC_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function getToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  try {
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) return data.access_token;
    }
  } catch {}
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
}

function walkFiles(dir, base = dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

(async () => {
  const [src, dst] = process.argv.slice(1);
  const endpoint = (process.env.GCS_API_ENDPOINT || 'https://storage.googleapis.com').replace(/\\/$/, '');
  const token = await getToken();
  const headers = token ? { Authorization: 'Bearer ' + token } : {};

  if (src.startsWith('gs://')) {
    const m = src.match(/^gs:\\/\\/([^/]+)\\/?(.*)$/);
    if (!m) throw new Error('invalid gs uri: ' + src);
    const [, bucket, rawPrefix] = m;
    const prefix = rawPrefix ? rawPrefix.replace(/\\/+$/, '') + '/' : '';
    let pageToken = '';
    do {
      const url = endpoint + '/storage/v1/b/' + encodeURIComponent(bucket) + '/o?prefix=' + encodeURIComponent(prefix) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error('GCS list failed: ' + res.status);
      const data = await res.json();
      for (const item of data.items || []) {
        const name = item.name || '';
        if (!name.startsWith(prefix) || name.endsWith('/')) continue;
        const rel = name.slice(prefix.length);
        if (!rel || rel.split('/').includes('..')) continue;
        const dl = await fetch(endpoint + '/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' + encodeURIComponent(name) + '?alt=media', { headers });
        if (!dl.ok) throw new Error('GCS download failed: ' + dl.status);
        const buf = Buffer.from(await dl.arrayBuffer());
        const target = path.join(dst, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  } else if (dst.startsWith('gs://')) {
    const m = dst.match(/^gs:\\/\\/([^/]+)\\/?(.*)$/);
    if (!m) throw new Error('invalid gs uri: ' + dst);
    const [, bucket, rawPrefix] = m;
    const prefix = rawPrefix ? rawPrefix.replace(/\\/+$/, '') + '/' : '';
    for (const rel of walkFiles(src)) {
      const bytes = fs.readFileSync(path.join(src, ...rel.split('/')));
      const objectName = prefix + rel;
      const url = endpoint + '/upload/storage/v1/b/' + encodeURIComponent(bucket) + '/o?uploadType=media&name=' + encodeURIComponent(objectName);
      const up = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      if (!up.ok) throw new Error('GCS upload failed: ' + up.status);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

function defaultSync(cmd: string, args: string[]): void {
  const env = platformEnv(process.env);
  if (cmd === 'gcloud' && args[0] === 'storage' && args[1] === 'rsync') {
    const src = args[args.length - 2];
    const dst = args[args.length - 1];
    execFileSync(process.execPath, ['-e', GCS_SYNC_SCRIPT, src, dst], { stdio: 'inherit', env });
    return;
  }
  execFileSync(cmd, args, { stdio: 'inherit', env });
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
