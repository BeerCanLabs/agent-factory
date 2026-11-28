// Front-door Phase 1 Slice 4 (#565, D-2). Turn a requested scope string into the consented set,
// and into the key-scope ceiling the Bouncer already enforces. Slice 5 is the one verifier.
import type { KeyScopes } from '@beercanlabs/factory-auth';
import {
  DEFAULT_OAUTH_SCOPE,
  FACTORY_SCOPES,
  LEGACY_FULL_SCOPE,
  isFactoryScope,
  isThirdPartyDeniedScope,
  scopeLabel,
  type FactoryScope,
} from '@beercanlabs/factory-auth';

const ALIAS: Record<string, FactoryScope> = {
  [LEGACY_FULL_SCOPE]: 'mcp',
  'agents.read': 'agents:read',
  'agents.converse': 'agents:converse',
  'agents.manage': 'agents:manage',
  'skills.manage': 'skills:manage',
  'grants.manage': 'grants:manage',
  'keys.manage': 'keys:manage',
};

/**
 * Privileges a viewer, an operator, or an approver holds. A token without `admin` cannot rise above this,
 * so a third-party console stays below admin, `grants:manage`, and `keys:manage` (D-2).
 */
const BELOW_ADMIN = [
  'agents.read',
  'agents.models.read',
  'policy.read',
  'config.read',
  'runs.read',
  'ledger.read',
  'models.read',
  'metrics.read',
  'triage.read',
  'spend.read',
  'approvals.read',
  'skills.read',
  'systems.read',
  'systems.propose',
  'connections.read',
  'credentials.provider.read',
  'events.subscribe',
  'schedules.read',
  'mcp.use',
  'content.submit',
  'subscriptions.own',
  'agents.wake',
  'agents.pause',
  'agents.resume',
  'agents.reset',
  'agents.isolate',
  'runs.cancel',
  'agents.converse',
  'schedules.write',
  'agents.update.read',
  'agents.create',
  'content.admit',
] as const;

const NARROW: Partial<Record<FactoryScope, readonly string[]>> = {
  'agents:read': ['agents.read', 'agents.models.read', 'runs.read'],
  'agents:converse': ['agents.converse', 'agents.read'],
  'agents:manage': [
    'agents.create',
    'agents.wake',
    'agents.pause',
    'agents.resume',
    'agents.reset',
    'agents.isolate',
    'agents.update.read',
    'agents.settings.read',
    'agents.settings.set',
    'agents.models.read',
    'agents.models.set',
  ],
  'skills:manage': ['skills.read', 'skills.register', 'skills.adopt.request', 'skills.adopt.remove', 'skills.version.add'],
  'grants:manage': ['grants.manage'],
  'keys:manage': ['credentials.platform.read', 'credentials.platform.set', 'credentials.outstanding.read'],
};

export type NormalizedScopes = { ok: true; scope: string; scopes: FactoryScope[] } | { ok: false; error: 'invalid_scope' };

export function canonicalScopeTokens(raw: string | undefined): FactoryScope[] {
  const out: FactoryScope[] = [];
  for (const token of (raw ?? '').split(/\s+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const canon = ALIAS[trimmed] ?? trimmed;
    if (!isFactoryScope(canon) || out.includes(canon)) continue;
    out.push(canon);
  }
  return FACTORY_SCOPES.filter((scope) => out.includes(scope));
}

/**
 * The scope set a consent screen may offer. An omitted scope is `mcp`. `mcp:full` and the dotted
 * privilege names already in use become the matching factory scope. An unknown scope is refused.
 * Third-party clients lose `admin`, `grants:manage`, and `keys:manage`. If nothing remains, the
 * request is `invalid_scope`.
 */
export function normalizeRequestedScopes(raw: string | undefined, firstParty: boolean): NormalizedScopes {
  const tokens = (raw ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const source = tokens.length === 0 ? [DEFAULT_OAUTH_SCOPE] : tokens;
  const kept: FactoryScope[] = [];
  for (const token of source) {
    const canon = ALIAS[token] ?? token;
    if (!isFactoryScope(canon)) return { ok: false, error: 'invalid_scope' };
    if (!firstParty && isThirdPartyDeniedScope(canon)) continue;
    if (!kept.includes(canon)) kept.push(canon);
  }
  if (kept.length === 0) return { ok: false, error: 'invalid_scope' };
  const scopes = FACTORY_SCOPES.filter((scope) => kept.includes(scope));
  return { ok: true, scope: scopes.join(' '), scopes: [...scopes] };
}

/** A stored `mcp:full` grant still covers any scope a third party is allowed to ask for. */
export function consentCovers(grantedRaw: string, requested: readonly string[]): boolean {
  if (requested.length === 0) return false;
  const grantedTokens = grantedRaw.split(/\s+/).filter(Boolean);
  if (grantedTokens.includes(LEGACY_FULL_SCOPE)) {
    return requested.every((scope) => !isThirdPartyDeniedScope(scope));
  }
  const granted = new Set(canonicalScopeTokens(grantedRaw));
  return requested.every((scope) => isFactoryScope(scope) && granted.has(scope));
}

export function scopeViews(scopes: readonly string[]): { id: string; label: string }[] {
  return scopes.filter(Boolean).map((id) => ({ id, label: scopeLabel(id) }));
}

/**
 * Key-scope ceiling for an access token. `admin` does not narrow (the person's live grants are the ceiling).
 * Any other set narrows. A broad `mcp` / `api` grant stays below admin. Absent scopes do the same, so a
 * token cannot become an admin grant by leaving `scope` off.
 */
export function mapOAuthScopeToKeyScopes(scopeStr?: string): KeyScopes | undefined {
  const scopes = canonicalScopeTokens(scopeStr);
  if (scopes.includes('admin')) return undefined;
  const narrowing = scopes.filter((scope) => NARROW[scope]);
  if (narrowing.length === 0) return { privileges: [...BELOW_ADMIN] };
  const privileges = new Set<string>(['mcp.use']);
  for (const scope of narrowing) {
    for (const privilege of NARROW[scope] ?? []) privileges.add(privilege);
  }
  return { privileges: [...privileges] };
}
