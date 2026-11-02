import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Principal } from '@beercanlabs/factory-auth';

const execFileAsync = promisify(execFile);

/** Canonical user principal actor (`user:<slug>` or `user:<lowercased-email>`, length <= 256). */
export const PRINCIPAL_ID = /^(?!.*@.*@)(?!.*\.\.)user:[a-z0-9](?:[a-z0-9._@+-]{0,249}[a-z0-9])?$/;
/** Canonical service principal actor (`service:<name>`, length <= 256). */
export const SERVICE_PRINCIPAL_ID = /^service:[a-z0-9][a-z0-9._-]{0,247}$/;

const VERSION_FILE = /^([1-9]\d*)\.json$/;
const EMAIL_LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const EMAIL_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type VersionedSnapshot<T> = {
  version: number;
  updatedAt: string;
  updatedBy: string;
  sha256: string;
  data: T;
};

export type VersionedLoadState<T> = {
  snapshot: VersionedSnapshot<T> | undefined;
  maxSeenVersion: number;
};

export interface VersionedDocBackend<T> {
  readonly description: string;
  loadLatest(): Promise<VersionedSnapshot<T> | undefined>;
  loadState?(): Promise<VersionedLoadState<T>>;
  write(snapshot: VersionedSnapshot<T>): Promise<void>;
}

export type AwsCliRunner = (args: string[]) => Promise<string>;

export type GcsDocBackendOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  apiEndpoint?: string;
};

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function snapshotSha256(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortDeep(data))).digest('hex');
}

function readSnapshotDir<T>(dir: string): VersionedLoadState<T> {
  if (!existsSync(dir)) return { snapshot: undefined, maxSeenVersion: 0 };
  const entries = readdirSync(dir);
  const versions = new Map<number, VersionedSnapshot<T>>();
  for (const name of entries) {
    const m = name.match(VERSION_FILE);
    if (!m) continue;
    const expectedVersion = Number(m[1]);
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as VersionedSnapshot<T>;
    if (!raw || typeof raw !== 'object' || raw.version !== expectedVersion || typeof raw.sha256 !== 'string') {
      throw new Error(`corrupt snapshot ${name}: invalid version metadata`);
    }
    if (snapshotSha256(raw.data) !== raw.sha256) {
      throw new Error(`corrupt snapshot ${name}: sha256 mismatch`);
    }
    versions.set(expectedVersion, raw);
  }
  const currentPath = join(dir, 'current.json');
  const hasCurrent = existsSync(currentPath);
  if (versions.size === 0 && !hasCurrent) {
    return { snapshot: undefined, maxSeenVersion: 0 };
  }
  if (!hasCurrent) {
    throw new Error('corrupt snapshot store: missing current.json pointer');
  }
  const ptr = JSON.parse(readFileSync(currentPath, 'utf8')) as { version?: unknown; sha256?: unknown };
  if (typeof ptr?.version !== 'number' || typeof ptr?.sha256 !== 'string') {
    throw new Error('corrupt current.json pointer');
  }
  const target = versions.get(ptr.version);
  if (!target || target.sha256 !== ptr.sha256) {
    throw new Error(`current.json points to missing or mismatched version ${String(ptr.version)}`);
  }
  return { snapshot: target, maxSeenVersion: Math.max(...versions.keys()) };
}

let tmpSeq = 0;

/** Atomic local directory store (`<dir>/<version>.json` + `current.json`). Fails closed on corrupt state (R2, R8). */
export class FileDocBackend<T> implements VersionedDocBackend<T> {
  readonly description: string;
  constructor(private readonly dir: string) {
    this.description = `file://${dir}`;
  }

  async loadState(): Promise<VersionedLoadState<T>> {
    return readSnapshotDir<T>(this.dir);
  }

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
    return (await this.loadState()).snapshot;
  }

  async write(snapshot: VersionedSnapshot<T>): Promise<void> {
    if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error(`invalid snapshot version: ${snapshot.version}`);
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${snapshot.version}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    const current = join(this.dir, 'current.json');
    const tmp = `${current}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: snapshot.version, sha256: snapshot.sha256 })}\n`);
    renameSync(tmp, current);
  }
}

