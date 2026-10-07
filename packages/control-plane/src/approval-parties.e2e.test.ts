// TSK-108 (GAP-088, E9, E4): who decides what an agent did. The requesting user of the run decides; when the run has no
// requesting user, any owner of the agent; the global admin and approver roles keep deciding any agent's (Dale,
// 2026-10-03). A requester whose Discord id is not linked to a person lets no owner decide. The agent, which holds
// only a run token, never decides.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { IdentityLinkStore } from './identity-links.js';
import { VersionedConfigStore, type ConfigBackend, type ConfigRecord } from '@beercanlabs/factory-registrar';

const T = (n: string) => `${n}-approval-parties`;
const ALICE = T('alice'); // viewer; linked to Discord 42: the requester
const OWNER = T('owner'); // viewer; owns ada
const DAVE = T('dave'); // viewer; nothing to do with ada
const APPROVER = T('approver');
const ADMIN = T('admin');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const memoryBackend = (): ConfigBackend => {
  const records: ConfigRecord[] = [];
  return {
    description: 'memory',
    async loadAll() {
      return records;
    },
    async write(r) {
      records.push(r);
    },
    async remove() {},
  };
};

describe('who decides what an agent did (TSK-108)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  let runTokens: RunTokens;

  const call = (path: string, method = 'GET', token?: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    });
  const decide = (id: string, token?: string, decision = 'approve') => call(`/api/v1/approvals/${id}`, 'POST', token, { decision });

  /** A live run of ada, with the requesting user if given, and one pending approval of the kind asked for. */
  function pending(kind: 'held' | 'tool', requestedBy?: { provider: string; id: string }, agentId = 'ada') {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'token:operator', trigger: 'manual', ...(requestedBy ? { requestedBy } : {}) });
    const argsSha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const base = { runId: run.runId, agentId, route: 'linkedin', tool: 'POST /posts', argsSha256 };
    const { approval } = kind === 'held'
      ? state.approvals.hold({ ...base, request: { method: 'POST', path: '/posts', headers: {}, body: '{}', bodyEncoding: 'utf8' } })
      : state.approvals.request(base);
    return approval.approvalId;
  }

  before(async () => {
    runTokens = new RunTokens('approval-parties-run-token-key-0123456789');
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'alice', token: ALICE, roles: ['viewer'] },
        { name: 'owner', token: OWNER, roles: ['viewer'] },
        { name: 'dave', token: DAVE, roles: ['viewer'] },
        { name: 'approver', token: APPROVER, roles: ['approver'] },
        { name: 'admin', token: ADMIN, roles: ['admin'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      identityLinks: new IdentityLinkStore(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.agents.set('ada', { id: 'ada', name: 'Ada', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/ada' } as never);
    state.configs = await VersionedConfigStore.open(memoryBackend());
    await state.configs.put({ agentId: 'ada', source: {}, skills: [], policy: null, owners: ['token:owner'] }, { updatedBy: 'test', reason: 'owners' });
    state.identityLinks!.link('discord', '42', 'token:alice', 'test');
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
  });

  for (const kind of ['held', 'tool'] as const) {
    describe(`a ${kind === 'held' ? 'held request' : 'tool-call approval'}`, () => {
      it('the linked requesting user decides it', async () => {
        const id = pending(kind, { provider: 'discord', id: '42' });
        const r = await decide(id, ALICE);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.state, 'approved');
        assert.equal(r.body.decidedBy, 'token:alice');
      });

      it('an unrelated viewer is refused, and so is an owner when the run has a requester', async () => {
        const id = pending(kind, { provider: 'discord', id: '42' });
        for (const token of [DAVE, OWNER]) {
          const r = await decide(id, token);
          assert.equal(r.status, 403);
          assert.equal(r.body.required, 'approver');
        }
        assert.equal(state.approvals.get(id)?.state, 'pending');
      });

      it('an owner decides when the run has no requesting user, and an unrelated viewer does not', async () => {
        const id = pending(kind);
        assert.equal((await decide(id, DAVE)).status, 403);
        const r = await decide(id, OWNER, 'reject');
        assert.equal(r.status, 200);
        assert.equal(r.body.state, 'rejected');
      });

      it('a requester who is not linked to anyone lets no owner decide; an admin still can', async () => {
        const id = pending(kind, { provider: 'discord', id: '99' });
        assert.equal((await decide(id, OWNER)).status, 403);
        assert.equal((await decide(id, DAVE)).status, 403);
        assert.equal((await decide(id, ADMIN)).status, 200);
      });

      it('the global approver and admin still decide any agent', async () => {
        assert.equal((await decide(pending(kind, { provider: 'discord', id: '42' }), APPROVER)).status, 200);
        assert.equal((await decide(pending(kind), ADMIN)).status, 200);
      });

      it('a second decision is 409 for the caller who may decide', async () => {
        const id = pending(kind, { provider: 'discord', id: '42' });
        assert.equal((await decide(id, ALICE)).status, 200);
        assert.equal((await decide(id, ALICE)).status, 409);
        assert.equal((await decide(id, DAVE)).status, 403);
      });
    });
  }

  it('the owner of one agent has no say over another agent that has no requester', async () => {
    state.agents.set('bea', { ...state.agents.get('ada')!, id: 'bea', name: 'Bea' });
    const id = pending('held', undefined, 'bea');
    assert.equal((await decide(id, OWNER)).status, 403);
  });

  it('a run that is gone lets no owner decide, because nobody can say who asked; an approver still can', async () => {
    const run = state.runs.create({ agentId: 'ada', state: 'DONE', actor: 'token:operator', trigger: 'manual' });
    const { approval } = state.approvals.request({ runId: `${run.runId}-gone`, agentId: 'ada', route: 'r', tool: 't', argsSha256: 'a'.repeat(64) });
    assert.equal((await decide(approval.approvalId, OWNER)).status, 403);
    assert.equal((await decide(approval.approvalId, APPROVER)).status, 200);
  });

  it('an unknown id is 409 for a caller who may decide and 403 for one who may not', async () => {
    assert.equal((await decide('nope', APPROVER)).status, 409);
    assert.equal((await decide('nope', ADMIN)).status, 409);
    assert.equal((await decide('nope', DAVE)).status, 403);
    assert.equal((await decide('nope', OWNER)).status, 403);
  });

  it('the agent, which holds only a run token, cannot decide (401)', async () => {
    const run = state.runs.create({ agentId: 'ada', state: 'WORKING', actor: 'token:operator', trigger: 'manual' });
    const id = pending('held');
    assert.equal((await decide(id, await runTokens.mint({ runId: run.runId, agentId: 'ada' }))).status, 401);
    assert.equal((await decide(id, undefined)).status, 401);
  });

  it('the MCP tool decides as the REST route does for a global approver, and still asks the role for the others', async () => {
    const mcp = (token: string, approvalId: string) =>
      call('/mcp', 'POST', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId, decision: 'approve' } } });
    const ok = await mcp(APPROVER, pending('held'));
    assert.equal(ok.body.error, undefined);
    assert.equal(JSON.parse(ok.body.result.content[0].text).state, 'approved');
    const refused = await mcp(ALICE, pending('held', { provider: 'discord', id: '42' }));
    assert.equal(refused.body.error.code, -32001);
  });

  it('a decision for a bad body is still a 400 for a caller who may decide, after the authorization', async () => {
    const id = pending('held');
    assert.equal((await call(`/api/v1/approvals/${id}`, 'POST', ADMIN, { decision: 'maybe' })).status, 400);
    assert.equal((await call(`/api/v1/approvals/${id}`, 'POST', DAVE, { decision: 'maybe' })).status, 403);
  });
});
