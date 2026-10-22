import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OidcSession, challengeOf, fetchProviderMetadata, newVerifier, startLoopback, type OidcConfig } from './oidc.js';
import { networkInterfaces } from 'node:os';
import { NeedsLoginError, type CredentialStore } from './credentials.js';
import { fakeJwt, fakeProvider, type Provider } from './testing-oidc.js';

const memory = (): CredentialStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};
const INSTANCE = 'https://f.example.com';
const decode = (raw: string) => JSON.parse(Buffer.from(raw.slice('oidc1:'.length), 'base64url').toString('utf8'));

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
      const kept = decode(store.data.get(INSTANCE)!);
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
      assert.equal(decode(store.data.get(INSTANCE)!).refreshToken, 'refresh-2', 'a rotated refresh token replaces the old');
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

describe('§6.17 CL9 an OIDC sign-in survives trouble that is not the provider ending it', () => {
  it('CL9 a network error or a 5xx while renewing keeps the sign-in, and says to try again', async () => {
    let clock = Date.now();
    const { provider, session, store } = await setup(() => {}, {}, () => clock);
    try {
      await session.login();
      const kept = store.data.get(INSTANCE);
      clock += 3600_000 + 120_000;
      provider.behave.refreshStatus = 503;
      await assert.rejects(session.credential(), (e: Error) => !(e instanceof NeedsLoginError) && /try again/.test(e.message));
      assert.equal(store.data.get(INSTANCE), kept, 'a provider outage does not cost the person their sign-in');
      await provider.close(); // now the network itself fails
      await assert.rejects(session.credential(), (e: Error) => !(e instanceof NeedsLoginError) && /try again/.test(e.message));
      assert.equal(store.data.get(INSTANCE), kept);
    } finally {
      await provider.close().catch(() => {});
    }
  });

  it('CL9 requests made at the same moment share one renewal, so a rotating refresh token is spent once', async () => {
    let clock = Date.now();
    const { provider, session } = await setup(() => {}, {}, () => clock);
    try {
      await session.login();
      clock += 3600_000 + 120_000;
      const [a, b, c] = await Promise.all([session.credential(), session.credential(), session.credential()]);
      assert.equal(provider.log.refresh.length, 1);
      assert.equal(a.value, b.value);
      assert.equal(b.value, c.value);
    } finally {
      await provider.close();
    }
  });
});

describe('§6.17 CL9 renewal edge cases', () => {
  it('CL9 a 429 or 408 from the provider is waited out, not treated as the end of the sign-in', async () => {
    for (const status of [429, 408]) {
      let clock = Date.now();
      const { provider, session, store } = await setup(() => {}, {}, () => clock);
      try {
        await session.login();
        const kept = store.data.get(INSTANCE);
        clock += 3600_000 + 120_000;
        provider.behave.refreshStatus = status;
        await assert.rejects(session.credential(), (e: Error) => !(e instanceof NeedsLoginError));
        assert.equal(store.data.get(INSTANCE), kept, `HTTP ${status}`);
      } finally {
        await provider.close();
      }
    }
  });

  it('CL9 a caller that read the sign-in before another renewed it uses the renewed one instead of spending the old refresh token', async () => {
    let clock = Date.now();
    const provider = await fakeProvider();
    try {
      const data = new Map<string, string>();
      let hold: (() => void) | undefined;
      let slowNext = false;
      const store: CredentialStore = {
        get: async (i) => {
          const v = data.get(i);
          if (slowNext) {
            slowNext = false;
            await new Promise<void>((r) => (hold = r)); // this reader sees the sign-in as it was, and is slow
          }
          return v;
        },
        set: async (i, t) => void data.set(i, t),
        delete: async (i) => void data.delete(i),
      };
      const config: OidcConfig = { issuer: provider.issuer, clientId: 'cli-client-1', scopes: ['openid'], tokenUse: 'id_token' };
      const deps = { fetch, openBrowser: provider.openBrowser, say: () => {}, timeoutMs: 3000, now: () => clock };
      const a = new OidcSession(INSTANCE, store, deps, config);
      const b = new OidcSession(INSTANCE, store, deps, config);
      await a.login();
      provider.issuedExp = Math.floor(clock / 1000) + 7200;
      clock += 3600_000 + 120_000;
      slowNext = true;
      const late = b.credential(); // reads the expired sign-in, then waits
      await new Promise((r) => setTimeout(r, 20));
      await a.credential(); // renews first: refresh-1 becomes refresh-2
      hold!();
      const got = await late;
      assert.match(got.value, /^Bearer /);
      assert.equal(provider.log.refresh.length, 1, 'the old refresh token was spent once, not twice');
      assert.ok(data.has(INSTANCE), 'the renewed sign-in was not deleted');
    } finally {
      await provider.close();
    }
  });
});

describe('§6.17 CL9 the sign-in request and the loopback listener', () => {
  it('CL9 keeps the query a provider\'s authorization endpoint already carries', async () => {
    const { provider, session } = await setup((p) => (p.behave.authorizeQuery = '?p=B2C_1_signin'));
    try {
      await session.login();
      assert.equal(provider.log.authorize[0].get('p'), 'B2C_1_signin');
      assert.equal(provider.log.authorize[0].get('code_challenge_method'), 'S256');
    } finally {
      await provider.close();
    }
  });

  it('CL9 does not follow a redirect from the token endpoint, so the code and verifier go nowhere else', async () => {
    const { provider, session, store } = await setup((p) => (p.behave.tokenRedirect = true));
    try {
      await assert.rejects(session.login());
      assert.equal(store.data.size, 0);
      assert.deepEqual(provider.log.stolen, [], 'the authorization code and PKCE verifier were sent on to the redirect target');
    } finally {
      await provider.close();
    }
  });

  it('CL9 the listener answers only /callback with the right state, and only on the loopback interface', async () => {
    const loop = await startLoopback();
    const port = Number(new URL(loop.redirectUri).port);
    try {
      assert.equal(new URL(loop.redirectUri).hostname, '127.0.0.1');
      assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=nope`)).status, 400);
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST' })).status, 404);
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (lan) await assert.rejects(fetch(`http://${lan.address}:${port}/callback?code=x&state=nope`), 'the listener is reachable from outside this machine');
      const waiting = loop.wait('right', 2000);
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=right`)).status, 200);
      assert.equal(await waiting, 'abc');
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=again&state=right`)).status, 200, 'a second callback after success is harmless');
    } finally {
      loop.close();
    }
  });

  it('CL9 a fixed port that is already in use is reported plainly', async () => {
    const first = await startLoopback();
    const port = Number(new URL(first.redirectUri).port);
    try {
      await assert.rejects(startLoopback(port), /port \d+ is in use/);
    } finally {
      first.close();
    }
  });
});
