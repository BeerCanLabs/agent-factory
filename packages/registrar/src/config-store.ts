/**
 * Deployment configuration store (DESIGN_AUTHORITY.md §6.14 SK3, §6.13 R1).
 *
 * Each agent has one versioned configuration record: its pinned source (repo and commit), the skills it has adopted
 * (each pinned to an approved version; empty until skill adoption exists) and its policy. Every change creates a new,
 * immutable version recording who, when and why, and is ledgered with the record's content hash (never the policy
 * body). Versions are never overwritten.
 *
 * Reads are served from memory. The backend is read once on start and written only on change, so no API read ever
 * calls the store (GAP-056: a per-read backend call once starved the control plane).
 *
 * Backends are provider-neutral behind `ConfigBackend`:
 *   - a directory (local, Compose): `<dir>/<agentId>/<n>.json` plus `<dir>/<agentId>/current.json`
 *   - an S3 bucket with versioning (AWS): the same layout under `s3://bucket/prefix/`, through the AWS CLI (no SDK in
 *     the kernel, GAP-014); bucket versioning gives point-in-time restore (R1).
 *
 * The Registrar holds the store, its backends and the content hash. The control plane's side (the agent's configuration
 * built from its state, the ledger rows, orphan pruning and the routes) is in `packages/control-plane/src/config-store.ts`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** A filesystem-safe UTC timestamp for archive folders: `2026-10-01T12-00-00-000Z`. */
export function archiveStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

const execFileAsync = promisify(execFile);

export type ConfigSkill = { id: string; version: string };

/**
 * The admin-set policy as the store holds it: copied and hashed, never read, so it is any JSON object (the control
 * plane's `AgentPolicy` fits).
 */
export type ConfigPolicy = Record<string, unknown>;

/** What a configuration is: the part the content hash covers. */
export type ConfigContent = {
  agentId: string;
  source: { repo?: string; commit?: string };
  skills: ConfigSkill[];
  /** The admin-set policy; null when none is set (E7: the agent has no egress of its own). */
  policy: ConfigPolicy | null;
  /** SK3, GAP-088: who owns the agent, as principal actors (`cloudflare:`, `oidc:`, `token:`). Absent when none, never `[]`. */
  owners?: string[];
};

export type ConfigRecord = ConfigContent & {
  version: number;
  updatedAt: string;
  updatedBy: string;
  reason: string;
  /** sha256 of the canonical JSON of the content (agentId, source, skills, policy), hex. */
  hash: string;
};

export type ConfigExport = {
  exportedAt: string;
  store: string;
  agents: Array<{ agentId: string; current: number; versions: ConfigRecord[] }>;
};

/** The provider-neutral store. Reads are synchronous, from memory; only `put` reaches the backend. */
export interface ConfigStore {
  readonly description: string;
  current(agentId: string): ConfigRecord | undefined;
  version(agentId: string, n: number): ConfigRecord | undefined;
  history(agentId: string): ConfigRecord[];
  agentIds(): string[];
  /** Creates the next version unless the content is unchanged (then returns the current one, `created: false`). */
  put(content: ConfigContent, meta: { updatedBy: string; reason: string }): Promise<{ record: ConfigRecord; created: boolean }>;
  /** Removes every version of the agent's record from the backend (recoverably). Undefined when it had none. */
  remove(agentId: string, by: string, reason: string, now?: Date): Promise<ConfigRecord | undefined>;
  exportAll(): ConfigExport;
}

/** Where versions live. Read in full on start; written once per new version. */
export interface ConfigBackend {
  readonly description: string;
  loadAll(): Promise<ConfigRecord[]>;
  /** Writes `<agentId>/<version>.json` (refusing to overwrite) and then the agent's current pointer. */
  write(record: ConfigRecord): Promise<void>;
  /** Removes `<agentId>/` recoverably: delete markers in a versioned bucket, or a move to `_removed/<timestamp>/`. */
  remove(agentId: string, meta: { removedBy: string; reason: string; now?: Date }): Promise<void>;
}

