import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, GrantStore, MemoryDocBackend, PrincipalStore, type GrantsDoc, type PrincipalsDoc } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ModelStore } from './models.js';
import { IdentityLinkStore } from './identity-links.js';
import { GroupStore, VersionedConfigStore, FileConfigBackend } from '@beercanlabs/factory-registrar';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createTreasury } from './spend.js';
import { loadSkills } from './skills.js';
import { SessionStore } from './login.js';
import { TOOLS } from './mcp.js';

const ADMIN = 'admin-expansion-token';
const VIEWER = 'viewer-expansion-token';
const OPERATOR = 'operator-expansion-token';

describe('Headless MCP Neck Expansion (TSK-338, GAP-250, GAP-251, E9, CL6, CL11)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  let tmp = '';
  let adminSid = '';
  let viewerSid = '';
  const secretStore = new Map<string, string>();

  async function mcpCall(
    path: string,
    body: unknown,
    token = ADMIN,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text ? JSON.parse(text) : null,
    };
  }

  async function httpGet(path: string, token = ADMIN, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...headers,
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json };
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-expansion-e2e-'));
    const ledger = new MemoryLedger();
    const treasury = createTreasury({ cloud: undefined, compute: undefined });
    treasury.budgets.set({ totalMonthUsd: 1000 }, 'system');

    const provider = {
      name: 'mem',
      async get(n: string) { return secretStore.get(n); },
      async has(n: string) { return secretStore.has(n); },
      async put(n: string, v: string) { secretStore.set(n, v); },
    };

    const principals = await PrincipalStore.open(new MemoryDocBackend<PrincipalsDoc>());
    await principals.create({ id: 'user:admin', displayName: 'Admin User', emails: ['admin@example.com'], by: 'bootstrap' } as never);
    await principals.create({ id: 'user:viewer', displayName: 'Viewer User', emails: ['viewer@example.com'], by: 'bootstrap' } as never);
    await principals.create({ id: 'user:operator', displayName: 'Operator User', emails: ['operator@example.com'], by: 'bootstrap' } as never);

    const grants = await GrantStore.open(new MemoryDocBackend<GrantsDoc>());
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'bootstrap', granterIsAdmin: true });
    await grants.grant({ subject: 'user:viewer', scope: { kind: 'fleet' }, role: 'viewer', by: 'bootstrap', granterIsAdmin: true });
    await grants.grant({ subject: 'user:operator', scope: { kind: 'fleet' }, role: 'operator', by: 'bootstrap', granterIsAdmin: true });

    const sessions = new SessionStore();
    adminSid = sessions.create('admin@example.com', 'google');
    viewerSid = sessions.create('viewer@example.com', 'google');

    state = {
      agents: new Map([
        ['castle', { id: 'castle', name: 'Castle Defense', state: 'ACTIVE', roles: [], requires: [], owners: ['user:admin', 'admin'] } as any],
        ['agent-test', { id: 'agent-test', name: 'Agent Test', state: 'ACTIVE', roles: [], requires: [], owners: ['user:admin', 'admin'] } as any],
      ]),
      modelStore: new ModelStore(join(tmp, 'catalog.json'), {
        'claude-haiku': { provider: 'bedrockConverse', id: 'haiku-id', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      }),
      defaultModel: 'claude-haiku',
      identityLinks: new IdentityLinkStore(join(tmp, 'identity')),
      groups: new GroupStore(join(tmp, 'groups.json')),
      schedules: new ScheduleStore(join(tmp, 'schedules.json')),
      treasury,
      spend: new SpendTracker(),
      ledger,
      principals,
      grants,
      sessions,
      providers: [provider as any],
      gatekeeperEgressHeldSecrets: new Set(['ANTHROPIC_API_KEY']),
      auth: {
        name: 'expansion-auth',
        async verify(header: string) {
          if (header === `Bearer ${ADMIN}`) return { ok: true, principal: { actor: 'user:admin', roles: ['admin'] } };
          if (header === `Bearer ${VIEWER}`) return { ok: true, principal: { actor: 'user:viewer', roles: ['viewer'] } };
          if (header === `Bearer ${OPERATOR}`) return { ok: true, principal: { actor: 'user:operator', roles: ['operator'] } };
          return { ok: false, reason: 'unknown token' };
        },
      },
      version: '0.1.0',
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('mcp-expansion-token-key-0123456789abc'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      secretValues: new Set(['SECRET_PASS_VAL']),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;

    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(tmp, 'configs')));
    await state.configs.put(
      { agentId: 'castle', source: {}, skills: [], policy: null, owners: ['user:admin', 'token:admin'] },
      { updatedBy: 'test', reason: 'init' },
    );

    loadSkills(state, join(tmp, 'skills'));
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('1. Core toolset default on POST /mcp is <= 40 tools, matches inCore, and 191 total tools in catalog', async () => {
    assert.equal(TOOLS.length, 191);
    const coreCount = TOOLS.filter((t) => (t as any)._meta?.inCore).length;
    assert.ok(coreCount <= 40, `Core tools count must be <= 40, found ${coreCount}`);
    assert.equal(coreCount, 39);

    const res = await mcpCall('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ADMIN);
    assert.equal(res.status, 200);
    const tools = res.body.result?.tools ?? [];
    assert.equal(tools.length, 40);
    for (const t of tools) {
      const match = TOOLS.find((spec) => spec.name === t.name) ?? (t.name === 'grant_role' ? TOOLS.find((spec) => spec.name === 'create_grant') : undefined);
      assert.ok(match, `Tool ${t.name} must exist in catalog`);
      assert.equal((match as any)._meta?.inCore, true);
    }
  });

  it('2. POST /mcp/x/all returns full domain coverage (> 40 tools for admin)', async () => {
    const res = await mcpCall('/mcp/x/all', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ADMIN);
    assert.equal(res.status, 200);
    const tools = res.body.result?.tools ?? [];
    assert.ok(tools.length > 40, `POST /mcp/x/all must return all authorized tools, got ${tools.length}`);
    // Admin has access to 190 tools (191 minus internal ingest)
    assert.ok(tools.length >= 180, `Admin sees almost all 191 tools, got ${tools.length}`);
  });

  it('3. Task-domain toolset selection via URL and X-MCP-Toolsets header', async () => {
    // URL path /mcp/x/schedules
    const schedRes = await mcpCall('/mcp/x/schedules', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ADMIN);
    assert.equal(schedRes.status, 200);
    const schedTools = schedRes.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(schedTools.includes('list_schedules'));
    assert.ok(schedTools.includes('create_schedule'));
    assert.ok(schedTools.includes('delete_schedule'));
    assert.ok(!schedTools.includes('admit_model'));

    // Comma-separated domains /mcp/x/schedules,models
    const comboRes = await mcpCall('/mcp/x/schedules,models', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, ADMIN);
    assert.equal(comboRes.status, 200);
    const comboTools = comboRes.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(comboTools.includes('list_schedules'));
    assert.ok(comboTools.includes('admit_model'));
    assert.ok(!comboTools.includes('create_group'));

    // Staff alias bouncer -> access
    const staffRes = await mcpCall('/mcp/x/bouncer', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, ADMIN);
    assert.equal(staffRes.status, 200);
    const staffTools = staffRes.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(staffTools.includes('authz_check'));

    // Header X-MCP-Toolsets: spend
    const headerRes = await mcpCall('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/list' }, ADMIN, {
      'x-mcp-toolsets': 'spend',
    });
    assert.equal(headerRes.status, 200);
    const headerTools = headerRes.body.result?.tools?.map((t: any) => t.name) ?? [];
    assert.ok(headerTools.includes('get_fleet_spend'));
    assert.ok(!headerTools.includes('admit_model'));

    // Unknown toolset token returns 400
    const errRes = await mcpCall('/mcp/x/bogus_toolset', { jsonrpc: '2.0', id: 6, method: 'tools/list' }, ADMIN);
    assert.equal(errRes.status, 400);
    assert.equal(errRes.body.error, 'unknown_toolset');
  });

  it('4. Read-only MCP view: POST /mcp/readonly and X-MCP-Readonly filter and refuse mutations', async () => {
    // 1. tools/list on /mcp/readonly returns only readOnlyHint tools
    const roList = await mcpCall('/mcp/readonly', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ADMIN);
    assert.equal(roList.status, 200);
    const roTools = roList.body.result?.tools ?? [];
    assert.ok(roTools.length > 0);
    for (const t of roTools) {
      assert.equal(t.annotations?.readOnlyHint, true, `Tool ${t.name} in read-only view must have readOnlyHint: true`);
    }

    // 2. tools/call for mutation on /mcp/readonly refuses with readonly_mcp_view
    const roCall = await mcpCall('/mcp/readonly', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wake_agent', arguments: { id: 'castle' } },
    }, ADMIN);
    assert.equal(roCall.status, 200);
    assert.equal(roCall.body.result?.isError, true);
    assert.equal(roCall.body.result?.structuredContent?.error, 'readonly_mcp_view');

    // 3. Header X-MCP-Readonly: true on /mcp also enforces read-only view
    const headerRoCall = await mcpCall('/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wake_agent', arguments: { id: 'castle' } },
    }, ADMIN, { 'x-mcp-readonly': 'true' });
    assert.equal(headerRoCall.status, 200);
    assert.equal(headerRoCall.body.result?.isError, true);
    assert.equal(headerRoCall.body.result?.structuredContent?.error, 'readonly_mcp_view');
  });

  it('5. Newly expanded domains: Schedules CRUD in-process dispatch', async () => {
    // 1. Create schedule
    const createRes = await mcpCall('/mcp/x/schedules', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_schedule',
        arguments: {
          agentId: 'castle',
          cron: '0 0 * * *',
          prompt: 'Run daily security audit',
        },
      },
    }, ADMIN);
    assert.equal(createRes.status, 200);
    assert.equal(createRes.body.result?.isError, undefined);
    const createdSched = JSON.parse(createRes.body.result?.content?.[0]?.text);
    const schedId = createdSched.schedule?.id ?? createdSched.id;
    assert.ok(schedId);

    // 2. List schedules
    const listRes = await mcpCall('/mcp/x/schedules', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_schedules', arguments: { agentId: 'castle' } },
    }, ADMIN);
    assert.equal(listRes.status, 200);
    const listed = JSON.parse(listRes.body.result?.content?.[0]?.text);
    assert.ok(listed.schedules.some((s: any) => s.id === schedId));

    // 3. Delete schedule
    const delRes = await mcpCall('/mcp/x/schedules', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delete_schedule', arguments: { id: schedId } },
    }, ADMIN);
    assert.equal(delRes.status, 200);
  });

  it('6. Newly expanded domains: Spend budgets, reports, and ledger verify', async () => {
    // 1. Get spend budgets
    const budgetRes = await mcpCall('/mcp/x/spend', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_spend_budgets', arguments: {} },
    }, ADMIN);
    assert.equal(budgetRes.status, 200);
    const budgets = JSON.parse(budgetRes.body.result?.content?.[0]?.text);
    assert.ok(budgets.current || Array.isArray(budgets.history));

    // 2. Get fleet spend report
    const spendRes = await mcpCall('/mcp/x/spend', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_fleet_spend', arguments: {} },
    }, ADMIN);
    assert.equal(spendRes.status, 200);

    // 3. Verify ledger integrity over MCP
    const verifyRes = await mcpCall('/mcp/x/observe', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'verify_ledger', arguments: {} },
    }, ADMIN);
    assert.equal(verifyRes.status, 200);
    const verified = JSON.parse(verifyRes.body.result?.content?.[0]?.text);
    assert.equal(verified.ok, true);
  });

  it('7. Danger toolset safety: requires explicit confirm argument matching target', async () => {
    // purge_agent without confirm -> 400
    const refusePurge = await mcpCall('/mcp/x/danger', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'purge_agent', arguments: { id: 'agent-test' } },
    }, ADMIN);
    assert.equal(refusePurge.status, 200);
    assert.equal(refusePurge.body.result?.isError, true);
    assert.equal(refusePurge.body.result?.structuredContent?.error, 'confirmation_required');
  });

  it('8. Human-decision safeguards: challenges, 403 on unauthorized deciders, and confirmation execution', async () => {
    // Create a pending approval
    const run = state.runs.create({ agentId: 'castle', state: 'WORKING', actor: 'test', trigger: 'manual' });
    const { approval: appr } = state.approvals.request({ runId: run.runId, agentId: 'castle', route: 'r', tool: 't', argsSha256: 'a'.repeat(64) });

    // 1. Unauthorized caller (viewer) gets immediate 403 refusal without challenge
    const viewerCall = await mcpCall('/mcp/x/all', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'decide_approval', arguments: { approvalId: appr.approvalId, decision: 'approve' } },
    }, VIEWER);
    assert.equal(viewerCall.status, 200);
    assert.equal(viewerCall.body.result?.isError, true);
    assert.equal(viewerCall.body.result?.structuredContent?.error, 'forbidden');

    // 2. Authorized caller (admin) gets human_confirmation_required challenge
    const adminCall = await mcpCall('/mcp/x/all', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'decide_approval', arguments: { approvalId: appr.approvalId, decision: 'approve' } },
    }, ADMIN, { 'x-mcp-client-id': 'test-desk' });
    assert.equal(adminCall.status, 200);
    const challengeData = adminCall.body.result?.structuredContent;
    assert.equal(challengeData?.status, 'human_confirmation_required');
    assert.ok(challengeData?.challengeId);
    assert.ok(challengeData?.confirmationUrl);

    // E9 Invariant Checks:
    // a) Calling confirmationUrl with Bearer token is refused with 401 session_required
    const bearerRefused = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(bearerRefused.status, 401);

    // b) Calling confirmationUrl without session is refused with 401
    const unauthRefused = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'GET',
    });
    assert.equal(unauthRefused.status, 401);

    // c) Calling confirmationUrl with different principal's session is refused with 403
    const wrongPrincipalRefused = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'GET',
      headers: { cookie: `factory_session=${viewerSid}` },
    });
    assert.equal(wrongPrincipalRefused.status, 403);

    // d) GET confirmation page with exact same principal's session returns 200 HTML
    const getHtml = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'GET',
      headers: {
        cookie: `factory_session=${adminSid}`,
        accept: 'text/html',
      },
    });
    assert.equal(getHtml.status, 200);
    const htmlText = await getHtml.text();
    assert.match(htmlText, /Confirm MCP Operation/);

    // e) POST confirmation without same-origin CSRF is refused
    const csrfRefused = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'POST',
      headers: {
        cookie: `factory_session=${adminSid}`,
        origin: 'https://evil.attacker.com',
      },
    });
    assert.equal(csrfRefused.status, 401);

    // f) POST confirmation executes decision and records via: mcp:<clientId> in ledger
    const confirmRes = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'POST',
      headers: {
        cookie: `factory_session=${adminSid}`,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(confirmRes.status, 200);
    const confirmJson = await confirmRes.json() as any;
    assert.equal(confirmJson.result?.state, 'approved');

    const lastEvent = state.ledger.events[state.ledger.events.length - 1];
    assert.equal(lastEvent.via, 'mcp:test-desk');

    // g) Challenge is single-use: replay returns 410
    const replayRes = await fetch(`http://127.0.0.1:${port}${challengeData.confirmationUrl}`, {
      method: 'POST',
      headers: {
        cookie: `factory_session=${adminSid}`,
        origin: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(replayRes.status, 410);
  });

  it('9. Session-bound secret handoffs: no plaintext secrets accepted over MCP', async () => {
    // Calling a handoff tool returns handoff_required
    const handoffRes = await mcpCall('/mcp/x/credentials', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'set_platform_credential', arguments: { name: 'ANTHROPIC_API_KEY', value: 'sk-secret' } },
    }, ADMIN, { 'x-mcp-client-id': 'desk-sec' });
    assert.equal(handoffRes.status, 200);
    const handoffData = handoffRes.body.result?.structuredContent;
    assert.equal(handoffData?.status, 'handoff_required');
    assert.ok(handoffData?.handoffId);
    assert.ok(handoffData?.handoffUrl);

    // Calling with Bearer token is 401
    const bearerRefused = await fetch(`http://127.0.0.1:${port}${handoffData.handoffUrl}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(bearerRefused.status, 401);

    // Calling with wrong session is 403
    const wrongRefused = await fetch(`http://127.0.0.1:${port}${handoffData.handoffUrl}`, {
      method: 'GET',
      headers: { cookie: `factory_session=${viewerSid}` },
    });
    assert.equal(wrongRefused.status, 403);

    // GET handoff page returns HTML form
    const getHandoff = await fetch(`http://127.0.0.1:${port}${handoffData.handoffUrl}`, {
      method: 'GET',
      headers: {
        cookie: `factory_session=${adminSid}`,
        accept: 'text/html',
      },
    });
    assert.equal(getHandoff.status, 200);
    const handoffHtml = await getHandoff.text();
    assert.match(handoffHtml, /MCP Secret Handoff/);

    // POST secret handoff securely configures credential with via: mcp:desk-sec
    const deliveredValue = ['sample', 'mock', 'cred', 'handoff', '9876'].join('-');
    const postSecret = await fetch(`http://127.0.0.1:${port}${handoffData.handoffUrl}`, {
      method: 'POST',
      headers: {
        cookie: `factory_session=${adminSid}`,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: deliveredValue }),
    });
    assert.ok(postSecret.status === 200 || postSecret.status === 201);
    const postJson = await postSecret.json() as any;
    assert.equal(postJson.ok, true);
    assert.ok(!JSON.stringify(postJson).includes(deliveredValue), 'Secret value never echoed');

    // Keymaster received the secret
    assert.equal(secretStore.get('ANTHROPIC_API_KEY'), deliveredValue);
    assert.ok(state.secretValues.has(deliveredValue));

    const lastEvent = state.ledger.events[state.ledger.events.length - 1];
    assert.equal(lastEvent.via, 'mcp:desk-sec');

    // Replay returns 410
    const replayHandoff = await fetch(`http://127.0.0.1:${port}${handoffData.handoffUrl}`, {
      method: 'POST',
      headers: {
        cookie: `factory_session=${adminSid}`,
        origin: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(replayHandoff.status, 410);
  });

  it('10. Conversational agent surface: POST /mcp/agents/:id', async () => {
    // 1. tools/list on /mcp/agents/:id returns exactly the 3 conversational tools
    const listRes = await mcpCall('/mcp/agents/castle', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }, ADMIN);
    assert.equal(listRes.status, 200);
    const tools = listRes.body.result?.tools?.map((t: any) => t.name).sort() ?? [];
    assert.deepEqual(tools, ['ask', 'get_agent_info', 'get_replies']);

    // 2. Calling get_agent_info returns agent status
    const infoRes = await mcpCall('/mcp/agents/castle', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_agent_info', arguments: {} },
    }, ADMIN);
    assert.equal(infoRes.status, 200);
    const info = JSON.parse(infoRes.body.result?.content?.[0]?.text);
    assert.equal(info.id, 'castle');
    assert.equal(info.name, 'Castle Defense');

    // 3. Calling ask posts a conversational message to the agent
    const askRes = await mcpCall('/mcp/agents/castle', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ask', arguments: { message: 'Hello agent, status check please', waitSeconds: 0 } },
    }, ADMIN);
    assert.equal(askRes.status, 200);
    const askOutput = JSON.parse(askRes.body.result?.content?.[0]?.text);
    assert.ok(askOutput.status === 'turn_queued' || askOutput.status === 'reply_received' || askOutput.runId);

    // 4. Calling get_replies returns conversation replies array
    const repliesRes = await mcpCall('/mcp/agents/castle', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_replies', arguments: { after: 0 } },
    }, ADMIN);
    assert.equal(repliesRes.status, 200);
    const replies = JSON.parse(repliesRes.body.result?.content?.[0]?.text);
    assert.ok(Array.isArray(replies.replies));
  });
});
