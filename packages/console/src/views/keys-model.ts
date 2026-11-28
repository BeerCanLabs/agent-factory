/** Factory issuer URLs, the Slice 2 access-token note, the Slice 3 D-4 lifetime copy, and Slice 4 connected apps. */

export const ACCESS_TOKEN_LIFETIME_MINUTES = 10;

/** D-4, locked 27 Nov 2026. The control plane enforces these same numbers. */
export const SESSION_IDLE_HOURS = 12;
export const SESSION_ABSOLUTE_DAYS = 7;
export const REFRESH_PERSON_DAYS = 30;
export const REFRESH_DEVICE_DAYS = 90;

/** Plain-language policy shown on Account and People & Access. */
export function sessionLifetimeCopy(): string {
  return `A sign-in stays active for ${SESSION_IDLE_HOURS} hours after you last use it (idle), and you stay signed in for at most ${SESSION_ABSOLUTE_DAYS} days. Refresh tokens for people last ${REFRESH_PERSON_DAYS} days and slide forward when used. Refresh tokens for devices last ${REFRESH_DEVICE_DAYS} days and slide forward when used.`;
}

/** Copy for the issuer card and the static-keys section. Static keys stay; retirement is Phase 3. */
export function keysAccessTokenCopy(): { issuer: string; keys: string } {
  return {
    issuer:
      'The factory authorization server signs access tokens as 10-minute JWTs and publishes the signing keys at the JWKS endpoint. Existing fk_at_ and fk_ keys still work during this dual-run. Static keys are not removed yet.',
    keys:
      'Static API keys issued for CLI, scripts, and local developer automation. A new secret is shown once and never stored unhashed. Factory-issued OAuth access tokens are 10-minute JWTs. These static keys remain valid during the dual-run.',
  };
}

export type FactoryIssuerInfo = {
  issuer: string;
  jwksUri: string;
  discoveryUrl: string;
};

export type ConnectedAppView = {
  clientName: string;
  scope: string;
  scopes?: { id: string; label: string }[];
  origin?: string;
  firstParty?: boolean;
  blocked?: boolean;
};

/** How a connected app is described on Your API Keys. First-party heads are not labeled as third-party consoles. */
export function connectedAppCopy(app: ConnectedAppView): { kind: string; origin: string; scopes: string } {
  const scopes = app.scopes && app.scopes.length > 0 ? app.scopes.map((scope) => scope.label).join('; ') : app.scope;
  return {
    kind: app.firstParty ? 'First-party factory app' : 'Third-party app',
    origin: app.origin ?? '',
    scopes,
  };
}

export function connectedAppsIntro(): string {
  return 'Connected apps show the scopes you granted. First-party factory apps (Console, Garrison, Web Chat, and Connect) are marked First-party so they are not shown as third-party consoles. Revoking an app invalidates its tokens immediately. Legacy fk_ and fk_at_ keys stay listed above and keep working.';
}

export function factoryIssuerInfo(
  origin: string,
  meta?: { issuer?: unknown; jwks_uri?: unknown } | null,
): FactoryIssuerInfo {
  const base = origin.replace(/\/$/, '');
  const issuer = typeof meta?.issuer === 'string' && meta.issuer.trim() ? meta.issuer.replace(/\/$/, '') : base;
  const jwksUri = typeof meta?.jwks_uri === 'string' && meta.jwks_uri.trim() ? meta.jwks_uri : `${issuer}/jwks`;
  return {
    issuer,
    jwksUri,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
  };
}
