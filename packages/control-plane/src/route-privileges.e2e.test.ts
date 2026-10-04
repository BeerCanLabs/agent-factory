// DESIGN_AUTHORITY.md GAP-087, TSK-099: a characterization of who may call every control-plane route today (the
// privilege census). For each credential (a token for each of the six roles, and none) it asserts whether a request is
// 401, 403 or neither (any other status means the request passed authentication and authorization, whatever the handler
// then says), and on a 403 which role the answer names. It passes before and after routes ask the Bouncer.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens, type Role } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { EventHub } from './events.js';
import { attachEventStream } from './stream.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';

const ROLES: Role[] = ['viewer', 'operator', 'approver', 'ingest', 'gatekeeper-egress', 'admin'];
const TOKEN = (r: Role) => `${r}-route-privileges-e2e`;
type Credential = Role | 'none';
const CREDENTIALS: Credential[] = ['none', ...ROLES];

// The old rule (`hasRole` in auth), copied: this file must not depend on it, because it is deleted later.
function oldHasRole(roles: Role[], role: Role): boolean {
  if (roles.includes('admin') || roles.includes(role)) return true;
  if (role === 'viewer') return roles.includes('operator') || roles.includes('approver');
  if (role === 'ingest') return roles.includes('gatekeeper-egress');
  return false;
}

type RouteRow = {
  method: string;
  path: string;
  /** The privilege the route asks the Bouncer for (the census). */
  privilege: string;
  /** The role the route names today. */
  role: Role;
  /** A role the route asks for first, before `role` (the schedule routes ask for a viewer, then for an operator). */
  firstRole?: Role;
  /** `gatekeeper-egress` only: an admin gets a 403 after authentication. */
  exclusive?: boolean;
  body?: unknown;
};

// Asked outside a row: the WebSocket upgrade and the ledger's attestation of the run as the actor.
const WEBSOCKET = { privilege: 'events.subscribe', role: 'viewer' as Role };
const ATTESTATION = { privilege: 'ledger.attest-run-actor', role: 'gatekeeper-egress' as Role };

