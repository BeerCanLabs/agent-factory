// DESIGN_AUTHORITY.md §6.12 A2: the proxy's signed assertion is verified against its issuer, audience and keys.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import { accessAssertionOf, accessAuthFromEnv, cloudflareAccessAuth } from './index.js';

const TEAM = 'team.example.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'aud-tag-0123456789';

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const k1 = keypair('k1');
const k2 = keypair('k2');
const other = keypair('k1'); // same kid, different key: a forger's key

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

function token(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; header?: Record<string, unknown> } = {}) {
  const header = opts.header ?? { alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' };
  const body = { iss: ISS, aud: [AUD], iat: nowSec(), nbf: nowSec(), exp: nowSec() + 300, ...claims };
  const input = `${b64(header)}.${b64(body)}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), opts.key ?? k1.privateKey).toString('base64url')}`;
}

function stubJwks(sets: object[][]) {
  const calls: string[] = [];
  let i = 0;
  const fetchJwks = async (url: string) => {
    calls.push(url);
    const keys = sets[Math.min(i++, sets.length - 1)];
    return { keys, public_cert: { kid: 'ignored' } };
  };
  return { calls, fetchJwks };
}

function auth(extra: Partial<Parameters<typeof cloudflareAccessAuth>[0]> = {}) {
  const jwks = stubJwks([[k1.jwk]]);
  return { jwks, auth: cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, adminEmails: ['Admin@Example.com'], fetchJwks: jwks.fetchJwks, ...extra }) };
}

