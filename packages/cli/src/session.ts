/** A way of signing a person in and the credential it yields (§6.17 CL1, CL9). */
export type Credential = { name: string; value: string };

export type SignInMethod = 'cloudflare-access' | 'oidc';
export const SIGN_IN_METHODS: readonly SignInMethod[] = ['cloudflare-access', 'oidc'];

export interface Session {
  readonly kind: SignInMethod;
  /** What to send. `refresh` skips a stored credential that was just refused. Never opens a browser. */
  credential(refresh?: boolean): Promise<Credential>;
  /** Signs the person in. `differentUser` asks the provider to authenticate again rather than reuse its session. */
  login(opts?: { differentUser?: boolean }): Promise<void>;
  /** Forgets the sign-in here, and wherever the method keeps a copy. */
  logout(): Promise<void>;
  /** For the person: how they are signing in. */
  describe(): string;
}
