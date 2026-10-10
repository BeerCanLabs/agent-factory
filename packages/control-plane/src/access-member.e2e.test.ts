// TSK-171 (DESIGN_AUTHORITY.md E12, GAP-127): a person who holds only an agent role reaches that agent, and no other.
// Stephanie and Aiden are in `Family` on Donna and hold no factory role; Dale owns Donna. The Gatekeeper's ingress
// names who asked; the Bouncer decides at the perimeter whether the message is delivered at all.
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
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { IdentityLinkStore } from './identity-links.js';

const ADMIN = 'admin-access-member';
const INGRESS = 'ingress-access-member'; // the Gatekeeper's ingress: operator, plus the one role that may say who asked
const SHA = '2'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const discord = (id: string) => ({ provider: 'discord', id });

describe('a person who holds only an agent role reaches that agent and no other (E12, TSK-171)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;

  const wake = (agent: string, who: { provider: string; id: string }, content = 'hi') =>
    api(`/api/v1/agents/${agent}/wake`, 'POST', INGRESS, { input: { messageId: `m-${Math.random()}`, content }, requestedBy: who });
  const converse = (agent: string, who: { provider: string; id: string }) =>
    api(`/api/v1/agents/${agent}/conversation`, 'POST', INGRESS, { input: { content: 'and one more thing' }, requestedBy: who });
  const refusals = (action: string, agentId: string) => ledger.query().filter((e) => e.action === action && e.agentId === agentId);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-access-member-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gatekeeper-ingress', token: INGRESS, roles: ['operator', 'gatekeeper-ingress'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('access-member-run-token-key-0123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
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
    for (const id of ['donna', 'higgins']) {
      const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, cartridge: { id, name: id } });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      assert.equal((await api(`/api/v1/agents/${id}/owners`, 'PUT', ADMIN, { owners: ['cloudflare:dale@example.com'] })).status, 200);
    }
    const links = state.identityLinks!;
    // Stephanie and Aiden: Family on Donna, and no factory role at all.
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', agentRoles: { donna: ['Family'] } });
    links.link('discord', '202', 'cloudflare:aiden@example.com', 'admin', { name: 'Aiden', agentRoles: { donna: ['Family'] } });
    // A cousin: a role on Higgins only. A mapped person with no role anywhere. A role list that is empty.
    links.link('discord', '203', 'cloudflare:cousin@example.com', 'admin', { name: 'Cousin', agentRoles: { higgins: ['Realtor'] } });
    links.link('discord', '204', 'cloudflare:friend@example.com', 'admin', { name: 'Friend' });
    links.link('discord', '205', 'cloudflare:former@example.com', 'admin', { name: 'Former', agentRoles: { donna: [] } });
    // Dale: owner of both, with no factory role either, so only ownership admits him.
    links.link('discord', '200', 'cloudflare:dale@example.com', 'admin', { name: 'Dale' });
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers Stephanie’s and Aiden’s messages to Donna, naming them and their role, and holding no factory role', async () => {
    for (const [id, name] of [['201', 'Stephanie'], ['202', 'Aiden']] as const) {
      const r = await wake('donna', discord(id), `hello from ${name}`);
      assert.equal(r.status, 202, `${name}: ${JSON.stringify(r.body)}`);
      const run = state.runs.get(r.body.runId)!;
      assert.deepEqual(run.requestedBy, discord(id), 'the run records who asked');
      const caller = (run.input as { caller: Record<string, unknown> }).caller;
      assert.equal(caller.name, name);
      assert.equal(caller.role, 'agent-member');
      assert.deepEqual(caller.roles, [], 'the badge never claims a factory role she does not hold');
      assert.deepEqual(caller.agentRoles, ['Family']);
      assert.equal(caller.isOwner, false);
    }
  });

  it('lets her keep the conversation going on Donna, too', async () => {
    const r = await converse('donna', discord('201'));
    assert.notEqual(r.status, 403, JSON.stringify(r.body));
    assert.notEqual(r.status, 401);
    assert.equal(refusals('CONVERSATION_REFUSED_UNAUTHORIZED_CALLER', 'donna').length, 0);
  });

  it('does not deliver her message to Higgins, where she holds no role', async () => {
    const before = state.runs.list({ agentId: 'higgins' }).length;
    const r = await wake('higgins', discord('201'));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, 'unauthorized_caller');
    assert.match(r.body.reason, /does not hold agents\.wake on agent 'higgins'/);
    assert.equal(state.runs.list({ agentId: 'higgins' }).length, before, 'no run was started');
    assert.equal(refusals('WAKE_REFUSED_UNAUTHORIZED_CALLER', 'higgins').length, 1, 'the refusal is ledgered');
    assert.equal((await converse('higgins', discord('201'))).status, 403);
    assert.equal(refusals('CONVERSATION_REFUSED_UNAUTHORIZED_CALLER', 'higgins').length, 1);
  });

  it('does not deliver a stranger’s message, or a mapped person’s who holds no role there, or an empty role list', async () => {
    const before = state.runs.list({ agentId: 'donna' }).length;
    for (const [id, why] of [['999', 'a stranger no one linked'], ['203', 'a role on Higgins only'], ['204', 'mapped, no role anywhere'], ['205', 'an empty role list']] as const) {
      const r = await wake('donna', discord(id));
      assert.equal(r.status, 403, `${why}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'unauthorized_caller', why);
    }
    assert.equal(state.runs.list({ agentId: 'donna' }).length, before, 'none of them started a run');
    assert.equal(refusals('WAKE_REFUSED_UNAUTHORIZED_CALLER', 'donna').length, 4);
  });

  it('still admits the owner by ownership, with no role assigned', async () => {
    const r = await wake('donna', discord('200'));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const caller = (state.runs.get(r.body.runId)!.input as { caller: Record<string, unknown> }).caller;
    assert.equal(caller.isOwner, true);
    assert.deepEqual(caller.agentRoles, ['Owner']);
  });

  it('a role is the only thing that changes: removing it removes her access to the next message', async () => {
    const links = state.identityLinks!;
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', agentRoles: { donna: [] } });
    assert.equal((await wake('donna', discord('201'))).status, 403);
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', agentRoles: { donna: ['Family'] } });
    assert.equal((await wake('donna', discord('201'))).status, 202);
  });

  it('the ingress alone, without naming anyone, is still refused (fail closed)', async () => {
    const r = await api('/api/v1/agents/donna/wake', 'POST', INGRESS, { input: { content: 'who am I' } });
    assert.equal(r.status, 403);
  });
});
