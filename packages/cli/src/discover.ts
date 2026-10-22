/** Finding out how a factory signs people in (§6.17 CL9). */
import type { OidcConfig } from './oidc.js';
import type { SignInMethod } from './session.js';

export type Discovered = { type: 'cloudflare-access' } | ({ type: 'oidc' } & OidcConfig);

export const DISCOVERY_PATH = '/.well-known/factory-cli';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const httpsOrLoopback = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
};

/** The factory's own document, checked as strictly as the factory builds it. Anything else is not trusted. */
export function parseDiscovery(doc: unknown): Discovered | undefined {
  const a = isObj(doc) && isObj(doc.auth) ? doc.auth : undefined;
  if (!a || a.type !== 'oidc') return undefined;
  const { issuer, clientId, scopes, tokenUse, redirectPort } = a;
  if (typeof issuer !== 'string' || !httpsOrLoopback(issuer)) return undefined;
  if (typeof clientId !== 'string' || !clientId || clientId.length > 256) return undefined;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 20 || scopes.some((s) => typeof s !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(s))) return undefined;
  if (tokenUse !== 'id_token' && tokenUse !== 'access_token') return undefined;
  if (redirectPort !== undefined && (!Number.isInteger(redirectPort) || (redirectPort as number) < 1024 || (redirectPort as number) > 65535)) return undefined;
  return { type: 'oidc', issuer: issuer.replace(/\/$/, ''), clientId, scopes: scopes as string[], tokenUse, ...(redirectPort ? { redirectPort: redirectPort as number } : {}) };
}

/**
 * Asks the factory how to sign in. A published document means OIDC. Behind Cloudflare Access nothing is reachable before
 * sign-in (A1), but the proxy answers with a redirect to its own login, which says what it is.
 */
export async function discoverAuth(instance: string, doFetch: typeof fetch = fetch): Promise<Discovered> {
  let res: Response;
  try {
    res = await doFetch(`${instance.replace(/\/$/, '')}${DISCOVERY_PATH}`, { redirect: 'manual', headers: { accept: 'application/json' } });
  } catch {
    throw new Error(`could not reach ${instance}`);
  }
  if (res.status >= 300 && res.status < 400) {
    const where = res.headers.get('location') ?? '';
    let host = '';
    try {
      host = new URL(where, instance).hostname;
    } catch {
      /* not a URL */
    }
    if (host.endsWith('.cloudflareaccess.com')) return { type: 'cloudflare-access' };
    throw new Error(`${instance} redirected somewhere that is not a sign-in the CLI knows`);
  }
  if (res.status === 200) {
    const found = parseDiscovery(await res.json().catch(() => undefined));
    if (found) return found;
    throw new Error(`${instance} published a sign-in description the CLI does not accept`);
  }
  throw new Error(`${instance} does not say how to sign in. Its admin sets FACTORY_OIDC_CLI_CLIENT_ID for OIDC, or puts it behind Cloudflare Access.`);
}

export const methodOf = (d: Discovered): SignInMethod => d.type;
