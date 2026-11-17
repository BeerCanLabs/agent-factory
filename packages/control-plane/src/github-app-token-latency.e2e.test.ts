import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { MemoryRunStore } from '@beercanlabs/factory-property-manager';
import { createFactoryServer, type FactoryState } from './app.js';
import { githubAppSecretNames } from './github-app-setup.js';
import { invalidateSecret, readSecretCached } from './app-setup-providers.js';

// #501: a cold installation-key mint must fit inside the gatekeeper-egress's 10 s call. Secret reads (each an AWS
// CLI spawn in prod) are cached and run together, concurrent mints are shared, installation ids are kept, the route
// answers by its deadline while a slow mint finishes into the cache, and every mint logs one line. Fake GitHub.
const EGRESS = 'egress-token';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GitHub App token latency (#501)', { concurrency: false }, () => {
  let cp: http.Server;
  let gh: http.Server;
  let port = 0;
  let state: FactoryState;
  const runs: Record<string, string> = {};
  const stored = new Map<string, string>();
  const reads: Array<{ name: string; at: number }> = [];
  const calls = { installation: 0, token: 0 };
  let readDelayMs = 0;
  let refuseNextToken = false;
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-latency-'));
  const origLog = console.log;
  const origErr = console.error;

  before(async () => {
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    gh = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/orgs/sandbox-org/installation') { calls.installation++; res.writeHead(200); return res.end(JSON.stringify({ id: 88 })); }
      if (req.method === 'POST' && req.url === '/app/installations/88/access_tokens') {
        calls.token++;
        if (refuseNextToken) { refuseNextToken = false; res.writeHead(404); return res.end('{}'); }
        // rev's keys expire inside the five-minute reuse margin, so each request after a mint mints again.
        const life = lifeFor(req);
        res.writeHead(201);
        return res.end(JSON.stringify({ token: `ghs_fake_${calls.token}`, expires_at: new Date(Date.now() + life).toISOString() }));
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
    mkdirSync(join(dir, 'github-apps'), { recursive: true });
    for (const [agent, appId] of [['rev', '501'], ['chuck', '502']]) {
      const n = githubAppSecretNames(agent);
      stored.set(n.id, appId);
      stored.set(n.privateKey, PEM);
      writeFileSync(join(dir, 'github-apps', `${agent}.json`), JSON.stringify({ orgs: ['sandbox-org'] }));
    }
    state = {
      registryDir: dir,
      agents: new Map(['rev', 'chuck'].map((id) => [id, { id, name: id, state: 'IDLE', roles: [], requires: [] } as any])),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] }]),
      version: '0.1.0',
      providers: [{ name: 'slow', async get(n: string) { reads.push({ name: n, at: Date.now() }); await sleep(readDelayMs); return stored.get(n); } }],
      secretValues: new Set(),
      runs: new MemoryRunStore(),
      callbacks: { signingKey: 'github-app-latency-signing-key-0123456789', allowInsecure: true, attempts: 1, backoffMs: 0 },
      githubApiBase: `http://127.0.0.1:${(gh.address() as any).port}`,
      githubWebBase: 'https://github.example',
    } as unknown as FactoryState;
    for (const a of ['rev', 'chuck']) runs[a] = state.runs.create({ agentId: a, state: 'WORKING', actor: 'test', trigger: 'api' } as any).runId;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as any).port;
  });
  after(() => { console.log = origLog; console.error = origErr; cp.close(); gh.close(); rmSync(dir, { recursive: true, force: true }); });

  // The app JWT's issuer says which app asks: rev (501) gets short-lived keys, chuck (502) an hour.
  function lifeFor(req: http.IncomingMessage): number {
    const claims = JSON.parse(Buffer.from(String(req.headers.authorization).split('.')[1], 'base64url').toString()) as { iss: string };
    return claims.iss === '501' ? 4 * 60_000 : 3600_000;
  }
  const token = async (agentId: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/gatekeeper-egress/github-app/token`, { method: 'POST', headers: { authorization: `Bearer ${EGRESS}`, 'content-type': 'application/json' }, body: JSON.stringify({ runId: runs[agentId], agentId, org: 'sandbox-org' }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const readsOf = (agentId: string) => reads.filter((r) => r.name.startsWith(`GITHUB_APP_${agentId.toUpperCase()}_`));

  it('concurrent requests share one mint; the two app secrets are read once, together', async () => {
    readDelayMs = 200;
    const out = await Promise.all([token('rev'), token('rev'), token('rev')]);
    assert.deepEqual(out.map((o) => o.status), [200, 200, 200]);
    assert.equal(new Set(out.map((o) => o.body.accessToken)).size, 1);
    assert.equal(calls.token, 1);
    const r = readsOf('rev');
    assert.equal(r.length, 2, 'ID and PRIVATE_KEY once each');
    assert.ok(Math.abs(r[0].at - r[1].at) < 100, 'read in parallel, not one after the other');
    assert.ok(logs.some((l) => /^\[github-app\] token rev\/sandbox-org: minted in \d+ ms \(secrets \d+ ms, installation \d+ ms, token \d+ ms\)$/.test(l)), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('ghs_fake') && !logs.join('\n').includes('PRIVATE KEY'), 'no key in any log line');
  });

  it('a re-mint reuses the cached app secrets and installation id: one GitHub call, no secret read', async () => {
    const r = await token('rev');
    assert.equal(r.status, 200);
    assert.equal(calls.token, 2);
    assert.equal(calls.installation, 1);
    assert.equal(readsOf('rev').length, 2);
    assert.ok(logs.some((l) => /token rev\/sandbox-org: minted in \d+ ms \(secrets \d+ ms, installation cached \d+ ms, token \d+ ms\)/.test(l)));
  });

  it('a refused key drops the cached installation id; the next mint looks it up again', async () => {
    refuseNextToken = true;
    assert.equal((await token('rev')).body.error, 'github_unavailable');
    assert.ok(logs.some((l) => l.startsWith('[github-app] token rev/sandbox-org: github_unavailable in ')));
    assert.equal((await token('rev')).status, 200);
    assert.equal(calls.installation, 2);
  });

  it('a mint slower than the route deadline answers 504 in time, then finishes into the cache for the next request', async () => {
    state.githubAppTokenDeadlineMs = 100;
    readDelayMs = 400;
    const t0 = Date.now();
    const first = await token('chuck');
    assert.equal(first.status, 504);
    assert.equal(first.body.error, 'github_app_token_slow');
    assert.ok(Date.now() - t0 < 350, 'answered by the deadline, not after the slow reads');
    assert.ok(logs.some((l) => l.includes('token chuck/sandbox-org: not ready after 100 ms')));
    await sleep(600);
    const before = calls.token;
    const second = await token('chuck');
    assert.equal(second.status, 200);
    assert.match(second.body.accessToken, /^ghs_fake_/);
    assert.equal(calls.token, before, 'served from the cache the slow mint filled');
    delete state.githubAppTokenDeadlineMs;
    readDelayMs = 0;
  });

  // #501 / PR #502: a secret read in flight when its secret is replaced must not put the old value back in the cache.
  // Each case uses its own secret names and removes them, the cache entries it made, and the values it added.
  // A provider that returns the value as it was when the read started, so a change made while the read is in flight
  // is what the invalidation exists for. The state's own provider reads `stored` only after its delay.
  const snapshotProvider = { name: 'snapshot', async get(n: string) { reads.push({ name: n, at: Date.now() }); const v = stored.get(n); await sleep(readDelayMs); return v; } };
  const useSnapshotProvider = () => {
    const saved = state.providers;
    state.providers = [snapshotProvider] as typeof saved;
    return () => { state.providers = saved; };
  };
  const cleanupSecrets = (names: string[], values: string[]) => {
    for (const n of names) { stored.delete(n); invalidateSecret(state, n); }
    for (const v of values) state.secretValues.delete(v);
    readDelayMs = 0;
  };

  it('AC1: a read in flight at invalidation returns the old value; the next read does a fresh provider read', async () => {
    const A = 'LATENCY_TEST_RACE_A';
    stored.set(A, 'old-value-a');
    const restore = useSnapshotProvider();
    try {
      readDelayMs = 200;
      const inFlight = readSecretCached(state, A);
      await sleep(20);
      stored.set(A, 'new-value-a');
      invalidateSecret(state, A);
      assert.equal(await inFlight, 'old-value-a', 'the in-flight caller still gets the value it read');
      readDelayMs = 0;
      assert.equal(await readSecretCached(state, A), 'new-value-a');
      assert.equal(reads.filter((r) => r.name === A).length, 2, 'the next read went to the provider');
    } finally {
      restore();
      cleanupSecrets([A], ['old-value-a', 'new-value-a']);
    }
  });

  it('AC2: invalidating A during a read of A and B leaves B cached; A is re-read', async () => {
    const A = 'LATENCY_TEST_RACE_2A';
    const B = 'LATENCY_TEST_RACE_2B';
    stored.set(A, 'old-value-2a');
    stored.set(B, 'value-2b');
    const restore = useSnapshotProvider();
    try {
      readDelayMs = 200;
      const readA = readSecretCached(state, A);
      const readB = readSecretCached(state, B);
      await sleep(20);
      stored.set(A, 'new-value-2a');
      invalidateSecret(state, A);
      assert.equal(await readA, 'old-value-2a');
      assert.equal(await readB, 'value-2b');
      readDelayMs = 0;
      assert.equal(await readSecretCached(state, A), 'new-value-2a', 'the next read of A is the new value');
      const bReads = reads.filter((r) => r.name === B).length;
      assert.equal(await readSecretCached(state, B), 'value-2b');
      assert.equal(reads.filter((r) => r.name === B).length, bReads, 'the next read of B does no provider read');
    } finally {
      restore();
      cleanupSecrets([A, B], ['old-value-2a', 'new-value-2a', 'value-2b']);
    }
  });

  it('AC3: an old read settling after invalidation does not remove a newer read from the in-flight map', async () => {
    const C = 'LATENCY_TEST_RACE_C';
    stored.set(C, 'old-value-c');
    const restore = useSnapshotProvider();
    try {
      readDelayMs = 200;
      const oldRead = readSecretCached(state, C);
      stored.set(C, 'new-value-c');
      invalidateSecret(state, C);
      readDelayMs = 300;
      const newRead = readSecretCached(state, C);
      assert.equal(await oldRead, 'old-value-c');
      // The old read has settled (its finally has run); the new read is still in flight and must be shared.
      const sharer = readSecretCached(state, C);
      assert.equal(await newRead, 'new-value-c');
      assert.equal(await sharer, 'new-value-c');
      assert.equal(reads.filter((r) => r.name === C).length, 2, 'two concurrent post-invalidation reads share one provider read');
    } finally {
      restore();
      cleanupSecrets([C], ['old-value-c', 'new-value-c']);
    }
  });
});