const SKILL = 'x';
const ROUTES: RouteRow[] = [
  // viewer
  { method: 'GET', path: '/api/v1/agents', privilege: 'agents.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/registry/agents', privilege: 'agents.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/registry/agents/castle', privilege: 'agents.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/agents/castle/policy', privilege: 'policy.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/agents/castle/config', privilege: 'config.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/agents/castle/config/history', privilege: 'config.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/agents/castle/config/versions/1', privilege: 'config.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/runs', privilege: 'runs.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/runs/nope', privilege: 'runs.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/ledger', privilege: 'ledger.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/ledger/verify', privilege: 'ledger.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/models', privilege: 'models.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/metrics', privilege: 'metrics.read', role: 'viewer' },
  { method: 'GET', path: '/metrics', privilege: 'metrics.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/triage', privilege: 'triage.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/spend', privilege: 'spend.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/approvals', privilege: 'approvals.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/skills', privilege: 'skills.read', role: 'viewer' },
  { method: 'GET', path: `/api/v1/skills/${SKILL}`, privilege: 'skills.read', role: 'viewer' },
  { method: 'GET', path: `/api/v1/skills/${SKILL}/versions/1`, privilege: 'skills.read', role: 'viewer' },
  { method: 'POST', path: '/api/v1/registry/skills', privilege: 'skills.register', role: 'viewer', body: {} },
  { method: 'GET', path: '/api/v1/systems', privilege: 'systems.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/systems/nope', privilege: 'systems.read', role: 'viewer' },
  { method: 'POST', path: '/api/v1/systems', privilege: 'systems.propose', role: 'viewer', body: {} },
  { method: 'GET', path: '/api/v1/connections/castle', privilege: 'connections.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/keymaster/providers/p/client', privilege: 'credentials.provider.read', role: 'viewer' },
  { method: 'GET', path: '/api/v1/schedules', privilege: 'schedules.read', role: 'viewer' },
  { method: 'POST', path: '/mcp', privilege: 'mcp.use', role: 'viewer', body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
  // operator
  { method: 'POST', path: '/api/v1/agents/nope/runs', privilege: 'agents.wake', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/agents/nope/wake', privilege: 'agents.wake', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/agents/nope/pause', privilege: 'agents.pause', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/agents/nope/resume', privilege: 'agents.resume', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/agents/nope/isolate', privilege: 'agents.isolate', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/runs/nope/cancel', privilege: 'runs.cancel', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/agents/nope/conversation', privilege: 'agents.converse', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/hooks/hooked', privilege: 'hooks.invoke', role: 'operator', body: {} },
  { method: 'POST', path: '/api/v1/schedules', privilege: 'schedules.write', role: 'operator', firstRole: 'viewer', body: {} },
  { method: 'DELETE', path: '/api/v1/schedules/nope', privilege: 'schedules.write', role: 'operator', firstRole: 'viewer' },
  // approver
  { method: 'POST', path: '/api/v1/approvals/nope', privilege: 'approvals.decide', role: 'approver', body: { decision: 'approved' } },
  // ingest
  { method: 'POST', path: '/api/v1/ledger', privilege: 'ledger.ingest', role: 'ingest', body: {} },
  // gatekeeper-egress
  { method: 'GET', path: '/api/v1/gatekeeper-egress/runs/nope', privilege: 'egress.run.read', role: 'gatekeeper-egress' },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/approvals', privilege: 'egress.approvals.request', role: 'gatekeeper-egress', body: {} },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/holds', privilege: 'egress.holds.create', role: 'gatekeeper-egress', body: {} },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/approvals/nope/consume', privilege: 'egress.approvals.consume', role: 'gatekeeper-egress', body: {} },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/keymaster/checkout', privilege: 'egress.keymaster.checkout', role: 'gatekeeper-egress', body: {} },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/progress', privilege: 'egress.progress.report', role: 'gatekeeper-egress', body: {} },
  { method: 'GET', path: '/api/v1/gatekeeper-egress/routes', privilege: 'egress.routes.read', role: 'gatekeeper-egress' },
  { method: 'POST', path: '/api/v1/gatekeeper-egress/connections/token', privilege: 'egress.connections.token', role: 'gatekeeper-egress', exclusive: true, body: {} },
  // admin
  { method: 'POST', path: '/api/v1/registry/agents', privilege: 'registry.register', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/registry/agents/nope/budget', privilege: 'registry.budget.set', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/retire', privilege: 'registry.retire', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/reinstate', privilege: 'registry.reinstate', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/purge', privilege: 'registry.purge', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/deploy', privilege: 'registry.deploy', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/model', privilege: 'registry.model.set', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/registry/agents/nope/model', privilege: 'registry.model.set', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/registry/agents/nope/models/approve', privilege: 'registry.model.set', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/agents/nope/policy', privilege: 'policy.set', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/policies/budget', privilege: 'policy.budget.set', role: 'admin', body: {} },
  { method: 'GET', path: '/api/v1/config/export', privilege: 'config.export', role: 'admin' },
  { method: 'GET', path: '/api/v1/config/export?agent=castle', privilege: 'config.export.agent', role: 'admin' },
  { method: 'PUT', path: '/api/v1/agents/nope/owners', privilege: 'agents.owners.set', role: 'admin', body: {} },
  { method: 'GET', path: '/api/v1/keymaster/outstanding', privilege: 'credentials.outstanding.read', role: 'admin' },
  { method: 'GET', path: '/api/v1/keymaster/platform/credentials', privilege: 'credentials.platform.read', role: 'admin' },
  { method: 'POST', path: '/api/v1/keymaster/platform/credentials/n', privilege: 'credentials.platform.set', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/keymaster/platform/credentials/n', privilege: 'credentials.platform.set', role: 'admin', body: {} },
  { method: 'GET', path: '/api/v1/keymaster/agents/castle/credentials', privilege: 'credentials.agent.read', role: 'admin' },
  { method: 'POST', path: '/api/v1/keymaster/agents/castle/credentials/n', privilege: 'credentials.agent.set', role: 'admin', body: {} },
  { method: 'PUT', path: '/api/v1/keymaster/agents/castle/credentials/n', privilege: 'credentials.agent.set', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/keymaster/providers/p/client', privilege: 'credentials.provider.set', role: 'admin', body: {} },
  { method: 'GET', path: '/api/v1/connections/castle/p/start', privilege: 'connections.start', role: 'admin' },
  { method: 'POST', path: '/api/v1/connections/castle/p/import', privilege: 'connections.import', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/systems/nope/approve', privilege: 'systems.decide', role: 'admin', body: {} },
  { method: 'POST', path: '/api/v1/systems/nope/reject', privilege: 'systems.decide', role: 'admin', body: {} },
  { method: 'POST', path: `/api/v1/registry/skills/${SKILL}/versions/1/approve`, privilege: 'skills.decide', role: 'admin', body: {} },
  { method: 'POST', path: `/api/v1/registry/skills/${SKILL}/versions/1/reject`, privilege: 'skills.decide', role: 'admin', body: {} },
  { method: 'POST', path: `/api/v1/registry/skills/${SKILL}/versions/1/checks`, privilege: 'skills.checks.run', role: 'admin', body: {} },
];

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, method: string, path: string, cred: Credential, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cred === 'none' ? {} : { authorization: `Bearer ${TOKEN(cred)}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as Record<string, unknown> | null };
}

/** The WebSocket upgrade: 101 (it upgraded) or the status line it refused with. */
function upgrade(port: number, cred: Credential): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/events',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('route-privileges').toString('base64'),
        ...(cred === 'none' ? {} : { authorization: `Bearer ${TOKEN(cred)}` }),
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(401));
    req.end();
  });
}

describe('who may call each route (GAP-087, TSK-099)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth(ROLES.map((r) => ({ name: r, token: TOKEN(r), roles: [r] }))),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('route-privileges-e2e-run-token-key-0123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;
    state.agents.set('castle', { id: 'castle', name: 'Castle', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: '/agents/castle' } as never);
    state.agents.set('hooked', { id: 'hooked', name: 'Hooked', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [{ type: 'webhook' }], dir: '/agents/hooked' } as never);
    state.agents.set('secret-hook', { id: 'secret-hook', name: 'Secret hook', role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [{ type: 'webhook', secretRef: 'HOOK_SECRET' }], dir: '/agents/secret-hook' } as never);
    cp = createFactoryServer(state);
    attachEventStream(cp, state, new EventHub());
    port = await listen(cp);
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('covers every route of the census', () => {
    assert.ok(ROUTES.length >= 59);
  });

  it('each route is 401 without a credential, and for a credential 403 (naming its role) or neither', async () => {
    const failures: string[] = [];
    for (const row of ROUTES) {
      for (const cred of CREDENTIALS) {
        const roles: Role[] = cred === 'none' ? [] : [cred];
        const r = await call(port, row.method, row.path, cred, row.body);
        const label = `${row.method} ${row.path} as ${cred}: ${r.status}`;
        if (cred === 'none') {
          if (r.status !== 401) failures.push(`${label} (want 401)`);
          continue;
        }
        const allowed = row.exclusive ? cred === 'gatekeeper-egress' : oldHasRole(roles, row.role);
        const named = row.firstRole && !oldHasRole(roles, row.firstRole) ? row.firstRole : row.role;
        if (allowed) {
          if (r.status === 401 || r.status === 403) failures.push(`${label} (want it to pass)`);
        } else if (r.status !== 403 || r.body?.error !== 'forbidden' || r.body?.required !== named) {
          failures.push(`${label} ${JSON.stringify(r.body)} (want 403 requiring ${named})`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it('the WebSocket upgrade needs a viewer, an operator, an approver or an admin', async () => {
    for (const cred of CREDENTIALS) {
      const status = await upgrade(port, cred);
      const expected = cred !== 'none' && oldHasRole([cred], WEBSOCKET.role) ? 101 : 401;
      assert.equal(status, expected, `/api/v1/events as ${cred}`);
    }
  });

  it('public routes and the OAuth callback answer every credential alike, and whoami needs only a verified principal', async () => {
    for (const path of ['/ui', '/healthz', '/', '/api/v1/health', '/api/v1/connections/p/callback']) {
      for (const cred of CREDENTIALS) {
        const r = await call(port, 'GET', path, cred);
        assert.ok(r.status !== 401 && r.status !== 403, `${path} as ${cred}: ${r.status}`);
      }
    }
    for (const cred of CREDENTIALS) {
      const r = await call(port, 'GET', '/api/v1/whoami', cred);
      assert.equal(r.status, cred === 'none' ? 401 : 200, `whoami as ${cred}`);
    }
  });

  it('the webhook with a secretRef and the run-token routes ignore roles: every credential is refused alike', async () => {
    const rows = [
      { method: 'POST', path: '/api/v1/hooks/secret-hook', body: {} },
      { method: 'GET', path: '/api/v1/runs/nope/input' },
      { method: 'POST', path: '/api/v1/runs/nope/result', body: {} },
      { method: 'POST', path: '/api/v1/runs/nope/heartbeat', body: {} },
      { method: 'GET', path: '/api/v1/runs/nope/mailbox' },
      { method: 'GET', path: '/api/v1/runs/nope/events' },
      { method: 'POST', path: '/api/v1/keymaster/checkout', body: {} },
    ];
    for (const row of rows) {
      const none = await call(port, row.method, row.path, 'none', row.body);
      assert.ok(none.status === 401 || none.status === 400, `${row.method} ${row.path} without a credential: ${none.status}`);
      for (const cred of ROLES) {
        const r = await call(port, row.method, row.path, cred, row.body);
        assert.equal(r.status, none.status, `${row.method} ${row.path} as ${cred}`);
      }
    }
  });

  it('MCP lists the tools a role may call and names the role a forbidden call needs', async () => {
    const rpc = async (cred: Role, method: string, params?: unknown) => (await call(port, 'POST', '/mcp', cred, { jsonrpc: '2.0', id: 1, method, params })).body as {
      result?: { tools?: Array<{ name: string }> };
      error?: { code: number; message: string };
    };
    const names = async (cred: Role) => (await rpc(cred, 'tools/list')).result?.tools?.map((t) => t.name).sort();
    const viewerTools = ['get_run', 'list_agents', 'list_approvals', 'query_ledger'];
    const operatorTools = ['isolate_agent', 'pause_agent', 'resume_agent', 'wake_agent'];
    assert.deepEqual(await names('viewer'), viewerTools);
    assert.deepEqual(await names('operator'), [...viewerTools, ...operatorTools].sort());
    assert.deepEqual(await names('approver'), [...viewerTools, 'decide_approval'].sort());
    assert.deepEqual(await names('admin'), [...viewerTools, ...operatorTools, 'decide_approval'].sort());
    assert.deepEqual(await names('ingest'), undefined);
    assert.equal((await rpc('viewer', 'tools/call', { name: 'wake_agent', arguments: { id: 'castle' } })).error?.message, 'forbidden: requires operator');
    assert.equal((await rpc('operator', 'tools/call', { name: 'decide_approval', arguments: {} })).error?.message, 'forbidden: requires approver');
    assert.equal((await rpc('viewer', 'tools/call', { name: 'list_agents' })).error, undefined);
  });

  it(`only the ${ATTESTATION.role} role may attest the run as the actor on a ledger write; an admin may not`, async () => {
    const run = state.runs.create({ agentId: 'castle', state: 'WORKING', actor: 'test', trigger: 'discord' });
    const event = { agentId: 'castle', type: 'action', action: 'ATTEST_TEST', runId: run.runId, actor: 'run:castle' };
    const asEgress = await call(port, 'POST', '/api/v1/ledger', ATTESTATION.role, event);
    assert.ok(asEgress.status < 300, `egress: ${asEgress.status}`);
    const asAdmin = await call(port, 'POST', '/api/v1/ledger', 'admin', event);
    assert.ok(asAdmin.status < 300, `admin: ${asAdmin.status}`);
    const actors = state.ledger.query({ agent: 'castle' }).filter((e) => e.action === 'ATTEST_TEST').map((e) => e.actor);
    assert.deepEqual(actors, ['run:castle', 'token:admin']);
    const wrongRun = await call(port, 'POST', '/api/v1/ledger', 'gatekeeper-egress', { ...event, runId: 'nope' });
    assert.equal(wrongRun.status, 400);
    assert.equal(wrongRun.body?.error, 'runId does not belong to agentId');
  });
});
