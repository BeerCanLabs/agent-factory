import type { DeployProvider } from './runtime.js';
import { checkMindPrefix, duplicateMindPrefixes, effectiveMindPrefix } from './mind-prefix.js';

export type IdentityMigrationResult = {
  agentId: string;
  outcome: 'updated' | 'no-role' | 'mismatch' | 'not-narrowed' | 'retired' | 'failed';
  revoked?: string[];
  detail?: string;
};

type Log = { log: (msg: string) => void; error: (msg: string) => void };

/** Waited out at start: the control plane's new grants may still be propagating, or IAM is throttling. */
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
 * GAP-263, at every control-plane start (not awaited): narrows each registered agent's role to its own prefix (not a
 * shared or invalid one), retires roles with no record, revokes direct model access everywhere. Never throws.
 */
export async function migrateAgentIdentities(
  agents: Iterable<{ id: string; memoryPrefix?: string }>,
  dp: Pick<DeployProvider, 'reconcileIdentity' | 'listIdentities' | 'retireIdentity'> | undefined,
  opts: { log?: Log; delays?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<IdentityMigrationResult[]> {
  const log = opts.log ?? console;
  const delays = opts.delays ?? MIGRATION_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const reconcile = dp?.reconcileIdentity?.bind(dp);
  if (!reconcile) return [];
  const list = [...agents];
  const shared = duplicateMindPrefixes(list);
  const results: IdentityMigrationResult[] = [];
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
      const r = await withRetry(() => reconcile(a.id, { memoryPrefix: prefix, narrow: !refuse }), delays, sleep);
      const outcome = refuse && r.outcome !== 'no-role' ? 'failed' : r.outcome;
      const detail = refuse && r.outcome !== 'no-role' ? `${refuse}; mind grant left unchanged` : r.detail;
      results.push({ agentId: a.id, outcome, revoked: r.revoked, ...(detail ? { detail } : {}) });
    } catch (err) {
      results.push({ agentId: a.id, outcome: 'failed', detail: message(err) });
    }
  }
  if (dp?.listIdentities && dp.retireIdentity) {
    const registered = new Set(list.map((a) => a.id));
    try {
      const ids = await withRetry(() => dp.listIdentities!(), delays, sleep);
      for (const id of ids.filter((x) => !registered.has(x))) {
        try {
          const r = await withRetry(() => dp.retireIdentity!(id), delays, sleep);
          results.push({ agentId: id, outcome: 'retired', revoked: r.revoked });
        } catch (err) {
          results.push({ agentId: id, outcome: 'failed', detail: `identity with no record: ${message(err)}` });
        }
      }
    } catch (err) {
      results.push({ agentId: '(identities with no record)', outcome: 'failed', detail: message(err) });
    }
  }
  const count = (o: IdentityMigrationResult['outcome']) => results.filter((r) => r.outcome === o).length;
  const revoked = results.filter((r) => r.revoked?.length);
  log.log(
    `[control-plane] agent identity migration (GAP-263): ${count('updated')} updated, ${count('retired')} without a record retired, ` +
      `${count('no-role')} without a role, ${count('not-narrowed')} model access only, ${count('mismatch')} prefix mismatch, ${count('failed')} failed` +
      (revoked.length ? `; direct model access removed from ${revoked.map((r) => `${r.agentId} (${r.revoked!.join(', ')})`).join(', ')}` : ''),
  );
  for (const r of results.filter((x) => x.outcome === 'mismatch' || x.outcome === 'failed')) {
    log.error(`[control-plane] agent identity migration ${r.outcome === 'failed' ? 'failed' : 'skipped the mind grant'} for ${r.agentId}: ${r.detail}`);
  }
  return results;
}