/** S3 versioned document store via `aws` CLI subprocesses (no AWS SDK in kernel per GAP-014; R2, R8). */
export class S3CliDocBackend<T> implements VersionedDocBackend<T> {
  readonly description: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cli: AwsCliRunner;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(uri: string, cli?: AwsCliRunner, options?: { maxAttempts?: number; retryDelayMs?: number }) {
    const m = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not an s3:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/+$/, '')}/` : '';
    this.description = `s3://${this.bucket}/${this.prefix}`;
    this.maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options?.retryDelayMs ?? 500);
    this.cli =
      cli ??
      (async (args) => {
        const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
        return (
          await execFileAsync('aws', [...args, ...region], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30_000,
          })
        ).stdout;
      });
  }

  async loadState(): Promise<VersionedLoadState<T>> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const dir = mkdtempSync(join(tmpdir(), 'bouncer-doc-load-'));
      try {
        await this.cli(['s3', 'sync', `s3://${this.bucket}/${this.prefix}`, dir, '--only-show-errors', '--no-progress']);
        return readSnapshotDir<T>(dir);
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw lastErr;
  }

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
    return (await this.loadState()).snapshot;
  }

  async write(snapshot: VersionedSnapshot<T>): Promise<void> {
    if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error(`invalid snapshot version: ${snapshot.version}`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'bouncer-doc-put-'));
    try {
      const versionFile = join(dir, 'version.json');
      const currentFile = join(dir, 'current.json');
      writeFileSync(versionFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      writeFileSync(currentFile, `${JSON.stringify({ version: snapshot.version, sha256: snapshot.sha256 })}\n`);
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', `${this.prefix}${snapshot.version}.json`,
        '--body', versionFile,
        '--content-type', 'application/json',
        '--checksum-algorithm', 'SHA256',
        '--if-none-match', '*',
      ]);
      let pointerErr: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          await this.cli([
            's3api', 'put-object',
            '--bucket', this.bucket,
            '--key', `${this.prefix}current.json`,
            '--body', currentFile,
            '--content-type', 'application/json',
            '--checksum-algorithm', 'SHA256',
          ]);
          pointerErr = undefined;
          break;
        } catch (err) {
          pointerErr = err;
          if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
          }
        }
      }
      if (pointerErr !== undefined) throw pointerErr;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

let cachedBouncerGcsToken: { token: string; expiresAt: number } | undefined;

async function defaultBouncerGcsToken(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  if (cachedBouncerGcsToken && Date.now() < cachedBouncerGcsToken.expiresAt - 60_000) return cachedBouncerGcsToken.token;
  try {
    const res = await fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      if (data.access_token) {
        cachedBouncerGcsToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
        return data.access_token;
      }
    }
  } catch {
    // Fall back to gcloud CLI on local developer machines
  }
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', timeout: 10_000 });
  return stdout.trim();
}

/** GCS versioned document store via native GCS JSON API (`ifGenerationMatch=0`, no cloud SDK in kernel per GAP-014; R2, R8, R12). */
export class GcsDocBackend<T> implements VersionedDocBackend<T> {
  readonly description: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly tokenFn: () => Promise<string>;
  private readonly endpoint: string;

  constructor(uri: string, options?: GcsDocBackendOptions) {
    const m = uri.match(/^(?:gs|gcs):\/\/([^/]+)\/?(.*)$/);
    if (!m) throw new Error(`not a gs:// or gcs:// uri: ${uri}`);
    this.bucket = m[1];
    this.prefix = m[2] ? `${m[2].replace(/\/+$/, '')}/` : '';
    this.description = `gs://${this.bucket}/${this.prefix}`;
    this.maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options?.retryDelayMs ?? 500);
    this.fetchFn = options?.fetch ?? fetch;
    this.tokenFn = options?.getAccessToken ?? (() => defaultBouncerGcsToken(this.fetchFn));
    this.endpoint = (options?.apiEndpoint ?? process.env.GCS_API_ENDPOINT ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  }

