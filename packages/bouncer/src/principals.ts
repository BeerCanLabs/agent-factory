import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Principal } from '@beercanlabs/factory-auth';

const execFileAsync = promisify(execFile);

export const PRINCIPAL_ID = /^user:[a-z0-9][a-z0-9._-]{0,127}$/;
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

export interface VersionedDocBackend<T> {
  readonly description: string;
  loadLatest(): Promise<VersionedSnapshot<T> | undefined>;
  write(snapshot: VersionedSnapshot<T>): Promise<void>;
}

export type AwsCliRunner = (args: string[]) => Promise<string>;

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

function readSnapshotDir<T>(dir: string): VersionedSnapshot<T> | undefined {
  if (!existsSync(dir)) return undefined;
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
  if (existsSync(currentPath)) {
    const ptr = JSON.parse(readFileSync(currentPath, 'utf8')) as { version?: unknown; sha256?: unknown };
    if (typeof ptr?.version !== 'number' || typeof ptr?.sha256 !== 'string') {
      throw new Error('corrupt current.json pointer');
    }
    const target = versions.get(ptr.version);
    if (!target || target.sha256 !== ptr.sha256) {
      throw new Error(`current.json points to missing or mismatched version ${String(ptr.version)}`);
    }
  }
  if (versions.size === 0) return undefined;
  const maxVersion = Math.max(...versions.keys());
  return versions.get(maxVersion);
}

let tmpSeq = 0;

/** Atomic local directory store (`<dir>/<version>.json` + `current.json`). Fails closed on corrupt state (R2, R8). */
export class FileDocBackend<T> implements VersionedDocBackend<T> {
  readonly description: string;
  constructor(private readonly dir: string) {
    this.description = `file://${dir}`;
  }

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
    return readSnapshotDir<T>(this.dir);
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

  async loadLatest(): Promise<VersionedSnapshot<T> | undefined> {
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
      await this.cli([
        's3api', 'put-object',
        '--bucket', this.bucket,
        '--key', `${this.prefix}current.json`,
        '--body', currentFile,
        '--content-type', 'application/json',
        '--checksum-algorithm', 'SHA256',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export class MemoryDocBackend<T> implements VersionedDocBackend<T> {
  readonly description = 'memory://';
  private latest?: VersionedSnapshot<T>;
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

export function docBackendFromUri<T>(uri: string | undefined, fallbackDir: string, cli?: AwsCliRunner): VersionedDocBackend<T> {
  const u = uri?.trim();
  if (!u) return new FileDocBackend<T>(fallbackDir);
  if (u.startsWith('s3://')) return new S3CliDocBackend<T>(u, cli);
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
 * Maps each person (`user:<slug>`) to 1..N globally unique verified lowercased emails across IdPs.
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
      const snap = await this.backend.loadLatest();
      const nextById = new Map<string, PrincipalRecord>();
      const nextByEmail = new Map<string, string>();
      for (const raw of snap?.data?.principals ?? []) {
        if (!raw || !PRINCIPAL_ID.test(raw.id) || nextById.has(raw.id)) {
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
      this.docVersion = snap?.version ?? 0;
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
      if (!PRINCIPAL_ID.test(id)) throw new Error(`invalid principal id '${id}': expected user:<slug>`);
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
    await this.backend.write({
      version: nextVersion,
      updatedAt,
      updatedBy,
      sha256: snapshotSha256(data),
      data,
    });
    this.byId = nextMap;
    if (removedEmail) this.byEmail.delete(removedEmail);
    for (const e of record.emails) this.byEmail.set(e, record.id);
    this.docVersion = nextVersion;
  }
}
