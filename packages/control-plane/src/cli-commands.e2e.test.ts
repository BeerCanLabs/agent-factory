// DESIGN_AUTHORITY.md §6.17 CL11: the CLI's own commands against the real control plane, as a viewer and as an admin, with
// no Factory Manager anywhere. Every read command is run for real, so a wrong route or a response the renderer cannot
// read shows up here and not on someone's terminal.
import type { AddressInfo } from 'node:net';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, cloudflareAccessAuth, RunTokens } from '@beercanlabs/factory-auth';
import { COMMANDS, FactoryClient, runCommand } from '@beercanlabs/factory-cli';
import { createFactoryServer, type FactoryState } from './app.js';
import { createTreasury } from './spend.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

const TEAM = 'team.example.cloudflareaccess.com';
const AUD = 'aud-tag-commands';
const ADMIN = 'owner@example.com';
const VIEWER = 'someone@example.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(email: string) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 300, email })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const viaProxy: typeof fetch = (input, init) => {
  const h = { ...(init?.headers as Record<string, string>) };
  if (h['cf-access-token']) h['cf-access-jwt-assertion'] = h['cf-access-token'];
  delete h['cf-access-token'];
  return fetch(input, { ...init, headers: h });
};

const agent = (id: string) => ({ id, name: id, role: 'House staff', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], memoryPrefix: id, warmDownSeconds: 300, dir: `/tmp/${id}`, requestedModels: [], approvedModels: [] });

let state: FactoryState;
let base = '';
let close: () => Promise<void>;

before(async () => {
  const access = cloudflareAccessAuth({ teamDomain: TEAM, audience: AUD, adminEmails: [ADMIN], fetchJwks: async () => ({ keys: [jwk] }) });
  state = {
    agents: new Map([['donna', agent('donna')]]),
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
});
after(async () => close());

const as = async (email: string) => {
  const client = new FactoryClient({ baseUrl: base, fetch: viaProxy, credential: async () => assertion(email) });
  const me = await client.whoami();
  const asked: string[] = [];
  const io = { note: () => {}, confirm: async (q: string) => (asked.push(q), true) };
  return { me, asked, run: (line: string, extra: { yes?: boolean; json?: boolean } = {}) => runCommand({ client, roles: me.roles, actor: me.actor, line, io, ...extra }) };
};

/** The read commands, each with arguments that are valid against this factory. */
const READS = ['agents', 'agent donna', 'policy donna', 'status', 'spend', 'report', 'report last', 'compute', 'budgets', 'runs', 'runs donna --limit 5', 'ledger --limit 5', 'ledger donna', 'models', 'skills', 'incidents', 'schedules', 'approvals'];

describe('§6.17 CL11 commands against the real control plane', () => {
  it('CL11 every read command works for a viewer, with no manager, and prints something readable', async () => {
    const { run } = await as(VIEWER);
    const problems: string[] = [];
    const made = state.runs.create({ agentId: 'donna', state: 'DONE', actor: 'test', trigger: 'test' });
    for (const line of [...READS, `run ${made.runId}`]) {
      const out = await run(line);
      if (!out.ok) problems.push(`${line}: ${out.output}`);
      else if (/\[object Object\]|undefined/.test(out.output)) problems.push(`${line}: unreadable output: ${out.output.slice(0, 120)}`);
      else assert.doesNotMatch(out.output, /[\x00-\x08\x0b-\x1f\x7f]/, line);
    }
    assert.deepEqual(problems, []);
  });

  it('CL11 the reads in the list cover every read command there is', () => {
    const covered = new Set([...READS, 'run x'].map((l) => l.split(' ')[0]));
    const reads = COMMANDS.filter((c) => !['budget', 'factory-budget', 'pause', 'resume', 'isolate', 'wake', 'reset', 'cancel', 'retire', 'reinstate', 'approve', 'reject'].includes(c.name));
    assert.deepEqual(reads.filter((c) => !covered.has(c.name)).map((c) => c.name), []);
  });

  it('CL11 --json is valid JSON of the factory\'s own answer', async () => {
    const { run } = await as(VIEWER);
    const out = await run('agents --json');
    const list = JSON.parse(out.output) as Array<{ id: string }>;
    assert.ok(list.some((a) => a.id === 'donna'));
  });

  it('CL3 a viewer cannot change anything through a command, and the factory would refuse too', async () => {
    const { run, me } = await as(VIEWER);
    assert.deepEqual(me.roles, ['viewer']);
    const out = await run('factory-budget total=999 --yes');
    assert.equal(out.ok, false);
    assert.match(out.output, /Your roles do not allow/);
    assert.equal(state.ledger.query({ agent: 'factory' }).filter((r) => r.action === 'FACTORY_BUDGET_SET').length, 0);
  });

  it('CL4 an admin changes a budget by command, after being asked, and it is on the ledger under that person', async () => {
    const { run, asked } = await as(ADMIN);
    const out = await run('factory-budget total=250 alert=0.8,1');
    assert.equal(out.ok, true, out.output);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Run: set_factory_budgets/);
    const row = state.ledger.query({ agent: 'factory' }).find((r) => r.action === 'FACTORY_BUDGET_SET');
    assert.equal(row?.actor, `cloudflare:${ADMIN}`);
    assert.match((await run('budgets')).output, /totalMonthUsd\s+250|250/);
  });

  it('CL4 a command for an agent the person may act on is the factory\'s decision, and its refusal is shown as worded', async () => {
    const { run } = await as(VIEWER);
    const out = await run('pause donna --yes'); // offered to everyone (owners hold it); the factory refuses a viewer
    assert.equal(out.ok, false);
    assert.match(out.output, /HTTP 403/);
  });
});