/** Keys sorted at every level, undefined dropped: the same content always yields the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function configHash(c: ConfigContent): string {
  // `owners` only when set, so the hash of every record that has none is what it was before owners existed.
  const content: ConfigContent = { agentId: c.agentId, source: c.source, skills: c.skills, policy: c.policy, ...(c.owners ? { owners: c.owners } : {}) };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_FILE = /^([1-9]\d*)\.json$/;

function checkAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) throw new Error(`agent id ${JSON.stringify(agentId)} cannot name a configuration record`);
}

function body(record: ConfigRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function pointer(record: ConfigRecord): string {
  return `${JSON.stringify({ agentId: record.agentId, version: record.version, hash: record.hash })}\n`;
}

/** Every `<agentId>/<n>.json` under a directory. A record whose hash does not match its content is reported. */
function readTree(dir: string): ConfigRecord[] {
  if (!existsSync(dir)) return [];
  const out: ConfigRecord[] = [];
  for (const agentId of readdirSync(dir)) {
    if (!AGENT_ID.test(agentId)) continue;
    let names: string[];
    try {
      names = readdirSync(join(dir, agentId));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = name.match(VERSION_FILE);
      if (!m) continue;
      const record = JSON.parse(readFileSync(join(dir, agentId, name), 'utf8')) as ConfigRecord;
      if (record.agentId !== agentId || record.version !== Number(m[1])) {
        throw new Error(`configuration ${agentId}/${name} names ${record.agentId} version ${record.version}`);
      }
      if (configHash(record) !== record.hash) {
        console.warn(`[control-plane] configuration ${agentId}/${name}: content does not match its hash ${record.hash}`);
      }
      out.push(record);
    }
  }
  return out;
}

/** A local directory: Compose and single-host installs. */
export class FileConfigBackend implements ConfigBackend {
  readonly description: string;

  constructor(private readonly dir: string) {
    this.description = `file://${dir}`;
  }

  async loadAll(): Promise<ConfigRecord[]> {
    return readTree(this.dir);
  }

  async write(record: ConfigRecord): Promise<void> {
    checkAgentId(record.agentId);
    const agentDir = join(this.dir, record.agentId);
    mkdirSync(agentDir, { recursive: true });
    // `wx`: a version, once written, is never overwritten.
    writeFileSync(join(agentDir, `${record.version}.json`), body(record), { flag: 'wx' });
    const current = join(agentDir, 'current.json');
    const tmp = `${current}.${process.pid}.tmp`;
    writeFileSync(tmp, pointer(record));
    renameSync(tmp, current);
  }

  /** Moves `<dir>/<agentId>` to `<dir>/_removed/<timestamp>/<agentId>` (never deleted) with a note of who and why. */
  async remove(agentId: string, meta: { removedBy: string; reason: string; now?: Date }): Promise<void> {
    checkAgentId(agentId);
    const from = join(this.dir, agentId);
    if (!existsSync(from)) return;
    const now = meta.now ?? new Date();
    const into = join(this.dir, '_removed', archiveStamp(now));
    mkdirSync(into, { recursive: true });
    const to = join(into, agentId);
    renameSync(from, to);
    writeFileSync(join(to, 'removed.json'), `${JSON.stringify({ agentId, removedAt: now.toISOString(), removedBy: meta.removedBy, reason: meta.reason })}\n`);
  }
}

export type AwsCli = (args: string[]) => Promise<string>;

/**
 * An S3 bucket with versioning (R1 point-in-time restore), through the AWS CLI like the ledger's WORM checkpoints.
 * Loading is one `s3 sync` into a scratch directory; each new version is a conditional put that fails if the key
 * already exists, then the current pointer.
 */
export class S3ConfigBackend implements ConfigBackend {
  readonly description: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cli: AwsCli;

