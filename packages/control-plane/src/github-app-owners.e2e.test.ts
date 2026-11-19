// Multi-owner apps (Dale, 2026-11-18): an agent holds one GitHub App per owner (an org or a personal account) beside
// its original app. Creating one never touches the others, keys are minted from the app of the repo's owner (falling
// back to the original app), the installations list is merged, and a webhook verifies against each app's secret and
// uses the verifying app's slug as the agent's "self". Fake GitHub throughout.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { createFactoryServer, type FactoryState } from './app.js';
import { githubAppSecretNames } from './github-app-setup.js';
import { chosenOrgs } from './github-app-install.js';
import { isPublicSecretName } from './app-setup-providers.js';

const ADMIN = 'admin-token';
const EGRESS = 'egress-token';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const LEGACY_SECRET = 'example-legacy-webhook-secret-0123456789'; // secret-scan:allow
const OWNER_SECRET = 'example-owner-webhook-secret-abcdef0123'; // secret-scan:allow

describe('GitHub Apps per owner', { concurrency: false }, () => {
  let cp: http.Server;
  let gh: http.Server;
  let port = 0;
  let state: FactoryState;
  let runId = '';
  const stored = new Map<string, string>();
  const ghCalls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-owners-'));
  let nextApp: Record<string, unknown> = { id: 7001, slug: 'flow-getdraft', webhook_secret: OWNER_SECRET };

  before(async () => {
    gh = http.createServer((req, res) => {
      req.url = req.url?.toLowerCase();
      ghCalls.push(`${req.method} ${req.url}`);
      const conv = req.url?.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (req.method === 'POST' && conv) { res.writeHead(201); return res.end(JSON.stringify({ ...nextApp, pem: PEM })); }
      if (req.method === 'GET' && req.url === '/users/getdraft') { res.writeHead(200); return res.end(JSON.stringify({ login: 'getdraft', type: 'Organization' })); }
      if (req.method === 'GET' && req.url === '/users/dsackr') { res.writeHead(200); return res.end(JSON.stringify({ login: 'dsackr', type: 'User' })); }
      if (req.method === 'GET' && req.url === '/orgs/beercanlabs/installation') { res.writeHead(200); return res.end(JSON.stringify({ id: 1 })); }
      if (req.method === 'GET' && req.url === '/orgs/getdraft/installation') { res.writeHead(200); return res.end(JSON.stringify({ id: 2 })); }
      if (req.method === 'GET' && req.url === '/users/dsackr/installation') { res.writeHead(200); return res.end(JSON.stringify({ id: 3 })); }
      const tok = req.url?.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (req.method === 'POST' && tok) {
        const iss = JSON.parse(Buffer.from(String(req.headers.authorization).split('.')[1], 'base64url').toString()).iss;
        res.writeHead(201);
        return res.end(JSON.stringify({ token: `ghs_inst${tok[1]}_app${iss}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    const legacy = githubAppSecretNames('flow');
    stored.set(legacy.id, '5001');
    stored.set(legacy.slug, 'flow-bcl');
    stored.set(legacy.privateKey, PEM);
    stored.set(legacy.webhookSecret, LEGACY_SECRET);
    state = {
      registryDir: dir,
      agents: new Map([['flow', { id: 'flow', name: 'Flow', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/flow', roles: [], skillIds: ['sdlc-conductor'] } as any]]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('test-run-token-key-01234567890123456789'),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { signingKey: 'github-app-owner-signing-key-0123456789', allowInsecure: true, attempts: 1, backoffMs: 0, allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      publicBaseUrl: 'https://factory.example.com',
      githubApiBase: `http://127.0.0.1:${(gh.address() as any).port}`,
      githubWebBase: 'https://github.example',
    } as unknown as FactoryState;
    runId = state.runs.create({ agentId: 'flow', state: 'WORKING', actor: 'test', trigger: 'api' } as any).runId;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { cp.closeAllConnections?.(); cp.close(); gh.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = async (path: string, token: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const start = (body: unknown) => post('/api/v1/keymaster/agents/flow/github-app/start', ADMIN, body);
  const cb = (s: string, code: string) => fetch(`http://127.0.0.1:${port}/api/v1/keymaster/github-app/callback?code=${code}&state=${encodeURIComponent(s)}`);
  const token = (org: string) => post('/api/v1/gatekeeper-egress/github-app/token', EGRESS, { runId, agentId: 'flow', org });
  const record = () => JSON.parse(readFileSync(join(dir, 'github-apps', 'flow.json'), 'utf8'));

  it('names an owner app\'s secrets apart from the original app; its id and slug are public', () => {
    const n = githubAppSecretNames('beercanlabs-conductor', 'getdraft');
    assert.equal(n.privateKey, 'GITHUB_APP_BEERCANLABS_CONDUCTOR__OWNER_GETDRAFT_PRIVATE_KEY');
    assert.equal(githubAppSecretNames('a', 'GetDraft').slug, githubAppSecretNames('a', 'getdraft').slug, 'owners are case-insensitive');
    assert.notEqual(n.slug, githubAppSecretNames('beercanlabs-conductor').slug);
    assert.equal(isPublicSecretName(n.id) && isPublicSecretName(n.slug), true);
    assert.equal(isPublicSecretName(n.privateKey) || isPublicSecretName(n.webhookSecret), false);
  });

  it('starts an org owner app at the org\'s settings and a user owner app at the user\'s own settings, typed by GitHub', async () => {
    const org = await start({ owner: 'getdraft', name: 'Flow (agent-factory) getdraft' });
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.ok(org.body.action.startsWith('https://github.example/organizations/getdraft/settings/apps/new?state='));
    assert.equal(org.body.manifest.name, 'Flow (agent-factory) getdraft');
    assert.equal(org.body.ownerType, 'org');
    assert.equal(org.body.manifest.hook_attributes.url, 'https://factory.example.com/hooks/flow', 'every app of the agent posts to its one hook');
    const user = await start({ owner: 'dsackr' });
    assert.equal(user.status, 200);
    assert.ok(user.body.action.startsWith('https://github.example/settings/apps/new?state='));
    assert.equal(user.body.ownerType, 'user');
    assert.equal((await start({ owner: 'nobody-here' })).body.error, 'owner_type_unknown');
    assert.equal((await start({ owner: 'nobody-here', ownerType: 'user' })).status, 200, 'the admin may say the type');
    assert.equal((await start({ owner: 'no/slash' })).status, 400);
    assert.equal((await start({ owner: 'getdraft', ownerType: 'team' })).status, 400);
    assert.equal((await start({ owner: 'getdraft', name: 'Chuck Finley (agent-factory) getdraft' })).body.error, 'invalid_name', 'over 34 characters');
    assert.equal((await start({})).body.error, 'github_app_exists', 'the original app still answers 409 as before');
  });

  it('stores an owner app under its own names and records the owner, leaving the original app and other owners alone', async () => {
    const before = new Map(stored);
    nextApp = { id: 7001, slug: 'flow-getdraft', webhook_secret: OWNER_SECRET };
    const s1 = (await start({ owner: 'getdraft' })).body.state;
    assert.equal((await cb(s1, 'one')).status, 200);
    const g = githubAppSecretNames('flow', 'getdraft');
    assert.equal(stored.get(g.id), '7001');
    assert.equal(stored.get(g.slug), 'flow-getdraft');
    assert.equal(stored.get(g.webhookSecret), OWNER_SECRET);
    for (const [k, v] of before) assert.equal(stored.get(k), v, `${k} untouched`);
    nextApp = { id: 7002, slug: 'flow-dsackr', webhook_secret: 'example-user-webhook-secret-xyz0123456' }; // secret-scan:allow
    const s2 = (await start({ owner: 'dsackr' })).body.state;
    assert.equal((await cb(s2, 'two')).status, 200);
    assert.equal(stored.get(githubAppSecretNames('flow', 'dsackr').slug), 'flow-dsackr');
    assert.equal(stored.get(g.slug), 'flow-getdraft', 'the first owner app is kept');
    assert.deepEqual(Object.keys(record().owners).sort(), ['dsackr', 'getdraft']);
    assert.equal(record().owners.dsackr.type, 'user');
    assert.equal((await start({ owner: 'getdraft' })).body.error, 'github_app_exists', 'a second start for the same owner is refused');
    assert.equal((await start({ owner: 'GetDraft' })).body.slug, 'flow-getdraft');
  });

  it('merges chosen orgs without dropping owner apps, and links each org to the app that serves it', async () => {
    const r = await post('/api/v1/keymaster/agents/flow/github-app/installations', ADMIN, { orgs: ['BeerCanLabs', 'getdraft'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.orgs[0].installUrl, 'https://github.example/apps/flow-bcl/installations/new');
    assert.equal(r.body.orgs[1].installUrl, 'https://github.example/apps/flow-getdraft/installations/new');
    assert.deepEqual(Object.keys(record().owners).sort(), ['dsackr', 'getdraft'], 'owners survive');
    await post('/api/v1/keymaster/agents/flow/github-app/installations', ADMIN, { orgs: ['other-org'] });
    assert.deepEqual(record().orgs, ['BeerCanLabs', 'getdraft', 'other-org'], 'added, not replaced');
    assert.deepEqual(chosenOrgs(state, 'flow').map((o) => o.toLowerCase()).sort(), ['beercanlabs', 'dsackr', 'getdraft', 'other-org']);
  });

  it('mints from the repo owner\'s own app, a user owner through its user installation, and the original app otherwise', async () => {
    const bcl = await token('BeerCanLabs');
    assert.equal(bcl.body.accessToken, 'ghs_inst1_app5001', 'the original app for BeerCanLabs');
    const gd = await token('getdraft');
    assert.equal(gd.body.accessToken, 'ghs_inst2_app7001', 'the getdraft app for getdraft');
    const me = await token('dsackr');
    assert.equal(me.body.accessToken, 'ghs_inst3_app7002', 'the dsackr app, through /users/dsackr/installation');
    assert.ok(ghCalls.includes('GET /users/dsackr/installation'));
    assert.ok(!ghCalls.includes('GET /orgs/dsackr/installation'), 'a recorded user owner is never looked up as an org');
    assert.equal((await token('elsewhere')).status, 403);
  });

  it('an owner app whose key is missing falls back to the original app', async () => {
    const g = githubAppSecretNames('flow', 'other-org');
    stored.delete(g.id);
    const rec = record();
    // Record an owner with no stored app: mint must use the original app (which GitHub says is not installed there).
    rec.owners['other-org'] = { type: 'org' };
    (await import('node:fs')).writeFileSync(join(dir, 'github-apps', 'flow.json'), JSON.stringify(rec));
    assert.equal((await token('other-org')).body.error, 'not_installed');
  });

  const hook = async (event: string, delivery: string, payload: unknown, secret: string) => {
    const body = JSON.stringify(payload);
    const r = await fetch(`http://127.0.0.1:${port}/hooks/flow`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const labeled = (sender: string, n: number) => ({ action: 'labeled', label: { name: 'sdlc:plan' }, sender: { login: sender }, repository: { full_name: 'getdraft/draftsman' }, issue: { number: n, labels: [] } });

  it('a webhook from any of the agent\'s apps verifies, and the verifying app\'s slug is the agent\'s self', async () => {
    const ownSelf = await hook('issues', '55555555-aaaa-bbbb-cccc-000000000001', labeled('flow-getdraft[bot]', 1), OWNER_SECRET);
    assert.equal(ownSelf.status, 200);
    assert.equal(ownSelf.body.ignored, true, 'the getdraft app\'s own label does not wake the agent');
    const fromOther = await hook('issues', '55555555-aaaa-bbbb-cccc-000000000002', labeled('flow-bcl[bot]', 2), OWNER_SECRET);
    assert.equal(fromOther.status, 202, 'a label by someone else, delivered by the getdraft app, wakes it');
    const legacySelf = await hook('issues', '55555555-aaaa-bbbb-cccc-000000000003', labeled('flow-bcl[bot]', 3), LEGACY_SECRET);
    assert.equal(legacySelf.body.ignored, true, 'the original app still knows its own slug');
    assert.equal((await hook('issues', '55555555-aaaa-bbbb-cccc-000000000004', labeled('x', 4), 'example-wrong-secret-0000000000000')).status, 401); // secret-scan:allow
  });

  it('jury #522 B1: with the original app on BeerCanLabs plus getdraft and dsackr apps, a call with no org still gets BeerCanLabs', async () => {
    const write = (rec: unknown) => writeFileSync(join(dir, 'github-apps', 'flow.json'), JSON.stringify(rec));
    const saved = record();
    const owners = { getdraft: { type: 'org' }, dsackr: { type: 'user' } };
    try {
      // getdraft is also in the chosen list, as the installations route puts it there: it still does not count.
      for (const orgs of [['BeerCanLabs'], ['BeerCanLabs', 'getdraft'], ['BeerCanLabs', 'GetDraft', 'dsackr']]) {
        write({ orgs, owners });
        const r = await post('/api/v1/gatekeeper-egress/github-app/token', EGRESS, { runId, agentId: 'flow' });
        assert.equal(r.status, 200, `${orgs.join(',')}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.org, 'BeerCanLabs');
        assert.equal(r.body.accessToken, 'ghs_inst1_app5001', 'minted from the original app');
      }
      write({ orgs: ['BeerCanLabs', 'other-org'], owners });
      assert.equal((await post('/api/v1/gatekeeper-egress/github-app/token', EGRESS, { runId, agentId: 'flow' })).body.error, 'org_ambiguous', 'two original-app orgs are still never guessed');
      write({ orgs: [], owners: { getdraft: { type: 'org' } } });
      assert.equal((await post('/api/v1/gatekeeper-egress/github-app/token', EGRESS, { runId, agentId: 'flow' })).body.org, 'getdraft', 'one owner app and no original-app org: that owner');
    } finally {
      write(saved);
    }
  });

});
