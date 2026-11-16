import type { DeployProvider } from './runtime.js';
import { checkMindPrefix, duplicateMindPrefixes, effectiveMindPrefix } from './mind-prefix.js';

export type IdentityMigrationResult = {
  agentId: string;
  outcome: 'updated' | 'no-role' | 'mismatch' | 'not-narrowed' | 'retired' | 'skipped' | 'failed';
  revoked?: string[];
  detail?: string;
};

type Log = { log: (msg: string) => void; error: (msg: string) => void };

/** Waited out once, at the preflight: the control plane's new grants may still be propagating, or IAM is throttling. */
const RETRYABLE = /^(AccessDenied|AccessDeniedException|Throttling|ThrottlingException|TooManyRequestsException|RequestLimitExceeded|ServiceUnavailable)$/;
export const isRetryable = (err: any): boolean => RETRYABLE.test(String(err?.name ?? err?.Code ?? ''));

export const MIGRATION_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 90_000, 120_000];

async function withRetry<T>(fn: () => Promise<T>, delays: number[], sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isRetryable(err)) throw err;
      await sleep(delays[attempt]);
    }
  }
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * GAP-263, at every control-plane start (not awaited). Never throws.
 * 1. One preflight (listing the identities), retried with backoff while the control plane's new grants propagate.
 *    After that every call fails fast, and each failure is logged as it happens.
 * 2. Identities with no record are stripped of every grant, unless `retireRefusal` says the registry may be incomplete
 *    (then none is). Membership is re-checked live (`isRegistered`) right before each retire, so an agent registered
 *    or re-created meanwhile keeps its role.
 * 3. Each registered agent's role is narrowed to its own prefix (never a shared or invalid one) and loses direct model
 *    access.
 */
export async function migrateAgentIdentities(
  agents: Iterable<{ id: string; memoryPrefix?: string }>,
  dp: Pick<DeployProvider, 'reconcileIdentity' | 'listIdentities' | 'retireIdentity'> | undefined,
  opts: {
    log?: Log;
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    retireRefusal?: string;
    isRegistered?: (id: string) => boolean;
  } = {},
): Promise<IdentityMigrationResult[]> {
  const log = opts.log ?? console;
  const delays = opts.delays ?? MIGRATION_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const reconcile = dp?.reconcileIdentity?.bind(dp);
  if (!reconcile) return [];
  const list = [...agents];
  const snapshot = new Set(list.map((a) => a.id));
  const isRegistered = opts.isRegistered ?? ((id: string) => snapshot.has(id));
  const results: IdentityMigrationResult[] = [];
  const failed = (agentId: string, detail: string) => {
    results.push({ agentId, outcome: 'failed', detail });
    log.error(`[control-plane] agent identity migration failed for ${agentId}: ${detail}`);
  };
  let ids: string[] | undefined;
  if (dp?.listIdentities) {
    try {
      ids = await withRetry(() => dp.listIdentities!(), delays, sleep);
    } catch (err) {
      failed('(preflight)', `${message(err)}; nothing changed`);
      return results;
    }
  }
  if (ids && dp?.retireIdentity) {
    if (opts.retireRefusal) {
      results.push({ agentId: '(identities with no record)', outcome: 'skipped', detail: opts.retireRefusal });
      log.error(`[control-plane] agent identity migration retires nothing: ${opts.retireRefusal}`);
    } else {
      for (const id of ids) {
        if (isRegistered(id)) continue;
        try {
          results.push({ agentId: id, outcome: 'retired', revoked: (await dp.retireIdentity(id)).revoked });
        } catch (err) {
          failed(id, `identity with no record: ${message(err)}`);
        }
      }
    }
  }
  const shared = duplicateMindPrefixes(list);
  for (const a of list) {
    const prefix = effectiveMindPrefix(a);
    let refuse: string | undefined;
    try {
      checkMindPrefix(prefix);
    } catch (err) {
      refuse = message(err);
    }
    if (shared.has(prefix)) refuse = `mind prefix ${JSON.stringify(prefix)} is shared by ${shared.get(prefix)!.join(', ')}`;
    try {
      const r = await reconcile(a.id, { memoryPrefix: prefix, narrow: !refuse });
      if (refuse && r.outcome !== 'no-role') failed(a.id, `${refuse}; mind grant left unchanged`);
      else {
        results.push({ agentId: a.id, outcome: r.outcome, revoked: r.revoked, ...(r.detail ? { detail: r.detail } : {}) });
        if (r.outcome === 'mismatch') log.error(`[control-plane] agent identity migration skipped the mind grant for ${a.id}: ${r.detail}`);
      }
    } catch (err) {
      failed(a.id, message(err));
    }
  }
  const count = (o: IdentityMigrationResult['outcome']) => results.filter((r) => r.outcome === o).length;
  const revoked = results.filter((r) => r.revoked?.length);
  log.log(
    `[control-plane] agent identity migration (GAP-263): ${count('updated')} updated, ${count('retired')} without a record retired, ` +
      `${count('no-role')} without a role, ${count('not-narrowed')} model access only, ${count('mismatch')} prefix mismatch, ${count('failed')} failed` +
      (count('skipped') ? ', retire step skipped' : '') +
      (revoked.length ? `; direct model access removed from ${revoked.map((r) => `${r.agentId} (${r.revoked!.join(', ')})`).join(', ')}` : ''),
  );
  return results;
}
