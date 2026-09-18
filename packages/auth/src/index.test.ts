import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { authFromEnv, bearerAuth, hasRole, oidcAuth } from './index.js';

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
});

describe('oidc discovery + remote JWKS', () => {
  let server: http.Server;
  let base = '';
  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/jwks` }));
      else res.end(JSON.stringify(jwks));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('fetches keys from the issuer and verifies', async () => {
    const auth = oidcAuth({ issuer: base, audience: AUD });
    const r = await auth.verify(`Bearer ${await sign({ sub: 'u3', roles: 'viewer' }, signer, { iss: base })}`);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe('bearer', () => {
  it('matches named tokens and returns their roles', async () => {
    const auth = bearerAuth([
      { name: 'doorman', token: 'doorman-token-000000', roles: ['operator'] },
      { name: 'sidecar', token: 'sidecar-token-000000', roles: ['ingest'] },
    ]);
    const r = await auth.verify('Bearer sidecar-token-000000');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.principal.actor, 'token:sidecar');
    assert.equal((await auth.verify('Bearer nope')).ok, false);
    assert.equal((await auth.verify(undefined)).ok, false);
  });
});

describe('roles', () => {
  it('admin implies all; operator and approver imply viewer; ingest is isolated', () => {
    assert.ok(hasRole({ actor: 'a', roles: ['admin'] }, 'approver'));
    assert.ok(hasRole({ actor: 'a', roles: ['operator'] }, 'viewer'));
    assert.ok(!hasRole({ actor: 'a', roles: ['operator'] }, 'approver'));
    assert.ok(!hasRole({ actor: 'a', roles: ['ingest'] }, 'viewer'));
    assert.ok(!hasRole({ actor: 'a', roles: [] }, 'viewer'));
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

  it('combines service tokens with OIDC', () => {
    const auth = authFromEnv({
      FACTORY_TOKENS: JSON.stringify([{ name: 'doorman', token: 't', roles: ['operator'] }]),
      FACTORY_OIDC_ISSUER: ISS,
      FACTORY_OIDC_AUDIENCE: AUD,
    });
    assert.equal(auth.name, 'bearer+oidc');
  });

  it('rejects tokens with no valid roles', () => {
    assert.throws(() => authFromEnv({ FACTORY_TOKENS: JSON.stringify([{ name: 'x', token: 't', roles: ['root'] }]) }));
  });
});
