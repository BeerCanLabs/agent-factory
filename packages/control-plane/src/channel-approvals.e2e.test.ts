// TSK-267 (DESIGN_AUTHORITY.md CF4, E9): the factory asks in the channel a person is on, and a reply from the right person,
// in that channel, decides it once; the agent never carries it. Real control plane; the ingress is a token that holds its role.
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
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { accessForRun } from './access-enforcement.js';
import { agentInForce } from './agent-settings.js';

const ADMIN = 'admin-settings';
const OWNER = 'owner-settings';
const OTHER = 'other-owner-settings';
const VIEWER = 'viewer-settings';
const CASED = 'cased-settings';
const APPROVER = 'approver-settings';
const INGRESS = 'ingress-settings';
const SHA = '5'.repeat(40);
const KEY = 'settings-run-token-key-0123456789abc';

describe('CF4 approvals are asked and answered in the channel (TSK-267)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let port = 0;
  const tokens = new RunTokens(KEY);
  const call = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const cartridge = (id: string) => ({
    id,
    name: id,
    memory: { archetype: 'personal-assistant' },
    skills: [{ id: 'google-calendar', routes: ['google-calendar'] }],
    roles: { Owner: { skills: { '*': { allow: ['*'] } } }, Family: { skills: { 'google-calendar': { allow: ['*'] } } } },
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-settings-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'owner-svc', token: OWNER, roles: [] },
        { name: 'other-svc', token: OTHER, roles: [] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
        { name: 'Cased-Svc', token: CASED, roles: [] },
        { name: 'approver', token: APPROVER, roles: ['approver', 'viewer'] },
        { name: 'ingress', token: INGRESS, roles: ['operator', 'gatekeeper-ingress'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
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
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    for (const id of ['mine', 'theirs']) {
      const reg = await call('POST', '/api/v1/registry/agents', { repo: `https://github.com/beercanlabs/SM-${id}`, commit: SHA, cartridge: cartridge(id) });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
    }
    assert.equal((await call('PUT', '/api/v1/agents/mine/owners', { owners: ['token:owner-svc'] })).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/theirs/owners', { owners: ['token:other-svc'] })).status, 200);
    const links = state.identityLinks!;
    links.link('discord', '100', 'token:owner-svc', 'admin', { name: 'Dale' });
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', roles: ['viewer'], agentRoles: { theirs: ['Family'] } });
    links.link('discord', '300', 'cloudflare:stranger@example.com', 'admin', { name: 'Stranger' });
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const runFor = async (requestedBy?: { provider: string; id: string }, agentId = 'mine') => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'factory:ingress', trigger: 'api', ...(requestedBy ? { requestedBy } : {}) } as never);
    return { run, token: await tokens.mint({ runId: run.runId, agentId }) };
  };
  const hold = (runId: string, agentId = 'mine', path = '/v2/posts') =>
    state.approvals.hold({
      runId,
      agentId,
      route: 'linkedin',
      tool: 'http',
      argsSha256: `h${Math.random()}`,
      request: { method: 'POST', path, headers: {}, body: '{"text":"hello `@everyone` <@1>"}', bodyEncoding: 'utf8' },
    }).approval;
  const prompts = async (agentId = 'mine', token = INGRESS) => call('POST', '/api/v1/ingress/approval-prompts', { agentId }, token);
  const asked = (id: string, channelId = 'chan-1', token = INGRESS) => call('POST', `/api/v1/ingress/approvals/${id}/asked`, { provider: 'discord', channelId }, token);
  const reply = (code: string, decision: string, identity: string, channelId = 'chan-1', token = INGRESS, agentId = 'mine') =>
    call('POST', '/api/v1/ingress/approvals/decision', { agentId, code, decision, provider: 'discord', identity, channelId }, token);
  const actions = (name: string) => ledger.query().filter((e) => (e as { action?: string }).action === name);
  const askFor = async (approval: { approvalId: string }, channel = 'chan-1') => {
    const p = (await prompts()).body.prompts.find((x: { approvalId: string }) => x.approvalId === approval.approvalId);
    assert.ok(p, 'a prompt for the approval');
    assert.equal((await asked(approval.approvalId, channel)).status, 200);
    return p as { approvalId: string; code: string; deciders: string[]; text: string };
  };

  it('only the ingress may ask, post or take a reply: no admin, operator, owner, run token or anonymous caller', async () => {
    const { run, token: runToken } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    for (const token of [ADMIN, OWNER, APPROVER, VIEWER, runToken]) {
      assert.equal((await prompts('mine', token)).status, token === runToken ? 401 : 403, token);
      assert.equal((await asked(a.approvalId, 'chan-1', token)).status, token === runToken ? 401 : 403, token);
      assert.equal((await reply('ABCDEF', 'approve', '100', 'chan-1', token)).status, token === runToken ? 401 : 403, token);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/ingress/approval-prompts`, { method: 'POST', body: '{}' })).status, 401);
  });

  it('asks a held action of its requester only, rendered from the factory’s copy, with nothing that pings', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = (await prompts()).body.prompts.find((x: { approvalId: string }) => x.approvalId === a.approvalId);
    assert.deepEqual(p.deciders, ['100'], 'the requester, who is linked; an owner never decides what is done in another person’s name');
    assert.match(p.text, /POST \/v2\/posts/);
    assert.match(p.text, /route `linkedin`/);
    assert.ok(!p.text.split('```')[1].includes('`'), 'the body cannot close its own fence');
    assert.ok(!/[@<>]/.test(p.text), 'nothing in it can ping');
    assert.match(p.text, new RegExp(`approve ${p.code}`));
    // Idempotent: the same code until it is asked, and nothing once it was.
    assert.equal((await prompts()).body.prompts.find((x: { approvalId: string }) => x.approvalId === a.approvalId).code, p.code);
    assert.equal((await asked(a.approvalId)).status, 200);
    assert.equal((await prompts()).body.prompts.some((x: { approvalId: string }) => x.approvalId === a.approvalId), false);
    assert.equal(actions('APPROVAL_ASKED_IN_CHANNEL').length >= 1, true);
    state.approvals.decide(a.approvalId, 'rejected', 'test');
  });

  it('does not ask when no one who could decide is known: an unlinked requester, a run that is gone', async () => {
    const stranger = await runFor({ provider: 'discord', id: '555' });
    const a = hold(stranger.run.runId);
    assert.equal((await prompts()).body.prompts.some((x: { approvalId: string }) => x.approvalId === a.approvalId), false);
    assert.equal((await asked(a.approvalId)).status, 404, 'no code was ever issued for it');
    state.approvals.decide(a.approvalId, 'rejected', 'test');
  });

  it('a reply decides it once, from the person it was asked of, in the channel it was asked in', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = await askFor(a);
    const code = p.code;
    // Not the person, not linked, not that channel, not a code: nothing is decided.
    assert.equal((await reply(code, 'approve', '300')).status, 403, 'another person');
    assert.equal((await reply(code, 'approve', '300')).body.error, 'not_permitted');
    assert.equal((await reply(code, 'approve', '777')).body.error, 'not_linked');
    assert.equal((await reply(code, 'approve', '100', 'chan-2')).status, 404, 'a different channel');
    assert.equal((await reply('ZZZZZZ', 'approve', '100')).status, 404, 'no such code');
    assert.equal((await reply(code, 'maybe', '100')).status, 400);
    assert.equal(state.approvals.get(a.approvalId)!.state, 'pending');
    assert.equal(actions('APPROVAL_GRANTED').filter((e) => e.approvalId === a.approvalId).length, 0);
    assert.ok(actions('APPROVAL_CHANNEL_REFUSED:not_permitted').some((e) => e.approvalId === a.approvalId && e.actor === 'cloudflare:stranger@example.com'));
    // The right person, with the code in any case.
    const ok = await reply(code.toLowerCase(), 'approve', '100');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const row = actions('APPROVAL_GRANTED').find((e) => e.approvalId === a.approvalId)!;
    assert.equal(row.actor, 'token:owner-svc');
    assert.equal((row as { requestId?: string }).requestId, 'discord:chan-1', 'the channel is in the row that allows it');
    assert.equal(state.approvals.get(a.approvalId)!.state, 'approved');
    // Once: the code is spent.
    assert.equal((await reply(code, 'reject', '100')).status, 404);
    assert.equal(state.approvals.get(a.approvalId)!.state, 'approved');
  });

  it('a person can reject by reply', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = await askFor(a);
    assert.equal((await reply(p.code, 'reject', '100')).status, 200);
    assert.equal(state.approvals.get(a.approvalId)!.state, 'rejected');
    assert.ok(actions('APPROVAL_REJECTED').some((e) => e.approvalId === a.approvalId));
  });

  it('an owner decides what a run with no requesting user held, and not what another person asked for', async () => {
    const queued = await runFor(undefined);
    const mine = hold(queued.run.runId);
    const p = await askFor(mine);
    assert.deepEqual(p.deciders, ['100'], 'the owner, as no one asked');
    assert.equal((await reply(p.code, 'approve', '100')).status, 200);
    const stephanie = await runFor({ provider: 'discord', id: '201' });
    const hers = hold(stephanie.run.runId);
    assert.equal((await prompts()).body.prompts.some((x: { approvalId: string }) => x.approvalId === hers.approvalId && x.deciders.includes('100')), false, 'an owner is not asked about what is done in Stephanie’s name');
    state.approvals.decide(hers.approvalId, 'rejected', 'test');
  });

  it('a question expires after a day', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = await prompts().then((r) => r.body.prompts.find((x: { approvalId: string }) => x.approvalId === a.approvalId));
    state.approvals.markAsked(a.approvalId, 'discord', 'chan-1', new Date(Date.now() - 25 * 3_600_000));
    const late = await reply(p.code, 'approve', '100');
    assert.equal(late.status, 410);
    assert.equal(state.approvals.get(a.approvalId)!.state, 'pending');
    assert.equal(actions('APPROVAL_GRANTED').filter((e) => e.approvalId === a.approvalId).length, 0);
    state.approvals.decide(a.approvalId, 'rejected', 'test');
  });

  it('a role change the agent asked for is asked of the owner in the channel and applied by the factory when they say yes', async () => {
    const { run, token } = await runFor({ provider: 'discord', id: '100' });
    const req = await call('POST', `/api/v1/runs/${run.runId}/role-requests`, { provider: 'discord', identity: '300', roles: ['Family'] }, token);
    assert.equal(req.status, 202, JSON.stringify(req.body));
    const id = req.body.approvalId;
    const p = await askFor({ approvalId: id });
    assert.deepEqual(p.deciders, ['100']);
    assert.match(p.text, /Give `discord:300` `Family` on `mine`\./);
    assert.equal((await reply(p.code, 'approve', '300')).status, 403, 'the person it names cannot grant it to themselves');
    assert.equal(state.identityLinks!.resolveLink('discord', '300')!.agentRoles?.mine, undefined);
    const ok = await reply(p.code, 'approve', '100');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(state.identityLinks!.resolveLink('discord', '300')!.agentRoles?.mine, ['Family']);
    assert.ok(actions('APPROVAL_GRANTED').some((e) => e.approvalId === id && (e as { requestId?: string }).requestId === 'discord:chan-1'));
  });

  it('the console and the API still decide as before (an admin, and the owner’s own session)', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = (await prompts()).body.prompts.find((x: { approvalId: string }) => x.approvalId === a.approvalId);
    assert.ok(p);
    assert.equal((await call('POST', `/api/v1/approvals/${a.approvalId}`, { decision: 'approve' }, ADMIN)).status, 200);
    assert.equal((await reply(p.code, 'approve', '100')).status, 404, 'decided elsewhere: the code is spent');
  });

  it('never shows less than it would send: a long path or body, a binary body, or many headers are not asked in the channel', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const { run } = await runFor({ provider: 'discord', id: '100' });
      return state.approvals.hold({
        runId: run.runId, agentId: 'mine', route: 'linkedin', tool: 'http', argsSha256: `h${Math.random()}`,
        request: { method: 'POST', path: '/v2/posts', headers: {}, body: 'ok', bodyEncoding: 'utf8', ...over } as never,
      }).approval;
    };
    const cases = [
      await mk({ path: `/v2/${'a'.repeat(300)}` }),
      await mk({ body: `${'x'.repeat(400)}and then the real payload` }),
      await mk({ body: 'AAAA', bodyEncoding: 'base64' }),
      await mk({ headers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-h${i}`, 'v'])) }),
    ];
    const asked = (await prompts()).body.prompts.map((x: { approvalId: string }) => x.approvalId);
    for (const c of cases) {
      assert.equal(asked.includes(c.approvalId), false, JSON.stringify(c.request).slice(0, 60));
      assert.equal(state.approvals.get(c.approvalId)!.ask, undefined, 'no code is issued for it');
      state.approvals.decide(c.approvalId, 'rejected', 'test');
    }
    // What it can show, it shows whole, with the headers it will send.
    const ok = await mk({ headers: { 'x-thing': 'a [link](http://x) \u202eevil' }, body: 'x'.repeat(400) });
    const p = (await prompts()).body.prompts.find((x: { approvalId: string }) => x.approvalId === ok.approvalId);
    assert.ok(p.text.includes('x'.repeat(400)));
    assert.match(p.text, /`x-thing: a \[link\]\(http:\/\/x\)  evil`/);
    assert.ok(!/[\u202e]/.test(p.text));
    state.approvals.decide(ok.approvalId, 'rejected', 'test');
  });

  it('a reply for another agent’s approval is just a message, and refusals are written to the ledger once, not once per message', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = await askFor(a);
    assert.equal((await reply(p.code, 'approve', '100', 'chan-1', INGRESS, 'theirs')).status, 404);
    assert.equal(state.approvals.get(a.approvalId)!.state, 'pending');
    for (let i = 0; i < 5; i++) assert.equal((await reply(p.code, 'approve', '300')).status, 403);
    assert.equal(actions('APPROVAL_CHANNEL_REFUSED:not_permitted').filter((e) => e.approvalId === a.approvalId).length, 1);
    state.approvals.decide(a.approvalId, 'rejected', 'test');
  });

  it('the code is never in a listing of approvals, for admins or approvers', async () => {
    const { run } = await runFor({ provider: 'discord', id: '100' });
    const a = hold(run.runId);
    const p = await askFor(a);
    for (const token of [ADMIN, APPROVER]) {
      const list = await call('GET', '/api/v1/approvals', undefined, token);
      const row = (list.body as Array<{ approvalId: string; ask?: { code?: string; channelId?: string } }>).find((x) => x.approvalId === a.approvalId)!;
      assert.ok(row, token);
      assert.ok(!JSON.stringify(list.body).includes(p.code), token);
      assert.equal(row.ask?.channelId, 'chan-1');
    }
    state.approvals.decide(a.approvalId, 'rejected', 'test');
  });

  it('what a schedule holds in another person’s name is not decided by an owner; one whose schedule cannot be read is decided by no owner', async () => {
    const mkScheduled = (scheduleId: string) => {
      const run = state.runs.create({ agentId: 'mine', state: 'WORKING', actor: 'factory:timekeeper', trigger: 'schedule', input: { scheduleId } } as never);
      return hold(run.runId);
    };
    state.schedules = { get: (id: string) => (id === 'hers' ? { createdVia: 'chat', requestedBy: { kind: 'identity', provider: 'discord', id: '201' } } : id === 'his' ? { createdVia: 'chat', requestedBy: { kind: 'identity', provider: 'discord', id: '100' } } : undefined) } as never;
    const hers = mkScheduled('hers');
    const his = mkScheduled('his');
    const gone = mkScheduled('gone');
    const asked = (await prompts()).body.prompts;
    const decidersFor = (id: string) => asked.find((x: { approvalId: string }) => x.approvalId === id)?.deciders;
    assert.deepEqual(decidersFor(hers.approvalId), ['201'], 'Stephanie’s schedule: Stephanie, the requester, is asked; the owner is not');
    assert.deepEqual(decidersFor(his.approvalId), ['100']);
    assert.equal(decidersFor(gone.approvalId), undefined);
    assert.equal((await call('POST', `/api/v1/approvals/${hers.approvalId}`, { decision: 'approve' }, OWNER)).status, 403);
    assert.equal((await call('POST', `/api/v1/approvals/${gone.approvalId}`, { decision: 'approve' }, OWNER)).status, 403);
    assert.equal((await call('POST', `/api/v1/approvals/${his.approvalId}`, { decision: 'approve' }, OWNER)).status, 200, 'their own schedule: the owner is the requester');
    for (const a of [hers, gone]) state.approvals.decide(a.approvalId, 'rejected', 'test');
    state.schedules = undefined as never;
  });
});
