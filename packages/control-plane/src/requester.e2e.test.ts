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
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { IdentityLinkStore } from './identity-links.js';

const ADMIN = 'admin-requester';
const OPERATOR = 'operator-requester';
const INGRESS = 'ingress-requester'; // the Gatekeeper's ingress: operator, to wake agents, plus the one role that may say who asked
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
  let state: FactoryState;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-requester-'));
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'operator', token: OPERATOR, roles: ['operator'] },
        { name: 'gatekeeper-ingress', token: INGRESS, roles: ['operator', 'gatekeeper-ingress'] },
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

  it('the ingress names the requester and the run records it', async () => {
    const r = await wake(INGRESS, { input: { messageId: 'm1', content: 'hi', authorId: '42' }, requestedBy: discord('42') });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(r.body.requestedBy, discord('42'));
    const got = await api(`/api/v1/runs/${r.body.runId}`, 'GET', ADMIN);
    assert.deepEqual(got.body.requestedBy, discord('42'));
  });

  it('an operator or an admin may not name the requester, so no one can approve their own request by claiming to be someone', async () => {
    for (const token of [OPERATOR, ADMIN]) {
      const r = await wake(token, { input: { messageId: `m-${token}` }, requestedBy: discord('7') });
      assert.equal(r.status, 403, token);
      assert.equal(r.body.required, 'gatekeeper-ingress');
    }
    const plain = await wake(OPERATOR, { input: { messageId: 'm-operator-plain' } });
    assert.equal(plain.status, 202, 'an operator can still wake an agent without naming a requester');
  });

  it('a caller who may wake but not say who asked gets 403 only when it sends requestedBy', async () => {
    const refused = await wake(ALICE, { input: { messageId: 'm2' }, requestedBy: discord('42') });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.required, 'gatekeeper-ingress');
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
    const first = await wake(INGRESS, { input: { messageId: 'm5' }, requestedBy: discord('1') });
    assert.equal(first.status, 202);
    const replay = await wake(INGRESS, { input: { messageId: 'm5' }, requestedBy: discord('2') });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.runId, first.body.runId);
    assert.deepEqual(replay.body.requestedBy, discord('1'));
  });

  it('a malformed requestedBy is a 400', async () => {
    for (const bad of ['42', [], {}, { provider: 'discord' }, { provider: 'discord', id: '' }, { provider: 'discord', id: 7 }, { provider: 'd'.repeat(129), id: '1' }, null]) {
      const r = await wake(INGRESS, { input: { messageId: 'bad' }, requestedBy: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  it('rejects unmapped callers when identityLinks is configured (Bouncer identity gate)', async () => {
    state.identityLinks = new IdentityLinkStore(join(dir, 'links'));
    try {
      const r = await wake(INGRESS, { input: { messageId: 'm-unmapped' }, requestedBy: discord('unmapped-user') });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'unauthorized_caller');
      assert.equal(r.body.reason, 'unmapped external identity: discord:unmapped-user');
    } finally {
      state.identityLinks = undefined;
    }
  });

  it('authorizes mapped admin and owner callers and injects caller metadata into run and input', async () => {
    state.identityLinks = new IdentityLinkStore(join(dir, 'links'));
    try {
      state.identityLinks.link('discord', '470400107028938752', 'cloudflare:dale.sackrider@gmail.com', 'admin', {
        name: 'Dale',
        roles: ['admin'],
      });
      const r = await wake(INGRESS, { input: { messageId: 'm-dale', content: 'hello agent' }, requestedBy: discord('470400107028938752') });
      assert.equal(r.status, 202);
      const expectedCaller = {
        actor: 'cloudflare:dale.sackrider@gmail.com',
        name: 'Dale',
        role: 'admin',
        roles: ['admin'],
        provider: 'discord',
        id: '470400107028938752',
      };
      assert.deepEqual(r.body.caller, expectedCaller);
      const run = state.runs.get(r.body.runId);
      assert.ok(run);
      assert.deepEqual(run.caller, expectedCaller);
      assert.deepEqual((run.input as any).caller, expectedCaller);

      // Mapped agent owner: Alice owns 'ada'
      state.identityLinks.link('discord', 'alice-discord-id', 'token:alice', 'admin', { name: 'Alice' });
      const rAlice = await wake(INGRESS, { input: { messageId: 'm-alice' }, requestedBy: discord('alice-discord-id') });
      assert.equal(rAlice.status, 202);
      assert.equal(rAlice.body.caller.role, 'agent-owner');

      // Mapped non-owner viewer: insufficient privileges
      state.identityLinks.link('discord', 'bob-discord-id', 'token:bob', 'admin', { name: 'Bob', roles: ['viewer'] });
      const rBob = await wake(INGRESS, { input: { messageId: 'm-bob' }, requestedBy: discord('bob-discord-id') });
      assert.equal(rBob.status, 403);
      assert.equal(rBob.body.error, 'unauthorized_caller');
    } finally {
      state.identityLinks = undefined;
    }
  });
});
