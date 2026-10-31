import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { DEFAULT_DISCORD_PERMISSIONS } from './discord-app-setup.js';

// E5.2 (#302): Discord bot setup as far as Discord allows, against a fake Discord API.
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';
const GOOD = 'F'.repeat(24) + '.' + 'a'.repeat(6) + '.' + 'b'.repeat(38); // fake, shaped like a bot token
const BAD = 'R'.repeat(24) + '.' + 'c'.repeat(6) + '.' + 'd'.repeat(38);

describe('Discord bot setup (E5.2)', { concurrency: false }, () => {
  let cp: http.Server;
  let dc: http.Server;
  let port = 0;
  let state: FactoryState;
  const stored = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), 'discord-setup-'));

  before(async () => {
    dc = http.createServer((req, res) => {
      if (req.url === '/oauth2/applications/@me' && req.headers.authorization === `Bot ${GOOD}`) { res.writeHead(200); return res.end(JSON.stringify({ id: '112233445566778899', name: 'Archie' })); }
      res.writeHead(401); res.end('{}');
    });
    await new Promise<void>((r) => dc.listen(0, '127.0.0.1', r));
    state = {
      registryDir: dir,
      agents: new Map([
        ['archie', { id: 'archie', name: 'Archie', state: 'IDLE', roles: [], requires: [], triggers: [{ type: 'discord', secretRef: 'ARCHIE_BOT' }], discord: { permissions: '3072' } } as any],
        ['plain', { id: 'plain', name: 'Plain', state: 'IDLE', roles: [], requires: [] } as any],
      ]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'viewer', token: VIEWER, roles: ['viewer'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
      discordApiBase: `http://127.0.0.1:${(dc.address() as any).port}`,
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { cp.close(); dc.close(); rmSync(dir, { recursive: true, force: true }); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: text ? JSON.parse(text) : null };
  };

  it('guides each step and marks the ones Discord keeps manual', async () => {
    const r = await call('GET', '/api/v1/keymaster/agents/archie/discord-app', ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.steps.map((s: any) => [s.id, s.manual]), [['create-app', true], ['add-bot', true], ['paste-token', false], ['invite', false]]);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.inviteUrl, undefined);
  });

  it('is admin-only to save a token', async () => {
    assert.equal((await call('POST', '/api/v1/keymaster/agents/archie/discord-app/token', VIEWER, { value: GOOD })).status, 403);
  });

  it('refuses a malformed or rejected token and stores nothing', async () => {
    assert.equal((await call('POST', '/api/v1/keymaster/agents/archie/discord-app/token', ADMIN, { value: 'short' })).body.error, 'token_invalid');
    assert.equal((await call('POST', '/api/v1/keymaster/agents/archie/discord-app/token', ADMIN, { value: BAD })).body.error, 'token_rejected');
    assert.equal(stored.size, 0);
  });

  it('stores a checked token under the declared secretRef, never shows it, and builds the invite with declared permissions', async () => {
    const r = await call('POST', '/api/v1/keymaster/agents/archie/discord-app/token', ADMIN, { value: GOOD });
    assert.equal(r.status, 201);
    assert.ok(!r.text.includes(GOOD));
    assert.equal(stored.get('ARCHIE_BOT'), GOOD);
    assert.equal(stored.get('ARCHIE_DISCORD_APP_ID'), '112233445566778899');
    assert.ok(state.secretValues.has(GOOD));
    const invite = new URL(r.body.inviteUrl);
    assert.equal(invite.searchParams.get('client_id'), '112233445566778899');
    assert.equal(invite.searchParams.get('permissions'), '3072');
    assert.equal(invite.searchParams.get('scope'), 'bot applications.commands');
    assert.ok(!JSON.stringify((state.ledger as any).events).includes(GOOD));
    const after = await call('GET', '/api/v1/keymaster/agents/archie/discord-app', ADMIN);
    assert.equal(after.body.configured, true);
    assert.equal(after.body.inviteUrl, r.body.inviteUrl);
    assert.ok(!after.text.includes(GOOD));
  });

  it('uses per-agent names and default permissions when nothing is declared', async () => {
    const r = await call('POST', '/api/v1/keymaster/agents/plain/discord-app/token', ADMIN, { value: GOOD });
    assert.equal(r.body.name, 'PLAIN_DISCORD_BOT_TOKEN');
    assert.equal(new URL(r.body.inviteUrl).searchParams.get('permissions'), DEFAULT_DISCORD_PERMISSIONS);
  });
});
