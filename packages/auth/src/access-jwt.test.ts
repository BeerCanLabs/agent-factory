import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { decodeProtectedHeader, generateKeyPair, SignJWT, createLocalJWKSet, jwtVerify } from 'jose';
import {
  ACCESS_JWT_TYP,
  ACCESS_TOKEN_TTL_SECONDS,
  accessKindOfUrl,
  accessResourceKind,
  asKeyFromMaterial,
  canonicalAccessResource,
  canonicalAudiences,
  isFactoryAccessJwt,
  publicJwksOf,
  signAccessToken,
  verifyAccessToken,
  type AsKeySet,
} from './index.js';

const ISSUER = 'https://auth.example.test';
const API = canonicalAccessResource(ISSUER, 'api');
const MCP = canonicalAccessResource(ISSUER, 'mcp');

async function keySet(kid = 'current-kid'): Promise<AsKeySet> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { current: await asKeyFromMaterial(pem, kid), ephemeral: false };
}

const base = {
  issuer: ISSUER,
  subject: 'user:stephanie',
  audiences: [MCP],
  clientId: 'mcpc_test',
  scope: 'mcp:full',
  sid: 'key_anchor',
  amr: ['oidc'],
  hints: { roles: ['admin'], grantsVersion: 7, agents: { higgins: ['member'] } },
};

