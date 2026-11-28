// Front-door Phase 1 Slice 4 (#565, D-2). Coarse consented scopes. Privileges stay in the Bouncer.
// `mcp:full` is the legacy name these replace. A token still cannot exceed the person's live grants.

export const FACTORY_SCOPES = [
  'openid',
  'profile',
  'email',
  'mcp',
  'api',
  'agents:read',
  'agents:converse',
  'agents:manage',
  'skills:manage',
  'grants:manage',
  'keys:manage',
  'admin',
  'offline_access',
] as const;

export type FactoryScope = (typeof FACTORY_SCOPES)[number];

/** D-2: a third-party client is never offered these. First-party clients may request them. */
export const THIRD_PARTY_DENIED_SCOPES = ['admin', 'grants:manage', 'keys:manage'] as const;

export const DEFAULT_OAUTH_SCOPE = 'mcp';

/** Legacy coarse scope. New grants store `mcp` instead. Refresh of an old family may still echo this string. */
export const LEGACY_FULL_SCOPE = 'mcp:full';

export const FACTORY_SCOPE_LABELS: Record<FactoryScope, string> = {
  openid: 'Confirm it is you',
  profile: 'See your name',
  email: 'See your email address',
  mcp: 'Use the factory MCP tools your account already allows',
  api: 'Call the factory API on your behalf',
  'agents:read': 'See your agents and their status',
  'agents:converse': 'Talk to your agents',
  'agents:manage': 'Create, wake, pause, and change your agents',
  'skills:manage': 'Manage skills',
  'grants:manage': 'Change who can access the factory',
  'keys:manage': 'Create and revoke API keys',
  admin: 'Administer the factory',
  offline_access: 'Stay connected after you close this window',
};

/**
 * First-party heads on `factory.<domain>` (#559). Seeded when `FACTORY_FACTORY_ORIGIN` is set.
 * Web Chat and Connect are flagged now so a later shell is not registered as a third-party console.
 */
export const FIRST_PARTY_HEADS = [
  { id: 'factory-console', name: 'Factory Console', path: '/oauth/callback' },
  { id: 'factory-garrison', name: 'Garrison', path: '/garrison/oauth/callback' },
  { id: 'factory-web-chat', name: 'Web Chat', path: '/chat/oauth/callback' },
  { id: 'factory-connect', name: 'Connect', path: '/connect/oauth/callback' },
] as const;

const KNOWN = new Set<string>(FACTORY_SCOPES);

export function isFactoryScope(scope: string): scope is FactoryScope {
  return KNOWN.has(scope);
}

export function scopeLabel(scope: string): string {
  return isFactoryScope(scope) ? FACTORY_SCOPE_LABELS[scope] : scope;
}

export function isThirdPartyDeniedScope(scope: string): boolean {
  return (THIRD_PARTY_DENIED_SCOPES as readonly string[]).includes(scope);
}
