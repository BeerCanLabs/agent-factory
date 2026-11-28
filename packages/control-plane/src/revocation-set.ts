// Front-door Phase 1 Slice 3 (#564, D-4): the revocation set. Durable, cached in memory.
// An entry lives only as long as the token it revokes. A later revoke of the same id keeps the later expiry.
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';

export type RevocationKind = 'sid' | 'jti';

export type RevocationEntry = {
  id: string;
  kind: RevocationKind;
  /** Epoch ms. The entry is ignored once this passes, then dropped on the next write. */
  expiresAt: number;
  revokedAt: number;
  reason: string;
};

export type RevocationDoc = { entries: RevocationEntry[] };

/** A versioned-document write lost a race with another task. The caller reloads and retries. */
export function isSnapshotConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === 'EEXIST') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

export type RevocationInput = { id: string; kind: RevocationKind; expiresAt: number; reason: string };

/**
 * Durable set of revoked session ids, refresh-family ids, legacy key anchors and access-token `jti`s.
 * `has` is a memory lookup. `reload` feeds that memory from the document store so another task's revoke is visible.
 */
export class RevocationSet {
  private entries = new Map<string, RevocationEntry>();
  private docVersion = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private unhealthy?: unknown;
  private readonly now: () => number;

  private constructor(
    private readonly backend: VersionedDocBackend<RevocationDoc>,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  static async open(
    backend: VersionedDocBackend<RevocationDoc> = new MemoryDocBackend<RevocationDoc>(),
    opts?: { now?: () => number },
  ): Promise<RevocationSet> {
    const set = new RevocationSet(backend, opts?.now);
    await set.reload();
    return set;
  }

  get healthy(): boolean {
    return this.unhealthy === undefined;
  }

  /** True when this id is revoked and the entry has not yet expired with its token. */
  has(id: string | undefined): boolean {
    if (!id) return false;
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  async reload(): Promise<void> {
    return this.serial(() => this.reloadUnlocked());
  }

  async revoke(entry: RevocationInput): Promise<void> {
    await this.revokeMany([entry]);
  }

  async revokeMany(batch: readonly RevocationInput[]): Promise<void> {
    const live = batch.filter((entry) => entry.id && entry.expiresAt > this.now());
    if (live.length === 0) return;
    await this.serial(async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.reloadUnlocked();
        const now = this.now();
        for (const entry of live) {
          if (entry.expiresAt <= now) continue;
          const prev = this.entries.get(entry.id);
          this.entries.set(entry.id, {
            id: entry.id,
            kind: entry.kind,
            reason: entry.reason,
            revokedAt: prev?.revokedAt ?? now,
            expiresAt: Math.max(prev?.expiresAt ?? 0, entry.expiresAt),
          });
        }
        this.prune(now);
        try {
          await this.commit();
          return;
        } catch (err) {
          last = err;
          if (!isSnapshotConflict(err)) throw err;
        }
      }
      throw last instanceof Error ? last : new Error('revocation_conflict');
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reloadUnlocked(): Promise<void> {
    try {
      const st = this.backend.loadState
        ? await this.backend.loadState()
        : await (async () => {
            const snapshot = await this.backend.loadLatest();
            return { snapshot, maxSeenVersion: snapshot?.version ?? 0 };
          })();
      const next = new Map<string, RevocationEntry>();
      const now = this.now();
      for (const entry of st.snapshot?.data?.entries ?? []) {
        if (!entry?.id || typeof entry.expiresAt !== 'number') continue;
        if (entry.expiresAt <= now) continue;
        next.set(entry.id, { ...entry });
      }
      this.entries = next;
      this.docVersion = st.snapshot?.version ?? 0;
      this.unhealthy = undefined;
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  private async commit(): Promise<void> {
    const entries = [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    const data: RevocationDoc = { entries };
    const version = this.docVersion + 1;
    try {
      await this.backend.write({
        version,
        updatedAt: new Date(this.now()).toISOString(),
        updatedBy: 'revocation',
        sha256: snapshotSha256(data),
        data,
      });
    } catch (err) {
      this.unhealthy = err;
      throw err;
    }
    this.docVersion = version;
    this.unhealthy = undefined;
  }
}
