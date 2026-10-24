// TSK-174 (DESIGN_AUTHORITY.md E12 item 4, GAP-128): the gatekeeper-egress enforces a person's roles on what the agent
// reaches. Stephanie holds `Family` on Donna and Gmail is denied to it: during her run a Gmail call is refused and a
// calendar call is forwarded; a scheduled run and Dale's own are unaffected. Real control plane, real egress, over HTTP.
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
import { createGatekeeperEgress, type ControlClient } from '@beercanlabs/factory-gatekeeper';
import { ScheduleStore, type ScheduledAction } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { IdentityLinkStore } from './identity-links.js';
import { accessForRun } from './access-enforcement.js';

const ADMIN = 'admin-access-enf';
const EGRESS = 'egress-access-enf';
const SHA = '4'.repeat(40);
const GMAIL_KEY = 'fake-gmail-credential-0000';
const KEY = 'access-enf-run-token-key-0123456789ab';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

const donna = {
  id: 'donna',
  name: 'Donna',
  memory: { archetype: 'personal-assistant' },
  skills: [
    { id: 'google-calendar', routes: ['google-calendar'] },
    { id: 'gmail', routes: ['google-gmail'] },
    { id: 'print', routes: ['print'] },
  ],
  roles: {
    Owner: { skills: { '*': { allow: ['*'] } } },
    Family: { skills: { 'google-calendar': { allow: ['*'] }, print: { allow: ['*'] }, gmail: { deny: ['*'] } } },
    Cousin: { skills: { gmail: { allow: ['*'] }, print: { deny: ['*'] } } },
  },
};

