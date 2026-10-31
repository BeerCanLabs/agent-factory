import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { buildManifest, githubAppSecretNames } from './github-app-setup.js';

// E5.1a (#315): the manifest flow stores an agent's app id and key in the secret store, never anywhere else.
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';
const PEM = ['-----BEGIN RSA', 'PRIVATE KEY-----\nFAKE-KEY\n-----END RSA', 'PRIVATE KEY-----'].join(' '); // fake fixture

describe('GitHub App manifest setup (E5.1a)', { concurrency: false }, () => {
  let cp: http.Server;
  let gh: http.Server;
  let port = 0;
  let state: FactoryState;
  const stored = new Map<string, string>();
  const conversions: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-setup-'));

  before(async () => {
    gh = http.createServer((req, res) => {
      const m = req.url?.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (req.method === 'POST' && m) {
        conversions.push(m[1]);
        if (m[1] === 'bad') { res.writeHead(404); return res.end('{}'); }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 4242, slug: 'archie-app', pem: PEM, webhook_secret: 'whsec-fake', client_secret: 'cs-fake' }));
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    state = {
      registryDir: dir,
      agents: new Map([['archie', { id: 'archie', name: 'Archie', state: 'IDLE', roles: [], requires: [] } as any]]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'viewer', token: VIEWER, roles: ['viewer'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
      callbacks: { signingKey: 'github-app-test-signing-key-0123456789', allowInsecure: true, attempts: 1, backoffMs: 0 },
      publicBaseUrl: 'https://factory.example.com',
      githubApiBase: `http://127.0.0.1:${(gh.address() as any).port}`,
      githubWebBase: 'https://github.example',
    } as unknown as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { cp.close(); gh.close(); rmSync(dir, { recursive: true, force: true }); });

  const start = (token: string, body: unknown = {}) => fetch(`http://127.0.0.1:${port}/api/v1/keymaster/agents/archie/github-app/start`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cb = (q: string) => fetch(`http://127.0.0.1:${port}/api/v1/keymaster/github-app/callback?${q}`);

  it('builds a prefilled manifest that redirects back to the factory', () => {
    const m = buildManifest('https://f.example', 'archie', 'Archie');
    assert.equal(m.redirect_url, 'https://f.example/api/v1/keymaster/github-app/callback');
    assert.equal(m.public, false);
    assert.equal(m.name, 'Archie (f)');
  });

  it('names secrets per agent', () => {
    assert.equal(githubAppSecretNames('sdlc-coder').privateKey, 'GITHUB_APP_SDLC_CODER_PRIVATE_KEY');
  });

  it('requires credentials.agent.set to start', async () => {
    assert.equal((await start(VIEWER)).status, 403);
  });

  it('rejects a bad org', async () => {
    assert.equal((await start(ADMIN, { org: 'no/slash' })).status, 400);
  });

  it('starts with a GitHub action URL carrying signed state, for an org', async () => {
    const r = await start(ADMIN, { org: 'sandbox-org' });
    assert.equal(r.status, 200);
    const b = await r.json() as any;
    assert.ok(b.action.startsWith('https://github.example/organizations/sandbox-org/settings/apps/new?state='));
    assert.equal(b.manifest.name, 'Archie (factory)');
    assert.ok(b.state);
  });

  it('rejects a forged state and stores nothing', async () => {
    const r = await cb('code=abc&state=forged.sig');
    assert.equal(r.status, 400);
    assert.equal(stored.size, 0);
    assert.equal(conversions.length, 0);
  });

  it('converts the code, stores the app in the secret store, and never echoes the key', async () => {
    const { state: s } = await (await start(ADMIN)).json() as any;
    const r = await cb(`code=good&state=${encodeURIComponent(s)}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes('FAKE-KEY'));
    const n = githubAppSecretNames('archie');
    assert.equal(stored.get(n.id), '4242');
    assert.equal(stored.get(n.slug), 'archie-app');
    assert.equal(stored.get(n.privateKey), PEM);
    assert.equal(stored.get(n.webhookSecret), 'whsec-fake');
    assert.ok(state.secretValues.has(PEM));
    const rows = JSON.stringify((state.ledger as any).events);
    assert.ok(!rows.includes('FAKE-KEY'));

    // Replay of the same redirect is refused.
    const again = await cb(`code=good&state=${encodeURIComponent(s)}`);
    assert.equal(again.status, 400);
    assert.equal(conversions.filter((c) => c === 'good').length, 1);
  });

  it('reports a failed conversion without storing', async () => {
    stored.clear();
    const { state: s } = await (await start(ADMIN)).json() as any;
    const r = await cb(`code=bad&state=${encodeURIComponent(s)}`);
    assert.equal(r.status, 502);
    assert.equal(stored.size, 0);
  });
});
