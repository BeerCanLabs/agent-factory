// DESIGN_AUTHORITY.md §6.17 (CL1, CL3, CL4, CL5): the factory CLI against the real control plane. The person signs in
// with a verified Access assertion; the manager is a cartridge, played here by a script that answers over the same
// run-token reply path a real one uses.
import type { AddressInfo } from 'node:net';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, cloudflareAccessAuth, RunTokens } from '@beercanlabs/factory-auth';
import { FactoryClient, ManagerSession, ConversationRefused, talk } from '@beercanlabs/factory-cli';
import { createFactoryServer, type FactoryState } from './app.js';
import { createTreasury } from './spend.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

const TEAM = 'team.example.cloudflareaccess.com';
const AUD = 'aud-tag-cli';
const ADMIN_EMAIL = 'owner@example.com';
const VIEWER_EMAIL = 'someone@example.com';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(email: string) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 300, email })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const manager = {
  id: 'factory-manager', name: 'Factory Manager', role: 'House staff', state: 'SLEEPING', provider: 'local', artifact: '',
  requires: [], ungated: [], gated: [], triggers: [], memoryPrefix: 'factory-manager', warmDownSeconds: 300, dir: '/tmp/fm', requestedModels: [], approvedModels: [],
};

let state: FactoryState;
let base = '';
let close: () => Promise<void>;
let stopManager: () => void;
const heard: Array<Record<string, unknown>> = [];
let script: (turn: Record<string, any>) => unknown = () => ({ type: 'message', text: 'unset' });

/** What the proxy does for the CLI: it turns `cf-access-token` into the assertion header the origin reads (A1). */
const viaProxy: typeof fetch = (input, init) => {
  const headers = { ...(init?.headers as Record<string, string>) };
  if (headers['cf-access-token']) headers['cf-access-jwt-assertion'] = headers['cf-access-token'];
  delete headers['cf-access-token'];
  return fetch(input, { ...init, headers });
};

const clientFor = (email: string) => new FactoryClient({ baseUrl: base, fetch: viaProxy, credential: async () => assertion(email), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))) });