  async loadState(): Promise<VersionedLoadState<T>> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const dir = mkdtempSync(join(tmpdir(), 'bouncer-gcs-load-'));
      try {
        const token = await this.tokenFn();
        let pageToken: string | undefined;
        do {
          const params = new URLSearchParams();
          if (this.prefix) params.set('prefix', this.prefix);
          if (pageToken) params.set('pageToken', pageToken);
          const listRes = await this.fetchFn(
            `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params.toString()}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
          );
          if (!listRes.ok) throw new Error(`GCS doc list failed (${listRes.status})`);
          const data = (await listRes.json()) as { items?: Array<{ name?: string }>; nextPageToken?: string };
          for (const item of data.items ?? []) {
            const name = item.name ?? '';
            if (!name.startsWith(this.prefix)) continue;
            const rel = name.slice(this.prefix.length);
            if (!rel || rel.includes('/') || (!VERSION_FILE.test(rel) && rel !== 'current.json')) continue;
            const dlRes = await this.fetchFn(
              `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media`,
              { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
            );
            if (!dlRes.ok) throw new Error(`GCS doc download failed (${dlRes.status})`);
            writeFileSync(join(dir, rel), await dlRes.text());
          }
          pageToken = data.nextPageToken;
        } while (pageToken);
        return readSnapshotDir<T>(dir);
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw lastErr;
  }

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
    return (await this.loadState()).snapshot;
  }

  async write(snapshot: VersionedSnapshot<T>): Promise<void> {
    if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error(`invalid snapshot version: ${snapshot.version}`);
    }
    const token = await this.tokenFn();
    const versionKey = `${this.prefix}${snapshot.version}.json`;
    const currentKey = `${this.prefix}current.json`;

    const vRes = await this.fetchFn(
      `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(versionKey)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: `${JSON.stringify(snapshot, null, 2)}\n`,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!vRes.ok) {
      throw new Error(`GCS doc write failed (${vRes.status}: PreconditionFailed)`);
    }

    const ptrBody = `${JSON.stringify({ version: snapshot.version, sha256: snapshot.sha256 })}\n`;
    let pointerErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const cRes = await this.fetchFn(
          `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(currentKey)}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: ptrBody,
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!cRes.ok) throw new Error(`GCS doc pointer write failed (${cRes.status})`);
        pointerErr = undefined;
        break;
      } catch (err) {
        pointerErr = err;
        if (attempt < this.maxAttempts && this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
        }
      }
    }
    if (pointerErr !== undefined) throw pointerErr;
  }
}

export class MemoryDocBackend<T> implements VersionedDocBackend<T> {
  readonly description = 'memory://';
  private latest?: VersionedSnapshot<T>;

  async loadState(): Promise<VersionedLoadState<T>> {
    return {
      snapshot: this.latest ? structuredClone(this.latest) : undefined,
      maxSeenVersion: this.latest?.version ?? 0,
    };
  }

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
    return this.latest ? structuredClone(this.latest) : undefined;
  }

  async write(snapshot: VersionedSnapshot<T>): Promise<void> {
    if (this.latest && snapshot.version <= this.latest.version) {
      throw new Error(`snapshot version ${snapshot.version} already exists`);
    }
    this.latest = structuredClone(snapshot);
  }
}

export function docBackendFromUri<T>(
  uri: string | undefined,
  fallbackDir: string,
  cliOrOptions?: AwsCliRunner | { cli?: AwsCliRunner; gcs?: GcsDocBackendOptions },
): VersionedDocBackend<T> {
  const cli = typeof cliOrOptions === 'function' ? cliOrOptions : cliOrOptions?.cli;
  const gcs = typeof cliOrOptions === 'object' ? cliOrOptions?.gcs : undefined;
  const u = uri?.trim();
  if (!u) return new FileDocBackend<T>(fallbackDir);
  if (u.startsWith('s3://')) return new S3CliDocBackend<T>(u, cli);
  if (u.startsWith('gs://') || u.startsWith('gcs://')) return new GcsDocBackend<T>(u, gcs);
  if (u.startsWith('file://')) return new FileDocBackend<T>(u.slice('file://'.length));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) throw new Error(`unsupported backend uri: ${u}`);
  return new FileDocBackend<T>(u);
}

export type IdpBinding = {
  idp: string;
  sub: string;
  email: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type PrincipalRecord = {
  id: string;
  displayName: string;
  emails: string[];
  idpBindings: IdpBinding[];
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type PrincipalsDoc = { principals: PrincipalRecord[] };

export class DuplicatePrincipalEmailError extends Error {
  readonly status = 409;
  readonly code = 'duplicate_principal_email';
  constructor(readonly email: string, readonly existingPrincipalId: string) {
    super(`email '${email}' is already mapped to principal '${existingPrincipalId}'`);
    this.name = 'DuplicatePrincipalEmailError';
  }
}

export class DuplicatePrincipalIdError extends Error {
  readonly status = 409;
  readonly code = 'duplicate_principal_id';
  constructor(readonly principalId: string) {
    super(`principal '${principalId}' already exists`);
    this.name = 'DuplicatePrincipalIdError';
  }
}

export class PrincipalStoreUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'principal_store_unavailable';
  constructor(cause?: unknown) {
    super(`principal store unavailable: ${cause instanceof Error ? cause.message : String(cause ?? 'unhealthy')}`);
    this.name = 'PrincipalStoreUnavailableError';
  }
}

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('email must be a string');
  const clean = raw.trim().toLowerCase();
  const at = clean.indexOf('@');
  if (clean.length < 3 || clean.length > 254 || at <= 0 || at !== clean.lastIndexOf('@')) {
    throw new Error(`invalid email: ${JSON.stringify(raw)}`);
  }
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !EMAIL_LOCAL.test(local) ||
    !EMAIL_DOMAIN.test(domain)
  ) {
    throw new Error(`invalid email: ${JSON.stringify(raw)}`);
  }
  return clean;
}

export function isValidUserPrincipalId(id: string): boolean {
  if (!PRINCIPAL_ID.test(id)) return false;
  const suffix = id.slice('user:'.length);
  if (suffix.includes('@')) {
    try {
      return normalizeEmail(suffix) === suffix;
    } catch {
      return false;
    }
  }
  return true;
}

export type CreatePrincipalInput = {
  id?: string;
  displayName: string;
  emails: string[];
  by: string;
};

export type RecordSignInInput = {
  idp: string;
  sub?: string;
  email: string;
  emailVerified?: boolean;
};

export type RecordSignInResult =
  | { ok: true; principal: Principal; record: PrincipalRecord; normalizedEmail: string }
  | { ok: true; principal: undefined; normalizedEmail: string }
  | { ok: false; reason: 'email_not_verified' | 'invalid_email' | 'invalid_idp' };

function deriveSlugFromEmail(email: string, existing: ReadonlyMap<string, PrincipalRecord>): string {
  const [local, domain] = email.split('@');
  const sanitize = (s: string) =>
    s.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[-_.]+$/, '').slice(0, 120) || 'u';
  const base = sanitize(local);
  if (!existing.has(`user:${base}`)) return `user:${base}`;
  const withDomain = `${base}-${sanitize(domain)}`.slice(0, 124);
  if (!existing.has(`user:${withDomain}`)) return `user:${withDomain}`;
  let i = 2;
  while (existing.has(`user:${base.slice(0, 118)}-${i}`)) i++;
  return `user:${base.slice(0, 118)}-${i}`;
}

/**
 * Versioned canonical principal directory (D2, D6, D32, R2, R8).
 * Maps each person (`user:<slug>` or `user:<email>`) to 1..N globally unique verified lowercased emails across IdPs.
 */
export class PrincipalStore {
  private byId = new Map<string, PrincipalRecord>();
  private byEmail = new Map<string, string>();
  private docVersion = 0;
  private unhealthy?: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  private constructor(private readonly backend: VersionedDocBackend<PrincipalsDoc>, opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  static async open(backend: VersionedDocBackend<PrincipalsDoc> = new MemoryDocBackend(), opts?: { now?: () => Date }): Promise<PrincipalStore> {
    const store = new PrincipalStore(backend, opts);
    await store.reload();
    return store;
  }

  static inMemory(opts?: { now?: () => Date }): PrincipalStore {
    return new PrincipalStore(new MemoryDocBackend(), opts);
  }

  get description(): string {
    return this.backend.description;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  markUnhealthy(err: unknown): void {
    this.unhealthy = err ?? new Error('marked unhealthy');
  }

  private assertHealthy(): void {
    if (this.unhealthy !== undefined) throw new PrincipalStoreUnavailableError(this.unhealthy);
  }

  async reload(): Promise<void> {
    try {
      const state = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();
      const snap = state.snapshot;
      const nextById = new Map<string, PrincipalRecord>();
      const nextByEmail = new Map<string, string>();
      for (const raw of snap?.data?.principals ?? []) {
        if (!raw || !isValidUserPrincipalId(raw.id) || nextById.has(raw.id)) {
          throw new Error(`invalid or duplicate principal id in store: ${JSON.stringify(raw?.id)}`);
        }
        if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) {
          throw new Error(`invalid displayName on ${raw.id}`);
        }
        if (!Array.isArray(raw.emails) || raw.emails.length === 0) {
          throw new Error(`principal ${raw.id} has no emails`);
        }
        const emails: string[] = [];
        for (const e of raw.emails) {
          const norm = normalizeEmail(e);
          const owner = nextByEmail.get(norm);
          if (owner && owner !== raw.id) throw new DuplicatePrincipalEmailError(norm, owner);
          if (!emails.includes(norm)) {
            emails.push(norm);
            nextByEmail.set(norm, raw.id);
          }
        }
        nextById.set(raw.id, {
          ...structuredClone(raw),
          emails,
          idpBindings: Array.isArray(raw.idpBindings) ? structuredClone(raw.idpBindings) : [],
        });
      }
      this.byId = nextById;
      this.byEmail = nextByEmail;
      this.docVersion = Math.max(snap?.version ?? 0, state.maxSeenVersion);
      this.unhealthy = undefined;
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
  }

  get(id: string): PrincipalRecord | undefined {
    this.assertHealthy();
    if (typeof id !== 'string') return undefined;
    const rec = this.byId.get(id.trim().toLowerCase());
    return rec ? structuredClone(rec) : undefined;
  }

  findByEmail(email: string): PrincipalRecord | undefined {
    this.assertHealthy();
    if (typeof email !== 'string') return undefined;
    const id = this.byEmail.get(email.trim().toLowerCase());
    if (!id) return undefined;
    const rec = this.byId.get(id);
    return rec ? structuredClone(rec) : undefined;
  }

  list(): PrincipalRecord[] {
    this.assertHealthy();
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => structuredClone(r));
  }

  create(input: CreatePrincipalInput): Promise<PrincipalRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
      if (!displayName || displayName.length > 256) throw new Error('displayName must be 1..256 characters');
      const by = typeof input.by === 'string' ? input.by.trim() : '';
      if (!by) throw new Error('by actor is required');
      if (!Array.isArray(input.emails) || input.emails.length === 0) {
        throw new Error('at least one email is required');
      }
      const emails: string[] = [];
      for (const raw of input.emails) {
        const norm = normalizeEmail(raw);
        const existingId = this.byEmail.get(norm);
        if (existingId) throw new DuplicatePrincipalEmailError(norm, existingId);
        if (!emails.includes(norm)) emails.push(norm);
      }
      const id = input.id !== undefined ? input.id.trim().toLowerCase() : deriveSlugFromEmail(emails[0], this.byId);
      if (!isValidUserPrincipalId(id)) throw new Error(`invalid principal id '${id}': expected user:<slug> or user:<email>`);
      if (this.byId.has(id)) throw new DuplicatePrincipalIdError(id);

      const nowIso = this.now().toISOString();
      const record: PrincipalRecord = {
        id,
        displayName,
        emails,
        idpBindings: [],
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        updatedBy: by,
      };
      await this.commitRecord(record, by, nowIso);
      return structuredClone(record);
    });
  }

  addEmail(id: string, email: string, by: string): Promise<PrincipalRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const target = this.byId.get(id.trim().toLowerCase());
      if (!target) throw new Error(`principal '${id}' not found`);
      const actor = by.trim();
      if (!actor) throw new Error('by actor is required');
      const norm = normalizeEmail(email);
      const existingOwner = this.byEmail.get(norm);
      if (existingOwner && existingOwner !== target.id) {
        throw new DuplicatePrincipalEmailError(norm, existingOwner);
      }
      if (target.emails.includes(norm)) return structuredClone(target);

      const nowIso = this.now().toISOString();
      const next: PrincipalRecord = {
        ...structuredClone(target),
        emails: [...target.emails, norm],
        version: target.version + 1,
        updatedAt: nowIso,
        updatedBy: actor,
      };
      await this.commitRecord(next, actor, nowIso);
      return structuredClone(next);
    });
  }

  removeEmail(id: string, email: string, by: string): Promise<PrincipalRecord> {
    return this.enqueue(async () => {
      this.assertHealthy();
      const target = this.byId.get(id.trim().toLowerCase());
      if (!target) throw new Error(`principal '${id}' not found`);
      const actor = by.trim();
      if (!actor) throw new Error('by actor is required');
      const norm = normalizeEmail(email);
      if (!target.emails.includes(norm)) {
        throw new Error(`email '${norm}' is not mapped to principal '${target.id}'`);
      }
      if (target.emails.length <= 1) {
        throw new Error(`cannot remove the last email from principal '${target.id}'`);
      }
      const nowIso = this.now().toISOString();
      const next: PrincipalRecord = {
        ...structuredClone(target),
        emails: target.emails.filter((e) => e !== norm),
        idpBindings: target.idpBindings.filter((b) => b.email !== norm).map((b) => ({ ...b })),
        version: target.version + 1,
        updatedAt: nowIso,
        updatedBy: actor,
      };
      await this.commitRecord(next, actor, nowIso, norm);
      return structuredClone(next);
    });
  }

  async recordSignIn(input: RecordSignInInput): Promise<RecordSignInResult> {
    this.assertHealthy();
    if (input.emailVerified !== true) return { ok: false, reason: 'email_not_verified' };
    const idp = typeof input.idp === 'string' ? input.idp.trim().toLowerCase() : '';
    if (!idp) return { ok: false, reason: 'invalid_idp' };
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(input.email);
    } catch {
      return { ok: false, reason: 'invalid_email' };
    }
    const sub = typeof input.sub === 'string' ? input.sub.trim() : '';

    return this.enqueue(async () => {
      this.assertHealthy();
      const ownerId = this.byEmail.get(normalizedEmail);
      if (!ownerId) {
        return { ok: true, principal: undefined, normalizedEmail };
      }
      const current = this.byId.get(ownerId)!;
      if (!sub) {
        return {
          ok: true,
          principal: { actor: current.id, roles: [] },
          record: structuredClone(current),
          normalizedEmail,
        };
      }
      const nowIso = this.now().toISOString();
      const bindings = structuredClone(current.idpBindings);
      const idx = bindings.findIndex((b) => b.idp === idp && b.sub === sub);
      if (idx >= 0) {
        bindings[idx] = { ...bindings[idx], email: normalizedEmail, lastSeenAt: nowIso };
      } else {
        bindings.push({ idp, sub, email: normalizedEmail, firstSeenAt: nowIso, lastSeenAt: nowIso });
      }
      const next: PrincipalRecord = {
        ...structuredClone(current),
        idpBindings: bindings,
        version: current.version + 1,
        updatedAt: nowIso,
        updatedBy: current.id,
      };
      await this.commitRecord(next, current.id, nowIso);
      return {
        ok: true,
        principal: { actor: next.id, roles: [] },
        record: structuredClone(next),
        normalizedEmail,
      };
    });
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async commitRecord(record: PrincipalRecord, updatedBy: string, updatedAt: string, removedEmail?: string): Promise<void> {
    const nextMap = new Map(this.byId);
    nextMap.set(record.id, record);
    const principals = [...nextMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const data: PrincipalsDoc = { principals };
    const nextVersion = this.docVersion + 1;
    try {
      await this.backend.write({
        version: nextVersion,
        updatedAt,
        updatedBy,
        sha256: snapshotSha256(data),
        data,
      });
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
    this.byId = nextMap;
    if (removedEmail) this.byEmail.delete(removedEmail);
    for (const e of record.emails) this.byEmail.set(e, record.id);
    this.docVersion = nextVersion;
  }
}
