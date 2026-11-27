// Front-door auth Phase 1 Slice 1: /jwks, OIDC discovery, kid rotation, #527 verified email.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import {
  authFromEnv,
  generateEphemeralAsKey,
  JWKS_CACHE_CONTROL,
  loadAsKeySet,
  publicJwksOf,
  RunTokens,
} from '@beercanlabs/factory-auth';
import {
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  PrincipalStore,
  authorize,
  type GrantsDoc,
  type PrincipalsDoc,
} from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import {
  authorizationGrantsFor,
  createFactoryServer,
  effectiveGrantsForActor,
  resolveVerifiedPrincipal,
  type FactoryState,
} from './app.js';

const ISS = 'https://idp.example';
const AUD = 'factory';

async function call(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers }, async (res) => {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      resolve({ status: res.statusCode || 0, headers: res.headers, body });
    });
    req.on('error', reject);
    req.end();
  });
}

function baseState(extra: Partial<FactoryState> = {}): FactoryState {
  return {
    agents: new Map(),
    ledger: new MemoryLedger(),
    auth: authFromEnv({ FACTORY_AUTH: 'none', FACTORY_INSECURE_NO_AUTH: '1' }),
    version: 'test',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    runTokens: new RunTokens(undefined),
    callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
    approvals: new ApprovalStore(),
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
    ...extra,
  } as FactoryState;
}

