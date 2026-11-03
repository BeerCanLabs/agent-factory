import { generateApiKey, hashApiKey, sameHash, type KeyScopes, type Role } from '@beercanlabs/factory-auth';
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from './principals.js';

/**
 * S5 (R6, D3, D14, D23): factory API keys. A person key is owned by `user:<id>` and is live-intersected with the owner's
 * grants on every request; at most one active key per (owner, deviceFamily). A machine key is owned by `service:<name>`
 * and carries the fixed roles an admin gave it. Only the SHA-256 hash is stored; the plaintext is returned once.
 */
export type ApiKeyRecord = {
  id: string;
  prefix: string;
  hash: string;
  /** Previous hash still accepted until `graceUntil` after a rotation with `graceSeconds`. */
  graceHash?: string;
  graceUntil?: string;
  owner: string;
  deviceFamily?: string;
  scopes?: KeyScopes;
  /** Machine keys only: the fixed roles a `service:<name>` key acts with. */
  roles?: Role[];
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  rotatedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  /** S6: last use, recorded only for the break-glass key (drives the alert until it is rotated). */
  lastUsedAt?: string;
};

/** S6: the sealed break-glass machine key's owner. */
export const BREAK_GLASS_OWNER = 'service:break-glass';

export type ApiKeysDoc = { keys: ApiKeyRecord[] };

