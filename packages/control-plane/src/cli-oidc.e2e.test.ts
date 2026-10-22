// DESIGN_AUTHORITY.md §6.17 CL9: a deployment with an OIDC provider and no proxy. The factory publishes how the CLI
// signs in; the CLI signs in with PKCE against the provider; the factory verifies the signed token (A2).
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { cliDiscoveryFromEnv, oidcAuth, RunTokens } from '@beercanlabs/factory-auth';
import { FactoryClient, discoverAuth, makeSession, type CredentialStoreLike } from '@beercanlabs/factory-cli';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

const CLIENT_ID = 'cli-public-client';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const signed = (claims: Record<string, unknown>, key = privateKey) => {
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), key).toString('base64url')}`;
};

let provider: { issuer: string; close: () => Promise<void>; authorize: URLSearchParams[]; forge: boolean };
let factory: { base: string; close: () => Promise<void> };

/** An identity provider that signs real tokens, and the "browser" that approves the sign-in. */
async function startProvider() {
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const authorize: URLSearchParams[] = [];
  const p = { issuer: '', authorize, forge: false } as typeof provider;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token` });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const rec = codes.get(f.get('code') ?? '');
      if (!rec || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== rec.challenge) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const id = signed({ iss: p.issuer, aud: CLIENT_ID, sub: 'u-1', email: 'dale@example.com', nonce: rec.nonce, iat: now, exp: now + 600 }, p.forge ? forger : privateKey);
      return json(200, { id_token: id, access_token: 'opaque', expires_in: 600 });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  p.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p.close = () => new Promise<void>((r) => server.close(() => r()));
  (p as unknown as { browse: (u: string) => Promise<void> }).browse = async (raw) => {
    const q = new URL(raw).searchParams;
    authorize.push(q);
    const code = `c-${authorize.length}`;
    codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirect: q.get('redirect_uri')! });
    await fetch(`${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}`);
  };
  return p;
}

before(async () => {
  provider = await startProvider();
  const env = { FACTORY_OIDC_ISSUER: provider.issuer, FACTORY_OIDC_AUDIENCE: CLIENT_ID, FACTORY_OIDC_CLI_CLIENT_ID: CLIENT_ID };
  const state = {
    agents: new Map(),
    ledger: new MemoryLedger(),
    auth: oidcAuth({ issuer: provider.issuer, audience: CLIENT_ID, keys: async () => publicKey as never, adminEmails: ['dale@example.com'] }),
    cliDiscovery: cliDiscoveryFromEnv(env),
    version: 'test',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    runTokens: new RunTokens(undefined),
    callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    approvals: new ApprovalStore(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
  } as unknown as FactoryState;
  const server = createFactoryServer(state);
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  factory = { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
});
after(async () => {
  await factory.close();
  await provider.close();
});

const memory = (): CredentialStoreLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (i) => data.get(i), set: async (i, t) => void data.set(i, t), delete: async (i) => void data.delete(i) };
};

describe('§6.17 CL9 the CLI against a factory that verifies OIDC', () => {
  it('CL9 the factory says how to sign in, the CLI signs in with PKCE, and the factory accepts the signed token as that person', async () => {
    const found = await discoverAuth(factory.base);
    assert.equal(found.type, 'oidc');
    assert.equal(found.type === 'oidc' && found.clientId, CLIENT_ID);

    const store = memory();
    const session = makeSession('oidc', factory.base, { store, openBrowser: (provider as unknown as { browse: (u: string) => Promise<void> }).browse, say: () => {} }, found.type === 'oidc' ? found : undefined);
    await session.login();
    assert.equal(provider.authorize[0].get('code_challenge_method'), 'S256');

    const client = new FactoryClient({ baseUrl: factory.base, credential: (r) => session.credential(r) });
    assert.deepEqual(await client.whoami(), { actor: 'oidc:dale@example.com', roles: ['admin'] });
    assert.equal((await client.request('GET', '/api/v1/agents')).status, 200);
  });

  it('CL9 the factory refuses a token signed by anyone but the provider, and one with no sign-in at all', async () => {
    provider.forge = true;
    try {
      const store = memory();
      const found = await discoverAuth(factory.base);
      const session = makeSession('oidc', factory.base, { store, openBrowser: (provider as unknown as { browse: (u: string) => Promise<void> }).browse, say: () => {} }, found.type === 'oidc' ? found : undefined);
      await session.login(); // the CLI cannot tell a forged signature; only the factory can (A2)
      const client = new FactoryClient({ baseUrl: factory.base, credential: (r) => session.credential(r) });
      await assert.rejects(client.whoami(), /not signed in|sign-in/);
    } finally {
      provider.forge = false;
    }
    assert.equal((await fetch(`${factory.base}/api/v1/whoami`)).status, 401);
  });

  it('CL9 the discovery document is public and holds only what a CLI needs', async () => {
    const res = await fetch(`${factory.base}/.well-known/factory-cli`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(((await res.json()) as { auth: object }).auth).sort(), ['clientId', 'issuer', 'scopes', 'tokenUse', 'type']);
  });
});