async function listen(state: FactoryState): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = createFactoryServer(state);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    server,
    port: addr.port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('front-door Phase 1 Slice 1: JWKS, OIDC discovery, and #527', { concurrency: false }, () => {
  it('GET /jwks and /.well-known/jwks.json serve the public set with Cache-Control, never the private key', async () => {
    const set = await loadAsKeySet({
      currentMaterial: (await generateEphemeralAsKey()).privateKeyPem,
      currentKid: 'now',
      previousMaterial: (await generateEphemeralAsKey()).privateKeyPem,
      previousKid: 'old',
    });
    const { port, close } = await listen(baseState({ asKeys: set, asIssuer: 'https://auth.example.com' }));
    try {
      for (const path of ['/jwks', '/.well-known/jwks.json']) {
        const r = await call(port, path, { host: 'auth.example.com', 'x-forwarded-proto': 'https' });
        assert.equal(r.status, 200, path);
        assert.equal(String(r.headers['cache-control'] || ''), JWKS_CACHE_CONTROL);
        assert.equal(String(r.headers['content-type'] || '').includes('application/json'), true);
        assert.deepEqual(r.body.keys.map((k: { kid: string }) => k.kid), ['now', 'old']);
        for (const k of r.body.keys) {
          assert.equal(k.kty, 'EC');
          assert.equal(k.crv, 'P-256');
          assert.equal(k.alg, 'ES256');
          assert.equal(k.use, 'sig');
          assert.equal('d' in k, false);
        }
        assert.deepEqual(r.body, publicJwksOf(set));
      }
    } finally {
      await close();
    }
  });

  it('openid-configuration and oauth-authorization-server share issuer, jwks_uri, and ES256, and honor the dashboard alias', async () => {
    const set = await loadAsKeySet({ allowEphemeral: true });
    const { port, close } = await listen(
      baseState({
        asKeys: set,
        asIssuer: 'https://auth.example.com',
        asIssuerAliases: ['https://factory-dashboard.example.com'],
        publicBaseUrl: 'https://should-not-win.example.com',
      }),
    );
    try {
      const primary = await call(port, '/.well-known/openid-configuration', {
        host: 'auth.example.com',
        'x-forwarded-proto': 'https',
      });
      const alias = await call(port, '/.well-known/oauth-authorization-server', {
        host: 'factory-dashboard.example.com',
        'x-forwarded-proto': 'https',
      });
      const other = await call(port, '/.well-known/openid-configuration', {
        host: 'other.example.com',
        'x-forwarded-proto': 'https',
      });
      assert.equal(primary.status, 200);
      assert.equal(primary.body.issuer, 'https://auth.example.com');
      assert.equal(primary.body.jwks_uri, 'https://auth.example.com/jwks');
      assert.deepEqual(primary.body.id_token_signing_alg_values_supported, ['ES256']);
      assert.equal(String(primary.headers['cache-control'] || ''), JWKS_CACHE_CONTROL);

      assert.equal(alias.status, 200);
      assert.equal(alias.body.issuer, 'https://factory-dashboard.example.com');
      assert.equal(alias.body.jwks_uri, 'https://factory-dashboard.example.com/jwks');
      assert.deepEqual(alias.body.id_token_signing_alg_values_supported, ['ES256']);
      assert.equal(alias.body.authorization_endpoint, 'https://factory-dashboard.example.com/authorize');

      assert.equal(other.body.issuer, 'https://auth.example.com');
    } finally {
      await close();
    }
  });

  it('discovery works even when the MCP OAuth store is absent, and lazily mints an ephemeral key', async () => {
    const { port, close } = await listen(baseState({ publicBaseUrl: 'https://factory.test' }));
    try {
      const meta = await call(port, '/.well-known/openid-configuration');
      assert.equal(meta.status, 200);
      assert.equal(meta.body.issuer, 'https://factory.test');
      const jwks = await call(port, '/jwks');
      assert.equal(jwks.status, 200);
      assert.equal(jwks.body.keys.length, 1);
      assert.equal(jwks.body.keys[0].alg, 'ES256');
    } finally {
      await close();
    }
  });

  it('#527 authFromEnv refuses an unverified-email OIDC bearer, and a verified one is accepted', async () => {
    const kp = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const jwksServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
    const jwksAddr = jwksServer.address();
    if (!jwksAddr || typeof jwksAddr === 'string') throw new Error('no jwks port');
    const jwksUrl = `http://127.0.0.1:${jwksAddr.port}/jwks`;

    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
        .setIssuer(ISS)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(kp.privateKey);

    const { port, close } = await listen(
      baseState({
        auth: authFromEnv({
          FACTORY_OIDC_ISSUER: ISS,
          FACTORY_OIDC_AUDIENCE: AUD,
          FACTORY_OIDC_JWKS_URL: jwksUrl,
        }),
      }),
    );
    try {
      for (const claims of [
        { sub: 'u1', email: 'dale@example.com' },
        { sub: 'u1', email: 'dale@example.com', email_verified: false },
        { sub: 'u1', email: 'dale@example.com', email_verified: 'true' },
      ]) {
        const token = await sign(claims);
        const r = await call(port, '/api/v1/whoami', { authorization: `Bearer ${token}` });
        assert.equal(r.status, 401, JSON.stringify(claims));
      }
      const ok = await call(port, '/api/v1/whoami', {
        authorization: `Bearer ${await sign({ sub: 'u1', email: 'dale@example.com', email_verified: true })}`,
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.actor, 'oidc:dale@example.com');
    } finally {
      await close();
      await new Promise<void>((r) => jwksServer.close(() => r()));
    }
  });

  it('#527 defense in depth: an oidc:<email> actor without emailVerified is not rewritten to a principal-store user', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase1-527-'));
    try {
      const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
      await principals.create({
        id: 'user:dale.sackrider',
        displayName: 'Dale',
        emails: ['dale@example.com'],
        by: 'user:admin',
      });
      const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), { principals });
      await grants.grant({
        subject: 'user:dale.sackrider',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:admin',
        granterIsAdmin: true,
      });

      const state = baseState({ principals, grants });
      const unverified = await resolveVerifiedPrincipal(state, { actor: 'oidc:dale@example.com', roles: [] }, true);
      assert.equal(unverified.actor, 'oidc:dale@example.com');
      assert.equal(unverified.roles.includes('admin'), false);

      const verified = await resolveVerifiedPrincipal(
        state,
        { actor: 'oidc:dale@example.com', roles: [], emailVerified: true },
        true,
      );
      assert.equal(verified.actor, 'user:dale.sackrider');
      assert.ok(verified.roles.includes('admin'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#527 requirePrivilege and authorize deny live principal-store grants for an unverified oidc:<email>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase1-527-authz-'));
    try {
      const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'principals.json')));
      await principals.create({
        id: 'user:dale.sackrider',
        displayName: 'Dale',
        emails: ['dale@example.com'],
        by: 'user:admin',
      });
      const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'grants.json')), { principals });
      await grants.grant({
        subject: 'user:dale.sackrider',
        scope: { kind: 'fleet' },
        role: 'admin',
        by: 'user:admin',
        granterIsAdmin: true,
      });

      const unverified = { actor: 'oidc:dale@example.com', roles: [] as const };
      const state = baseState({ principals, grants });
      const leaked = effectiveGrantsForActor(state, unverified.actor);
      assert.equal(leaked.ok, true);
      assert.equal(leaked.ok && leaked.grants?.some((eg) => !eg.readOnly && eg.grant.role === 'admin'), true);

      const gated = authorizationGrantsFor(state, unverified);
      assert.equal(gated.ok, true);
      assert.deepEqual(gated.ok ? gated.grants : undefined, []);
      assert.equal(
        authorize({
          principal: { actor: unverified.actor, roles: [] },
          privilege: 'grants.manage',
          resource: { grants: gated.ok ? gated.grants : [] },
        }).allowed,
        false,
      );
      assert.equal(
        authorize({
          principal: { actor: unverified.actor, roles: [] },
          privilege: 'grants.manage',
          resource: { grants: leaked.ok ? leaked.grants : [] },
        }).allowed,
        true,
      );

      const { port, close } = await listen(
        baseState({
          principals,
          grants,
          ledger: state.ledger,
          auth: {
            name: 'test-oidc',
            async verify(authorization) {
              if (authorization === 'Bearer verified') {
                return { ok: true, principal: { actor: 'oidc:dale@example.com', roles: [], emailVerified: true } };
              }
              if (authorization === 'Bearer unverified') {
                return { ok: true, principal: { actor: 'oidc:dale@example.com', roles: [] } };
              }
              return { ok: false, reason: 'no credential' };
            },
          },
        }),
      );
      try {
        const denied = await call(port, '/api/v1/principals', { authorization: 'Bearer unverified' });
        assert.equal(denied.status, 403, JSON.stringify(denied.body));
        const who = await call(port, '/api/v1/whoami', { authorization: 'Bearer unverified' });
        assert.equal(who.status, 200, JSON.stringify(who.body));
        assert.equal(who.body.actor, 'oidc:dale@example.com');
        assert.equal(who.body.principal, 'oidc:dale@example.com');
        assert.equal(who.body.roles.includes('admin'), false);
        assert.deepEqual(who.body.grants, []);
        assert.equal(who.body.materialized, false);

        const allowed = await call(port, '/api/v1/principals', { authorization: 'Bearer verified' });
        assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
        const verifiedWho = await call(port, '/api/v1/whoami', { authorization: 'Bearer verified' });
        assert.equal(verifiedWho.status, 200, JSON.stringify(verifiedWho.body));
        assert.equal(verifiedWho.body.principal, 'user:dale.sackrider');
        assert.equal(verifiedWho.body.roles.includes('admin'), true);
      } finally {
        await close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
