import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import {
  ApiKeyStore,
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  PrincipalStore,
  type GrantsDoc,
  type PrincipalsDoc,
} from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { CONTROL_PLANE_ROUTES } from './route-registry.js';
import { createFactoryServer, type FactoryState } from './app.js';
import { loadSkills } from './skills.js';

const SHA = '9'.repeat(40);
const RUNTIME_SHA = 'c'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:memory';
const RUN_KEY = 'memory-run-token-key-0123456789abcdef'; // secret-scan:allow (test fixture)
const TOKENS = { admin: 'tok-memory-admin' } as const; // secret-scan:allow (test fixture)

function identityOnlyBearer(): AuthProvider {
  return {
    name: 'memory-identity',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
      const tok = authorization.slice('Bearer '.length).trim();
      if (tok === TOKENS.admin) return { ok: true, principal: { actor: 'user:admin', roles: [] } };
      return { ok: false, reason: 'unknown token' };
    },
  };
}

const MEMORY_SCOPES = {
  privileges: [
    'agents.converse',
    'mcp.use',
    'agents.read',
    'agents.settings.read',
    'agents.memory.append',
    'agents.memory.read',
  ],
};

describe('edge memory append and summary', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let port = 0;
  let rosieKey: string;

  const call = async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body: body as any, headers: res.headers };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-memory-'));
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });
    await principals.create({ id: 'user:admin', displayName: 'Admin', emails: ['admin@beercanlabs.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger: new MemoryLedger(),
      auth: identityOnlyBearer(),
      principals,
      grants,
      groups,
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(RUN_KEY),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: { 'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      mind: { store: { root: join(dir, 'mind') } },
      deployProvider: {
        buildImage: async (agentId: string, source: { commit: string }) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId: string) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;

    state.keys = await ApiKeyStore.open();
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;

    for (const spec of [
      { id: 'rosie', name: 'Rosie', role: 'Household companion', soul: 'Rosie is a household companion.' },
      { id: 'donna', name: 'Donna', role: 'Executive Assistant', soul: 'Donna is an executive assistant.' },
    ]) {
      const created = await call('POST', '/api/v1/agents', {
        token: TOKENS.admin,
        body: {
          id: spec.id,
          name: spec.name,
          role: spec.role,
          kind: 'team',
          accountableLead: 'user:admin',
          soul: spec.soul,
          memory: { archetype: 'team-member' },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }

    const minted = await call('POST', '/api/v1/keys', {
      token: TOKENS.admin,
      body: { owner: 'agent:rosie', roles: ['operator'], scopes: MEMORY_SCOPES, expiresAt: null },
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    rosieKey = minted.body.secret;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('OpenAPI documents speak-as converse fields and the memory routes', () => {
    const converse = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'agents_converse' || r.pattern === '/api/v1/agents/:id/conversation');
    const body = (converse as { requestBodySchema?: { properties?: Record<string, unknown> } } | undefined)?.requestBodySchema;
    assert.ok(body?.properties?.speaker, 'converse body should list speaker');
    assert.ok(body?.properties?.mode, 'converse body should list mode');
    assert.ok(body?.properties?.channel, 'converse body should list channel');
    assert.ok(body?.properties?.assurance, 'converse body should list assurance');
    assert.ok(body?.properties?.conversationId, 'converse body should list conversationId');
    assert.ok(CONTROL_PLANE_ROUTES.some((r) => r.operationId === 'append_agent_memory_turns'));
    assert.ok(CONTROL_PLANE_ROUTES.some((r) => r.operationId === 'get_agent_memory_summary'));
  });

  it('refuses memory routes on the rosie key until the agent-edge grant exists', async () => {
    const denied = await call('POST', '/api/v1/agents/rosie/memory/turns', {
      token: rosieKey,
      body: { speaker: 'user:dale.sackrider', source: 'reachy-edge', turns: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const grant = await call('POST', '/api/v1/grants', {
      token: TOKENS.admin,
      body: { subject: 'agent:rosie', role: 'agent-edge', scope: { kind: 'agent', id: 'rosie' } },
    });
    assert.ok(grant.status === 200 || grant.status === 201, JSON.stringify(grant.body));
    assert.equal(grant.body.grant?.role ?? grant.body.role, 'agent-edge');
  });

  it('appends finished edge turns without waking a run, then summarizes soul and recent memory', async () => {
    const runsBefore = state.runs.list({ agentId: 'rosie' }).length;
    const appended = await call('POST', '/api/v1/agents/rosie/memory/turns', {
      token: rosieKey,
      body: {
        speaker: 'user:dale.sackrider',
        source: 'reachy-edge',
        channel: 'voice',
        sessionName: 'kitchen chat',
        turns: [
          { role: 'user', content: 'turn on the office lights', timestamp: '2026-11-22T16:00:00.000Z' },
          { role: 'assistant', content: 'I turned on the office lights.', timestamp: '2026-11-22T16:00:02.000Z' },
        ],
      },
    });
    assert.equal(appended.status, 201, JSON.stringify(appended.body));
    assert.equal(appended.body.turnsAppended, 2);
    assert.equal(appended.body.source, 'reachy-edge');
    assert.equal(appended.body.channel, 'voice');
    assert.equal(typeof appended.body.sessionId, 'string');
    assert.equal(state.runs.list({ agentId: 'rosie' }).length, runsBefore, 'append must not start a run');

    const more = await call('POST', '/api/v1/agents/rosie/memory/turns', {
      token: rosieKey,
      body: {
        speaker: 'user:dale.sackrider',
        source: 'reachy-edge',
        sessionId: appended.body.sessionId,
        turns: [{ role: 'user', content: 'how is the frame battery?' }],
      },
    });
    assert.equal(more.status, 201, JSON.stringify(more.body));
    assert.equal(more.body.sessionId, appended.body.sessionId);

    const summary = await call('GET', '/api/v1/agents/rosie/memory/summary', { token: rosieKey });
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.soul, 'Rosie is a household companion.');
    assert.equal(summary.body.memory?.archetype, 'team-member');
    assert.equal(summary.body.notebookStale, undefined);
    assert.ok(Array.isArray(summary.body.recentSessions) && summary.body.recentSessions.length >= 1);
    const session = summary.body.recentSessions.find((s: { id: string }) => s.id === appended.body.sessionId);
    assert.ok(session, 'expected the appended session in the summary');
    assert.equal(session.userId, 'user:dale.sackrider');
    assert.equal(session.turnCount, 3);
    const sources = session.turns.map((t: { source?: string }) => t.source);
    assert.ok(sources.every((s: string) => s === 'reachy-edge'));
    assert.ok(session.turns.some((t: { content: string }) => t.content.includes('office lights')));
    assert.ok(session.turns.some((t: { content: string }) => t.content.includes('frame battery')));
  });

  it('does not let the rosie edge grant write or read another agent\'s notebook', async () => {
    const denied = await call('POST', '/api/v1/agents/donna/memory/turns', {
      token: rosieKey,
      body: { speaker: 'user:dale.sackrider', source: 'reachy-edge', turns: [{ role: 'user', content: 'hi donna' }] },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const summary = await call('GET', '/api/v1/agents/donna/memory/summary', { token: rosieKey });
    assert.equal(summary.status, 403, JSON.stringify(summary.body));
  });

  it('refuses an append with 409 when a live run holds the notebook, without writing', async () => {
    const run = state.runs.create({ agentId: 'rosie', state: 'WORKING', actor: 'agent:rosie', trigger: 'conversation' });
    const blocked = await call('POST', '/api/v1/agents/rosie/memory/turns', {
      token: rosieKey,
      body: { speaker: 'user:dale.sackrider', source: 'reachy-edge', turns: [{ role: 'user', content: 'should not land' }] },
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'notebook_in_use');
    assert.equal(blocked.body.runId, run.runId);
    assert.equal(blocked.headers.get('retry-after'), '15');

    const stale = await call('GET', '/api/v1/agents/rosie/memory/summary', { token: rosieKey });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.notebookStale, true);
    const leaked = JSON.stringify(stale.body).includes('should not land');
    assert.equal(leaked, false);
    state.runs.update(run.runId, { state: 'DONE' });
  });

  it('exposes factory MCP tools for append and summary', async () => {
    const listed = await call('POST', '/mcp/x/agents', {
      token: rosieKey,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.ok(listed.status < 300, JSON.stringify(listed.body));
    const tools = listed.body?.result?.tools ?? [];
    const names = tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('append_agent_memory_turns'), JSON.stringify(names));
    assert.ok(names.includes('get_agent_memory_summary'), JSON.stringify(names));
  });
});