  constructor(uri: string, cli?: AwsCli) {
    const m = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not an s3:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/+$/, '')}/` : '';
    this.description = `s3://${this.bucket}/${this.prefix}`;
    this.cli =
      cli ??
      (async (args) => {
        const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
        return (await execFileAsync('aws', [...args, ...region], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
      });
  }

  async loadAll(): Promise<ConfigRecord[]> {
    const dir = mkdtempSync(join(tmpdir(), 'config-store-'));
    try {
      await this.cli(['s3', 'sync', `s3://${this.bucket}/${this.prefix}`, dir, '--only-show-errors', '--no-progress']);
      return readTree(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async write(record: ConfigRecord): Promise<void> {
    checkAgentId(record.agentId);
    const dir = mkdtempSync(join(tmpdir(), 'config-put-'));
    try {
      const versionFile = join(dir, 'version.json');
      const currentFile = join(dir, 'current.json');
      writeFileSync(versionFile, body(record));
      writeFileSync(currentFile, pointer(record));
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', `${this.prefix}${record.agentId}/${record.version}.json`,
        '--body', versionFile,
        '--content-type', 'application/json',
        '--checksum-algorithm', 'SHA256',
        '--if-none-match', '*',
      ]);
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', `${this.prefix}${record.agentId}/current.json`,
        '--body', currentFile,
        '--content-type', 'application/json',
        '--checksum-algorithm', 'SHA256',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * `s3 rm --recursive` of the agent's prefix (with its trailing slash, so `ada/` never matches `adam/`). The bucket is
   * versioned, so this only adds delete markers: every version stays restorable for the non-current retention period.
   */
  async remove(agentId: string, _meta?: { removedBy: string; reason: string; now?: Date }): Promise<void> {
    checkAgentId(agentId);
    await this.cli(['s3', 'rm', `s3://${this.bucket}/${this.prefix}${agentId}/`, '--recursive', '--only-show-errors']);
  }
}

/** `FACTORY_CONFIG_STORE_URI`: `s3://bucket/prefix`, `file:///path` or a plain path. Unset: `fallbackDir`. */
export function configBackendFromEnv(uri: string | undefined, fallbackDir: string, cli?: AwsCli): ConfigBackend {
  const u = uri?.trim();
  if (!u) return new FileConfigBackend(fallbackDir);
  if (u.startsWith('s3://')) return new S3ConfigBackend(u, cli);
  if (u.startsWith('file://')) return new FileConfigBackend(u.slice('file://'.length));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) throw new Error(`FACTORY_CONFIG_STORE_URI must be s3://, file:// or a path, got ${u}`);
  return new FileConfigBackend(u);
}

/** The store: every version in memory, written through to its backend on change. */
export class VersionedConfigStore implements ConfigStore {
  private readonly versions = new Map<string, ConfigRecord[]>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly backend: ConfigBackend) {}

  get description(): string {
    return this.backend.description;
  }

  /** Reads the backend once. */
  static async open(backend: ConfigBackend): Promise<VersionedConfigStore> {
    const store = new VersionedConfigStore(backend);
    for (const r of await backend.loadAll()) {
      const list = store.versions.get(r.agentId) ?? [];
      list.push(r);
      store.versions.set(r.agentId, list);
    }
    for (const list of store.versions.values()) list.sort((a, b) => a.version - b.version);
    return store;
  }

  current(agentId: string): ConfigRecord | undefined {
    const list = this.versions.get(agentId);
    return list?.length ? structuredClone(list[list.length - 1]) : undefined;
  }

  version(agentId: string, n: number): ConfigRecord | undefined {
    const r = this.versions.get(agentId)?.find((v) => v.version === n);
    return r ? structuredClone(r) : undefined;
  }

  history(agentId: string): ConfigRecord[] {
    return structuredClone(this.versions.get(agentId) ?? []);
  }

  agentIds(): string[] {
    return [...this.versions.keys()].sort();
  }

  put(content: ConfigContent, meta: { updatedBy: string; reason: string }): Promise<{ record: ConfigRecord; created: boolean }> {
    // One write at a time, so version numbers are assigned in order.
    const next = this.queue.then(() => this.write(content, meta));
    this.queue = next.catch(() => undefined);
    return next;
  }

  remove(agentId: string, by: string, reason: string, now?: Date): Promise<ConfigRecord | undefined> {
    const next = this.queue.then(async () => {
      checkAgentId(agentId);
      const latest = this.current(agentId);
      if (!latest) return undefined;
      await this.backend.remove(agentId, { removedBy: by, reason, ...(now ? { now } : {}) });
      this.versions.delete(agentId);
      return latest;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(content: ConfigContent, meta: { updatedBy: string; reason: string }): Promise<{ record: ConfigRecord; created: boolean }> {
    checkAgentId(content.agentId);
    const hash = configHash(content);
    const latest = this.current(content.agentId);
    if (latest && latest.hash === hash) return { record: latest, created: false };
    const record: ConfigRecord = {
      agentId: content.agentId,
      version: (latest?.version ?? 0) + 1,
      source: structuredClone(content.source),
      skills: structuredClone(content.skills),
      policy: structuredClone(content.policy),
      ...(content.owners ? { owners: [...content.owners] } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: meta.updatedBy,
      reason: meta.reason,
      hash,
    };
    await this.backend.write(record);
    const list = this.versions.get(record.agentId) ?? [];
    list.push(record);
    this.versions.set(record.agentId, list);
    return { record: structuredClone(record), created: true };
  }

  exportAll(): ConfigExport {
    return {
      exportedAt: new Date().toISOString(),
      store: this.backend.description,
      agents: this.agentIds().map((agentId) => {
        const versions = this.history(agentId);
        return { agentId, current: versions[versions.length - 1].version, versions };
      }),
    };
  }
}
