/** Factory issuer URLs shown on Your API Keys (front-door Phase 1 Slice 1). */

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
