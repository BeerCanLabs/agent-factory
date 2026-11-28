/** Slice 5 (#566): the "Who still uses old credentials" rows, including a zero when nobody has used that kind yet. */

export const LEGACY_KIND_ORDER = ['fk_', 'fk_at_', 'factory-token', 'oidc-bearer', 'cloudflare-access'] as const;

export type LegacyKindId = (typeof LEGACY_KIND_ORDER)[number];

export type LegacyCredentialSample = {
  ts: string;
  actor?: string;
  path: string;
  keyId?: string;
  ledgered?: boolean;
};

export type LegacyCredentialKind = {
  id: string;
  label?: string;
  detail?: string;
  count?: number;
  ledgerSamples?: number;
  lastSeenAt?: string;
  recent?: LegacyCredentialSample[];
};

const COPY: Record<LegacyKindId, { label: string; detail: string }> = {
  fk_: { label: 'fk_ keys', detail: 'Static factory API keys.' },
  fk_at_: { label: 'fk_at_ tokens', detail: 'Legacy OAuth access tokens.' },
  'factory-token': { label: 'factory-token', detail: 'The static FACTORY_TOKEN bearer.' },
  'oidc-bearer': { label: 'oidc-bearer', detail: 'An external OIDC bearer.' },
  'cloudflare-access': { label: 'cloudflare-access', detail: 'A Cloudflare Access assertion.' },
};

export type LegacyCredentialRow = {
  id: LegacyKindId;
  label: string;
  detail: string;
  count: number;
  ledgerSamples: number;
  lastSeenAt?: string;
  recent: LegacyCredentialSample[];
};

/** Always the five Phase 3 leftovers, in a stable order. A missing kind is zero, not hidden. */
export function legacyCredentialRows(kinds: readonly LegacyCredentialKind[] | undefined): LegacyCredentialRow[] {
  return LEGACY_KIND_ORDER.map((id) => {
    const found = kinds?.find((kind) => kind.id === id);
    const copy = COPY[id];
    return {
      id,
      label: found?.label || copy.label,
      detail: found?.detail || copy.detail,
      count: typeof found?.count === 'number' && found.count > 0 ? found.count : 0,
      ledgerSamples: typeof found?.ledgerSamples === 'number' && found.ledgerSamples > 0 ? found.ledgerSamples : 0,
      ...(found?.lastSeenAt ? { lastSeenAt: found.lastSeenAt } : {}),
      recent: [...(found?.recent ?? [])].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
    };
  });
}

export function legacyKindsInUse(rows: readonly LegacyCredentialRow[]): LegacyKindId[] {
  return rows.filter((row) => row.count > 0).map((row) => row.id);
}
