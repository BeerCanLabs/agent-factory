// TSK-106 (GAP-088, E9): the requesting user is recorded on the run, only from a caller allowed to say who asked (the
// Gatekeeper's ingress). A body `input.authorId` is whatever the caller wrote and is never an identity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { FileConfigBackend, VersionedConfigStore } from './config-store.js';

const ADMIN = 'admin-requester';
const OPERATOR = 'operator-requester';
const ALICE = 'alice-requester'; // viewer; owns ada, so may wake it, but may not say who asked
const SHA = '1'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const passed = (status: number) => status !== 401 && status !== 403;

describe('the requesting user on the run (TSK-106)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-requester-'));
    const state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'alice', token: ALICE, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('requester-e2e-run-token-key-0123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    cp = createFactoryServer(state);
    const port = await listen(cp);
    api = async (path, method = 'GET', token, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-ada', commit: SHA, cartridge: { id: 'ada', name: 'ada' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await api('/api/v1/agents/ada/owners', 'PUT', ADMIN, { owners: ['token:alice'] })).status, 200);
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const wake = (token: string, body: unknown) => api('/api/v1/agents/ada/wake', 'POST', token, body);
  const discord = (id: string) => ({ provider: 'discord', id });

  it('an operator (the ingress) names the requester and the run records it', async () => {
    const r = await wake(OPERATOR, { input: { messageId: 'm1', content: 'hi', authorId: '42' }, requestedBy: discord('42') });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(r.body.requestedBy, discord('42'));
    const got = await api(`/api/v1/runs/${r.body.runId}`, 'GET', ADMIN);
    assert.deepEqual(got.body.requestedBy, discord('42'));
  });

  it('an admin may name the requester too', async () => {
    const r = await wake(ADMIN, { input: { messageId: 'm-admin' }, requestedBy: discord('7') });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body.requestedBy, discord('7'));
  });

  it('a caller who may wake but not say who asked gets 403 only when it sends requestedBy', async () => {
    const refused = await wake(ALICE, { input: { messageId: 'm2' }, requestedBy: discord('42') });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.required, 'operator');
    const plain = await wake(ALICE, { input: { messageId: 'm3' } });
    assert.ok(plain.status !== 401 && plain.status !== 403, `plain wake: ${plain.status}`);
    assert.equal('requestedBy' in plain.body, false);
  });

  it('no requestedBy records none, and input.authorId alone is not an identity', async () => {
    const r = await wake(OPERATOR, { input: { messageId: 'm4', authorId: '42' } });
    assert.equal(r.status, 202);
    assert.equal('requestedBy' in r.body, false);
  });

  it('a replayed message returns the first run and keeps its first requester', async () => {
    const first = await wake(OPERATOR, { input: { messageId: 'm5' }, requestedBy: discord('1') });
    assert.equal(first.status, 202);
    const replay = await wake(OPERATOR, { input: { messageId: 'm5' }, requestedBy: discord('2') });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.runId, first.body.runId);
    assert.deepEqual(replay.body.requestedBy, discord('1'));
  });

  it('a malformed requestedBy is a 400', async () => {
    for (const bad of ['42', [], {}, { provider: 'discord' }, { provider: 'discord', id: '' }, { provider: 'discord', id: 7 }, { provider: 'd'.repeat(129), id: '1' }, null]) {
      const r = await wake(OPERATOR, { input: { messageId: 'bad' }, requestedBy: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
});
