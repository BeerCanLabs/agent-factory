import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Directory stand-in or object storage (`uri: s3://bucket`, `uri: gcs://bucket`, `uri: gs://bucket`). */
export type MindStore = {
  root: string;
  uri?: string;
};

export type SyncExecutor = (cmd: string, args: string[]) => void;

/**
 * AM3 (the user's decision): a notebook rotates when it reaches 10 MB or 90 days, whichever comes first. Factory-wide
 * policy, not per agent. The agent closes the current notebook as a read-only volume under `volumes/<name>/` of
 * $MEMORY_DIR; the factory keeps closed volumes in cold storage (the same mind prefix), never hydrates them on wake, and
 * fetches one when the agent asks by writing `<name>` into `.volume-requests/`. A push deletes from the store only a
 * SQLite database's stale journal (see `staleSidecars`), so a rotating agent keeps its notebook's file name (the new
 * notebook replaces the old one in place).
 */
export const NOTEBOOK_ROTATION = { maxBytes: 10 * 1024 * 1024, maxDays: 90 } as const;
export const VOLUMES_DIR = 'volumes';
export const VOLUME_REQUESTS_DIR = '.volume-requests';
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isVolumeName = (name: string): boolean => VOLUME_NAME.test(name) && !name.includes('..');

/** AM3: what every run is told about notebook rotation and volumes. */
export function notebookEnv(): Record<string, string> {
  return {
    FACTORY_NOTEBOOK_MAX_BYTES: String(NOTEBOOK_ROTATION.maxBytes),
    FACTORY_NOTEBOOK_MAX_DAYS: String(NOTEBOOK_ROTATION.maxDays),
    FACTORY_NOTEBOOK_VOLUMES_DIR: VOLUMES_DIR,
    FACTORY_VOLUME_REQUESTS_DIR: VOLUME_REQUESTS_DIR,
  };
}

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
  const [src, dst, exclude] = process.argv.slice(1);
  const endpoint = (process.env.GCS_API_ENDPOINT || 'https://storage.googleapis.com').replace(/\\/$/, '');
  const token = await getToken();
  const headers = token ? { Authorization: 'Bearer ' + token } : {};

  if (process.argv[1] === 'rm') {
    // Delete objects; one that is already gone is not an error.
    for (const uri of process.argv.slice(2)) {
      const m = uri.match(/^gs:\\/\\/([^/]+)\\/(.+)$/);
      if (!m) throw new Error('invalid gs uri: ' + uri);
      const res = await fetch(endpoint + '/storage/v1/b/' + encodeURIComponent(m[1]) + '/o/' + encodeURIComponent(m[2]), { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw new Error('GCS delete failed: ' + res.status);
    }
    return;
  }

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
        if (exclude && exclude.split(',').some((d) => rel === d || rel.startsWith(d + '/'))) continue;
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

/** A mind or volume sync that has not finished in this long is abandoned (it blocks the shim while it runs). */
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** The process a sync step runs: the platform CLI, or this package's GCS helper script. */
export function syncCommand(cmd: string, args: string[]): { file: string; args: string[] } {
  if (cmd === 'gcloud' && args[0] === 'storage' && args[1] === 'rm') {
    return { file: process.execPath, args: ['-e', GCS_SYNC_SCRIPT, 'rm', ...args.slice(2).filter((a) => a.startsWith('gs://'))] };
  }
  if (cmd === 'gcloud' && args[0] === 'storage' && args[1] === 'rsync') {
    const src = args[args.length - 2];
    const dst = args[args.length - 1];
    // `-x ^<dir>/` excludes one top-level directory (AM3: closed volumes on pull).
    const x = args.indexOf('-x');
    const exclude = x >= 0 ? args[x + 1].replace(/^\^\(?/, '').replace(/\)?\/$/, '').split('|').join(',') : '';
    return { file: process.execPath, args: ['-e', GCS_SYNC_SCRIPT, src, dst, ...(exclude ? [exclude] : [])] };
  }
  return { file: cmd, args };
}

export function syncEnv(): NodeJS.ProcessEnv {
  return platformEnv(process.env);
}

function defaultSync(cmd: string, args: string[]): void {
  const c = syncCommand(cmd, args);
  execFileSync(c.file, c.args, { stdio: 'inherit', env: syncEnv(), timeout: SYNC_TIMEOUT_MS });
}

function s3Prefix(store: MindStore, prefix: string): string {
  const base = (store.uri ?? '').replace(/\/$/, '');
  return `${base}/${prefix}`;
}

function gcsPrefix(store: MindStore, prefix: string): string {
  const base = (store.uri ?? '').replace(/\/$/, '').replace(/^gcs:\/\//, 'gs://');
  return `${base}/${prefix}`;
}

/** Hydrates the current notebook. Closed volumes (AM3) stay in cold storage: they are never pulled on wake. */
export function pullMind(store: MindStore, prefix: string, dest: string, sync: SyncExecutor = defaultSync): void {
  mkdirSync(dest, { recursive: true });
  if (store.uri?.startsWith('s3://')) {
    try {
      sync('aws', ['s3', 'sync', s3Prefix(store, prefix), dest, '--exclude', `${VOLUMES_DIR}/*`, '--exclude', `${VOLUME_REQUESTS_DIR}/*`]);
    } catch {
      /* empty prefix on first wake */
    }
    return;
  }
  if (store.uri?.startsWith('gcs://') || store.uri?.startsWith('gs://')) {
    try {
      sync('gcloud', ['storage', 'rsync', '-r', '-x', `^(${VOLUMES_DIR}|${VOLUME_REQUESTS_DIR})/`, gcsPrefix(store, prefix), dest]);
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
  const skipped = [join(src, VOLUMES_DIR), join(src, VOLUME_REQUESTS_DIR)];
  cpSync(src, dest, { recursive: true, filter: (from) => !skipped.some((d) => from === d || from.startsWith(d + sep)) });
}

/** AM3: fetch one closed volume from cold storage into `<dest>/volumes/<name>/`. */
export function pullVolume(store: MindStore, prefix: string, name: string, dest: string, sync: SyncExecutor = defaultSync): void {
  if (!isVolumeName(name)) throw new Error(`invalid volume name: ${name}`);
  const target = join(dest, VOLUMES_DIR, name);
  mkdirSync(target, { recursive: true });
  const rel = `${prefix}/${VOLUMES_DIR}/${name}`;
  if (store.uri?.startsWith('s3://')) sync('aws', ['s3', 'sync', s3Prefix(store, rel), target]);
  else if (store.uri?.startsWith('gcs://') || store.uri?.startsWith('gs://')) sync('gcloud', ['storage', 'rsync', '-r', gcsPrefix(store, rel), target]);
  else {
    const src = join(store.root, rel);
    if (existsSync(src)) cpSync(src, target, { recursive: true });
  }
  // A sync of a prefix that does not exist succeeds and copies nothing: that is a missing volume, not a fetched one.
  if (readdirSync(target).length === 0) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`no volume ${name}`);
  }
}

/** The files SQLite keeps beside a database for writes not yet in it. */
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

function isSqliteDatabase(file: string): boolean {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      return readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === 'SQLite format 3\u0000';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * The journals of the agent's SQLite databases that it no longer has (paths relative to `src`). Object storage keeps
 * what a push does not delete, so a write-ahead log uploaded while the database was open outlives SQLite removing it on
 * a clean close; the next wake pulls the newer database with that old log, SQLite replays it, and the database is
 * corrupt. Only these are deleted from the store: a database the run has, without its journal, is complete without it.
 * Closed volumes (AM3) and volume requests are not the run's to mirror.
 */
export function staleSidecars(src: string): string[] {
  const stale: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!rel && (entry.name === VOLUMES_DIR || entry.name === VOLUME_REQUESTS_DIR)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, path);
      else if (entry.isFile() && isSqliteDatabase(full)) {
        for (const suffix of SQLITE_SIDECARS) if (!existsSync(full + suffix)) stale.push(path + suffix);
      }
    }
  };
  if (existsSync(src)) walk(src, '');
  return stale;
}

/** An S3 CLI filter that matches exactly this key (its filters are globs: `[`, `*` and `?` are taken literally). */
function literalGlob(key: string): string {
  return key.replace(/[[*?]/g, (c) => `[${c}]`);
}

export function pushMind(store: MindStore, prefix: string, src: string, sync: SyncExecutor = defaultSync): void {
  if (store.uri?.startsWith('s3://')) {
    if (!existsSync(src)) return;
    // Stale journals leave first: uploading a newer database beside one is the corruption itself, so a failed delete
    // throws before the upload and the next push tries again. `--delete` is limited by the filters to exactly these keys.
    const stale = staleSidecars(src);
    if (stale.length) sync('aws', ['s3', 'sync', src, s3Prefix(store, prefix), '--delete', '--exclude', '*', ...stale.flatMap((key) => ['--include', literalGlob(key)])]);
    sync('aws', ['s3', 'sync', src, s3Prefix(store, prefix)]);
    return;
  }
  if (store.uri?.startsWith('gcs://') || store.uri?.startsWith('gs://')) {
    if (!existsSync(src)) return;
    const stale = staleSidecars(src);
    if (stale.length) sync('gcloud', ['storage', 'rm', '--continue-on-error', ...stale.map((key) => `${gcsPrefix(store, prefix)}/${key}`)]);
    sync('gcloud', ['storage', 'rsync', '-r', src, gcsPrefix(store, prefix)]);
    return;
  }
  const dest = join(store.root, prefix);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  // Clear contents, not the directory: in containers `dest` is often a mount point. Closed volumes (AM3) are cold
  // storage: the run never hydrated them, so their absence locally is not a deletion.
  for (const name of readdirSync(dest)) if (name !== VOLUMES_DIR) rmSync(join(dest, name), { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

export { gatekeeperEgressEnv } from './gatekeeper-egress-env.js';
