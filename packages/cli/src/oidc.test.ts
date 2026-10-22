import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OidcSession, challengeOf, fetchProviderMetadata, newVerifier, type OidcConfig } from './oidc.js';
import { NeedsLoginError, type CredentialStore } from './credentials.js';
import { fakeJwt, fakeProvider, type Provider } from './testing-oidc.js';

const memory = (): CredentialStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};
const INSTANCE = 'https://f.example.com';

async function setup(configure: (p: Provider) => void = () => {}, over: Partial<OidcConfig> = {}, now = () => Date.now()) {
  const provider = await fakeProvider();
  configure(provider);
  const store = memory();
  const said: string[] = [];
  const config: OidcConfig = { issuer: provider.issuer, clientId: 'cli-client-1', scopes: ['openid', 'email'], tokenUse: 'id_token', ...over };
  const session = new OidcSession(INSTANCE, store, { fetch, openBrowser: provider.openBrowser, say: (t) => said.push(t), timeoutMs: 3000, now }, config);
  return { provider, store, said, session, config };
}

describe('§6.17 CL9 OIDC sign-in (authorization code with PKCE)', () => {
  it('CL9 signs in with PKCE S256, state, nonce and a loopback redirect, and stores the token the factory verifies', async () => {
    const { provider, store, session, said } = await setup();
    try {
      await session.login();
      const q = provider.log.authorize[0];
      assert.equal(q.get('scope'), 'openid email');
      assert.equal(q.get('code_challenge_method'), 'S256');
      assert.ok(q.get('state') && q.get('nonce') && q.get('state') !== q.get('nonce'));
      assert.match(q.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      assert.equal(q.get('prompt'), null, 'a normal sign-in reuses the provider session');
      const tokenReq = provider.log.token[0];
      assert.equal(createHash('sha256').update(tokenReq.get('code_verifier')!).digest('base64url'), q.get('code_challenge'));
      assert.equal(tokenReq.has('client_secret'), false, 'a public client holds no secret');
      assert.match(said.join('\n'), /sign in at 127\.0\.0\.1/);
      const cred = await session.credential();
      assert.equal(cred.name, 'authorization');
      assert.match(cred.value, /^Bearer h?[\w-]+\.[\w-]+\.sig$|^Bearer .+\..+\./);
      const kept = JSON.parse(store.data.get(INSTANCE)!);
      assert.equal(kept.refreshToken, 'refresh-1');
    } finally {
      await provider.close();
    }
  });

  it('CL9 signing in as a different user asks the provider to authenticate again', async () => {
    const { provider, session } = await setup();
    try {
      await session.login({ differentUser: true });
      assert.equal(provider.log.authorize[0].get('prompt'), 'login');
    } finally {
      await provider.close();
    }
  });

  it('CL9 can present the access token instead of the ID token, as the deployment says', async () => {
    const { provider, session } = await setup(() => {}, { tokenUse: 'access_token' });
    try {
      await session.login();
      assert.equal((await session.credential()).value, 'Bearer access-1');
    } finally {
      await provider.close();
    }
  });

  it('CL9 ignores a request to the loopback listener that does not carry this sign-in\'s state', async () => {
    const { provider, session } = await setup((p) => (p.behave.strayRequestFirst = true));
    try {
      await session.login();
      assert.match((await session.credential()).value, /^Bearer /, 'the forged callback neither failed nor completed the sign-in');
      assert.equal(provider.log.token.length, 1);
    } finally {
      await provider.close();
    }
  });

  it('CL9 refuses a token response whose nonce is not this sign-in\'s, and stores nothing', async () => {
    const { provider, session, store } = await setup((p) => (p.behave.wrongNonce = true));
    try {
      await assert.rejects(session.login(), /nonce/);
      assert.equal(store.data.size, 0);
    } finally {
      await provider.close();
    }
  });

  it('CL9 reports a provider that refuses or returns the wrong token, without storing anything', async () => {
    for (const [behave, expected] of [
      [{ error: 'access_denied' }, /refused the sign-in \(access_denied\)/],
      [{ omitIdToken: true }, /nonce/],
    ] as const) {
      const { provider, session, store } = await setup((p) => Object.assign(p.behave, behave));
      try {
        await assert.rejects(session.login(), expected);
        assert.equal(store.data.size, 0);
      } finally {
        await provider.close();
      }
    }
  });

  it('CL9 will not trust provider metadata that names another issuer or uses plain http', async () => {
    const wrong = await fakeProvider();
    wrong.behave.wrongIssuerInMetadata = true;
    const plain = await fakeProvider();
    plain.behave.plainHttpEndpoints = true;
    try {
      await assert.rejects(fetchProviderMetadata(wrong.issuer, fetch), /different issuer/);
      await assert.rejects(fetchProviderMetadata(plain.issuer, fetch), /not https/);
    } finally {
      await wrong.close();
      await plain.close();
    }
  });

  it('CL9 times out when the person never completes the sign-in', async () => {
    const { provider, session } = await setup();
    const quiet = new OidcSession(INSTANCE, memory(), { fetch, openBrowser: async () => {}, say: () => {}, timeoutMs: 50 }, { issuer: provider.issuer, clientId: 'cli-client-1', scopes: ['openid'], tokenUse: 'id_token' });
    try {
      await assert.rejects(quiet.login(), /not completed in time/);
      void session;
    } finally {
      await provider.close();
    }
  });
});

describe('§6.17 CL9 keeping an OIDC sign-in alive', () => {
  it('CL9 renews an expired token with the refresh token and keeps the sign-in', async () => {
    let clock = Date.now();
    const { provider, session, store } = await setup(() => {}, {}, () => clock);
    try {
      await session.login();
      provider.issuedExp = Math.floor(clock / 1000) + 7200;
      clock += 3600_000 + 120_000; // past the first token's life
      const cred = await session.credential();
      assert.equal(provider.log.refresh.length, 1);
      assert.equal(provider.log.refresh[0].get('refresh_token'), 'refresh-1');
      assert.equal(JSON.parse(store.data.get(INSTANCE)!).refreshToken, 'refresh-2', 'a rotated refresh token replaces the old');
      assert.match(cred.value, /^Bearer /);
      await session.credential(); // fresh now: no second refresh
      assert.equal(provider.log.refresh.length, 1);
    } finally {
      await provider.close();
    }
  });

  it('CL9 a refused refresh ends the sign-in and says to log in again', async () => {
    let clock = Date.now();
    const { provider, session, store } = await setup(() => {}, {}, () => clock);
    try {
      await session.login();
      provider.behave.refuseRefresh = true;
      clock += 3600_000 + 120_000;
      await assert.rejects(session.credential(), NeedsLoginError);
      assert.equal(store.data.size, 0, 'the dead sign-in is removed');
    } finally {
      await provider.close();
    }
  });

  it('CL9 with no refresh token, a token that has expired ends the sign-in', async () => {
    let clock = Date.now();
    const { provider, session } = await setup((p) => (p.behave.noRefreshToken = true), {}, () => clock);
    try {
      await session.login();
      await session.credential();
      clock += 3600_000 + 120_000;
      await assert.rejects(session.credential(), NeedsLoginError);
    } finally {
      await provider.close();
    }
  });

  it('CL9 a refusal from the factory forces a renewal even before the token expires', async () => {
    const { provider, session } = await setup();
    try {
      await session.login();
      await session.credential(true);
      assert.equal(provider.log.refresh.length, 1);
    } finally {
      await provider.close();
    }
  });

  it('CL1 sign-out forgets the stored sign-in; a session with no sign-in asks for one', async () => {
    const { provider, session, store } = await setup();
    try {
      await session.login();
      await session.logout();
      assert.equal(store.data.size, 0);
      await assert.rejects(session.credential(), NeedsLoginError);
      const stranger = new OidcSession(INSTANCE, store, { fetch, openBrowser: async () => {}, say: () => {} });
      await assert.rejects(stranger.login(), /has not told the CLI how to sign in/);
    } finally {
      await provider.close();
    }
  });

  it('CL9 PKCE helpers: the challenge is the S256 of the verifier, and verifiers do not repeat', () => {
    const v = newVerifier();
    assert.equal(challengeOf(v), createHash('sha256').update(v).digest('base64url'));
    assert.notEqual(newVerifier(), v);
    assert.ok(v.length >= 43, 'RFC 7636 minimum length');
    assert.equal(fakeJwt({ a: 1 }).split('.').length, 3);
  });
});
