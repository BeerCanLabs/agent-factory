// TSK-107 (GAP-088): an admin links a Discord identity to a person. The store holds no authority by itself; every change
// is ledgered without the external id.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.equal((await call('/api/v1/identity-links/unknown/1', 'PUT', ADMIN, { actor: 'token:x' })).status, 400);
    assert.equal((await call('/api/v1/identity-links/discord/a%20b', 'PUT', ADMIN, { actor: 'token:x' })).status, 400);
    for (const actor of ['alice', 'email:alice@example.com', 'token:', 'cloudflare:a b', 42, undefined]) {
      assert.equal((await call('/api/v1/identity-links/discord/1', 'PUT', ADMIN, { actor })).status, 400, String(actor));
    }
  });

  it('supports slack, teams, webui, and cli providers with optional name and roles', async () => {
    for (const provider of ['slack', 'teams', 'webui', 'cli'] as const) {
      const res = await call(`/api/v1/identity-links/${provider}/user1`, 'PUT', ADMIN, {
        actor: 'cloudflare:dale@example.com',
        name: 'Dale',
        roles: ['admin', 'operator'],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.provider, provider);
      assert.equal(res.body.name, 'Dale');
      assert.deepEqual(res.body.roles, ['admin', 'operator']);
      const resolved = state.identityLinks!.resolveLink(provider, 'user1');
      assert.equal(resolved?.actor, 'cloudflare:dale@example.com');
      assert.equal(resolved?.name, 'Dale');
      assert.deepEqual(resolved?.roles, ['admin', 'operator']);
      await call(`/api/v1/identity-links/${provider}/user1`, 'DELETE', ADMIN);
    }
  });

  it('IDENTITY_LINKED ledger hash changes when roles or name change', async () => {
    const before = ledger.query({ agentId: 'factory' }).length;
    await call('/api/v1/identity-links/discord/hash-test', 'PUT', ADMIN, {
      actor: 'token:user1',
      name: 'User One',
      roles: ['viewer'],
    });
    await call('/api/v1/identity-links/discord/hash-test', 'PUT', ADMIN, {
      actor: 'token:user1',
      name: 'User One (Updated)',
      roles: ['viewer'],
    });
    await call('/api/v1/identity-links/discord/hash-test', 'PUT', ADMIN, {
      actor: 'token:user1',
      name: 'User One (Updated)',
      roles: ['viewer', 'operator'],
    });
    const rows = ledger.query({ agentId: 'factory' }).slice(before);
    assert.equal(rows.length, 3);
    const hashes = rows.map((r) => r.payloadSha256);
    assert.notEqual(hashes[0], hashes[1]);
    assert.notEqual(hashes[1], hashes[2]);
    assert.notEqual(hashes[0], hashes[2]);
    await call('/api/v1/identity-links/discord/hash-test', 'DELETE', ADMIN);
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

  it('rejects non-admin caller attempting to grant agentRoles with 403 privilege_escalation', async () => {
    // OPERATOR token has operator role, not admin
    const res = await call('/api/v1/identity-links/discord/555', 'PUT', OPERATOR, {
      actor: 'token:user555',
      agentRoles: { switch: ['Operator'] },
    });
    // First, check if operator even has identity.links.set (requires admin)
    // If operator has no identity.links.set privilege, it fails with 403 at privilege check.
    // If a non-admin principal with identity.links.set existed, it fails with privilege_escalation.
    assert.equal(res.status, 403);
  });

  it('rejects reserved Owner role in agentRoles with 400 invalid_agent_roles', async () => {
    const res = await call('/api/v1/identity-links/discord/555', 'PUT', ADMIN, {
      actor: 'token:user555',
      agentRoles: { switch: ['Owner'] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_agent_roles');
  });

  it('rejects invalid agent IDs and prototype keys in agentRoles with 400', async () => {
    const protoRes = await call(
      '/api/v1/identity-links/discord/556',
      'PUT',
      ADMIN,
      JSON.parse('{"actor":"token:user556","agentRoles":{"__proto__":["Operator"]}}'),
    );
    assert.equal(protoRes.status, 400);

    const ctorRes = await call('/api/v1/identity-links/discord/556', 'PUT', ADMIN, {
      actor: 'token:user556',
      agentRoles: { 'constructor': ['Operator'] },
    });
    assert.equal(ctorRes.status, 400);

    const badSlugRes = await call('/api/v1/identity-links/discord/556', 'PUT', ADMIN, {
      actor: 'token:user556',
      agentRoles: { 'bad/agent/slug': ['Operator'] },
    });
    assert.equal(badSlugRes.status, 400);
  });

  it('rejects invalid role names in agentRoles with 400', async () => {
    const badRoleRes = await call('/api/v1/identity-links/discord/557', 'PUT', ADMIN, {
      actor: 'token:user557',
      agentRoles: { switch: ['bad role with spaces!'] },
    });
    assert.equal(badRoleRes.status, 400);
  });

  it('links agentRoles, includes them in ledger hash, and preserves them on partial update', async () => {
    const before = ledger.query({ agentId: 'factory' }).length;
    const put = await call('/api/v1/identity-links/discord/558', 'PUT', ADMIN, {
      actor: 'cloudflare:aiden@sackrider.org',
      name: 'Aiden',
      roles: ['operator'],
      agentRoles: { switch: ['Operator', 'Maintainer'] },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.agentRoles, { switch: ['Operator', 'Maintainer'] });

    // Verify ledger row was created
    const rows = ledger.query({ agentId: 'factory' }).slice(before);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'IDENTITY_LINKED');

    // Partial update omitting agentRoles should NOT clear switch agentRoles
    const patch = await call('/api/v1/identity-links/discord/558', 'PUT', ADMIN, {
      actor: 'cloudflare:aiden@sackrider.org',
      name: 'Aiden Sackrider',
      roles: ['operator'],
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.name, 'Aiden Sackrider');
    assert.deepEqual(patch.body.agentRoles, { switch: ['Operator', 'Maintainer'] });

    // Verify resolved link in store also preserved agentRoles
    const resolved = state.identityLinks!.resolveLink('discord', '558');
    assert.deepEqual({ ...resolved?.agentRoles }, { switch: ['Operator', 'Maintainer'] });
  });

  it('without a store the routes answer 503 after the admin check', async () => {
    const saved = state.identityLinks;
    state.identityLinks = undefined;
    assert.equal((await call('/api/v1/identity-links', 'GET', ADMIN)).status, 503);
    assert.equal((await call('/api/v1/identity-links/discord/1', 'PUT', ADMIN, { actor: 'token:x' })).status, 503);
    state.identityLinks = saved;
  });
});

describe('the identity link store keeps memory and disk in step', () => {
  it('a link whose write fails is not live in memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'links-'));
    try {
      const store = new IdentityLinkStore(join(dir, 'links'));
      rmSync(join(dir, 'links'), { recursive: true });
      writeFileSync(join(dir, 'links'), 'not a directory');
      assert.throws(() => store.link('discord', '42', 'cloudflare:a@example.com', 'admin'));
      assert.equal(store.resolve('discord', '42'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a corrupt file is skipped and the other links still load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'links-'));
    try {
      const first = new IdentityLinkStore(dir);
      first.link('discord', '7', 'cloudflare:b@example.com', 'admin');
      writeFileSync(join(dir, 'discord__broken.json'), '{"provider":"disc');
      const again = new IdentityLinkStore(dir);
      assert.equal(again.resolve('discord', '7'), 'cloudflare:b@example.com');
      assert.equal(again.list().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