export class ApiKeyStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const USER_OWNER = /^user:[A-Za-z0-9!#$%&'*+/=?^_`{|}~@.-]{1,315}$/;
const SERVICE_OWNER = /^service:[a-z0-9][a-z0-9-]{0,62}$/;
const DEVICE_FAMILY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function publicKeyView(k: ApiKeyRecord): Omit<ApiKeyRecord, 'hash' | 'graceHash'> {
  const { hash: _h, graceHash: _g, ...rest } = k;
  return structuredClone(rest);
}

export class ApiKeyStore {
  private byId = new Map<string, ApiKeyRecord>();
  private docVersion = 0;
  private unhealthy?: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  private constructor(private readonly backend: VersionedDocBackend<ApiKeysDoc>, opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  static async open(backend: VersionedDocBackend<ApiKeysDoc> = new MemoryDocBackend(), opts?: { now?: () => Date }): Promise<ApiKeyStore> {
    const store = new ApiKeyStore(backend, opts);
    try {
      await store.reload();
    } catch {
      // stays unhealthy: every key is refused (fail closed)
    }
    return store;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  async reload(): Promise<void> {
    try {
      const st = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();
      const next = new Map<string, ApiKeyRecord>();
      for (const raw of st.snapshot?.data?.keys ?? []) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.hash !== 'string' || next.has(raw.id)) {
          throw new Error('invalid or duplicate key record in store');
        }
        next.set(raw.id, structuredClone(raw));
      }
      this.byId = next;
      this.docVersion = Math.max(st.snapshot?.version ?? 0, st.maxSeenVersion);
      this.unhealthy = undefined;
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
  }

  get(id: string): ApiKeyRecord | undefined {
    const k = this.byId.get(id);
    return k ? structuredClone(k) : undefined;
  }

  list(filter?: { owner?: string; includeRevoked?: boolean }): ApiKeyRecord[] {
    return [...this.byId.values()]
      .filter((k) => (filter?.owner ? k.owner === filter.owner : true))
      .filter((k) => (filter?.includeRevoked ? true : !k.revokedAt))
      .map((k) => structuredClone(k));
  }

  private isActive(k: ApiKeyRecord, at: Date): boolean {
    return !k.revokedAt && (k.expiresAt === null || Date.parse(k.expiresAt) > at.getTime());
  }

  /** The active key a plaintext matches (current hash, or the previous one inside its grace window), else undefined. */
  verify(plaintext: string): ApiKeyRecord | undefined {
    if (!this.healthy || !plaintext.startsWith('fk_')) return undefined;
    const at = this.now();
    const h = hashApiKey(plaintext);
    for (const k of this.byId.values()) {
      if (!this.isActive(k, at)) continue;
      if (sameHash(k.hash, h)) return structuredClone(k);
      if (k.graceHash && k.graceUntil && Date.parse(k.graceUntil) > at.getTime() && sameHash(k.graceHash, h)) {
        return structuredClone(k);
      }
    }
    return undefined;
  }

  create(input: {
    owner: string;
    deviceFamily?: string;
    scopes?: KeyScopes;
    roles?: Role[];
    expiresAt?: string | null;
    by: string;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    return this.serial(async () => {
      this.assertHealthy();
      const owner = String(input.owner ?? '').trim().toLowerCase();
      const isUser = USER_OWNER.test(owner);
      if (!isUser && !SERVICE_OWNER.test(owner)) {
        throw new ApiKeyStoreError(400, 'invalid_owner', 'owner must be user:<id> or service:<name>');
      }
      let deviceFamily: string | undefined;
      if (isUser) {
        deviceFamily = String(input.deviceFamily ?? '').trim().toLowerCase();
        if (!DEVICE_FAMILY.test(deviceFamily)) {
          throw new ApiKeyStoreError(400, 'invalid_device_family', 'person keys need a deviceFamily ([a-z0-9._-], max 64)');
        }
        if (input.roles?.length) throw new ApiKeyStoreError(400, 'invalid_roles', 'person keys take roles from live grants');
        const at = this.now();
        if ([...this.byId.values()].some((k) => k.owner === owner && k.deviceFamily === deviceFamily && this.isActive(k, at))) {
          throw new ApiKeyStoreError(409, 'key_exists', `an active '${deviceFamily}' key already exists for ${owner}; rotate it instead`);
        }
      }
      const expiresAt = normalizeExpiry(input.expiresAt, this.now());
      const scopes = normalizeScopes(input.scopes);
      const gen = generateApiKey();
      const record: ApiKeyRecord = {
        id: 'key_' + gen.hash.slice(0, 16),
        prefix: gen.prefix,
        hash: gen.hash,
        owner,
        ...(deviceFamily ? { deviceFamily } : {}),
        ...(scopes ? { scopes } : {}),
        ...(!isUser && input.roles?.length ? { roles: [...new Set(input.roles)] } : {}),
        expiresAt,
        createdAt: this.now().toISOString(),
        createdBy: input.by,
      };
      await this.commit(record, input.by);
      return { record: structuredClone(record), plaintext: gen.plaintext };
    });
  }

  rotate(id: string, input: { graceSeconds?: number; by: string }): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    return this.serial(async () => {
      this.assertHealthy();
      const cur = this.byId.get(id);
      if (!cur || !this.isActive(cur, this.now())) throw new ApiKeyStoreError(404, 'key_not_found', `no active key '${id}'`);
      const grace = Number(input.graceSeconds ?? 0);
      if (!Number.isFinite(grace) || grace < 0 || grace > 7 * 24 * 3600) {
        throw new ApiKeyStoreError(400, 'invalid_grace', 'graceSeconds must be between 0 and 604800');
      }
      const gen = generateApiKey();
      const now = this.now();
      const next: ApiKeyRecord = { ...structuredClone(cur), hash: gen.hash, prefix: gen.prefix, rotatedAt: now.toISOString() };
      delete next.graceHash;
      delete next.graceUntil;
      if (grace > 0) {
        next.graceHash = cur.hash;
        next.graceUntil = new Date(now.getTime() + grace * 1000).toISOString();
      }
      await this.commit(next, input.by);
      return { record: structuredClone(next), plaintext: gen.plaintext };
    });
  }

  revoke(id: string, input: { by: string }): Promise<ApiKeyRecord> {
    return this.serial(async () => {
      this.assertHealthy();
      const cur = this.byId.get(id);
      if (!cur) throw new ApiKeyStoreError(404, 'key_not_found', `no key '${id}'`);
      if (cur.revokedAt) return structuredClone(cur);
      const next: ApiKeyRecord = { ...structuredClone(cur), revokedAt: this.now().toISOString(), revokedBy: input.by };
      delete next.graceHash;
      delete next.graceUntil;
      await this.commit(next, input.by);
      return structuredClone(next);
    });
  }

  /** S6: record a use of a key (only called for `service:break-glass`, so writes stay rare). */
  markUsed(id: string): Promise<void> {
    return this.serial(async () => {
      const cur = this.byId.get(id);
      if (!cur || !this.healthy) return;
      await this.commit({ ...structuredClone(cur), lastUsedAt: this.now().toISOString() }, 'service:break-glass');
    });
  }

  /** S6 (R11): true while an active break-glass key has been used since it was last issued or rotated. */
  breakGlassAlert(): boolean {
    const at = this.now();
    return [...this.byId.values()].some(
      (k) =>
        k.owner === BREAK_GLASS_OWNER &&
        this.isActive(k, at) &&
        k.lastUsedAt !== undefined &&
        Date.parse(k.lastUsedAt) >= Date.parse(k.rotatedAt ?? k.createdAt),
    );
  }

  private assertHealthy(): void {
    if (this.unhealthy !== undefined) throw new ApiKeyStoreError(503, 'key_store_unavailable', 'API key store is unhealthy');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(record: ApiKeyRecord, by: string): Promise<void> {
    const nextMap = new Map(this.byId);
    nextMap.set(record.id, record);
    const data: ApiKeysDoc = { keys: [...nextMap.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    const version = this.docVersion + 1;
    try {
      await this.backend.write({ version, updatedAt: this.now().toISOString(), updatedBy: by, sha256: snapshotSha256(data), data });
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
    this.byId = nextMap;
    this.docVersion = version;
  }
}

function normalizeExpiry(raw: unknown, now: Date): string | null {
  if (raw === undefined || raw === null) return null;
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) {
    throw new ApiKeyStoreError(400, 'invalid_expiry', 'expiresAt must be a future ISO timestamp or null');
  }
  return new Date(t).toISOString();
}

function normalizeScopes(raw: KeyScopes | undefined): KeyScopes | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new ApiKeyStoreError(400, 'invalid_scopes', 'scopes must be an object');
  const out: KeyScopes = {};
  for (const k of ['privileges', 'agents'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new ApiKeyStoreError(400, 'invalid_scopes', `scopes.${k} must be a list of names`);
    }
    out[k] = [...new Set(v.map((x) => x.trim().toLowerCase()))];
  }
  return out;
}