describe('A2 Cloudflare Access assertion verifier', () => {
  it('accepts a valid assertion and takes identity only from its claims', async () => {
    const { auth: a, jwks } = auth();
    const r = await a.verify(token({ email: 'admin@example.com', sub: 'u1' }));
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.principal.actor, 'cloudflare:admin@example.com');
      assert.deepEqual(r.principal.roles, ['admin', 'operator', 'approver', 'viewer', 'ingest']);
    }
    assert.deepEqual(jwks.calls, [`${ISS}/cdn-cgi/access/certs`]);
  });

  it('maps other verified users to viewer and service tokens to no roles', async () => {
    const { auth: a } = auth();
    const u = await a.verify(token({ email: 'someone@example.com' }));
    assert.ok(u.ok && u.principal.actor === 'cloudflare:someone@example.com');
    if (u.ok) assert.deepEqual(u.principal.roles, ['viewer']);
    const s = await a.verify(token({ common_name: 'deploy-check.access', sub: '' }));
    assert.ok(s.ok);
    if (s.ok) assert.deepEqual(s.principal, { actor: 'cloudflare-service:deploy-check.access', roles: [] });
  });

  it('has no built-in admins', async () => {
    const a = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, fetchJwks: stubJwks([[k1.jwk]]).fetchJwks });
    const r = await a.verify(token({ email: 'admin@example.com' }));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.principal.roles, ['viewer']);
  });

  it('rejects the wrong audience and the wrong issuer', async () => {
    const { auth: a } = auth();
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com', aud: ['other-app'] })), { ok: false, reason: 'wrong audience' });
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com', iss: 'https://evil.cloudflareaccess.com' })), { ok: false, reason: 'wrong issuer' });
  });

  it('accepts aud as a string and any configured audience', async () => {
    const { auth: a } = auth({ audience: `first,${AUD}` });
    assert.equal((await a.verifyAssertion(token({ email: 'a@example.com', aud: AUD }))).ok, true);
  });

  it('rejects expired and not-yet-valid assertions, within a small skew', async () => {
    const { auth: a } = auth();
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com', exp: nowSec() - 120 })), { ok: false, reason: 'assertion expired' });
    assert.equal((await a.verifyAssertion(token({ email: 'a@example.com', exp: nowSec() - 10 }))).ok, true);
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com', nbf: nowSec() + 600 })), { ok: false, reason: 'assertion not yet valid' });
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com', exp: undefined })), { ok: false, reason: 'assertion has no exp' });
  });

  it('rejects a tampered payload and a signature by another key', async () => {
    const { auth: a } = auth();
    const [h, , s] = token({ email: 'someone@example.com' }).split('.');
    const forged = `${h}.${b64({ iss: ISS, aud: [AUD], exp: nowSec() + 300, email: 'admin@example.com' })}.${s}`;
    assert.deepEqual(await a.verifyAssertion(forged), { ok: false, reason: 'bad signature' });
    assert.deepEqual(await a.verifyAssertion(token({ email: 'admin@example.com' }, { key: other.privateKey })), { ok: false, reason: 'bad signature' });
  });

  it('rejects alg none and HS256 (key confusion)', async () => {
    const { auth: a } = auth();
    const body = b64({ iss: ISS, aud: [AUD], exp: nowSec() + 300, email: 'admin@example.com' });
    assert.equal((await a.verifyAssertion(`${b64({ alg: 'none', kid: 'k1' })}.${body}.`)).ok, false);
    assert.equal((await a.verifyAssertion(`${b64({ alg: 'none', kid: 'k1' })}.${body}.AA`)).ok, false);
    const hsInput = `${b64({ alg: 'HS256', kid: 'k1' })}.${body}`;
    const hs = createHmac('sha256', JSON.stringify(k1.jwk)).update(hsInput).digest('base64url');
    assert.deepEqual(await a.verifyAssertion(`${hsInput}.${hs}`), { ok: false, reason: 'alg HS256 not accepted' });
  });

  it('rejects garbage and missing assertions', async () => {
    const { auth: a } = auth();
    for (const t of [undefined, '', 'a.b', 'not a jwt at all', `${'x'.repeat(20000)}.a.b`]) assert.equal((await a.verifyAssertion(t)).ok, false);
    assert.deepEqual(await a.verifyAssertion(token({ sub: 'nobody' })), { ok: false, reason: 'assertion names no user or service' });
  });

  it('refreshes on an unknown kid, at most once per cooldown', async () => {
    let t = 1_000_000;
    const jwks = stubJwks([[k1.jwk], [k1.jwk, k2.jwk]]);
    const a = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, fetchJwks: jwks.fetchJwks, now: () => t, refreshCooldownMs: 30_000 });
    const claims = { email: 'a@example.com', iat: t / 1000, nbf: t / 1000, exp: t / 1000 + 300 };
    assert.equal((await a.verifyAssertion(token(claims))).ok, true);
    assert.equal(jwks.calls.length, 1);
    // A rotated key within the cooldown is unknown and does not trigger a fetch.
    assert.deepEqual(await a.verifyAssertion(token(claims, { kid: 'k2', key: k2.privateKey })), { ok: false, reason: 'unknown kid' });
    assert.equal(jwks.calls.length, 1);
    t += 31_000;
    assert.equal((await a.verifyAssertion(token({ ...claims, exp: t / 1000 + 300 }, { kid: 'k2', key: k2.privateKey }))).ok, true);
    assert.equal(jwks.calls.length, 2);
    // Known kids never refetch; a kid nobody publishes is refused.
    assert.equal((await a.verifyAssertion(token({ ...claims, exp: t / 1000 + 300 }))).ok, true);
    assert.deepEqual(await a.verifyAssertion(token({ ...claims, exp: t / 1000 + 300 }, { kid: 'k9' })), { ok: false, reason: 'unknown kid' });
    assert.equal(jwks.calls.length, 2);
  });

  it('concurrent unknown kids share one fetch, and a failed fetch grants nothing', async () => {
    let n = 0;
    const a = cloudflareAccessAuth({
      teamDomain: TEAM,
      audience: AUD,
      fetchJwks: async () => {
        n++;
        await new Promise((r) => setTimeout(r, 10));
        return { keys: [k1.jwk] };
      },
    });
    const results = await Promise.all([1, 2, 3].map(() => a.verifyAssertion(token({ email: 'a@example.com' }))));
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.equal(n, 1);
    const failing = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, fetchJwks: async () => { throw new Error('down'); } });
    assert.deepEqual(await failing.verifyAssertion(token({ email: 'a@example.com' })), { ok: false, reason: 'unknown kid' });
  });

  it('ignores weak and non-RSA keys and bounds the key set', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const weakJwk = { ...weak.publicKey.export({ format: 'jwk' }), kid: 'weak' };
    const many = Array.from({ length: 40 }, (_, i) => ({ ...k2.jwk, kid: `x${i}` }));
    const a = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, maxKeys: 16, fetchJwks: async () => ({ keys: [weakJwk, { kty: 'EC', kid: 'ec' }, ...many, k1.jwk] }) });
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com' }, { kid: 'weak', key: weak.privateKey })), { ok: false, reason: 'unknown kid' });
    // k1 is past the bound, so it is not kept.
    assert.deepEqual(await a.verifyAssertion(token({ email: 'a@example.com' })), { ok: false, reason: 'unknown kid' });
    assert.equal((await a.verifyAssertion(token({ email: 'a@example.com' }, { kid: 'x3', key: k2.privateKey }))).ok, true);
  });

  it('missing configuration disables Access identity; half a configuration is refused', () => {
    assert.equal(accessAuthFromEnv({}), undefined);
    assert.equal(accessAuthFromEnv({ FACTORY_ACCESS_TEAM_DOMAIN: '', FACTORY_ACCESS_AUD: '' }), undefined);
    assert.throws(() => accessAuthFromEnv({ FACTORY_ACCESS_TEAM_DOMAIN: TEAM }), /FACTORY_ACCESS_AUD/);
    assert.throws(() => accessAuthFromEnv({ FACTORY_ACCESS_AUD: AUD }), /FACTORY_ACCESS_TEAM_DOMAIN/);
    assert.throws(() => accessAuthFromEnv({ FACTORY_ACCESS_TEAM_DOMAIN: 'https://evil.example/path', FACTORY_ACCESS_AUD: AUD }), /team domain/);
    assert.equal(accessAuthFromEnv({ FACTORY_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, FACTORY_ACCESS_AUD: AUD })?.name, 'cloudflare-access');
  });

  it('reads the assertion from the header, else the CF_Authorization cookie', () => {
    assert.equal(accessAssertionOf({ 'cf-access-jwt-assertion': 'h.p.s' }), 'h.p.s');
    assert.equal(accessAssertionOf({ cookie: 'a=1; CF_Authorization=c.p.s; b=2' }), 'c.p.s');
    assert.equal(accessAssertionOf({ 'cf-access-authenticated-user-email': 'admin@example.com' }), undefined);
  });
});
