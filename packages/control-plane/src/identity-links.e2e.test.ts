// TSK-107 (GAP-088): an admin links a Discord identity to a person. The store holds no authority by itself; every change
// is ledgered without the external id.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { IdentityLinkStore } from './identity-links.js';

const ADMIN = 'admin-identity-links';
const OPERATOR = 'operator-identity-links';
const SHA = '1'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const passed = (status: number) => status !== 401 && status !== 403;

const DISCORD_ID = '987654321012345678';

describe('identity links (TSK-107)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dir: string;
  let ledger: MemoryLedger;
  let state: FactoryState;
  const call = (path: string, method = 'GET', token?: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-identity-links-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links, replaces, lists and unlinks; the actor is stored lower-case', async () => {
    const put = await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'PUT', ADMIN, { actor: 'Cloudflare:Alice@Example.com' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.actor, 'cloudflare:alice@example.com');
    assert.equal(put.body.linkedBy, 'token:admin');
    assert.equal(state.identityLinks!.resolve('discord', DISCORD_ID), 'cloudflare:alice@example.com');
    const replaced = await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'PUT', ADMIN, { actor: 'oidc:alice' });
    assert.equal(replaced.body.actor, 'oidc:alice');
    const list = await call('/api/v1/identity-links', 'GET', ADMIN);
    assert.deepEqual(list.body.links.map((l: { id: string; actor: string }) => [l.id, l.actor]), [[DISCORD_ID, 'oidc:alice']]);
    assert.equal((await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'DELETE', ADMIN)).status, 200);
    assert.equal(state.identityLinks!.resolve('discord', DISCORD_ID), undefined);
    assert.equal((await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'DELETE', ADMIN)).status, 404);
  });

  it('survives a restart', async () => {
    await call('/api/v1/identity-links/discord/42', 'PUT', ADMIN, { actor: 'token:bob' });
    const again = new IdentityLinkStore(join(dir, 'links'));
    assert.equal(again.resolve('discord', '42'), 'token:bob');
    assert.deepEqual(again.list().map((l) => l.id), ['42']);
    assert.equal(again.unlink('discord', '42')?.actor, 'token:bob');
    assert.equal(new IdentityLinkStore(join(dir, 'links')).resolve('discord', '42'), undefined);
  });

  it('only an admin may read or change links', async () => {
    for (const [path, method] of [
      ['/api/v1/identity-links', 'GET'],
      ['/api/v1/identity-links/discord/1', 'PUT'],
      ['/api/v1/identity-links/discord/1', 'DELETE'],
    ] as const) {
      const r = await call(path, method, OPERATOR, { actor: 'token:x' });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.required, 'admin');
      assert.equal((await call(path, method, undefined, { actor: 'token:x' })).status, 401);
    }
  });

  it('refuses an unknown provider, a bad id and an actor that is not a principal', async () => {
    assert.equal((await call('/api/v1/identity-links/slack/1', 'PUT', ADMIN, { actor: 'token:x' })).status, 400);
    assert.equal((await call('/api/v1/identity-links/discord/a%20b', 'PUT', ADMIN, { actor: 'token:x' })).status, 400);
    for (const actor of ['alice', 'email:alice@example.com', 'token:', 'cloudflare:a b', 42, undefined]) {
      assert.equal((await call('/api/v1/identity-links/discord/1', 'PUT', ADMIN, { actor })).status, 400, String(actor));
    }
  });

  it('ledgers each change once, with no Discord id in the row, and not an unchanged link', async () => {
    const before = ledger.query({ agentId: 'factory' }).length;
    await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'PUT', ADMIN, { actor: 'token:carol' });
    await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'PUT', ADMIN, { actor: 'token:carol' });
    await call(`/api/v1/identity-links/discord/${DISCORD_ID}`, 'DELETE', ADMIN);
    const rows = ledger.query({ agentId: 'factory' }).slice(before);
    assert.deepEqual(rows.map((r) => r.action), ['IDENTITY_LINKED', 'IDENTITY_UNLINKED']);
    assert.ok(rows.every((r) => r.actor === 'token:admin' && /^[0-9a-f]{64}$/.test(String(r.payloadSha256))));
    assert.equal(JSON.stringify(rows).includes(DISCORD_ID), false);
  });

  it('without a store the routes answer 503 after the admin check', async () => {
    const saved = state.identityLinks;
    state.identityLinks = undefined;
    assert.equal((await call('/api/v1/identity-links', 'GET', ADMIN)).status, 503);
    assert.equal((await call('/api/v1/identity-links/discord/1', 'PUT', ADMIN, { actor: 'token:x' })).status, 503);
    state.identityLinks = saved;
  });
});
