import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerLease, LeaseHeldError } from './lease.js';

describe('LedgerLease (LG1 single writer)', () => {
  const setup = () => {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms: number) => (t += ms) };
    const path = join(mkdtempSync(join(tmpdir(), 'lease-')), 'ledger.jsonl.lease');
    const lease = (holder: string, onLost?: () => void) => new LedgerLease(path, { ttlMs: 30_000, now: clock.now, holder, onLost });
    return { clock, lease };
  };

  it('refuses a second writer while the lease is fresh', () => {
    const { clock, lease } = setup();
    lease('a').acquire();
    clock.advance(29_000);
    assert.throws(() => lease('b').acquire(), LeaseHeldError);
  });

  it('lets a new writer take over a lease a crashed holder stopped renewing', () => {
    const { clock, lease } = setup();
    lease('a').acquire();
    clock.advance(30_001);
    const b = lease('b');
    b.acquire();
    assert.equal(b.read()?.holder, 'b');
  });

  it('renewal keeps the lease; a holder that lost it finds out', () => {
    const { clock, lease } = setup();
    let lost = false;
    const a = lease('a', () => (lost = true));
    a.acquire();
    clock.advance(20_000);
    assert.equal(a.renew(), true);
    clock.advance(20_000);
    assert.throws(() => lease('b').acquire(), LeaseHeldError, 'renewed lease must still be fresh');
    clock.advance(31_000);
    lease('b').acquire();
    assert.equal(a.renew(), false);
    assert.equal(lost, true);
  });

  it('release frees the lease immediately for the next writer (stop-then-start deploys)', () => {
    const { lease } = setup();
    const a = lease('a');
    a.acquire();
    a.release();
    lease('b').acquire();
  });
});
