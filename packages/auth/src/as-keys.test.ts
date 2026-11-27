import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { SignJWT, importJWK, jwtVerify } from 'jose';
import {
  asKeyFromMaterial,
  generateEphemeralAsKey,
  loadAsKeySet,
  loadAsKeySetFromEnv,
  parseIssuerAliases,
  publicJwksOf,
  type SecretReader,
} from './as-keys.js';

function pemPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('AS signing keys (front-door Phase 1 Slice 1)', () => {
  it('generates an ephemeral ES256 key with kid, use, and alg on the public JWK', async () => {
    const key = await generateEphemeralAsKey();
    assert.equal(key.publicJwk.kty, 'EC');
    assert.equal(key.publicJwk.crv, 'P-256');
    assert.equal(key.publicJwk.alg, 'ES256');
    assert.equal(key.publicJwk.use, 'sig');
    assert.ok(key.kid);
    assert.equal(key.publicJwk.kid, key.kid);
    assert.equal('d' in key.publicJwk, false);
    assert.match(key.privateKeyPem, /BEGIN PRIVATE KEY/);
  });

  it('loads a PKCS#8 PEM and a JWK, and honors an explicit kid', async () => {
    const pem = pemPair();
    const fromPem = await asKeyFromMaterial(pem, 'kid-pem');
    assert.equal(fromPem.kid, 'kid-pem');
    const jwk = { ...createPublicKey(fromPem.privateKey).export({ format: 'jwk' }), d: fromPem.privateKey.export({ format: 'jwk' }).d };
    const fromJwk = await asKeyFromMaterial(JSON.stringify(jwk), 'kid-jwk');
    assert.equal(fromJwk.kid, 'kid-jwk');
    assert.equal(fromJwk.publicJwk.x, fromPem.publicJwk.x);
  });

  it('refuses non-P-256 keys, public-only JWKs, and empty material', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await assert.rejects(asKeyFromMaterial(rsa), /P-256|ES256/);
    const ephemeral = await generateEphemeralAsKey();
    const pubOnly = { ...ephemeral.publicJwk };
    await assert.rejects(asKeyFromMaterial(JSON.stringify(pubOnly)), /private `d`/);
    await assert.rejects(asKeyFromMaterial(''), /empty/);
    await assert.rejects(asKeyFromMaterial('not-a-key'), /could not be parsed/);
  });

  it('kid rotation: JWKS lists current then previous public keys, never private material', async () => {
    const current = await asKeyFromMaterial(pemPair(), 'current');
    const previous = await asKeyFromMaterial(pemPair(), 'previous');
    const set = { current, previous, ephemeral: false };
    const jwks = publicJwksOf(set);
    assert.deepEqual(jwks.keys.map((k) => k.kid), ['current', 'previous']);
    for (const k of jwks.keys) {
      assert.equal('d' in k, false);
      assert.equal(k.alg, 'ES256');
      assert.equal(k.use, 'sig');
    }
    const sameKid = publicJwksOf({ current, previous: current, ephemeral: false });
    assert.equal(sameKid.keys.length, 1);
  });

  it('the current (and previous) private keys can sign JWTs that verify against the published JWKS', async () => {
    const set = await loadAsKeySet({
      currentMaterial: pemPair(),
      currentKid: 'now',
      previousMaterial: pemPair(),
      previousKid: 'old',
    });
    const jwks = publicJwksOf(set);
    for (const asKey of [set.current, set.previous!]) {
      const token = await new SignJWT({ sub: 'user:dale' })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: asKey.kid })
        .setIssuer('https://auth.example.test')
        .setAudience('api')
        .setExpirationTime('10m')
        .sign(asKey.privateKey);
      const jwk = jwks.keys.find((k) => k.kid === asKey.kid)!;
      const { payload } = await jwtVerify(token, await importJWK(jwk), {
        issuer: 'https://auth.example.test',
        audience: 'api',
        algorithms: ['ES256'],
      });
      assert.equal(payload.sub, 'user:dale');
    }
  });

  it('loadAsKeySet generates an ephemeral key when nothing is configured, and refuses when allowEphemeral is false', async () => {
    const a = await loadAsKeySet({ allowEphemeral: true });
    assert.equal(a.ephemeral, true);
    assert.ok(a.current.kid);
    await assert.rejects(loadAsKeySet({ allowEphemeral: false }), /no AS signing key configured/);
  });

  it('loadAsKeySetFromEnv reads PEM from env, previous from a secret reader, and throws on a bare KMS key id', async () => {
    const pem = pemPair();
    const prev = pemPair();
    const secrets: SecretReader[] = [
      { async get(name) { return name === 'as/previous' ? prev : undefined; } },
    ];
    const set = await loadAsKeySetFromEnv(
      {
        FACTORY_AS_SIGNING_KEY: pem,
        FACTORY_AS_SIGNING_KEY_KID: 'env-current',
        FACTORY_AS_PREVIOUS_SIGNING_KEY_SECRET: 'as/previous',
        FACTORY_AS_PREVIOUS_SIGNING_KEY_KID: 'env-prev',
      },
      secrets,
    );
    assert.equal(set.ephemeral, false);
    assert.equal(set.current.kid, 'env-current');
    assert.equal(set.previous?.kid, 'env-prev');

    await assert.rejects(
      loadAsKeySetFromEnv({ FACTORY_AS_KMS_KEY_ID: 'arn:aws:kms:us-west-2:123:key/abcd' }),
      /KMS signer is wired/,
    );

    const ephemeral = await loadAsKeySetFromEnv({});
    assert.equal(ephemeral.ephemeral, true);
  });

  it('parseIssuerAliases splits, trims, and strips trailing slashes', () => {
    assert.deepEqual(parseIssuerAliases('https://auth.example.com/, https://factory-dashboard.example.com'), [
      'https://auth.example.com',
      'https://factory-dashboard.example.com',
    ]);
    assert.deepEqual(parseIssuerAliases(undefined), []);
  });
});