describe('the gatekeeper-egress enforces a person’s roles (E12 item 4, TSK-174)', { concurrency: false }, () => {
  let cp: http.Server;
  let gw: http.Server;
  let upstream: http.Server;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let gwPort = 0;
  const saw: Array<{ path: string; key?: string }> = [];
  const tokens = new RunTokens(KEY);
  const discord = (id: string) => ({ provider: 'discord', id });

  const liveRun = async (over: Record<string, unknown> = {}) => {
    const run = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'factory:test', trigger: 'api', ...over } as never);
    return { run, token: await tokens.mint({ runId: run.runId, agentId: 'donna' }) };
  };
  const forwardCall = (token: string, route: string) =>
    fetch(`http://127.0.0.1:${gwPort}/${route}/x`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: (await r.text()) as string }));
  const asPerson = (id: string) => liveRun({ requestedBy: discord(id), actor: 'factory:ingress' });

  const priorAdminEmails = process.env.FACTORY_ADMIN_EMAILS;

  before(async () => {
    process.env.FACTORY_ADMIN_EMAILS = 'boss-email@example.com';
    dir = mkdtempSync(join(tmpdir(), 'cp-access-enf-'));
    ledger = new MemoryLedger();
    upstream = http.createServer((req, res) => {
      saw.push({ path: req.url ?? '', key: req.headers['x-key'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const upPort = await listen(upstream);
    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gatekeeper-egress', token: EGRESS, roles: ['gatekeeper-egress'] },
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
      schedules: new ScheduleStore(),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    cp = createFactoryServer(state);
    const cpPort = await listen(cp);
    const call = async (method: string, path: string, body?: unknown, token = EGRESS) => {
      const res = await fetch(`http://127.0.0.1:${cpPort}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const reg = await call('POST', '/api/v1/registry/agents', { repo: 'https://github.com/beercanlabs/SM-donna', commit: SHA, cartridge: donna }, ADMIN);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await call('PUT', '/api/v1/agents/donna/owners', { owners: ['cloudflare:dale@example.com'] }, ADMIN)).status, 200);
    assert.equal((await call('PUT', '/api/v1/agents/donna/policy', { routes: ['google-gmail', 'google-calendar', 'print'] }, ADMIN)).status, 200);
    const links = state.identityLinks!;
    links.link('discord', '100', 'cloudflare:dale@example.com', 'admin', { name: 'Dale' }); // owner, no factory role
    links.link('discord', '201', 'cloudflare:stephanie@example.com', 'admin', { name: 'Stephanie', agentRoles: { donna: ['Family'] } });
    links.link('discord', '202', 'cloudflare:cousin@example.com', 'admin', { name: 'Cousin', agentRoles: { donna: ['Cousin'] } });
    links.link('discord', '203', 'cloudflare:boss@example.com', 'admin', { name: 'Boss', roles: ['admin'] });
    links.link('discord', '204', 'cloudflare:op@example.com', 'admin', { name: 'Op', roles: ['operator'] });
    links.link('discord', '205', 'cloudflare:both@example.com', 'admin', { name: 'Both', agentRoles: { donna: ['Family', 'Cousin'] } });
    links.link('discord', '206', 'cloudflare:nobody@example.com', 'admin', { name: 'Nobody' });
    links.link('discord', '207', 'cloudflare:owner-role@example.com', 'admin', { name: 'NotOwner', agentRoles: { donna: ['Owner'] } });
    links.link('discord', '208', 'cloudflare:boss-email@example.com', 'admin', { name: 'EmailAdmin' });
    const control: ControlClient = {
      runContext: async (runId) => {
        const r = await call('GET', `/api/v1/gatekeeper-egress/runs/${runId}`);
        return r.status === 200 ? r.body : null;
      },
      requestApproval: async (req) => (await call('POST', '/api/v1/gatekeeper-egress/approvals', req)).body,
      consumeApproval: async (id) => (await call('POST', `/api/v1/gatekeeper-egress/approvals/${id}/consume`)).status === 200,
      ledger: async (event) => {
        const r = await call('POST', '/api/v1/ledger', event);
        if (r.status !== 201) throw new Error(`ledger ${r.status}`);
      },
    };
    gw = createGatekeeperEgress({
      routes: [
        { id: 'google-gmail', kind: 'http', upstream: `http://127.0.0.1:${upPort}/gmail`, credential: { secret: 'GMAIL_KEY', header: 'x-key' } },
        { id: 'google-calendar', kind: 'http', upstream: `http://127.0.0.1:${upPort}/cal` },
        { id: 'print', kind: 'http', upstream: `http://127.0.0.1:${upPort}/print` },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [envProvider({ GMAIL_KEY })],
      contextTtlMs: 0,
    });
    gwPort = await listen(gw);
  });

  after(async () => {
    if (priorAdminEmails === undefined) delete process.env.FACTORY_ADMIN_EMAILS;
    else process.env.FACTORY_ADMIN_EMAILS = priorAdminEmails;
    for (const s of [gw, cp, upstream]) await new Promise<void>((r) => s.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const deniedRows = () => ledger.query().filter((e) => (e as { action?: string }).action === 'EGRESS_DENIED_ROLE_NOT_ALLOWED');

  it('during Stephanie’s run a Gmail call is refused and a calendar call is forwarded', async () => {
    saw.length = 0;
    const { run, token } = await asPerson('201');
    const gmail = await forwardCall(token, 'google-gmail');
    assert.equal(gmail.status, 403, gmail.body);
    assert.deepEqual(JSON.parse(gmail.body), { error: 'role_not_allowed', route: 'google-gmail' });
    assert.equal((await forwardCall(token, 'google-calendar')).status, 200);
    assert.equal((await forwardCall(token, 'print')).status, 200);
    assert.deepEqual(saw.map((s) => s.path), ['/cal/x', '/print/x'], 'Gmail was never called, so its credential was never injected');
    await settle();
    const rows = deniedRows().filter((e) => e.runId === run.runId);
    assert.equal(rows.length, 1, 'the refusal is ledgered');
    assert.equal(rows[0].route, 'google-gmail');
  });

  it('the agent cannot change the answer: nothing it sends reaches the decision', async () => {
    const { token } = await asPerson('201');
    const r = await fetch(`http://127.0.0.1:${gwPort}/google-gmail/x?role=Owner`, { headers: { authorization: `Bearer ${token}`, 'x-factory-roles': 'Owner', 'x-roles': 'Owner' } });
    assert.equal(r.status, 403);
  });

  it('Dale’s own run (the owner, no factory role), an admin’s and an operator’s are not restricted', async () => {
    for (const id of ['100', '203', '204', '208']) {
      saw.length = 0;
      const { token } = await asPerson(id);
      const r = await forwardCall(token, 'google-gmail');
      assert.equal(r.status, 200, `${id}: ${r.body}`);
      assert.deepEqual(saw, [{ path: '/gmail/x', key: GMAIL_KEY }], 'the credential is injected only for the run that may use it');
    }
  });

  it('a console or API caller, a cartridge cron and a system schedule are not restricted (E12 item 5)', async () => {
    for (const over of [{ actor: 'cloudflare:dale@example.com' }, { trigger: 'cron', actor: 'factory:scheduler' }]) {
      const { token } = await liveRun(over);
      assert.equal((await forwardCall(token, 'google-gmail')).status, 200, JSON.stringify(over));
    }
    const legacy = scheduleOf({});
    state.schedules!.save(legacy);
    const { token } = await liveRun({ trigger: 'schedule', actor: 'factory:scheduler', input: { scheduleId: legacy.id } });
    assert.equal((await forwardCall(token, 'google-gmail')).status, 200, 'a schedule with no requester reads as the system');
  });

  function scheduleOf(over: Partial<ScheduledAction>): ScheduledAction {
    return { id: `s-${Math.random().toString(36).slice(2)}`, agentId: 'donna', name: 'debrief', cron: '0 6 * * *', prompt: 'x', enabled: true, createdAt: new Date().toISOString(), ...over };
  }

  it('a schedule Stephanie made carries only Family’s authority, however it runs', async () => {
    const s = scheduleOf({ createdVia: 'agent', requestedBy: { kind: 'identity', provider: 'discord', id: '201' } });
    state.schedules!.save(s);
    const { token } = await liveRun({ trigger: 'schedule', actor: 'factory:scheduler', requestedBy: discord('201'), input: { scheduleId: s.id } });
    assert.equal((await forwardCall(token, 'google-gmail')).status, 403);
    assert.equal((await forwardCall(token, 'google-calendar')).status, 200);
    // Even a scheduled run that records no requester of its own takes Stephanie's from the schedule.
    const bare = await liveRun({ trigger: 'schedule', actor: 'factory:scheduler', input: { scheduleId: s.id } });
    assert.equal((await forwardCall(bare.token, 'google-gmail')).status, 403);
  });

  it('a scheduled run whose schedule is gone is unknown, not the system: it fails closed', async () => {
    const { token } = await liveRun({ trigger: 'schedule', actor: 'factory:scheduler', input: { scheduleId: 'gone' } });
    assert.equal((await forwardCall(token, 'google-gmail')).status, 403);
  });

  it('a person who holds two roles gets what either allows, and a deny wins over an allow', async () => {
    const { token } = await asPerson('205'); // Family (gmail denied) and Cousin (gmail allowed, print denied)
    assert.equal((await forwardCall(token, 'google-gmail')).status, 403, 'Family denies gmail even though Cousin allows it');
    assert.equal((await forwardCall(token, 'google-calendar')).status, 200);
    assert.equal((await forwardCall(token, 'print')).status, 403, 'Cousin denies print even though Family allows it');
  });

  it('a person with no role on the agent, an unmapped identity, and a claimed Owner role get nothing from its skills', async () => {
    for (const id of ['206', '207', '999']) {
      const { token } = await asPerson(id);
      for (const route of ['google-gmail', 'google-calendar', 'print']) assert.equal((await forwardCall(token, route)).status, 403, `${id} ${route}`);
    }
  });

  it('a role change applies to the next request, with no redeploy', async () => {
    const { token } = await asPerson('202'); // Cousin: gmail allowed
    assert.equal((await forwardCall(token, 'google-gmail')).status, 200);
    state.identityLinks!.link('discord', '202', 'cloudflare:cousin@example.com', 'admin', { name: 'Cousin', agentRoles: { donna: ['Family'] } });
    assert.equal((await forwardCall(token, 'google-gmail')).status, 403, 'now Family');
    state.identityLinks!.link('discord', '202', 'cloudflare:cousin@example.com', 'admin', { name: 'Cousin', agentRoles: { donna: ['Cousin'] } });
  });

  it('an agent that declares no roles gives a non-owner person nothing from its skills; an agent with no skills restricts nothing', async () => {
    const reg = (cartridge: Record<string, unknown>) => fetch(`http://127.0.0.1:${(cp.address() as { port: number }).port}/api/v1/registry/agents`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ repo: 'https://github.com/beercanlabs/SM-x', commit: SHA, cartridge: { memory: { archetype: 'personal-assistant' }, ...cartridge } }) });
    assert.equal((await reg({ id: 'norole', name: 'n', skills: [{ id: 's', routes: ['print'] }] })).status, 201);
    assert.equal((await reg({ id: 'noskill', name: 'n' })).status, 201);
    state.identityLinks!.link('discord', '301', 'cloudflare:member@example.com', 'admin', { name: 'M', agentRoles: { norole: ['Any'], noskill: ['Any'] } });
    const run = (agentId: string) => state.runs.create({ agentId, state: 'WORKING', actor: 'x', trigger: 'api', requestedBy: discord('301') } as never);
    assert.deepEqual(accessForRun(state, run('norole'), state.agents.get('norole')!), { restricted: true, routes: { print: 'denied' } });
    assert.deepEqual(accessForRun(state, run('noskill'), state.agents.get('noskill')!), { restricted: true, routes: {} });
  });

  it('even a stored link that claims the Owner role (the store drops it, but stored data is not trusted) is not the owner', () => {
    const forged = { ...state, identityLinks: { resolveLink: () => ({ provider: 'discord', id: '9', actor: 'cloudflare:x@example.com', agentRoles: { donna: ['Owner'] } }) } } as unknown as FactoryState;
    const run = state.runs.create({ agentId: 'donna', state: 'WORKING', actor: 'x', trigger: 'api', requestedBy: discord('9') } as never);
    assert.deepEqual(accessForRun(forged, run, state.agents.get('donna')!), { restricted: true, routes: { 'google-calendar': 'denied', 'google-gmail': 'denied', print: 'denied' } });
  });

  it('the run read the egress uses carries the answer, and only the egress may read it', async () => {
    const { run } = await asPerson('201');
    const port = (cp.address() as { port: number }).port;
    const read = (token: string) => fetch(`http://127.0.0.1:${port}/api/v1/gatekeeper-egress/runs/${run.runId}`, { headers: { authorization: `Bearer ${token}` } });
    const ok = await read(EGRESS);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).access, { restricted: true, routes: { 'google-calendar': 'allowed', 'google-gmail': 'denied', print: 'allowed' } });
    assert.equal((await read('nonsense')).status, 401);
  });
});