describe('RFC 9068 access tokens (front-door Phase 1 Slice 2)', () => {
  it('classifies api and mcp resources and rejects anything else', () => {
    assert.equal(accessResourceKind(ISSUER, `${API}/`), 'api');
    assert.equal(accessResourceKind(ISSUER, `${MCP}/agents/higgins`), 'mcp');
    assert.equal(accessResourceKind(ISSUER, 'https://evil.example/mcp'), undefined);
    assert.equal(accessKindOfUrl('https://old.example/api'), 'api');
    assert.deepEqual(canonicalAudiences(ISSUER, []), { ok: true, audiences: [MCP] });
    assert.deepEqual(canonicalAudiences(ISSUER, [API, MCP, API]), { ok: true, audiences: [API, MCP] });
    assert.deepEqual(canonicalAudiences(ISSUER, ['https://evil.example/api']), { ok: false });
  });

  it('signs an ES256 at+jwt with kid, 10-minute exp, and hint claims, verifiable from the public JWKS', async () => {
    const keys = await keySet();
    const issued = await signAccessToken(keys, { ...base, actSub: 'client:mcpc_test' });
    assert.equal(issued.expiresIn, ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(isFactoryAccessJwt(issued.token), true);
    const header = decodeProtectedHeader(issued.token);
    assert.equal(header.alg, 'ES256');
    assert.equal(header.kid, keys.current.kid);
    assert.equal(header.typ, ACCESS_JWT_TYP);
    const jwks = publicJwksOf(keys);
    assert.equal('d' in jwks.keys[0], false);
    const { payload } = await jwtVerify(issued.token, createLocalJWKSet({ keys: jwks.keys }), {
      issuer: ISSUER,
      audience: MCP,
    });
    assert.equal(payload.sub, 'user:stephanie');
    assert.equal(payload.client_id, 'mcpc_test');
    assert.equal(payload.scope, 'mcp:full');
    assert.equal(payload.sid, 'key_anchor');
    assert.deepEqual(payload.aud, [MCP]);
    assert.deepEqual(payload.roles, ['admin']);
    assert.equal(payload.grants_v, 7);
    assert.deepEqual(payload.agents, { higgins: ['member'] });
    assert.deepEqual(payload.amr, ['oidc']);
    assert.deepEqual(payload.act, { sub: 'client:mcpc_test' });
    assert.equal((payload.exp ?? 0) - (payload.iat ?? 0), ACCESS_TOKEN_TTL_SECONDS);

    const verified = await verifyAccessToken(issued.token, { keys, issuers: [ISSUER], audience: MCP });
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.token.clientId, 'mcpc_test');
      assert.deepEqual(verified.token.hints.roles, ['admin']);
    }
  });

  it('keeps api and mcp audiences apart, and accepts a previous kid', async () => {
    const current = await keySet();
    const previous = (await keySet('previous-kid')).current;
    const keys: AsKeySet = { current: current.current, previous, ephemeral: false };
    const both = await signAccessToken(keys, { ...base, audiences: [API, MCP] });
    const apiOnly = await verifyAccessToken(both.token, { keys, issuers: [ISSUER], audience: API });
    const mcpOnly = await verifyAccessToken(both.token, { keys, issuers: [ISSUER], audience: MCP });
    assert.equal(apiOnly.ok, true);
    assert.equal(mcpOnly.ok, true);

    const mcpToken = await signAccessToken(keys, base);
    const rejected = await verifyAccessToken(mcpToken.token, { keys, issuers: [ISSUER], audience: API });
    assert.deepEqual(rejected, { ok: false, reason: 'audience' });

    const old = await signAccessToken({ current: previous, ephemeral: false }, base);
    const still = await verifyAccessToken(old.token, { keys, issuers: [ISSUER], audience: MCP });
    assert.equal(still.ok, true, JSON.stringify(still));
  });

  it('rejects a bad signature, a foreign key, an expired token, a wrong issuer, alg none, and a missing typ', async () => {
    const keys = await keySet();
    const issued = await signAccessToken(keys, base);
    const [h, p, s] = issued.token.split('.');
    const tampered = `${h}.${p}.${s!.slice(0, -2)}aa`;
    assert.deepEqual(await verifyAccessToken(tampered, { keys, issuers: [ISSUER], audience: MCP }), { ok: false, reason: 'invalid' });

    const other = await keySet();
    const foreign = await signAccessToken(other, { ...base, jti: 'foreign' });
    assert.equal((await verifyAccessToken(foreign.token, { keys, issuers: [ISSUER], audience: MCP })).ok, false);

    const expired = await signAccessToken(keys, { ...base, now: new Date(Date.now() - 3600_000) });
    assert.deepEqual(await verifyAccessToken(expired.token, { keys, issuers: [ISSUER], audience: MCP }), { ok: false, reason: 'expired' });

    const wrongIss = await verifyAccessToken(issued.token, { keys, issuers: ['https://other.example'], audience: MCP });
    assert.equal(wrongIss.ok, false);

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: ACCESS_JWT_TYP, kid: keys.current.kid })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'user:stephanie', aud: MCP, client_id: 'c', sid: 'key_anchor', jti: 'j', iat: 1, exp: 9_999_999_999 })).toString('base64url')}.`;
    assert.equal(isFactoryAccessJwt(unsigned), true);
    assert.deepEqual(await verifyAccessToken(unsigned, { keys, issuers: [ISSUER], audience: MCP }), { ok: false, reason: 'invalid' });

    const rs = await generateKeyPair('RS256');
    const rsToken = await new SignJWT({ client_id: 'c', sid: 'key_anchor' })
      .setProtectedHeader({ alg: 'RS256', kid: keys.current.kid, typ: ACCESS_JWT_TYP })
      .setIssuer(ISSUER)
      .setSubject('user:stephanie')
      .setAudience(MCP)
      .setIssuedAt()
      .setExpirationTime('10m')
      .setJti('rs')
      .sign(rs.privateKey);
    assert.deepEqual(await verifyAccessToken(rsToken, { keys, issuers: [ISSUER], audience: MCP }), { ok: false, reason: 'invalid' });

    const noTyp = await new SignJWT({ client_id: 'c', sid: 'key_anchor' })
      .setProtectedHeader({ alg: 'ES256', kid: keys.current.kid })
      .setIssuer(ISSUER)
      .setSubject('user:stephanie')
      .setAudience(MCP)
      .setIssuedAt()
      .setExpirationTime('10m')
      .setJti('notyp')
      .sign(keys.current.privateKey);
    assert.equal(isFactoryAccessJwt(noTyp), false);
    assert.deepEqual(await verifyAccessToken(noTyp, { keys, issuers: [ISSUER], audience: MCP }), { ok: false, reason: 'invalid' });
  });
});
