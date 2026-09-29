/**
 * Keymaster credential facilitation (DESIGN_AUTHORITY.md §6.11 K5): what an agent declares, what is present, and
 * what is outstanding. Pure logic: callers supply presence checks and grant lookups, so this never sees a value.
 */
import { catalogEntry, catalogView, inferSource, type CatalogView } from './catalog.js';
import { connectionProvider, type GrantView } from './connections.js';

export type CredentialStatus = 'present' | 'missing' | 'needs_consent' | 'missing_scopes' | 'needs_reconsent';

export type CredentialAction =
  /** Write-only submission: POST the value to `path` (relative to the factory API origin). */
  | { type: 'submit'; method: 'POST'; path: string }
  /** OAuth consent: open `path` (or the absolute `url`) in the browser; it redirects to the provider. */
  | { type: 'consent'; path: string; url: string; available: boolean; reason?: string }
  | { type: 'none'; reason: string };

export type CredentialItem = {
  kind: 'static' | 'oauth';
  /** Secret name (static) or connection provider (OAuth). */
  name: string;
  source?: string;
  /** The source was guessed from the secret name because the cartridge does not declare one. */
  sourceInferred?: boolean;
  description?: string;
  status: CredentialStatus;
  outstanding: boolean;
  /** `platform`: supplied once for the whole factory (gateway-held keys, shared app credentials), not per agent. */
  managedBy: 'agent' | 'platform';
  /** A platform app credential shared by every agent that uses the connection named in `requiredBy`. */
  shared?: boolean;
  requiredBy?: string;
  scopes?: { declared: string[]; granted: string[]; missing: string[] };
  grant?: { grantedBy: string; obtainedAt: string };
  instructions: CatalogView | null;
  action: CredentialAction;
};

export type CredentialSummary = { total: number; outstanding: number; present: number };

export type AssessOptions = {
  agentId: string;
  secrets: Array<{ name: string; source?: string; description?: string }>;
  connections: Array<{ provider: string; scopes: string[] }>;
  /** Secrets the gateway holds for the whole platform (S1): supplied once, through the platform endpoint, never per agent. */
  gatewayHeld: ReadonlySet<string>;
  /** Presence of a secret by name. Must not return or log the value. */
  present: (name: string) => Promise<boolean>;
  grant: (provider: string) => Promise<GrantView | undefined>;
  submitPath: (name: string) => string;
  /** Where a gateway-held (platform) credential is submitted. */
  platformSubmitPath: (name: string) => string;
  consent: (provider: string) => { path: string; url: string };
  /** Why consent cannot start at all (e.g. the factory's public URL is not configured). */
  consentUnavailable?: string;
};

/** Keymaster-held app credentials a declared connection depends on (§6.11 K1). */
function appCredentialOf(provider: string): { name: string; source: string } | undefined {
  const def = connectionProvider(provider);
  if (!def) return undefined;
  return def.kind === 'oauth-user'
    ? { name: def.clientSecret, source: `${def.provider}-oauth-client` }
    : { name: def.keySecret, source: def.provider };
}

/**
 * The secret names an owner may submit for this agent: its declared static secrets that the gateway does not hold,
 * plus the app credentials its declared connections depend on. Anything else is refused.
 */
export function submittableSecrets(opts: Pick<AssessOptions, 'secrets' | 'connections' | 'gatewayHeld'>): Set<string> {
  const out = new Set<string>();
  for (const s of opts.secrets) if (!opts.gatewayHeld.has(s.name)) out.add(s.name);
  for (const c of opts.connections) {
    const app = appCredentialOf(c.provider);
    if (app && !opts.gatewayHeld.has(app.name)) out.add(app.name);
  }
  return out;
}

const instructionsFor = (source?: string) => {
  const entry = catalogEntry(source);
  return entry ? catalogView(entry) : null;
};

