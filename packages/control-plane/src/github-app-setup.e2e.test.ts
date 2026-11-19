import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { appNeeds, buildManifest, githubAppSecretNames } from './github-app-setup.js';

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
    // GitHub answered "Public cannot be private" to public:false with an inactive hook: `public` is never sent.
    assert.equal('public' in m, false);
    // GAP-257: an agent that declares neither events nor Projects gets the old, narrow manifest.
    assert.equal('hook_attributes' in m, false);
    assert.deepEqual(m.default_events, []);
    assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' });
    const allowed = ['name', 'url', 'hook_attributes', 'redirect_url', 'callback_urls', 'setup_url', 'description', 'public', 'default_events', 'default_permissions', 'request_oauth_on_install', 'setup_on_update'];
    for (const k of Object.keys(m)) assert.ok(allowed.includes(k), `undocumented manifest key ${k}`);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
    assert.match(m.name, /^Archie \(f\) [0-9a-f]{4}$/);
    assert.notEqual(buildManifest('https://f.example', 'archie', 'Archie').name, m.name);
    assert.ok(buildManifest('https://f.example', 'a', 'A'.repeat(60)).name.length <= 34);
  });

  it('#483: the ops leader also gets workflow_run and Actions write (to dispatch its workflows); no other agent does', () => {
    const ops = buildManifest('https://f.example', 'sdlc-ops', 'Ops', appNeeds({ skillIds: ['sdlc-ops'] }));
    assert.deepEqual(ops.hook_attributes, { url: 'https://f.example/hooks/sdlc-ops', active: true });
    assert.deepEqual(ops.default_events, ['workflow_run'], 'jury #485 B2: an ops-only app takes only workflow_run');
    assert.deepEqual(ops.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', actions: 'write' });
    const both = buildManifest('https://f.example', 'lead', 'Lead', appNeeds({ skillIds: ['sdlc-conductor', 'sdlc-ops'] }));
    assert.deepEqual(both.default_events, ['issues', 'issue_comment', 'pull_request', 'check_suite', 'status', 'workflow_run']);
    assert.deepEqual([both.default_permissions.checks, both.default_permissions.statuses, both.default_permissions.actions], ['read', 'read', 'write']);
    const conductor = buildManifest('https://f.example', 'flow', 'Flow', appNeeds({ skillIds: ['sdlc-conductor'] }));
    assert.equal(conductor.default_events.includes('workflow_run'), false);
    assert.equal('actions' in conductor.default_permissions, false);
    assert.deepEqual(appNeeds({}, { workflows: true }), { events: false, projects: false, workflows: true }, 'the admin can declare it');
  });

  it('GAP-257: only the agents that need them get the hook and events, or organization Projects', () => {
    const conductor = buildManifest('https://f.example', 'flow bot', 'Flow', appNeeds({ skillIds: ['sdlc-conductor', 'sdlc-merge'] }));
    assert.deepEqual(conductor.hook_attributes, { url: 'https://f.example/hooks/flow%20bot', active: true }, 'the agent id is URL-encoded');
    assert.deepEqual(conductor.default_events, ['issues', 'issue_comment', 'pull_request', 'check_suite', 'status']);
    assert.ok(!conductor.default_events.includes('check_run'), 'check_run is ignored by the factory, so never subscribed');
    assert.equal(conductor.default_permissions.checks, 'read');
    assert.equal(conductor.default_permissions.statuses, 'read');
    assert.equal('organization_projects' in conductor.default_permissions, false);
    const backlog = buildManifest('https://f.example', 'ops', 'Ops', appNeeds({ skillRoutes: { 'sdlc-backlog-github': ['github'] } }));
    assert.equal(backlog.default_permissions.organization_projects, 'write');
    assert.equal('hook_attributes' in backlog, false);
    assert.deepEqual(backlog.default_events, []);
    assert.deepEqual(appNeeds({ skillIds: ['sdlc-coder'] }), { events: false, projects: false }, 'a coder takes no app events');
    assert.deepEqual(appNeeds({}, { events: true, projects: true }), { events: true, projects: true }, 'the admin can declare them');
    assert.deepEqual(appNeeds({}, { events: 'yes' }), { events: false, projects: false });
    // The reviewer reads checks and statuses with no hook or events.
    const rev = buildManifest('https://f.example', 'rev', 'Rev', appNeeds({ skillIds: ['sdlc-reviewer'] }));
    assert.deepEqual(rev.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', statuses: 'read' });
    assert.equal('hook_attributes' in rev, false);
    assert.deepEqual(rev.default_events, []);
    assert.deepEqual(appNeeds({}, { ci: true }), { events: false, projects: false, ci: true }, 'the admin can declare it');
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
    assert.match(b.manifest.name, /^Archie \(factory\) [0-9a-f]{4}$/);
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

    // A second Start once the app is stored points at the install link instead of creating a duplicate.
    const dup = await start(ADMIN);
    assert.equal(dup.status, 409);
    const d = await dup.json() as any;
    assert.equal(d.error, 'github_app_exists');
    assert.equal(d.installUrl, 'https://github.example/apps/archie-app/installations/new');
    assert.equal((await start(ADMIN, { replace: true })).status, 200);
  });

  it('reports a failed conversion without storing', async () => {
    stored.clear();
    const { state: s } = await (await start(ADMIN)).json() as any;
    const r = await cb(`code=bad&state=${encodeURIComponent(s)}`);
    assert.equal(r.status, 502);
    assert.equal(stored.size, 0);
  });
  it('GAP-257: an existing app is upgraded by creating it again (replace), which stores the new webhook secret', async () => {
    const archie = state.agents.get('archie') as any;
    archie.skillIds = ['sdlc-conductor'];
    try {
      stored.set(githubAppSecretNames('archie').slug, 'archie-old-app');
      assert.equal((await start(ADMIN)).status, 409);
      const r = await start(ADMIN, { replace: true });
      assert.equal(r.status, 200);
      const b = await r.json() as any;
      assert.deepEqual(b.manifest.hook_attributes, { url: 'https://factory.example.com/hooks/archie', active: true });
      assert.ok(b.manifest.default_events.includes('pull_request'));
      assert.equal((await cb(`code=upgrade&state=${encodeURIComponent(b.state)}`)).status, 200);
      assert.equal(stored.get(githubAppSecretNames('archie').webhookSecret), 'whsec-fake');
      assert.equal(stored.get(githubAppSecretNames('archie').slug), 'archie-app');
    } finally {
      delete archie.skillIds;
      stored.clear();
    }
  });
});
