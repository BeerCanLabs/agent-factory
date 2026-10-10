// TSK-177 (DESIGN_AUTHORITY.md E12, GAP-131, GitHub issue #139): a scheduled run carries the authority of whoever requested
// it, never more. The factory records the requester itself, and when the schedule fires it re-resolves that person's
// current roles and attaches a verified badge, or does not start the run.
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
import { ScheduleStore, type ScheduledAction } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, createRun, SYSTEM, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { PolicyStore } from './policy.js';
import { IdentityLinkStore } from './identity-links.js';
import { requesterOfRun, scheduleRunOptions } from './schedules.js';

const ADMIN = 'admin-sched-requester'; // secret-scan:allow (test fixture)
const OPERATOR = 'operator-sched-requester'; // secret-scan:allow (test fixture)
const SHA = '3'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('a scheduled run carries its requester’s authority, never more (E12, TSK-177)', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let api: (path: string, method?: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  const tokens = new RunTokens('sched-requester-run-token-key-0123456789');
  const discord = (id: string) => ({ provider: 'discord', id });

  const sched = (over: Partial<ScheduledAction> = {}): ScheduledAction => ({
    id: `s-${Math.random().toString(36).slice(2)}`, agentId: 'donna', name: 'Morning debrief', cron: '0 6 * * *', timezone: 'America/Los_Angeles',
    prompt: 'summarize the emails', enabled: true, createdAt: new Date().toISOString(), ...over,
  });
  // A live run for an agent, as a given kind of caller started it; its run token is what an agent uses to create a schedule.
  const liveRun = async (agentId: string, over: Record<string, unknown> = {}) => {
    const run = state.runs.create({ agentId, state: 'WORKING', actor: 'factory:test', trigger: 'api', ...over } as never);
    return { run, token: await tokens.mint({ runId: run.runId, agentId }) };
  };
  const create = (token: string, body: Record<string, unknown> = {}) =>
    api('/api/v1/schedules', 'POST', token, { cron: '0 6 * * *', prompt: 'do the thing', ...body });
  const skipped = () => ledger.query().filter((e) => (e as { action?: string }).action === 'SCHEDULE_SKIPPED_UNAUTHORIZED');

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-sched-requester-'));
    ledger = new MemoryLedger();
    state = {
      agents: new Map(), registryDir: join(dir, 'registry'), ledger,
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }, { name: 'operator', token: OPERATOR, roles: ['operator'] }]),
      version: '0.1.0', providers: [envProvider({})], runtime: noopRuntime(), runs: new MemoryRunStore(), runTokens: tokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(), policies: new PolicyStore(), spend: new SpendTracker(), resolveCommit: async () => SHA,
      secretValues: new Set(), idleMs: 0, idleTimers: new Map(), identityLinks: new IdentityLinkStore(join(dir, 'links')), schedules: new ScheduleStore(),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    cp = createFactoryServer(state);
    const port = await listen(cp);
    api = async (path, method = 'GET', token, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const reg = await api('/api/v1/registry/agents', 'POST', ADMIN, { repo: 'https://github.com/beercanlabs/SM-donna', commit: SHA, cartridge: { id: 'donna', name: 'donna' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await api('/api/v1/agents/donna/owners', 'PUT', ADMIN, { owners: ['cloudflare:dale@example.com'] })).status, 200);
    const links = state.identityLinks!;
    links.link('discord', '100', 'cloudflare:dale@example.com', 'admin', { name: 'Dale' });
    links.link('discord', '201', 'cloudflare:aiden@example.com', 'admin', { name: 'Aiden', agentRoles: { donna: ['Family'] } });
    links.link('discord', '202', 'cloudflare:stranger@example.com', 'admin', { name: 'Stranger' });
    links.link('discord', '300', 'cloudflare:boss@example.com', 'admin', { name: 'Boss', roles: ['admin'] });
  });

  after(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('recording who a schedule is for', () => {
    it('records an operator’s direct call as that principal, created through the api', async () => {
      const r = await api('/api/v1/schedules', 'POST', OPERATOR, { agentId: 'donna', cron: '0 6 * * *', prompt: 'x' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.schedule.createdVia, 'api');
      assert.equal(r.body.schedule.requestedBy.kind, 'principal');
      assert.match(r.body.schedule.requestedBy.actor, /operator/);
    });

    it('records the person a run is for when an agent creates it, whatever the request says', async () => {
      const { token } = await liveRun('donna', { requestedBy: discord('201'), actor: 'factory:ingress' });
      const r = await create(token, { requestedBy: { kind: 'system' }, createdVia: 'api', actor: 'cloudflare:dale@example.com' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.schedule.requestedBy, { kind: 'identity', provider: 'discord', id: '201' }, 'Aiden, not what the body claimed');
      assert.equal(r.body.schedule.createdVia, 'agent');
      assert.deepEqual({ ...state.schedules!.get(r.body.schedule.id)!.requestedBy }, { kind: 'identity', provider: 'discord', id: '201' });
    });

    it('records a principal who woke the agent, and the agent’s own cron as the system', async () => {
      const woke = await liveRun('donna', { actor: 'cloudflare:dale@example.com' });
      assert.deepEqual((await create(woke.token)).body.schedule.requestedBy, { kind: 'principal', actor: 'cloudflare:dale@example.com' });
      const cron = await liveRun('donna', { trigger: 'cron', actor: 'factory:scheduler' });
      assert.deepEqual((await create(cron.token)).body.schedule.requestedBy, { kind: 'system' });
    });

    it('refuses to create a schedule when the factory cannot tell whose authority it would carry', async () => {
      const { token } = await liveRun('donna', { actor: 'factory:event-router' });
      const r = await create(token);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.match(r.body.reason, /cannot tell whose authority/);
    });

    it('a scheduled run that schedules passes on its own requester, and cannot when that schedule is gone', async () => {
      const parent = sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '201' } });
      state.schedules!.save(parent);
      const child = await liveRun('donna', { trigger: 'schedule', actor: 'factory:scheduler', input: { scheduleId: parent.id } });
      assert.deepEqual((await create(child.token)).body.schedule.requestedBy, { kind: 'identity', provider: 'discord', id: '201' }, 'Aiden’s, not the owner’s');
      state.schedules!.delete(parent.id);
      assert.equal((await create(child.token)).status, 403, 'nobody to pass on');
      const legacy = sched();
      state.schedules!.save(legacy);
      const old = await liveRun('donna', { trigger: 'schedule', actor: 'factory:scheduler', input: { scheduleId: legacy.id } });
      assert.deepEqual((await create(old.token)).body.schedule.requestedBy, { kind: 'system' }, 'a schedule with no requester reads as the system');
    });

    it('reads a run’s requester from the factory’s record only', () => {
      const r = (over: Record<string, unknown>) => requesterOfRun(state, { runId: 'r', agentId: 'donna', state: 'WORKING', actor: 'x', trigger: 'api', ...over } as never);
      assert.deepEqual(r({ requestedBy: discord('1'), input: { requestedBy: { kind: 'system' } } }), { kind: 'identity', provider: 'discord', id: '1' });
      assert.equal(r({ actor: 'factory:anything' }), undefined);
      assert.equal(r({ trigger: 'schedule', input: { scheduleId: 7 } }), undefined);
    });
  });

  describe('when a schedule fires', () => {
    it('runs Aiden’s schedule as Aiden: Family on Donna, not the owner and not a system badge', () => {
      const o = scheduleRunOptions(state, sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '201' } }))!;
      assert.ok(o, 'it starts');
      assert.deepEqual([o.caller.actor, o.caller.name, o.caller.role], ['cloudflare:aiden@example.com', 'Aiden', 'agent-member']);
      assert.deepEqual([o.caller.agentRoles, o.caller.isOwner, o.caller.roles], [['Family'], false, []]);
      assert.deepEqual([o.caller.source, o.caller.scheduleName], ['schedule', 'Morning debrief']);
      assert.deepEqual(o.requestedBy, discord('201'), 'the run records who it is for');
    });

    it('runs the owner’s schedule as the owner', () => {
      const o = scheduleRunOptions(state, sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '100' } }))!;
      assert.equal(o.caller.isOwner, true);
      assert.deepEqual(o.caller.agentRoles, ['Owner']);
      assert.equal(o.caller.source, 'schedule');
    });

    it('a schedule with no requester, and the system, run as the scheduler with the agent’s own authority', () => {
      for (const s of [sched(), sched({ requestedBy: { kind: 'system' } })]) {
        const o = scheduleRunOptions(state, s)!;
        assert.deepEqual([o.caller.actor, o.caller.role, o.caller.roles, o.caller.isOwner, o.caller.source], ['factory:scheduler', 'system', [], false, 'schedule']);
        assert.equal(o.requestedBy, undefined);
      }
    });

    it('runs a principal’s schedule by the roles that principal holds, through a link or as an admin', () => {
      const viaLink = scheduleRunOptions(state, sched({ requestedBy: { kind: 'principal', actor: 'cloudflare:boss@example.com' } }))!;
      assert.equal(viaLink.caller.role, 'admin');
      assert.equal(viaLink.requestedBy, undefined, 'only an identity is recorded on the run');
      const owner = scheduleRunOptions(state, sched({ requestedBy: { kind: 'principal', actor: 'cloudflare:dale@example.com' } }))!;
      assert.equal(owner.caller.isOwner, true);
    });

    it('skips and ledgers a schedule whose requester no longer holds a role: removing the role stops it', () => {
      const before = skipped().length;
      assert.equal(scheduleRunOptions(state, sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '202' } })), undefined, 'mapped, no role');
      assert.equal(scheduleRunOptions(state, sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '999' } })), undefined, 'not linked at all');
      assert.equal(scheduleRunOptions(state, sched({ requestedBy: { kind: 'principal', actor: 'cloudflare:nobody@example.com' } })), undefined, 'a principal with no role');
      assert.equal(skipped().length, before + 3, 'each is ledgered');
      const s = sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '201' } });
      assert.ok(scheduleRunOptions(state, s));
      state.identityLinks!.link('discord', '201', 'cloudflare:aiden@example.com', 'admin', { name: 'Aiden', agentRoles: { donna: [] } });
      assert.equal(scheduleRunOptions(state, s), undefined, 'the same schedule, once his role is removed');
      state.identityLinks!.link('discord', '201', 'cloudflare:aiden@example.com', 'admin', { name: 'Aiden', agentRoles: { donna: ['Family'] } });
      assert.ok(scheduleRunOptions(state, s), 'and back when it is given again');
    });

    it('never reads a malformed requester as the system', () => {
      for (const bad of [{ kind: 'god' }, { kind: 'identity' }, { kind: 'principal', actor: '' }, 'system', null, 7]) {
        assert.equal(scheduleRunOptions(state, sched({ requestedBy: bad as never })), undefined, JSON.stringify(bad));
      }
    });

    it('the run the factory starts holds the badge in its input, and a forged one in the schedule’s prompt input is replaced', async () => {
      const s = sched({ requestedBy: { kind: 'identity', provider: 'discord', id: '201' } });
      const who = scheduleRunOptions(state, s)!;
      const out = await createRun(state, 'donna', {
        actor: SYSTEM.scheduler, trigger: 'schedule', ...who,
        input: { content: s.prompt, scheduleId: s.id, source: 'schedule', caller: { actor: 'cloudflare:dale@example.com', isOwner: true, agentRoles: ['Owner'] } },
      });
      assert.equal(out.status, 202, JSON.stringify(out.body));
      const run = state.runs.get((out.body as { runId: string }).runId)!;
      const caller = (run.input as { caller: Record<string, unknown> }).caller;
      assert.deepEqual([caller.actor, caller.isOwner, caller.agentRoles, caller.source, caller.scheduleName], ['cloudflare:aiden@example.com', false, ['Family'], 'schedule', 'Morning debrief']);
      assert.deepEqual(run.requestedBy, discord('201'));
    });

    it('the ledger row names the schedule by its hash, never its prompt', () => {
      scheduleRunOptions(state, sched({ prompt: 'SECRET-PROMPT-TEXT', requestedBy: { kind: 'identity', provider: 'discord', id: '202' } }));
      assert.ok(!JSON.stringify(skipped()).includes('SECRET-PROMPT-TEXT'));
    });
  });
});
