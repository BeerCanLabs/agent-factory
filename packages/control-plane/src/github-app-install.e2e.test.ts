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
import { githubAppSecretNames, isGithubAppKeyMaterial } from './github-app-setup.js';
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
  it('GAP-256: a call with no org (GraphQL) uses the only chosen org; with two chosen it is refused, never guessed', async () => {
    assert.equal((await token({ runId, agentId: 'archie' })).body.error, 'org_ambiguous');
    // The chosen list is merged by default; replace:true narrows it to the one org.
    assert.equal((await post('/api/v1/keymaster/agents/archie/github-app/installations', ADMIN, { orgs: ['sandbox-org'] })).body.chosen.length, 2, 'merged, not replaced');
    assert.equal((await token({ runId, agentId: 'archie' })).body.error, 'org_ambiguous');
    assert.deepEqual((await post('/api/v1/keymaster/agents/archie/github-app/installations', ADMIN, { orgs: ['sandbox-org'], replace: true })).body.chosen, ['sandbox-org']);
    const r = await token({ runId, agentId: 'archie' });
    assert.equal(r.status, 200);
    assert.equal(r.body.org, 'sandbox-org');
    assert.match(r.body.accessToken, /^ghs_fake_/);
    assert.equal((await token({ runId, agentId: 'archie', org: 'bad/org' })).status, 400);
    assert.equal((await token({ runId, agentId: 'other' })).body.error, 'org_ambiguous', 'an agent with no chosen org gets no key');
  });
});

describe('which credential names are a GitHub App mint source (#504)', () => {
  const names = githubAppSecretNames('nina');
  const owner = githubAppSecretNames('nina', 'acme');

  it('is the app id and private key, including an owner app, and nothing else', () => {
    assert.equal(isGithubAppKeyMaterial('nina', names.id), true);
    assert.equal(isGithubAppKeyMaterial('nina', names.privateKey), true);
    assert.equal(isGithubAppKeyMaterial('nina', owner.id), true);
    assert.equal(isGithubAppKeyMaterial('nina', owner.privateKey), true);
    assert.equal(isGithubAppKeyMaterial('nina', names.slug), false);
    assert.equal(isGithubAppKeyMaterial('nina', names.webhookSecret), false);
    assert.equal(isGithubAppKeyMaterial('nina', owner.slug), false);
    assert.equal(isGithubAppKeyMaterial('nina', owner.webhookSecret), false);
    assert.equal(isGithubAppKeyMaterial('nina', githubAppSecretNames('cleo').privateKey), false);
    assert.equal(isGithubAppKeyMaterial('platform', 'shared/microsoft/oauth-client'), false);
  });
});

