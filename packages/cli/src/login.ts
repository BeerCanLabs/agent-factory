/**
 * S13: `factory login --url <address>` — the factory's own login page signs the person in, and hands this CLI its
 * `cli` device-family key over a state-verified 127.0.0.1 loopback. No pre-credential fetch: nothing is asked of the
 * factory before the browser sign-in (no /.well-known/factory-cli).
 */
import { randomBytes } from 'node:crypto';
import { NeedsLoginError, type CredentialStore } from './credentials.js';
import { challengeOf, newVerifier, openBrowser as defaultOpen, startLoopback } from './oidc.js';
import type { Credential, Session } from './session.js';

export const KEY_PREFIX = 'fk1:';

export type FactoryLoginDeps = {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  say?: (text: string) => void;
  timeoutMs?: number;
};

/** The URL the browser opens: the factory login page carrying the loopback port, our state, and our PKCE challenge. */
export function loginUrl(instance: string, port: number, state: string, challenge: string): string {
  const u = new URL('/login', instance);
  u.search = new URLSearchParams({ cli_port: String(port), cli_state: state, cli_challenge: challenge }).toString();
  return u.toString();
}

export class FactoryKeySession implements Session {
  readonly kind = 'factory' as const;
  constructor(private readonly instance: string, private readonly store: CredentialStore, private readonly deps: FactoryLoginDeps = {}) {}

  describe(): string {
    return 'the factory login page';
  }

  async credential(): Promise<Credential> {
    const raw = await this.store.get(this.instance);
    if (!raw?.startsWith(KEY_PREFIX)) throw new NeedsLoginError(this.instance);
    return { name: 'authorization', value: `Bearer ${raw.slice(KEY_PREFIX.length)}` };
  }

  async login(): Promise<void> {
    const loop = await startLoopback(0);
    try {
      const port = Number(new URL(loop.redirectUri).port);
      const state = randomBytes(24).toString('base64url');
      const verifier = newVerifier();
      const url = loginUrl(this.instance, port, state, challengeOf(verifier));
      (this.deps.say ?? (() => {}))(`Opening ${url} in your browser to sign in.`);
      await (this.deps.openBrowser ?? defaultOpen)(url);
      const code = await loop.wait(state, this.deps.timeoutMs ?? 5 * 60 * 1000);
      const r = await (this.deps.fetch ?? fetch)(new URL('/api/v1/auth/cli/token', this.instance), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      });
      if (!r.ok) throw new Error(`the factory refused the sign-in (HTTP ${r.status})`);
      const out = (await r.json()) as { secret?: unknown };
      if (typeof out.secret !== 'string' || !out.secret.startsWith('fk_')) throw new Error('the factory returned no key');
      await this.store.set(this.instance, KEY_PREFIX + out.secret);
    } finally {
      loop.close();
    }
  }

  async logout(): Promise<void> {
    await this.store.delete(this.instance);
  }
}
