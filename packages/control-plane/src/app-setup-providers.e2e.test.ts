import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { agentPath, registerAppSetupProvider, type AppSetupProvider, type SetupAction } from './app-setup-providers.js';

// E5.3 (#303): GitHub and Discord through one setup pattern, and a stub provider that needs no flow-specific code.
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';
const KINDS: Array<SetupAction['kind']> = ['secret', 'browser-post', 'list'];

describe('shared app setup pattern (E5.3)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  const stored = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), 'app-setup-'));
  const stub: AppSetupProvider = {
    id: 'stub',
    title: 'Stub service',
    steps: (_s, agentId) => [
      { id: 'portal', manual: true, text: 'Create the app in the stub portal.' },
      { id: 'key', manual: false, text: 'Paste the key.', action: { kind: 'secret', path: agentPath(agentId, 'app-setup/stub/key') } },
    ],
    async status(_s, agentId) { return { configured: stored.has(`STUB_${agentId}`) }; },
    async submit(_s, agentId, _step, value) { stored.set(`STUB_${agentId}`, value); return { status: 201, body: { status: 'present' } }; },
  };

  before(async () => {
    registerAppSetupProvider(stub);
    const state = {
      registryDir: dir,
      agents: new Map([['archie', { id: 'archie', name: 'Archie', state: 'IDLE', roles: [], requires: [] } as any]]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'viewer', token: VIEWER, roles: ['viewer'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { cp.close(); rmSync(dir, { recursive: true, force: true }); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: text ? JSON.parse(text) : null };
  };

  it('describes GitHub, Discord and the stub with only the shared step kinds', async () => {
    const r = await call('GET', agentPath('archie', 'app-setup'), ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.providers.map((p: any) => p.id), ['github', 'discord', 'stub']);
    for (const p of r.body.providers) {
      assert.equal(typeof p.configured, 'boolean');
      for (const s of p.steps) {
        assert.equal(typeof s.manual, 'boolean');
        if (s.action) {
          assert.ok(KINDS.includes(s.action.kind), `${p.id}/${s.id}: ${s.action.kind}`);
          assert.ok(s.action.path.startsWith('/keymaster/agents/archie/'));
        }
      }
    }
    const discord = r.body.providers.find((p: any) => p.id === 'discord');
    assert.equal(discord.steps.find((s: any) => s.id === 'paste-token').action.path, '/keymaster/agents/archie/discord-app/token');
  });

  it('runs the stub provider end to end through the generic route, write-only', async () => {
    assert.equal((await call('POST', agentPath('archie', 'app-setup/stub/key'), VIEWER, { value: 'stub-value-1' })).status, 403);
    const r = await call('POST', agentPath('archie', 'app-setup/stub/key'), ADMIN, { value: 'stub-value-1' });
    assert.equal(r.status, 201);
    assert.ok(!r.text.includes('stub-value-1'));
    assert.equal(stored.get('STUB_archie'), 'stub-value-1');
    const after = await call('GET', agentPath('archie', 'app-setup'), ADMIN);
    assert.equal(after.body.providers.find((p: any) => p.id === 'stub').configured, true);
  });

  it('refuses a step that is not a secret step, or an unknown provider', async () => {
    assert.equal((await call('POST', agentPath('archie', 'app-setup/stub/portal'), ADMIN, { value: 'x' })).status, 404);
    assert.equal((await call('POST', agentPath('archie', 'app-setup/nope/key'), ADMIN, { value: 'x' })).status, 404);
  });
});
