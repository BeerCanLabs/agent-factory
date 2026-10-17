import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperEgress, type ControlClient } from './gatekeeper-egress.js';

const TOKEN = 'egress-service-token';
const KEY = 'sk-anthropic-test-key';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function post(port: number, token: string | undefined, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/internal/vendor-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('vendor discovery', () => {
  let server: http.Server;
  let port = 0;
  let seenKey = '';

  const control = {
    async runContext() { return null; },
    async requestApproval() { return { approvalId: 'a', state: 'pending' as const }; },
    async consumeApproval() { return false; },
    async ledger() {},
  } satisfies ControlClient;

  const providers: SecretProvider[] = [{
    name: 'mem',
    async get(name) { return name === 'ANTHROPIC_API_KEY' ? KEY : undefined; },
    async put() {},
    async has() { return false; },
    async present() { return new Set<string>(); },
  }];

  before(async () => {
    server = createGatekeeperEgress({
      routes: [],
      prices: {},
      runTokens: new RunTokens('vendor-discovery-test-run-token-key-0123456789'),
      control,
      providers,
      serviceToken: TOKEN,
      heldSecretNames: ['ANTHROPIC_API_KEY'],
      discoverFetch: async (_url, init) => {
        seenKey = new Headers(init?.headers).get('x-api-key') ?? '';
        return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }), { status: 200 });
      },
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses a caller without the service token', async () => {
    const res = await post(port, undefined, { upstream: 'https://api.anthropic.com', adapter: 'anthropicMessages', secretName: 'ANTHROPIC_API_KEY' });
    assert.equal(res.status, 401);
  });

  it('refuses a secret the egress does not hold', async () => {
    const res = await post(port, TOKEN, { upstream: 'https://api.anthropic.com', adapter: 'anthropicMessages', secretName: 'OTHER_API_KEY' });
    assert.equal(res.status, 403);
  });

  it('lists models with the held key and does not return the key', async () => {
    const res = await post(port, TOKEN, {
      upstream: 'https://api.anthropic.com',
      adapter: 'anthropicMessages',
      discoveryPath: '/v1/models',
      secretName: 'ANTHROPIC_API_KEY',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { models: Array<{ id: string }> };
    assert.equal(body.models[0].id, 'claude-sonnet-4-5');
    assert.equal(seenKey, KEY);
    assert.equal(JSON.stringify(body).includes(KEY), false);
  });
});
