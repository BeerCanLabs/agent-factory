/** Factory issuer URLs and the Slice 2 access-token note shown on Your API Keys. */

export const ACCESS_TOKEN_LIFETIME_MINUTES = 10;

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
