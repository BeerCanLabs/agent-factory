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
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { PrincipalStore } from '@beercanlabs/factory-bouncer';

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
    // E12: a role can be given only if the agent declares it.
    state.agents.set('switch', { id: 'switch', name: 'Switch', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/switch', roles: [{ name: 'Operator', skills: {} }, { name: 'Maintainer', skills: {} }, { name: 'Owner', skills: {} }] } as never);
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

  describe('only roles the agent declares can be given (E12, TSK-173)', () => {
    const put = (id: string, actor: string, agentRoles: Record<string, string[]>, extra: Record<string, unknown> = {}) =>
      call(`/api/v1/identity-links/discord/${id}`, 'PUT', ADMIN, { actor, ...extra, agentRoles });
    const agent = (id: string, roles: string[]) =>
      state.agents.set(id, { id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: `/agents/${id}`, roles: roles.map((name) => ({ name, skills: {} })) } as never);

    it('refuses a role the agent does not declare, saying which it does', async () => {
      agent('donna-e', ['Owner', 'Family']);
      const r = await put('701', 'cloudflare:cousin@example.com', { 'donna-e': ['Famly'] });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'unknown_agent_role');
      assert.deepEqual([r.body.agentId, r.body.roles, r.body.assignable], ['donna-e', ['Famly'], ['Family']]);
      assert.match(r.body.message, /does not declare 'Famly'; it declares 'Family'/);
      assert.equal(state.identityLinks!.resolveLink('discord', '701'), undefined, 'nothing was linked');
    });

    it('refuses a role of another agent, an agent that is not registered, the reserved Owner, and any role on an agent that declares none', async () => {
      agent('higgins-e', ['Owner', 'Realtor']);
      agent('plain-e', []);
      assert.equal((await put('702', 'cloudflare:a@example.com', { 'donna-e': ['Realtor'] })).body.error, 'unknown_agent_role', 'Realtor is Higgins’s');
      assert.equal((await put('702', 'cloudflare:a@example.com', { ghost: ['Family'] })).body.error, 'unknown_agent');
      assert.equal((await put('702', 'cloudflare:a@example.com', { 'donna-e': ['Owner'] })).status, 400, 'Owner is never assigned');
      const none = await put('702', 'cloudflare:a@example.com', { 'plain-e': ['Anything'] });
      assert.equal(none.body.error, 'unknown_agent_role');
      assert.deepEqual(none.body.assignable, []);
      assert.match(none.body.message, /no roles that can be given/);
    });

    it('gives a declared role, and one person may hold roles on several agents', async () => {
      const r = await put('703', 'cloudflare:stephanie-e@example.com', { 'donna-e': ['Family'], 'higgins-e': ['Realtor'] }, { name: 'Stephanie' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual({ ...r.body.agentRoles }, { 'donna-e': ['Family'], 'higgins-e': ['Realtor'] });
    });

    it('does not refuse a role the link already holds when the cartridge has since dropped it, but will not add it to anyone else', async () => {
      assert.equal((await put('704', 'cloudflare:aiden-e@example.com', { 'donna-e': ['Family'] })).status, 200);
      agent('donna-e', ['Owner']); // the cartridge no longer declares Family
      const rename = await put('704', 'cloudflare:aiden-e@example.com', { 'donna-e': ['Family'] }, { name: 'Aiden' });
      assert.equal(rename.status, 200, 'an unrelated edit is not blocked by a role the cartridge dropped');
      assert.equal(rename.body.name, 'Aiden');
      assert.equal((await put('705', 'cloudflare:new-e@example.com', { 'donna-e': ['Family'] })).body.error, 'unknown_agent_role', 'but it cannot be given to anyone new');
      assert.equal((await put('704', 'cloudflare:someone-else@example.com', { 'donna-e': ['Family'] })).body.error, 'unknown_agent_role', 'nor kept when the link is re-pointed to another person');
    });

    it('an agent that has since been unregistered does not block an edit that only keeps what is already held', async () => {
      agent('gone-e', ['Owner', 'Family']);
      assert.equal((await put('706', 'cloudflare:ghosted@example.com', { 'gone-e': ['Family'], 'higgins-e': ['Realtor'] })).status, 200);
      state.agents.delete('gone-e');
      const keep = await put('706', 'cloudflare:ghosted@example.com', { 'gone-e': ['Family'], 'higgins-e': ['Realtor'] }, { name: 'Ghosted' });
      assert.equal(keep.status, 200, JSON.stringify(keep.body));
      assert.equal((await put('707', 'cloudflare:other@example.com', { 'gone-e': ['Family'] })).body.error, 'unknown_agent', 'but a role on it cannot be given to anyone new');
    });

    it('always allows removing a role, even for an agent that is gone', async () => {
      const r = await put('704', 'cloudflare:aiden-e@example.com', { 'donna-e': [], ghost: [] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.agentRoles ?? {}, {});
    });
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

describe('channel identity linked to a principal by name (#439)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dir: string;
  let ledger: MemoryLedger;
  let state: FactoryState;
  let principals: PrincipalStore;
  const DISCORD = '555001122334455667';
  const SLACK = 'U0DALE123';
  const call = (path: string, method = 'GET', token?: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    });
  const mcp = (token: string | undefined, payload: unknown) => call('/mcp/x/access', 'POST', token, payload);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-identity-by-name-'));
    ledger = new MemoryLedger();
    principals = PrincipalStore.inMemory();
    await principals.create({ id: 'user:dale', displayName: 'Dale', emails: ['dale@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:dale.sackrider', displayName: 'Dale Sackrider', emails: ['dale.sackrider@gmail.com'], by: 'user:admin' });
    await principals.create({ id: 'user:sam.a', displayName: 'Sam', emails: ['sam.a@example.com'], by: 'user:admin' });
    await principals.create({ id: 'user:sam.b', displayName: 'Sam', emails: ['sam.b@example.com'], by: 'user:admin' });
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
      principals,
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

  it('links Discord and Slack accounts to a person by friendly name and unlinks them, ledgered, with no external id in the row', async () => {
    const before = ledger.query({ agentId: 'factory' }).length;
    const discord = await call(`/api/v1/identity-links/discord/${DISCORD}`, 'PUT', ADMIN, { principalName: '  dale ' });
    assert.equal(discord.status, 200, JSON.stringify(discord.body));
    assert.equal(discord.body.actor, 'user:dale');
    assert.equal(discord.body.provider, 'discord');
    assert.equal(discord.body.roles, undefined);
    assert.equal(discord.body.name, undefined);
    assert.equal(state.identityLinks!.resolve('discord', DISCORD), 'user:dale');
    const again = await call(`/api/v1/identity-links/discord/${DISCORD}`, 'PUT', ADMIN, { principalName: 'Dale' });
    assert.equal(again.status, 200);
    assert.equal(again.body.actor, 'user:dale');

    const listed = await mcp(ADMIN, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const tool = listed.body.result.tools.find((t: { name: string }) => t.name === 'set_identity_link');
    const unlinkTool = listed.body.result.tools.find((t: { name: string }) => t.name === 'delete_identity_link');
    assert.ok(tool, 'set_identity_link is on the access toolset');
    assert.ok(tool.inputSchema.properties.principalName);
    assert.ok(!tool.inputSchema.required?.includes('actor'));
    assert.ok(tool.inputSchema.required?.includes('provider'));
    assert.ok(unlinkTool);

    const slack = await mcp(ADMIN, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'set_identity_link', arguments: { provider: 'slack', id: SLACK, principalName: 'Dale' } },
    });
    assert.equal(slack.status, 200, JSON.stringify(slack.body));
    assert.equal(slack.body.result?.isError, undefined);
    assert.equal(slack.body.result.structuredContent.actor, 'user:dale');
    assert.equal(state.identityLinks!.resolve('slack', SLACK), 'user:dale');

    const dropDiscord = await mcp(ADMIN, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delete_identity_link', arguments: { provider: 'discord', id: DISCORD } },
    });
    assert.equal(dropDiscord.body.result?.isError, undefined, JSON.stringify(dropDiscord.body));
    assert.equal(dropDiscord.body.result.structuredContent.ok, true);
    assert.equal(state.identityLinks!.resolve('discord', DISCORD), undefined);

    const dropSlack = await call(`/api/v1/identity-links/slack/${SLACK}`, 'DELETE', ADMIN);
    assert.equal(dropSlack.status, 200, JSON.stringify(dropSlack.body));
    assert.equal(state.identityLinks!.resolve('slack', SLACK), undefined);

    const rows = ledger.query({ agentId: 'factory' }).slice(before);
    assert.deepEqual(rows.map((r) => r.action), ['IDENTITY_LINKED', 'IDENTITY_LINKED', 'IDENTITY_UNLINKED', 'IDENTITY_UNLINKED']);
    assert.ok(rows.every((r) => r.actor === 'token:admin' && /^[0-9a-f]{64}$/.test(String(r.payloadSha256))));
    const dumped = JSON.stringify(rows);
    assert.equal(dumped.includes(DISCORD), false);
    assert.equal(dumped.includes(SLACK), false);
  });

  it('keeps an actor-only link as the legacy IdP string, even when that email belongs to a principal', async () => {
    const put = await call('/api/v1/identity-links/discord/legacy-dale', 'PUT', ADMIN, { actor: 'Cloudflare:Dale@Example.com' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.actor, 'cloudflare:dale@example.com');
    assert.equal(state.identityLinks!.resolve('discord', 'legacy-dale'), 'cloudflare:dale@example.com');
    const agreed = await call('/api/v1/identity-links/slack/agreed-dale', 'PUT', ADMIN, {
      actor: 'cloudflare:dale@example.com',
      principalName: 'Dale',
    });
    assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
    assert.equal(agreed.body.actor, 'user:dale');
    await call('/api/v1/identity-links/discord/legacy-dale', 'DELETE', ADMIN);
    await call('/api/v1/identity-links/slack/agreed-dale', 'DELETE', ADMIN);
  });

  it('refuses a missing, ambiguous, or disagreeing name, and a longer name is a different person', async () => {
    const before = ledger.query({ agentId: 'factory' }).length;
    const missing = await call('/api/v1/identity-links/discord/no-such', 'PUT', ADMIN, { principalName: 'Nobody' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'principal_not_found');
    const longer = await call('/api/v1/identity-links/discord/no-such', 'PUT', ADMIN, { principalName: 'Dale' });
    assert.equal(longer.status, 200);
    assert.equal(longer.body.actor, 'user:dale');
    assert.notEqual(state.identityLinks!.resolve('discord', 'no-such'), 'user:dale.sackrider');
    await call('/api/v1/identity-links/discord/no-such', 'DELETE', ADMIN);

    const ambiguous = await call('/api/v1/identity-links/slack/sam-acct', 'PUT', ADMIN, { principalName: 'Sam' });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.error, 'ambiguous_principal');
    assert.deepEqual(ambiguous.body.matches.map((m: { id: string }) => m.id), ['user:sam.a', 'user:sam.b']);
    assert.equal(state.identityLinks!.resolve('slack', 'sam-acct'), undefined);

    const mismatch = await call('/api/v1/identity-links/discord/mismatch', 'PUT', ADMIN, {
      principalName: 'Dale',
      actor: 'token:someone',
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, 'actor_name_mismatch');
    assert.equal(state.identityLinks!.resolve('discord', 'mismatch'), undefined);

    const neither = await call('/api/v1/identity-links/discord/neither', 'PUT', ADMIN, {});
    assert.equal(neither.status, 400);
    assert.match(neither.body.error, /principalName/);
    const badActor = await call('/api/v1/identity-links/discord/neither', 'PUT', ADMIN, { actor: 'alice' });
    assert.equal(badActor.status, 400);
    assert.equal(badActor.body.error, 'actor must be a principal actor such as cloudflare:alice@example.com, oidc:... or token:...');
    const rows = ledger.query({ agentId: 'factory' }).slice(before);
    assert.deepEqual(rows.map((r) => r.action), ['IDENTITY_LINKED', 'IDENTITY_UNLINKED']);
  });

  it('only an admin may link or unlink by name, on the API and the MCP', async () => {
    const rest = await call('/api/v1/identity-links/discord/priv', 'PUT', OPERATOR, { principalName: 'Dale' });
    assert.equal(rest.status, 403);
    assert.equal(rest.body.required, 'admin');
    assert.equal((await call('/api/v1/identity-links/discord/priv', 'PUT', undefined, { principalName: 'Dale' })).status, 401);
    assert.equal((await call('/api/v1/identity-links/discord/priv', 'DELETE', OPERATOR)).status, 403);
    const denied = await mcp(OPERATOR, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'set_identity_link', arguments: { provider: 'discord', id: 'priv', principalName: 'Dale' } },
    });
    assert.equal(denied.body.result.isError, true);
    assert.equal(denied.body.result.structuredContent.required, 'admin');
    const deniedUnlink = await mcp(OPERATOR, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'delete_identity_link', arguments: { provider: 'discord', id: 'priv' } },
    });
    assert.equal(deniedUnlink.body.result.isError, true);
    assert.equal(deniedUnlink.body.result.structuredContent.required, 'admin');
    assert.equal(state.identityLinks!.resolve('discord', 'priv'), undefined);
  });

  it('refuses a name link when the principal store is down', async () => {
    const saved = state.principals;
    const sick = PrincipalStore.inMemory();
    sick.markUnhealthy(new Error('down'));
    state.principals = sick;
    try {
      const down = await call(`/api/v1/identity-links/discord/${DISCORD}`, 'PUT', ADMIN, { principalName: 'Dale' });
      assert.equal(down.status, 503);
      assert.equal(down.body.error, 'principal_store_unavailable');
      const legacy = await call('/api/v1/identity-links/discord/still-legacy', 'PUT', ADMIN, { actor: 'token:carol' });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.actor, 'token:carol');
      await call('/api/v1/identity-links/discord/still-legacy', 'DELETE', ADMIN);
    } finally {
      state.principals = saved;
    }
  });
});
