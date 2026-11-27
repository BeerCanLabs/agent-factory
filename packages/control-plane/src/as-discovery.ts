// Front-door auth Phase 1 Slice 1: AS JWKS + OIDC discovery (docs/design/front-door-auth.md §7 / §10 item 4).
import type http from 'node:http';
import {
  JWKS_CACHE_CONTROL,
  generateEphemeralAsKey,
  publicJwksOf,
  stripTrailingSlash,
  type AsKeySet,
} from '@beercanlabs/factory-auth';
import { json, type FactoryState } from './app.js';


function originOf(req?: http.IncomingMessage): string | undefined {
  if (!req?.headers.host) return undefined;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]!.trim() || 'http';
  return `${proto}://${req.headers.host}`;
}

/** Allowed issuer origins (primary + aliases), trailing slashes stripped. */
export function allowedIssuerOrigins(state: Pick<FactoryState, 'asIssuer' | 'asIssuerAliases'>): string[] {
  const out: string[] = [];
  if (state.asIssuer) out.push(stripTrailingSlash(state.asIssuer));
  for (const alias of state.asIssuerAliases ?? []) {
    const clean = stripTrailingSlash(alias);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * The issuer advertised in discovery (and used by the AS). If the request Host is the primary issuer or an
 * alias (D-1: factory-dashboard stays an alias until Phase 3), that origin is returned so existing MCP
 * clients keep seeing a matching `iss`. Otherwise prefer the configured primary, then login/public base, then the request host.
 */
export function resolveAsIssuer(
  state: Pick<FactoryState, 'asIssuer' | 'asIssuerAliases' | 'loginBaseUrl' | 'publicBaseUrl'>,
  req?: http.IncomingMessage,
): string {
  const requestOrigin = originOf(req);
  const allowed = allowedIssuerOrigins(state);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  if (state.asIssuer) return stripTrailingSlash(state.asIssuer);
  if (state.loginBaseUrl) return stripTrailingSlash(state.loginBaseUrl);
  if (state.publicBaseUrl) return stripTrailingSlash(state.publicBaseUrl);
  if (requestOrigin) return requestOrigin;
  return 'http://localhost';
}

export function buildAsMetadata(issuer: string): Record<string, unknown> {
  const iss = stripTrailingSlash(issuer);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    registration_endpoint: `${iss}/api/v1/auth/register`,
    revocation_endpoint: `${iss}/revoke`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    id_token_signing_alg_values_supported: ['ES256'],
    subject_types_supported: ['public'],
    scopes_supported: ['mcp:full'],
  };
}

const ephemeralByState = new WeakMap<FactoryState, AsKeySet>();

/** Configured keys if present, otherwise one ephemeral key (tests / local dev), stable for the state object. */
export async function ensureAsKeys(state: FactoryState): Promise<AsKeySet> {
  if (state.asKeys) return state.asKeys;
  let generated = ephemeralByState.get(state);
  if (!generated) {
    generated = { current: await generateEphemeralAsKey(), ephemeral: true };
    ephemeralByState.set(state, generated);
    state.asKeys = generated;
  }
  return generated;
}

export async function handleAsDiscoveryRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const isJwks = path === '/jwks' || path === '/.well-known/jwks.json';
  const isDiscovery =
    path === '/.well-known/openid-configuration' || path === '/.well-known/oauth-authorization-server';
  if (!isJwks && !isDiscovery) return false;
  const issuer = resolveAsIssuer(state, req);
  const keys = await ensureAsKeys(state);
  res.setHeader('Cache-Control', JWKS_CACHE_CONTROL);
  if (isJwks) {
    return json(res, 200, publicJwksOf(keys)), true;
  }
  return json(res, 200, buildAsMetadata(issuer)), true;
}
