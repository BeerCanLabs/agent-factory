/** Choosing the session that matches how a deployment signs people in (§6.17 CL9). */
import { AccessSession, type Cloudflared, type CredentialStore } from './credentials.js';
import { OidcSession, STORED_PREFIX, openBrowser, type OidcConfig, type OidcDeps } from './oidc.js';
import type { Session, SignInMethod } from './session.js';

export type MethodDeps = {
  store: CredentialStore;
  fetch?: typeof fetch;
  say?: (text: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  cloudflared?: Cloudflared;
  cloudflaredDir?: string;
  env?: NodeJS.ProcessEnv;
  signInTimeoutMs?: number;
};

export function makeSession(kind: SignInMethod, instance: string, deps: MethodDeps, oidc?: OidcConfig): Session {
  if (kind === 'oidc') {
    const d: OidcDeps = { fetch: deps.fetch ?? fetch, openBrowser: deps.openBrowser ?? openBrowser, say: deps.say ?? (() => {}), timeoutMs: deps.signInTimeoutMs };
    return new OidcSession(instance, deps.store, d, oidc);
  }
  return new AccessSession(instance, deps.store, deps.cloudflared, deps.env ?? process.env, undefined, deps.cloudflaredDir);
}

/**
 * The method for an address when nothing has been discovered this run: the saved hint, else the one an earlier version
 * of the CLI used (a bare Access assertion in the Keychain). Undefined means /login has to find out.
 */
export async function knownMethod(instance: string, hint: SignInMethod | undefined, store: CredentialStore, env: NodeJS.ProcessEnv = process.env): Promise<SignInMethod | undefined> {
  if (hint) return hint;
  if (env.FACTORY_CLI_ACCESS_TOKEN?.trim()) return 'cloudflare-access'; // an assertion given directly is Access's
  const stored = await store.get(instance).catch(() => undefined);
  if (stored) return stored.startsWith(STORED_PREFIX) ? 'oidc' : 'cloudflare-access';
  return undefined;
}