export async function assessCredentials(opts: AssessOptions): Promise<CredentialItem[]> {
  const items: CredentialItem[] = [];
  const seen = new Set<string>();

  const staticItem = async (
    d: { name: string; source?: string; description?: string },
    extra: Partial<CredentialItem> = {},
  ): Promise<CredentialItem> => {
    const inferred = d.source ? undefined : inferSource(d.name);
    const source = d.source ?? inferred;
    const base = {
      kind: 'static' as const,
      name: d.name,
      ...(source ? { source } : {}),
      ...(inferred ? { sourceInferred: true } : {}),
      ...(d.description ? { description: d.description } : {}),
      instructions: instructionsFor(source),
      ...extra,
    };
    if (opts.gatewayHeld.has(d.name)) {
      // Held by the gateway for every agent (S1). The Keymaster still owns it (K1/K5): it reports it from metadata
      // and accepts it through the platform's write-only channel.
      const present = await opts.present(d.name);
      return {
        ...base,
        status: present ? 'present' : 'missing',
        outstanding: !present,
        managedBy: 'platform',
        shared: true,
        action: { type: 'submit', method: 'POST', path: opts.platformSubmitPath(d.name) },
      };
    }
    const present = await opts.present(d.name);
    return {
      managedBy: 'agent',
      ...base,
      status: present ? 'present' : 'missing',
      outstanding: !present,
      action: { type: 'submit', method: 'POST', path: opts.submitPath(d.name) },
    };
  };

  const statics = await Promise.all(opts.secrets.map((d) => staticItem(d)));
  for (const item of statics) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    items.push(item);
  }

  for (const c of opts.connections) {
    const def = connectionProvider(c.provider);
    const app = appCredentialOf(c.provider);
    let appItem: CredentialItem | undefined;
    if (app && !seen.has(app.name)) {
      seen.add(app.name);
      appItem = await staticItem(app, { managedBy: 'platform', shared: true, requiredBy: `connection:${c.provider}` });
    }
    if (!def) {
      items.push({
        kind: 'oauth', name: c.provider, status: 'missing', outstanding: true, managedBy: 'agent',
        instructions: instructionsFor(c.provider),
        action: { type: 'none', reason: `the Keymaster does not support the ${c.provider} connection yet` },
      });
      continue;
    }
    if (def.kind === 'jwt-bearer') {
      // App-level access: satisfied by the platform key alone; there is no person to consent.
      if (appItem) items.push(appItem);
      continue;
    }
    const declared = [...new Set(c.scopes)];
    const grant = await opts.grant(c.provider);
    const granted = grant?.scopes ?? [];
    const missing = declared.filter((s) => !granted.includes(s));
    const status: CredentialStatus = !grant ? 'needs_consent' : grant.status === 'needs_reconsent' ? 'needs_reconsent' : missing.length ? 'missing_scopes' : 'present';
    const clientMissing = appItem ? appItem.status !== 'present' : false;
    const reason = opts.consentUnavailable ?? (clientMissing ? `supply ${app!.name} first (the factory's OAuth client)` : undefined);
    items.push({
      kind: 'oauth',
      name: c.provider,
      source: c.provider,
      status,
      outstanding: status !== 'present',
      managedBy: 'agent',
      scopes: { declared, granted, missing },
      ...(grant ? { grant: { grantedBy: grant.grantedBy, obtainedAt: grant.obtainedAt } } : {}),
      instructions: instructionsFor(c.provider),
      action: { type: 'consent', ...opts.consent(c.provider), available: !reason, ...(reason ? { reason } : {}) },
    });
    if (appItem) items.push(appItem);
  }
  return items;
}

/** Platform credentials (gateway-held keys) with their status, for the platform view. */
export async function assessPlatformCredentials(opts: {
  gatewayHeld: ReadonlySet<string>;
  present: (name: string) => Promise<boolean>;
  submitPath: (name: string) => string;
}): Promise<CredentialItem[]> {
  return Promise.all([...opts.gatewayHeld].sort().map(async (name) => {
    const source = inferSource(name);
    const present = await opts.present(name);
    return {
      kind: 'static' as const,
      name,
      ...(source ? { source, sourceInferred: true } : {}),
      status: present ? ('present' as const) : ('missing' as const),
      outstanding: !present,
      managedBy: 'platform' as const,
      shared: true,
      instructions: instructionsFor(source),
      action: { type: 'submit' as const, method: 'POST' as const, path: opts.submitPath(name) },
    };
  }));
}

export function summarize(items: CredentialItem[]): CredentialSummary {
  const outstanding = items.filter((i) => i.outstanding).length;
  return { total: items.length, outstanding, present: items.length - outstanding };
}
