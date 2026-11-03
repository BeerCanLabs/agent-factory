import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { authFromEnv, bearerAuth, oidcAuth, verifyOidcIdentity } from './index.js';

const ISS = 'https://idp.example';
const AUD = 'factory';

let signer: CryptoKey;
let other: CryptoKey;
let jwks: { keys: object[] };

async function sign(claims: Record<string, unknown>, key = signer, opts: { exp?: string; iss?: string; aud?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(key);
}

before(async () => {
  const kp = await generateKeyPair('RS256');
  signer = kp.privateKey;
  other = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

describe('oidc', () => {
  const auth = () => oidcAuth({ issuer: ISS, audience: AUD, keys: createLocalJWKSet(jwks as never) });

  it('accepts a correctly signed token and reads roles', async () => {
    const r = await auth().verify(`Bearer ${await sign({ sub: 'u1', email: 'dale@example.com', roles: ['operator'] })}`);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.principal.actor, 'oidc:dale@example.com');
      assert.deepEqual(r.principal.roles, ['operator']);
    }
  });

  it('rejects a forged token with a valid-looking payload and no real signature', async () => {
    const payload = Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, sub: 'attacker', roles: ['admin'] })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const r = await auth().verify(`Bearer ${header}.${payload}.c2ln`);
    assert.equal(r.ok, false);
  });

  it('rejects alg=none', async () => {
    const payload = Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, sub: 'attacker' })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    assert.equal((await auth().verify(`Bearer ${header}.${payload}.`)).ok, false);
  });

  it('rejects a token signed by a different key', async () => {
    assert.equal((await auth().verify(`Bearer ${await sign({ sub: 'u1' }, other)}`)).ok, false);
  });

  it('rejects expired, wrong issuer, wrong audience', async () => {
    assert.equal((await auth().verify(`Bearer ${await sign({ sub: 'u1' }, signer, { exp: '-10m' })}`)).ok, false);
    assert.equal((await auth().verify(`Bearer ${await sign({ sub: 'u1' }, signer, { iss: 'https://evil' })}`)).ok, false);
    assert.equal((await auth().verify(`Bearer ${await sign({ sub: 'u1' }, signer, { aud: 'other' })}`)).ok, false);
  });

  it('maps IdP group ids to factory roles and drops unknown roles', async () => {
    const mapped = oidcAuth({
      issuer: ISS,
      audience: AUD,
      keys: createLocalJWKSet(jwks as never),
      rolesClaim: 'groups',
      roleMap: { 'grp-approvers': 'approver' },
    });
    const r = await mapped.verify(`Bearer ${await sign({ sub: 'u2', groups: ['grp-approvers', 'grp-other'] })}`);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.principal.roles, ['approver']);
  });

  it('S1 identityOnly / verifyOidcIdentity requires email_verified=true and strips all claim/env roles', async () => {
    const opts = {
      issuer: ISS,
      audience: AUD,
      keys: createLocalJWKSet(jwks as never),
      identityOnly: true,
      adminEmails: ['stephaniesackrider@hotmail.com'],
    };
    const identityProvider = oidcAuth(opts);

    // Unverified or missing email_verified is refused before any principal resolution
    for (const badClaims of [
      { sub: 'u1', email: 'stephaniesackrider@hotmail.com', email_verified: false, roles: ['admin'] },
      { sub: 'u1', email: 'stephaniesackrider@hotmail.com', roles: ['admin'] },
      { sub: 'u1', email: 'stephaniesackrider@hotmail.com', email_verified: 'true' },
    ]) {
      const jwt = await sign(badClaims);
      assert.deepEqual(await identityProvider.verify(`Bearer ${jwt}`), { ok: false, reason: 'email not verified' });
      assert.deepEqual(await verifyOidcIdentity(jwt, opts), { ok: false, reason: 'email not verified' });
    }

    assert.deepEqual(
      await verifyOidcIdentity(await sign({ sub: 'u1', email_verified: true }), opts),
      { ok: false, reason: 'jwt has no email' },
    );

    // Verified assertion normalizes email to lowercase and yields zero roles regardless of JWT claims or adminEmails
    const goodJwt = await sign({
      sub: 'ms-sub-42',
      email: 'StephanieSackrider@Hotmail.COM',
      email_verified: true,
      roles: ['admin', 'operator'],
    });
    const expected = {
      ok: true as const,
      principal: { actor: 'user:stephaniesackrider@hotmail.com', roles: [] },
      claims: { email: 'stephaniesackrider@hotmail.com', emailVerified: true as const, sub: 'ms-sub-42' },
    };
    assert.deepEqual(await identityProvider.verify(`Bearer ${goodJwt}`), expected);
    assert.deepEqual(await verifyOidcIdentity(goodJwt, opts), expected);
    assert.deepEqual(await verifyOidcIdentity(`Bearer ${goodJwt}`, opts), expected);
  });

  it('requireEmailVerified alone enforces email_verified=true while preserving legacy oidc: actor and mapped roles', async () => {
    const legacyVerifiedProvider = oidcAuth({
      issuer: ISS,
      audience: AUD,
      keys: createLocalJWKSet(jwks as never),
      requireEmailVerified: true,
      adminEmails: ['dale@example.com'],
    });

    for (const unverified of [
      { sub: 'u1', email: 'dale@example.com', roles: ['operator'] },
      { sub: 'u1', email: 'dale@example.com', email_verified: false, roles: ['operator'] },
      { sub: 'u1', email: 'dale@example.com', email_verified: 'true', roles: ['operator'] },
    ]) {
      assert.deepEqual(await legacyVerifiedProvider.verify(`Bearer ${await sign(unverified)}`), {
        ok: false,
        reason: 'email not verified',
      });
    }

    const okRes = await legacyVerifiedProvider.verify(
      `Bearer ${await sign({ sub: 'u1', email: 'dale@example.com', email_verified: true, roles: ['operator'] })}`,
    );
    assert.equal(okRes.ok, true);
    if (okRes.ok) {
      assert.equal(okRes.principal.actor, 'oidc:dale@example.com');
      assert.deepEqual(okRes.principal.roles, ['operator', 'admin']);
      assert.equal(okRes.claims, undefined);
    }
  });
});

