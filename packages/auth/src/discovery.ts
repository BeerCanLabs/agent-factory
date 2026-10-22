/**
 * How a command-line client signs a person in (DESIGN_AUTHORITY.md §6.17 CL9). The factory verifies OIDC tokens with
 * `FACTORY_OIDC_ISSUER` and `FACTORY_OIDC_AUDIENCE`; to get one a client also needs a public client id, scopes and to
 * know which token to present. Those are deployment configuration, published here. Nothing in it is a secret.
 */

export type CliDiscovery = {
  auth: {
    type: 'oidc';
    issuer: string;
    clientId: string;
    scopes: string[];
    /** The token the factory verifies: the provider's ID token, or an access token issued for the factory's audience. */
    tokenUse: 'id_token' | 'access_token';
    /** A fixed loopback port, for providers that match the redirect address exactly. Omitted when any port will do. */
    redirectPort?: number;
  };
};

export const CLI_DISCOVERY_PATH = '/.well-known/factory-cli';

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

/** A public document is only as good as its inputs: a bad value stops the factory at boot, like `authFromEnv`. */
export function cliDiscoveryFromEnv(env: NodeJS.ProcessEnv = process.env): CliDiscovery | undefined {
  const clientId = env.FACTORY_OIDC_CLI_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const issuer = env.FACTORY_OIDC_ISSUER?.trim();
  if (!issuer) throw new Error('FACTORY_OIDC_CLI_CLIENT_ID needs FACTORY_OIDC_ISSUER: the CLI signs in at the issuer the factory verifies');
  const url = new URL(issuer);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('FACTORY_OIDC_ISSUER must be https');
  if (clientId.length > 256 || /\s/.test(clientId)) throw new Error('FACTORY_OIDC_CLI_CLIENT_ID is not a client id');

  const scopes = (env.FACTORY_OIDC_CLI_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
  const list = scopes.length ? scopes : DEFAULT_SCOPES;
  if (!list.includes('openid')) list.unshift('openid');
  if (list.length > 20 || list.some((s) => s.length > 128 || !/^[\x21-\x7e]+$/.test(s))) throw new Error('FACTORY_OIDC_CLI_SCOPES is not a list of scopes');

  const tokenUse = (env.FACTORY_OIDC_CLI_TOKEN_USE ?? 'id_token').trim();
  if (tokenUse !== 'id_token' && tokenUse !== 'access_token') throw new Error('FACTORY_OIDC_CLI_TOKEN_USE must be id_token or access_token');

  const portRaw = env.FACTORY_OIDC_CLI_REDIRECT_PORT?.trim();
  let redirectPort: number | undefined;
  if (portRaw) {
    redirectPort = Number(portRaw);
    if (!Number.isInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535) throw new Error('FACTORY_OIDC_CLI_REDIRECT_PORT must be a port from 1024 to 65535');
  }
  return { auth: { type: 'oidc', issuer: issuer.replace(/\/$/, ''), clientId, scopes: list, tokenUse, ...(redirectPort ? { redirectPort } : {}) } };
}
