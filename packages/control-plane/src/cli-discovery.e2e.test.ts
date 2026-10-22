// DESIGN_AUTHORITY.md §6.17 CL9: the factory publishes how a CLI signs people in, publicly and without a secret.
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, cliDiscoveryFromEnv, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

async function serve(env: NodeJS.ProcessEnv) {
  const state = {
    agents: new Map(),
    ledger: new MemoryLedger(),
    auth: bearerAuth([{ name: 'ops', token: 'ops-token', roles: ['admin'] }]), // secret-scan:allow (test fixture)
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
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('§6.17 CL9 GET /.well-known/factory-cli', () => {
  it('CL9 serves the document to anyone, with no credential, and nothing secret in it', async () => {
    const srv = await serve({ FACTORY_OIDC_ISSUER: 'https://login.example.com', FACTORY_OIDC_CLI_CLIENT_ID: 'cli-1', FACTORY_TOKEN: 'shared-admin', FACTORY_OIDC_AUDIENCE: 'factory-api' });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/.well-known/factory-cli`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /max-age/);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { auth: { type: 'oidc', issuer: 'https://login.example.com', clientId: 'cli-1', scopes: ['openid', 'email', 'profile'], tokenUse: 'id_token' } });
      assert.doesNotMatch(text, /shared-admin|factory-api/);
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/.well-known/factory-cli`, { method: 'POST' })).status, 404, 'read only');
    } finally {
      await srv.close();
    }
  });

  it('CL9 is not there when the deployment has no CLI client (an Access-fronted factory)', async () => {
    const srv = await serve({});
    try {
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/.well-known/factory-cli`)).status, 404);
    } finally {
      await srv.close();
    }
  });
});