describe('oidc discovery + remote JWKS', () => {
  let server: http.Server;
  let base = '';
  let discoveryCalls = 0;
  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/.well-known/openid-configuration') {
        discoveryCalls++;
        res.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/jwks` }));
      } else {
        res.end(JSON.stringify(jwks));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('fetches keys from the issuer and verifies, caching discovery across verifyOidcIdentity calls', async () => {
    discoveryCalls = 0;
    const jwt1 = await sign({ sub: 'u-steph-1', email: 'stephanie@example.com', email_verified: true }, signer, { iss: base });
    const jwt2 = await sign({ sub: 'u-steph-2', email: 'dale@example.com', email_verified: true }, signer, { iss: base });
    const r1 = await verifyOidcIdentity(jwt1, { issuer: base, audience: AUD });
    const r2 = await verifyOidcIdentity(jwt2, { issuer: base, audience: AUD });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(discoveryCalls, 1, 'verifyOidcIdentity must reuse cached OIDC discovery/JWKS resolver per issuer');

    const auth = oidcAuth({ issuer: base, audience: AUD });
    const r3 = await auth.verify(`Bearer ${await sign({ sub: 'u3', roles: 'viewer' }, signer, { iss: base })}`);
    assert.equal(r3.ok, true, JSON.stringify(r3));
    assert.equal(discoveryCalls, 1);
  });
});

describe('bearer', () => {
  it('matches named tokens and returns their roles', async () => {
    const auth = bearerAuth([
      { name: 'gatekeeper-ingress', token: 'gatekeeper-ingress-token-000000', roles: ['operator'] }, // secret-scan:allow (test fixture)
      { name: 'gatekeeper-egress', token: 'gatekeeper-egress-token-000000', roles: ['ingest'] }, // secret-scan:allow (test fixture)
    ]);
    const r = await auth.verify('Bearer gatekeeper-egress-token-000000');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.principal.actor, 'token:gatekeeper-egress');
    assert.equal((await auth.verify('Bearer nope')).ok, false);
    assert.equal((await auth.verify(undefined)).ok, false);
  });
});

describe('authFromEnv', () => {
  it('fails closed when nothing is configured', () => {
    assert.throws(() => authFromEnv({}), /no auth configured/);
  });

  it('refuses none without the explicit insecure flag', () => {
    assert.throws(() => authFromEnv({ FACTORY_AUTH: 'none' }), /INSECURE/);
    assert.equal(authFromEnv({ FACTORY_AUTH: 'none', FACTORY_INSECURE_NO_AUTH: '1' }).name, 'none');
  });

  it('combines the admin token with OIDC', () => {
    const auth = authFromEnv({
      FACTORY_TOKEN: 't',
      FACTORY_OIDC_ISSUER: ISS,
      FACTORY_OIDC_AUDIENCE: AUD,
    });
    assert.equal(auth.name, 'bearer+oidc');
  });

  it('S11: FACTORY_TOKENS is no longer read, so it alone configures no auth', () => {
    assert.throws(() => authFromEnv({ FACTORY_TOKENS: JSON.stringify([{ name: 'x', token: 't', roles: ['admin'] }]) }), /no auth configured/);
  });
});
