// Front-door Phase 1 Slice 5 (#566). The "who still uses old credentials" tally.
// Every auth.request log line for a legacy method increments the count. The same use is written to the
// ledger as AUTH_LEGACY_CREDENTIAL (at most once per caller and key per 15 minutes) so an operator can
// audit it. Access JWTs and factory login sessions are not legacy.
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import type { AuthMethod, AuthRequestLogEntry } from './auth-method.js';

export const LEGACY_CREDENTIAL_KINDS = [
  { id: 'fk_', label: 'fk_ keys', detail: 'Static factory API keys (person, service, and break-glass).', methods: ['api-key'] as const },
  { id: 'fk_at_', label: 'fk_at_ tokens', detail: 'Legacy OAuth access tokens minted before factory JWTs.', methods: ['oauth'] as const },
  { id: 'factory-token', label: 'factory-token', detail: 'The static FACTORY_TOKEN bearer.', methods: ['static-token'] as const },
  { id: 'oidc-bearer', label: 'oidc-bearer', detail: 'An external OIDC bearer, not a factory login session.', methods: ['oidc-bearer'] as const },
  { id: 'cloudflare-access', label: 'cloudflare-access', detail: 'A Cloudflare Access assertion.', methods: ['cloudflare-access'] as const },
] as const;

export type LegacyCredentialKindId = (typeof LEGACY_CREDENTIAL_KINDS)[number]['id'];

const KIND_BY_METHOD = new Map<AuthMethod, LegacyCredentialKindId>();
for (const kind of LEGACY_CREDENTIAL_KINDS) {
  for (const method of kind.methods) KIND_BY_METHOD.set(method, kind.id);
}

export type LegacyCredentialSample = {
  ts: string;
  actor?: string;
  path: string;
  keyId?: string;
  ledgered: boolean;
};

export type LegacyCredentialKindView = {
  id: LegacyCredentialKindId;
  label: string;
  detail: string;
  /** Requests seen by this control-plane process since it started. */
  count: number;
  /** AUTH_LEGACY_CREDENTIAL rows in the ledger. These survive a restart. A sampled row, not every request. */
  ledgerSamples: number;
  lastSeenAt?: string;
  recent: LegacyCredentialSample[];
};

const RECENT_CAP = 20;
const LEDGER_INTERVAL_MS = 15 * 60 * 1000;

type Bucket = { count: number; lastSeenAt?: string; recent: LegacyCredentialSample[] };

export class LegacyCredentialUse {
  private readonly buckets = new Map<LegacyCredentialKindId, Bucket>();
  private readonly ledgeredAt = new Map<string, number>();

  note(entry: AuthRequestLogEntry, ledger?: LedgerStore, now = Date.now()): void {
    const id = KIND_BY_METHOD.get(entry.authMethod);
    if (!id) return;
    const bucket = this.buckets.get(id) ?? { count: 0, recent: [] };
    bucket.count += 1;
    bucket.lastSeenAt = entry.ts;
    const ledgered = this.writeLedger(id, entry, ledger, now);
    bucket.recent.unshift({
      ts: entry.ts,
      ...(entry.actor ? { actor: entry.actor } : {}),
      path: entry.path,
      ...(entry.keyId ? { keyId: entry.keyId } : {}),
      ledgered,
    });
    if (bucket.recent.length > RECENT_CAP) bucket.recent.length = RECENT_CAP;
    this.buckets.set(id, bucket);
  }

  snapshot(): { source: 'auth.request'; ledgerAction: 'AUTH_LEGACY_CREDENTIAL'; kinds: LegacyCredentialKindView[] } {
    return {
      source: 'auth.request',
      ledgerAction: 'AUTH_LEGACY_CREDENTIAL',
      kinds: LEGACY_CREDENTIAL_KINDS.map((kind) => {
        const bucket = this.buckets.get(kind.id);
        return {
          id: kind.id,
          label: kind.label,
          detail: kind.detail,
          count: bucket?.count ?? 0,
          ledgerSamples: 0,
          ...(bucket?.lastSeenAt ? { lastSeenAt: bucket.lastSeenAt } : {}),
          recent: bucket?.recent.map((sample) => ({ ...sample })) ?? [],
        };
      }),
    };
  }

  private writeLedger(id: LegacyCredentialKindId, entry: AuthRequestLogEntry, ledger: LedgerStore | undefined, now: number): boolean {
    if (!ledger) return false;
    const key = `${id}\0${entry.actor ?? ''}\0${entry.keyId ?? ''}`;
    const previous = this.ledgeredAt.get(key);
    if (previous !== undefined && now - previous < LEDGER_INTERVAL_MS) return false;
    try {
      ledger.append({
        timestamp: entry.ts,
        agentId: 'control-plane',
        type: 'action',
        action: 'AUTH_LEGACY_CREDENTIAL',
        ...(entry.actor ? { actor: entry.actor } : {}),
        subject: `credential:${id}`,
        route: entry.path,
      });
      this.ledgeredAt.set(key, now);
      return true;
    } catch {
      return false;
    }
  }
}

type LedgerAuthRow = { action?: string; subject?: string; actor?: string; route?: string; timestamp?: string };

/** Fold ledger samples into the live tally. Counts stay "since this process started"; ledgerSamples survive a restart. */
export function withLedgerSamples<T extends { kinds: LegacyCredentialKindView[] }>(
  snap: T,
  rows: readonly LedgerAuthRow[],
): T {
  const extra = new Map<string, LegacyCredentialSample[]>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== 'AUTH_LEGACY_CREDENTIAL' || typeof row.subject !== 'string' || !row.subject.startsWith('credential:')) continue;
    const id = row.subject.slice('credential:'.length);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const list = extra.get(id) ?? [];
    list.push({
      ts: row.timestamp ?? '',
      ...(row.actor ? { actor: row.actor } : {}),
      path: row.route ?? '',
      ledgered: true,
    });
    extra.set(id, list);
  }
  return {
    ...snap,
    kinds: snap.kinds.map((kind) => {
      const recent = [...kind.recent];
      for (const sample of extra.get(kind.id) ?? []) {
        if (recent.some((have) => have.ts === sample.ts && have.actor === sample.actor && have.path === sample.path)) continue;
        recent.push(sample);
      }
      recent.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      const lastSeenAt = recent[0]?.ts || kind.lastSeenAt;
      return {
        ...kind,
        ledgerSamples: counts.get(kind.id) ?? 0,
        ...(lastSeenAt ? { lastSeenAt } : {}),
        recent: recent.slice(0, RECENT_CAP),
      };
    }),
  };
}