/** The manager cartridge, played: reads each turn the factory delivered and answers it on the run-token reply path. */
function playManager(): () => void {
  const seen = new Set<string>();
  const timer = setInterval(async () => {
    const run = state.runs.list({ agentId: 'factory-manager', active: true })[0];
    if (!run) return;
    const turns = [run.input, ...(state.mailboxes?.get('factory-manager')?.messages.map((m) => m.payload) ?? [])] as Array<Record<string, any>>;
    for (const t of turns) {
      if (!t || typeof t.turnId !== 'string' || seen.has(t.turnId)) continue;
      seen.add(t.turnId);
      heard.push(t);
      const token = await state.runTokens.mint({ runId: run.runId, agentId: 'factory-manager' });
      await fetch(`${base}/api/v1/runs/${run.runId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ turnId: t.turnId, content: JSON.stringify(script(t)) }),
      });
    }
  }, 10);
  return () => clearInterval(timer);
}

before(async () => {
  const access = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, adminEmails: [ADMIN_EMAIL], fetchJwks: async () => ({ keys: [jwk] }) });
  state = {
    agents: new Map([['factory-manager', manager]]),
    ledger: new MemoryLedger(),
    auth: bearerAuth([{ name: 'ops', token: 'ops-token', roles: ['admin'] }]), // secret-scan:allow (test fixture)
    access,
    treasury: createTreasury({
      cloud: { provider: 'aws', costs: async (w: { start: string; end: string }) => ({ provider: 'aws', start: w.start, end: w.end, lines: [], usage: [] }) },
      compute: { provider: 'aws', cluster: 'c', inventory: async () => ({ provider: 'aws', cluster: 'c', services: [], tasks: [] }) },
    } as never),
    version: 'test',
    providers: [envProvider({})],
    runtime: noopRuntime(),
    runs: new MemoryRunStore(),
    runTokens: new RunTokens(undefined),
    callbacks: { allowInsecure: true, attempts: 1, backoffMs: 1 },
    policies: new PolicyStore(),
    spend: new SpendTracker(),
    approvals: new ApprovalStore(),
    idleMs: 0,
    idleTimers: new Map(),
    secretValues: new Set<string>(),
  } as unknown as FactoryState;
  const server = createFactoryServer(state);
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
  stopManager = playManager();
});
after(async () => {
  stopManager();
  await close();
});

function session(email: string, roles: string[], said: string[] = [], confirm = async (_q: string) => true) {
  return new ManagerSession({
    client: clientFor(email),
    agent: 'factory-manager',
    roles,
    actor: `cloudflare:${email}`,
    io: { say: (t) => said.push(t), note: () => {}, busy: () => {}, confirm },
    version: 'e2e',
    intervalMs: 10,
    timeoutMs: 8000,
  });
}

describe('§6.17 the factory CLI against the control plane', () => {
  it('CL1 the CLI is known by its verified Access assertion alone', async () => {
    const me = await clientFor(ADMIN_EMAIL).whoami();
    assert.equal(me.actor, `cloudflare:${ADMIN_EMAIL}`);
    assert.ok(me.roles.includes('admin'));
    const viewer = await clientFor(VIEWER_EMAIL).whoami();
    assert.deepEqual(viewer.roles, ['viewer']);
  });

  it('CL4 the manager asks for a tool, the CLI runs it as the person, and the result returns as the next turn', async () => {
    heard.length = 0;
    const said: string[] = [];
    script = (t) =>
      t.toolResults
        ? { type: 'message', text: `Spend call ok=${t.toolResults[0].ok}` }
        : { type: 'tool_calls', calls: [{ id: 'c1', name: 'get_spend', arguments: {} }] };
    const me = await clientFor(ADMIN_EMAIL).whoami();
    const out = await session(ADMIN_EMAIL, me.roles, said).ask('what have we spent?');
    assert.deepEqual(out, { kind: 'done' });
    assert.deepEqual(said, ['Spend call ok=true']);
    assert.equal(heard.length, 2, 'two turns reached the manager: the question, then the tool result');
    const first = heard[0] as any;
    assert.equal(first.content, 'what have we spent?');
    assert.equal(first.caller.actor, `cloudflare:${ADMIN_EMAIL}`, 'the factory told the manager who is speaking (AM2)');
    assert.ok(first.tools.some((t: any) => t.name === 'set_factory_budgets'), 'an admin is offered the budget tool');
    assert.ok(state.ledger.query({ agent: 'factory-manager' }).some((r) => r.action === 'CONVERSATION_HANDOFF'), 'the handoff is on the ledger');
  });

  it('CL4 a change runs only after the person says yes, and is made as that person', async () => {
    script = (t) =>
      t.toolResults
        ? { type: 'message', text: `ok=${t.toolResults[0].ok} declined=${Boolean(t.toolResults[0].declined)}` }
        : { type: 'tool_calls', calls: [{ id: 'b1', name: 'set_factory_budgets', arguments: { totalMonthUsd: 250 } }] };
    const roles = (await clientFor(ADMIN_EMAIL).whoami()).roles;

    const said: string[] = [];
    await session(ADMIN_EMAIL, roles, said, async () => false).ask('set the monthly budget to $250');
    assert.deepEqual(said, ['ok=false declined=true']);
    assert.equal((await fetch(`${base}/api/v1/spend/budgets`, { headers: { authorization: 'Bearer ops-token' } }).then((r) => r.json()) as any).current, null, 'nothing changed');

    said.length = 0;
    await session(ADMIN_EMAIL, roles, said, async () => true).ask('set the monthly budget to $250');
    assert.deepEqual(said, ['ok=true declined=false']);
    const row = state.ledger.query({ agent: 'factory' }).find((r) => r.action === 'FACTORY_BUDGET_SET');
    assert.ok(row, 'the budget change is on the ledger');
    assert.equal(row.actor, `cloudflare:${ADMIN_EMAIL}`, 'under the person, not the manager');
    assert.notEqual((await fetch(`${base}/api/v1/spend/budgets`, { headers: { authorization: 'Bearer ops-token' } }).then((r) => r.json()) as any).current, null);
  });

  it('CL3 a person below operator cannot reach the manager; the factory\'s refusal is worded for them', async () => {
    const viewer = clientFor(VIEWER_EMAIL);
    await assert.rejects(viewer.converse('factory-manager', { content: 'hello' }), (e: Error) => e instanceof ConversationRefused && e.status === 403 && /needs operator/.test(e.message));
  });

  it('CL5 a person connects to an agent and the agent answers through the same reply path', async () => {
    script = () => ({ type: 'connect', agent: 'factory-manager', text: 'Connecting you.' });
    const roles = (await clientFor(ADMIN_EMAIL).whoami()).roles;
    const out = await session(ADMIN_EMAIL, roles).ask('talk to the manager directly');
    assert.deepEqual(out, { kind: 'connect', agent: 'factory-manager' });

    script = (t) => ({ type: 'message', text: `you said ${t.content}` });
    const client = clientFor(ADMIN_EMAIL);
    const reply = await talk(client, 'factory-manager', { content: 'hi' }, { busy: () => {} }, { intervalMs: 10 });
    assert.equal(JSON.parse(reply.content).text, 'you said hi');
    assert.deepEqual(Object.keys(heard.at(-1) ?? {}).filter((k) => k === 'tools'), [], 'a direct conversation carries no manager tools');
  });
});
