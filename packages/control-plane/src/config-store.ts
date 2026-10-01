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
 *   GET /api/v1/agents/:id/config                 the current version (viewer)
 *   GET /api/v1/agents/:id/config/history         every version, oldest first (viewer)
 *   GET /api/v1/agents/:id/config/versions/:n     one version (viewer)
 *   GET /api/v1/config/export                     every agent's full history (admin; ledgered)
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { authenticate, json, type FactoryState } from './app.js';
import type { AgentPolicy } from './policy.js';

const execFileAsync = promisify(execFile);

export type ConfigSkill = { id: string; version: string };

/** What a configuration is: the part the content hash covers. */
export type ConfigContent = {
  agentId: string;
  source: { repo?: string; commit?: string };
  skills: ConfigSkill[];
  /** The admin-set policy; null when none is set (E7: the agent has no egress of its own). */
  policy: AgentPolicy | null;
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
  exportAll(): ConfigExport;
}

/** Where versions live. Read in full on start; written once per new version. */
export interface ConfigBackend {
  readonly description: string;
  loadAll(): Promise<ConfigRecord[]>;
  /** Writes `<agentId>/<version>.json` (refusing to overwrite) and then the agent's current pointer. */
  write(record: ConfigRecord): Promise<void>;
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
  const content: ConfigContent = { agentId: c.agentId, source: c.source, skills: c.skills, policy: c.policy };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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

/** The agent's configuration as the factory holds it now. Adopted skills carry forward until skill adoption exists. */
export function configOf(state: FactoryState, agentId: string): ConfigContent {
  const agent = state.agents.get(agentId);
  const previous = state.configs?.current(agentId);
  return {
    agentId,
    source: { ...(agent?.repo ? { repo: agent.repo } : {}), ...(agent?.commit ? { commit: agent.commit } : {}) },
    skills: previous?.skills ?? [],
    policy: state.policies.has(agentId) ? state.policies.get(agentId) : null,
  };
}

/**
 * Write-through: record the agent's current configuration as a new version when it changed, and ledger it
 * (`CONFIG_VERSIONED`: agent, version, content hash; never the policy). Never fails the caller: the registry and
 * policy files remain authoritative for running agents, so a store failure is logged and ledgered, not raised.
 */
export async function recordConfig(state: FactoryState, agentId: string, change: { actor: string; reason: string }): Promise<ConfigRecord | undefined> {
  const store = state.configs;
  if (!store || agentId.startsWith('__')) return undefined;
  try {
    const { record, created } = await store.put(configOf(state, agentId), { updatedBy: change.actor, reason: change.reason });
    if (created) ledgerVersion(state, record, change.actor);
    return record;
  } catch (err) {
    console.error(`[control-plane] configuration for ${agentId} not versioned: ${err instanceof Error ? err.message : String(err)}`);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CONFIG_VERSION_FAILED', actor: change.actor });
    return undefined;
  }
}

function ledgerVersion(state: FactoryState, record: ConfigRecord, actor: string): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: record.agentId,
    type: 'action',
    action: 'CONFIG_VERSIONED',
    actor,
    // The ledger's fixed schema has no version field: the version travels as the row's request id, the content hash
    // as its payload hash.
    requestId: `config:${record.agentId}:v${record.version}`,
    payloadSha256: record.hash,
  });
}

/**
 * Migration on start: every agent with registry or policy state but no configuration record gets version 1 from
 * what exists (`updatedBy: 'migration'`). Agents that already have a record are untouched, so it is idempotent.
 */
export async function migrateConfigs(state: FactoryState, candidates: Iterable<string>): Promise<ConfigRecord[]> {
  const store = state.configs;
  if (!store) return [];
  const created: ConfigRecord[] = [];
  for (const agentId of new Set(candidates)) {
    if (agentId.startsWith('__') || store.current(agentId)) continue;
    if (!AGENT_ID.test(agentId)) {
      console.warn(`[control-plane] configuration migration skipped ${JSON.stringify(agentId)}: not a valid record name`);
      continue;
    }
    const record = await recordConfig(state, agentId, { actor: 'migration', reason: 'migrated from existing registry and policy state' });
    if (record) created.push(record);
  }
  return created;
}

/** Who changed it and why: the principal, and an optional `X-Change-Reason` header over the default. */
export function changeReason(req: http.IncomingMessage, fallback: string): string {
  const raw = req.headers['x-change-reason'];
  const given = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return given ? given.slice(0, 500) : fallback;
}

const AGENT_CONFIG = /^\/api\/v1\/agents\/([^/]+)\/config(?:\/(history|versions\/([^/]+)))?$/;

/** The configuration API. Returns false for any path it does not own. Reads never touch the backend. */
export async function handleConfig(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (path === '/api/v1/config/export') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;
    if (!state.configs) {
      json(res, 503, { error: 'config_store_unavailable' });
      return true;
    }
    const out = state.configs.exportAll();
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'factory', type: 'action', action: 'CONFIG_EXPORTED', actor: principal.actor });
    json(res, 200, out);
    return true;
  }
  const m = path.match(AGENT_CONFIG);
  if (!m) return false;
  if (!(await authenticate(req, res, state, 'viewer'))) return true;
  if (!state.configs) {
    json(res, 503, { error: 'config_store_unavailable' });
    return true;
  }
  const agentId = decodeURIComponent(m[1]);
  const history = state.configs.history(agentId);
  if (!history.length) {
    json(res, 404, { error: state.agents.has(agentId) ? 'no_config' : 'not_found' });
    return true;
  }
  if (!m[2]) {
    json(res, 200, history[history.length - 1]);
  } else if (m[2] === 'history') {
    json(res, 200, { agentId, current: history[history.length - 1].version, versions: history });
  } else {
    const n = /^[1-9]\d*$/.test(m[3]) ? Number(m[3]) : NaN;
    const record = history.find((r) => r.version === n);
    if (record) json(res, 200, record);
    else json(res, 404, { error: 'version_not_found' });
  }
  return true;
}
