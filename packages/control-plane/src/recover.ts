import {
  BREAK_GLASS_OWNER,
  MemoryDocBackend,
  normalizeEmail,
  snapshotSha256,
  type ApiKeyStore,
  type GrantStore,
  type PrincipalStore,
  type VersionedDocBackend,
} from '@beercanlabs/factory-bouncer';
import type { LedgerStore } from '@beercanlabs/factory-ledger';

/**
 * S6 (R9, R11, R12, D5): day-zero bootstrap and out-of-band lockout recovery.
 *
 * Recovery runs with cloud IAM, not factory credentials, so it works even when every admin is unreachable. It writes
 * straight to the principal/grant/key stores. A running control plane holds the single-writer ledger lease, so recovery
 * queues its ledger rows in a recovery outbox. The control plane drains the outbox into the hash-chained ledger and
 * reloads its stores (`drainRecoveryOutbox`). The new break-glass plaintext only ever goes to `writeSecret` and is never
 * returned or printed.
 */

type Stores = { principals: PrincipalStore; grants: GrantStore };

export type RecoveryEvent = { timestamp: string; action: string; actor: string; subject?: string };
export type RecoveryOutboxDoc = { events: RecoveryEvent[] };

function activeHumanAdmins(grants: GrantStore): string[] {
  return grants
    .list({ scopeKind: 'fleet' })
    .filter((g) => g.role === 'admin' && g.state === 'active' && g.subject.startsWith('user:'))
    .map((g) => g.subject);
}

async function ensureAdmin(stores: Stores, email: string, by: string): Promise<string> {
  const norm = normalizeEmail(email);
  const existing = stores.principals.findByEmail(norm);
  const id = existing?.id ?? (await stores.principals.create({ displayName: norm, emails: [norm], by })).id;
  if (!activeHumanAdmins(stores.grants).includes(id)) {
    await stores.grants.grant({ subject: id, scope: { kind: 'fleet' }, role: 'admin', by, granterIsAdmin: true });
  }
  return id;
}

/** FACTORY_BOOTSTRAP_ADMIN applies only while zero active human admins exist; otherwise it is ignored. */
export async function bootstrapAdmin(
  stores: Stores & { ledger: LedgerStore },
  email: string | undefined,
): Promise<'bootstrapped' | 'ignored' | 'unset'> {
  if (!email?.trim()) return 'unset';
  if (activeHumanAdmins(stores.grants).length > 0) return 'ignored';
  const id = await ensureAdmin(stores, email, 'service:bootstrap');
  stores.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: 'control-plane',
    type: 'action',
    action: 'BOOTSTRAP_ADMIN',
    actor: 'service:bootstrap',
    subject: id,
  });
  return 'bootstrapped';
}

export type RecoverInput = Stores & {
  keys: ApiKeyStore;
  outbox: VersionedDocBackend<RecoveryOutboxDoc>;
  /** The operator's cloud identity (e.g. the STS caller ARN), recorded on the outbox write; ledger rows use service:recovery. */
  operator: string;
  email?: string;
  reseedBreakGlass?: boolean;
  /** Writes the new break-glass plaintext to the secret store. Never log its argument. */
  writeSecret?: (plaintext: string) => Promise<void>;
};

export async function recoverLockout(input: RecoverInput): Promise<{ adminId?: string; breakGlassKeyId?: string }> {
  if (!input.email && !input.reseedBreakGlass) throw new Error('nothing to recover: pass an email and/or reseed the break-glass key');
  if (input.reseedBreakGlass && !input.writeSecret) throw new Error('reseeding the break-glass key needs a secret writer');
  const actor = `service:recovery`;
  const events: RecoveryEvent[] = [];
  const out: { adminId?: string; breakGlassKeyId?: string } = {};
  if (input.email) {
    out.adminId = await ensureAdmin(input, input.email, actor);
    events.push({ timestamp: new Date().toISOString(), action: 'LOCKOUT_RECOVERED:admin', actor, subject: out.adminId });
  }
  if (input.reseedBreakGlass) {
    const old = input.keys.list({ owner: BREAK_GLASS_OWNER });
    const { record, plaintext } = await input.keys.create({ owner: BREAK_GLASS_OWNER, roles: ['admin'], expiresAt: null, by: actor });
    try {
      await input.writeSecret!(plaintext);
    } catch (err) {
      // Never leave a key nobody holds: drop the new one and keep the old ones.
      await input.keys.revoke(record.id, { by: actor });
      throw err;
    }
    for (const k of old) await input.keys.revoke(k.id, { by: actor });
    out.breakGlassKeyId = record.id;
    events.push({ timestamp: new Date().toISOString(), action: `LOCKOUT_RECOVERED:break-glass:${record.id}`, actor, subject: BREAK_GLASS_OWNER });
  }
  const prev = (await input.outbox.loadLatest()) ?? undefined;
  const data: RecoveryOutboxDoc = { events: [...(prev?.data.events ?? []), ...events] };
  await input.outbox.write({ version: (prev?.version ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: input.operator, sha256: snapshotSha256(data), data });
  return out;
}

/**
 * Control-plane side: move queued recovery rows into the ledger (keeping its hash chain) and reload the stores so the
 * recovered admin and key take effect without a restart. Returns the number of rows drained.
 */
export async function drainRecoveryOutbox(deps: {
  outbox: VersionedDocBackend<RecoveryOutboxDoc>;
  ledger: LedgerStore;
  reload: () => Promise<void>;
}): Promise<number> {
  const snap = await deps.outbox.loadLatest();
  const events = snap?.data.events ?? [];
  if (events.length === 0) return 0;
  await deps.reload();
  for (const e of events) {
    deps.ledger.append({ timestamp: e.timestamp, agentId: 'control-plane', type: 'action', action: e.action, actor: e.actor, ...(e.subject ? { subject: e.subject } : {}) });
  }
  const data: RecoveryOutboxDoc = { events: [] };
  await deps.outbox.write({ version: (snap?.version ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: 'control-plane', sha256: snapshotSha256(data), data });
  return events.length;
}

export const newRecoveryOutbox = (): VersionedDocBackend<RecoveryOutboxDoc> => new MemoryDocBackend<RecoveryOutboxDoc>();
