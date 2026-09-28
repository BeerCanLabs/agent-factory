import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * Exclusive, renewed lease on a ledger file (DESIGN_AUTHORITY.md LG1: single writer). Works on shared file systems
 * (e.g. EFS) where two hosts could otherwise append to the same file and tear rows. A holder renews its lease
 * well within the TTL; a lease not renewed for a full TTL (a crashed holder) may be taken over.
 */
export type LeaseRecord = { holder: string; renewedAt: number };

export class LeaseHeldError extends Error {
  constructor(readonly current: LeaseRecord, readonly ageMs: number) {
    super(`ledger lease held by ${current.holder} (renewed ${Math.round(ageMs / 1000)}s ago); refusing to become a second writer`);
  }
}

export class LedgerLease {
  readonly holder: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly path: string,
    private readonly opts: { ttlMs?: number; now?: () => number; holder?: string; onLost?: (by: LeaseRecord | undefined) => void } = {},
  ) {
    this.holder = opts.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  private get ttl() {
    return this.opts.ttlMs ?? 30_000;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  read(): LeaseRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as LeaseRecord;
    } catch {
      return undefined; // unreadable lease: treat as absent (it will be overwritten)
    }
  }

  private write() {
    const tmp = `${this.path}.${this.holder.replace(/[^a-z0-9]/gi, '_')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ holder: this.holder, renewedAt: this.now() } satisfies LeaseRecord));
    renameSync(tmp, this.path);
  }

  /** Take the lease, or throw LeaseHeldError if another holder renewed it within the TTL. */
  acquire(): void {
    const cur = this.read();
    if (cur && cur.holder !== this.holder) {
      const age = this.now() - cur.renewedAt;
      if (age < this.ttl) throw new LeaseHeldError(cur, age);
    }
    this.write();
    // Two starters racing over a stale lease: only the one whose write landed last proceeds.
    const after = this.read();
    if (after?.holder !== this.holder) throw new LeaseHeldError(after ?? { holder: 'unknown', renewedAt: this.now() }, 0);
  }

  /** Renew; returns false (and calls onLost) if another holder has taken the lease. */
  renew(): boolean {
    const cur = this.read();
    if (cur && cur.holder !== this.holder) {
      this.opts.onLost?.(cur);
      return false;
    }
    this.write();
    return true;
  }

  /** Renew every third of the TTL until released. */
  keepAlive(): void {
    this.timer = setInterval(() => void this.renew(), Math.max(1000, Math.floor(this.ttl / 3)));
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.read()?.holder === this.holder) {
      try {
        unlinkSync(this.path);
      } catch {}
    }
  }
}
