import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { MemoryRunStore } from '@beercanlabs/factory-property-manager';
import { createFactoryServer, type FactoryState } from './app.js';
import { githubAppSecretNames } from './github-app-setup.js';
import { appJwt } from './github-app-install.js';

// E5.1b (#316): install on chosen orgs; mint short-lived installation keys for the gatekeeper-egress only. Fake GitHub.
const ADMIN = 'admin-token';
const EGRESS = 'egress-token';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('GitHub App install and installation keys (E5.1b)', { concurrency: false }, () => {
  let cp: http.Server;
  let gh: http.Server;
  let port = 0;
  let state: FactoryState;
  let runId = '';
  let minted = 0;
  const jwts: string[] = [];
  const stored = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-install-'));

  before(async () => {
    gh = http.createServer((req, res) => {
      jwts.push(String(req.headers.authorization).replace('Bearer ', ''));
      if (req.method === 'GET' && req.url === '/orgs/sandbox-org/installation') { res.writeHead(200); return res.end(JSON.stringify({ id: 77 })); }
      if (req.method === 'GET' && req.url?.startsWith('/orgs/')) { res.writeHead(404); return res.end('{}'); }
      if (req.method === 'POST' && req.url === '/app/installations/77/access_tokens') {
        minted++;
        res.writeHead(201);
        return res.end(JSON.stringify({ token: `ghs_fake_${minted}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    const names = githubAppSecretNames('archie');
    stored.set(names.id, '4242');
    stored.set(names.slug, 'archie-app');
    stored.set(names.privateKey, PEM);
    state = {
      registryDir: dir,
      agents: new Map([['archie', { id: 'archie', name: 'Archie', state: 'IDLE', roles: [], requires: [] } as any], ['other', { id: 'other', name: 'Other', state: 'IDLE', roles: [], requires: [] } as any]]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
      runs: new MemoryRunStore(),
      callbacks: { signingKey: 'github-app-test-signing-key-0123456789', allowInsecure: true, attempts: 1, backoffMs: 0 },
      githubApiBase: `http://127.0.0.1:${(gh.address() as any).port}`,
      githubWebBase: 'https://github.example',
    } as unknown as FactoryState;
    runId = state.runs.create({ agentId: 'archie', state: 'WORKING', actor: 'test', trigger: 'api' } as any).runId;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { cp.close(); gh.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = async (path: string, token: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const token = (body: unknown, who = EGRESS) => post('/api/v1/gatekeeper-egress/github-app/token', who, body);

  it('signs a verifiable RS256 app JWT', () => {
    const [h, p, s] = appJwt('4242', PEM, 1_000_000_000_000).split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(claims.iss, '4242');
    assert.ok(claims.exp - claims.iat <= 600);
  });

  it('refuses a key before any org is chosen', async () => {
    assert.equal((await token({ runId, agentId: 'archie', org: 'sandbox-org' })).body.error, 'org_not_chosen');
  });

  it('validates chosen orgs and requires the app to exist', async () => {
    assert.equal((await post('/api/v1/keymaster/agents/archie/github-app/installations', ADMIN, { orgs: ['bad/org'] })).status, 400);
    assert.equal((await post('/api/v1/keymaster/agents/other/github-app/installations', ADMIN, { orgs: ['sandbox-org'] })).status, 428);
  });

  it('records the chosen orgs and returns an install link per org', async () => {
    const r = await post('/api/v1/keymaster/agents/archie/github-app/installations', ADMIN, { orgs: ['sandbox-org', 'second-org'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.orgs.map((o: any) => o.org), ['sandbox-org', 'second-org']);
    assert.equal(r.body.orgs[0].installUrl, 'https://github.example/apps/archie-app/installations/new');
  });

  it('mints a short-lived key for a chosen org, signed with the stored app key, and caches it', async () => {
    const a = await token({ runId, agentId: 'archie', org: 'sandbox-org' });
    assert.equal(a.status, 200);
    assert.equal(a.body.accessToken, 'ghs_fake_1');
    assert.ok(Date.parse(a.body.expiresAt) > Date.now());
    assert.ok(state.secretValues.has('ghs_fake_1'));
    const [h, p, s] = jwts[0].split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
    const b = await token({ runId, agentId: 'archie', org: 'Sandbox-Org' });
    assert.equal(b.body.accessToken, 'ghs_fake_1');
    assert.equal(minted, 1);
    assert.ok(!JSON.stringify((state.ledger as any).events).includes('ghs_fake'));
  });

  it('refuses an org that was not chosen, and a chosen org without an installation', async () => {
    assert.equal((await token({ runId, agentId: 'archie', org: 'elsewhere' })).status, 403);
    assert.equal((await token({ runId, agentId: 'archie', org: 'second-org' })).body.error, 'not_installed');
  });

  it('is exclusive to the gatekeeper-egress and needs a live run of that agent', async () => {
    assert.equal((await token({ runId, agentId: 'archie', org: 'sandbox-org' }, ADMIN)).status, 403);
    assert.equal((await token({ runId, agentId: 'other', org: 'sandbox-org' })).body.error, 'run_not_live');
  });

  it("#334: a live helper run borrows its parent's key; a helper of another agent, or after the parent ends, does not", async () => {
    const helper = state.runs.create({ agentId: 'juror.helper.1', state: 'WORKING', actor: 'test', trigger: 'subagent', parentRunId: runId, parentAgentId: 'archie' } as any).runId;
    assert.equal((await token({ runId: helper, agentId: 'archie', org: 'sandbox-org' })).status, 200);
    assert.equal((await token({ runId: helper, agentId: 'other', org: 'sandbox-org' })).body.error, 'run_not_live');
    const ended = state.runs.create({ agentId: 'archie', state: 'DONE', actor: 'test', trigger: 'api' } as any).runId;
    const orphan = state.runs.create({ agentId: 'juror.helper.2', state: 'WORKING', actor: 'test', trigger: 'subagent', parentRunId: ended, parentAgentId: 'archie' } as any).runId;
    assert.equal((await token({ runId: orphan, agentId: 'archie', org: 'sandbox-org' })).body.error, 'run_not_live');
  });
});