describe('replacing a GitHub App drops minted installation keys (GAP-269, #504)', { concurrency: false }, () => {
  let cp: http.Server;
  let gh: http.Server;
  let port = 0;
  let state: FactoryState;
  const stored = new Map<string, string>();
  const tokenIss: string[] = [];
  const installationIss: string[] = [];
  const waiting: Array<{ iss: string; release: () => void }> = [];
  let hold = 0;
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-replace-'));
  const pemOld = PEM;
  const pemNew = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const pemRotated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const apps = new Map<string, { id: number; slug: string; pem: string }>([
    ['nina-old', { id: 1111, slug: 'nina-old', pem: pemOld }],
    ['nina-new', { id: 2222, slug: 'nina-new', pem: pemNew }],
    ['cleo', { id: 3333, slug: 'cleo-app', pem: pemOld }],
    ['otto-old', { id: 4444, slug: 'otto-old', pem: pemOld }],
    ['otto-new', { id: 5555, slug: 'otto-new', pem: pemNew }],
  ]);

  before(async () => {
    gh = http.createServer(async (req, res) => {
      const conv = req.url?.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (req.method === 'POST' && conv) {
        const app = apps.get(decodeURIComponent(conv[1]));
        if (!app) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: app.id, slug: app.slug, pem: app.pem, webhook_secret: 'whsec-fake-value' }));
      }
      const iss = (() => {
        const part = String(req.headers.authorization ?? '').replace(/^Bearer /, '').split('.')[1];
        return part ? (JSON.parse(Buffer.from(part, 'base64url').toString()) as { iss?: string }).iss ?? '' : '';
      })();
      if (req.method === 'GET' && req.url === '/orgs/sandbox-org/installation') {
        installationIss.push(iss);
        res.writeHead(200);
        return res.end(JSON.stringify({ id: 77 }));
      }
      if (req.method === 'POST' && req.url === '/app/installations/77/access_tokens') {
        tokenIss.push(iss);
        if (hold > 0) {
          hold -= 1;
          await new Promise<void>((release) => waiting.push({ iss, release }));
        }
        res.writeHead(201);
        return res.end(JSON.stringify({ token: `ghs_${iss}_${tokenIss.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    const ninaNames = githubAppSecretNames('nina');
    state = {
      registryDir: dir,
      agents: new Map([
        ['nina', { id: 'nina', name: 'Nina', state: 'IDLE', roles: [], requires: [ninaNames.id, ninaNames.slug, ninaNames.privateKey, ninaNames.webhookSecret] } as any],
        ['cleo', { id: 'cleo', name: 'Cleo', state: 'IDLE', roles: [], requires: [] } as any],
        ['otto', { id: 'otto', name: 'Otto', state: 'IDLE', roles: [], requires: [] } as any],
      ]),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [{ name: 'mem', async get(n: string) { return stored.get(n); }, async put(n: string, v: string) { stored.set(n, v); } }],
      secretValues: new Set(),
      runs: new MemoryRunStore(),
      callbacks: { signingKey: 'github-app-test-signing-key-0123456789', allowInsecure: true, attempts: 1, backoffMs: 0 },
      publicBaseUrl: 'https://factory.example.com',
      githubApiBase: `http://127.0.0.1:${(gh.address() as any).port}`,
      githubWebBase: 'https://github.example',
    } as unknown as FactoryState;
    for (const id of ['nina', 'cleo', 'otto']) state.runs.create({ agentId: id, state: 'WORKING', actor: 'test', trigger: 'api' } as any);
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => {
    for (const w of waiting) w.release();
    cp?.close();
    gh?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = async (path: string, token: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const runOf = (agentId: string) => [...state.runs.list({ agentId })].find((r) => r.state === 'WORKING')!.runId;
  const mint = (agentId: string) => post('/api/v1/gatekeeper-egress/github-app/token', EGRESS, { runId: runOf(agentId), agentId, org: 'sandbox-org' });
  const untilWaiting = async (n: number) => {
    const t0 = Date.now();
    while (waiting.length < n) {
      if (Date.now() - t0 > 3_000) throw new Error(`expected ${n} held mints, have ${waiting.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const createApp = async (agentId: string, code: string, replace = false) => {
    const start = await post(`/api/v1/keymaster/agents/${agentId}/github-app/start`, ADMIN, replace ? { replace: true } : {});
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const cb = await fetch(`http://127.0.0.1:${port}/api/v1/keymaster/github-app/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(start.body.state)}`);
    assert.equal(cb.status, 200, await cb.text());
    if (!replace) {
      const chosen = await post(`/api/v1/keymaster/agents/${agentId}/github-app/installations`, ADMIN, { orgs: ['sandbox-org'] });
      assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    }
  };

  it('a replaced app is not served from the settled cache, and another agent keeps its key', async () => {
    await createApp('nina', 'nina-old');
    await createApp('cleo', 'cleo');
    const first = await mint('nina');
    assert.equal(first.status, 200);
    assert.match(first.body.accessToken, /^ghs_1111_/);
    assert.equal((await mint('nina')).body.accessToken, first.body.accessToken);
    assert.equal(tokenIss.filter((iss) => iss === '1111').length, 1);
    const cleo = await mint('cleo');
    assert.match(cleo.body.accessToken, /^ghs_3333_/);
    const cleoMints = tokenIss.filter((iss) => iss === '3333').length;

    await createApp('nina', 'nina-new', true);
    const minted = await mint('nina');
    assert.equal(minted.status, 200);
    assert.match(minted.body.accessToken, /^ghs_2222_/);
    assert.notEqual(minted.body.accessToken, first.body.accessToken);
    assert.equal((await mint('nina')).body.accessToken, minted.body.accessToken);
    assert.equal(tokenIss.filter((iss) => iss === '2222').length, 1, 'the new key is cached; the old key is not written back');
    assert.equal((await mint('cleo')).body.accessToken, cleo.body.accessToken);
    assert.equal(tokenIss.filter((iss) => iss === '3333').length, cleoMints, 'replacing nina does not drop cleo');
  });

  it('a mint in flight at the replacement returns its key to its caller and does not cache it', async () => {
    await createApp('otto', 'otto-old');
    hold = 1;
    const firstP = mint('otto');
    await untilWaiting(1);
    assert.equal(waiting[0].iss, '4444');
    await createApp('otto', 'otto-new', true);
    hold = 1;
    const secondP = mint('otto');
    await untilWaiting(2);
    assert.equal(waiting[1].iss, '5555');
    const posts = tokenIss.length;
    waiting[0].release();
    const first = await firstP;
    assert.match(first.body.accessToken, /^ghs_4444_/);
    const thirdP = mint('otto');
    waiting[1].release();
    const second = await secondP;
    const third = await thirdP;
    assert.match(second.body.accessToken, /^ghs_5555_/);
    assert.equal(third.body.accessToken, second.body.accessToken, 'the request after the replacement shares the new mint');
    assert.notEqual(third.body.accessToken, first.body.accessToken, 'the old app key is not served again');
    assert.equal(tokenIss.filter((iss) => iss === '5555').length, 1, 'the old mint did not cache, and did not start another GitHub call');
    assert.equal(tokenIss.length, posts, 'releasing the old mint wrote nothing that needed a new call');
  });

  it('writing the app id or private key drops the cached key; the slug and webhook secret do not', async () => {
    const names = githubAppSecretNames('nina');
    const cached = await mint('nina');
    assert.match(cached.body.accessToken, /^ghs_2222_/);
    const write = (name: string, value: string) => post(`/api/v1/keymaster/agents/nina/credentials/${name}`, ADMIN, { value });
    assert.equal((await write(names.slug, 'nina-slug-rotated')).status, 200);
    assert.equal((await mint('nina')).body.accessToken, cached.body.accessToken);
    assert.equal((await write(names.webhookSecret, 'whsec-rotated-value')).status, 200);
    assert.equal((await mint('nina')).body.accessToken, cached.body.accessToken, 'the slug and webhook secret are not the mint source');

    const posts = tokenIss.length;
    const installs = installationIss.filter((iss) => iss === '2222').length;
    assert.equal((await write(names.privateKey, pemRotated)).status, 200);
    const rotated = await mint('nina');
    assert.match(rotated.body.accessToken, /^ghs_2222_/);
    assert.notEqual(rotated.body.accessToken, cached.body.accessToken);
    assert.equal(tokenIss.length, posts + 1, 'the key minted with the old private key was not reused');
    assert.ok(installationIss.filter((iss) => iss === '2222').length > installs, 'the installation id from the old key was not reused');
    assert.equal((await mint('nina')).body.accessToken, rotated.body.accessToken);

    const beforeId = tokenIss.length;
    assert.equal((await write(names.id, '66666666')).status, 200);
    const afterId = await mint('nina');
    assert.match(afterId.body.accessToken, /^ghs_66666666_/);
    assert.notEqual(afterId.body.accessToken, rotated.body.accessToken);
    assert.equal(tokenIss.length, beforeId + 1);
    assert.equal((await mint('nina')).body.accessToken, afterId.body.accessToken);
  });
});
