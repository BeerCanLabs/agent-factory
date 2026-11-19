// DESIGN_AUTHORITY.md §5 (TSK-337), GAP-248, CL3, CL6, CL11, S1, D23: MCP Protocol Compliance, Refusal Clarity & Error Refactoring
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_PLANE_ROUTES,
  getMcpSchemaCatalog,
} from '@beercanlabs/factory-control-plane/routes';
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  TOOLS,
  handleMcp,
  handleAgentMcp,
  parseToolsetTokens,
  redactMcpResponse,
} from '@beercanlabs/factory-control-plane/mcp';

describe('MCP Protocol Compliance & Conformance (TSK-337, GAP-248, CL3, CL6, CL11, S1, D23)', () => {
  it('route registry registers POST /mcp and POST /mcp/run with required contracts and status codes', () => {
    const mcpRoute = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/mcp');
    assert.ok(mcpRoute, 'POST /mcp must be registered');
    assert.deepEqual(mcpRoute.statusCodes, [200, 202], 'POST /mcp statusCodes must be [200, 202]');
    assert.equal(mcpRoute.mcpExposure, 'internal');

    const runMcpRoute = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/mcp/run');
    assert.ok(runMcpRoute, 'POST /mcp/run must be registered');
    assert.equal(runMcpRoute.operationId, 'invoke_run_mcp');
    assert.equal(runMcpRoute.staff, 'property-manager');
    assert.equal(runMcpRoute.exception, 'run-token');
    assert.equal(runMcpRoute.mcpExposure, 'internal');
    assert.deepEqual(runMcpRoute.statusCodes, [200, 202], 'POST /mcp/run statusCodes must be [200, 202]');
    assert.ok(runMcpRoute.requestBodySchema, 'POST /mcp/run must declare requestBodySchema');
  });

  it('CL6 & GAP-248: no tool in TOOLS or McpSchemaCatalog exposes actAs or onBehalfOf', () => {
    for (const tool of TOOLS) {
      const props = Object.keys(tool.args || {});
      assert.ok(!props.includes('actAs'), `Tool ${tool.name} must not declare actAs in args`);
      assert.ok(!props.includes('onBehalfOf'), `Tool ${tool.name} must not declare onBehalfOf in args`);
    }

    const catalog = getMcpSchemaCatalog();
    for (const tool of catalog.tools) {
      const props = Object.keys(tool.inputSchema.properties || {});
      assert.ok(!props.includes('actAs'), `Catalog tool ${tool.name} must not declare actAs in inputSchema`);
      assert.ok(!props.includes('onBehalfOf'), `Catalog tool ${tool.name} must not declare onBehalfOf in inputSchema`);
    }
  });

  it('MCP protocol versions and tool annotations adhere to MCP specification', () => {
    assert.ok(SUPPORTED_MCP_PROTOCOL_VERSIONS.includes('2025-11-25'));
    assert.ok(SUPPORTED_MCP_PROTOCOL_VERSIONS.includes('2025-06-18'));
    assert.ok(SUPPORTED_MCP_PROTOCOL_VERSIONS.includes('2025-03-26'));
    assert.ok(SUPPORTED_MCP_PROTOCOL_VERSIONS.includes('2024-11-05'));

    for (const tool of TOOLS) {
      assert.ok(typeof tool.title === 'string' && tool.title.length > 0, `Tool ${tool.name} must have a title`);
      assert.ok(tool.annotations, `Tool ${tool.name} must declare annotations`);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `Tool ${tool.name} readOnlyHint must be boolean`);
      assert.equal(typeof tool.annotations.destructiveHint, 'boolean', `Tool ${tool.name} destructiveHint must be boolean`);
      assert.equal(typeof tool.annotations.idempotentHint, 'boolean', `Tool ${tool.name} idempotentHint must be boolean`);
      assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `Tool ${tool.name} openWorldHint must be boolean`);
    }
  });

  it('MCP initialize negotiates supported protocol versions and advertises capabilities', async () => {
    const mockState: any = { version: '0.1.0', secretValues: new Set(), agents: new Map() };
    const adminPrincipal = { actor: 'alice', roles: ['admin'] };

    // Negotiated to requested supported version
    const resSupported = (await handleMcp(
      mockState,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      adminPrincipal,
    )) as any;
    assert.equal(resSupported.jsonrpc, '2.0');
    assert.equal(resSupported.id, 1);
    const resultSupported = resSupported.result as any;
    assert.equal(resultSupported.protocolVersion, '2024-11-05');
    assert.deepEqual(resultSupported.capabilities, { tools: { listChanged: false } });

    // Fallback to latest supported version for unsupported version
    const resUnsupported = (await handleMcp(
      mockState,
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      adminPrincipal,
    )) as any;
    const resultUnsupported = resUnsupported.result as any;
    assert.equal(resultUnsupported.protocolVersion, '2025-11-25');
  });

  it('CL6 & GAP-248: tools/call strictly rejects actAs and onBehalfOf with refusal', async () => {
    const mockState: any = { version: '0.1.0', secretValues: new Set(), agents: new Map() };
    const adminPrincipal = { actor: 'alice', roles: ['admin'] };

    const resActAs = (await handleMcp(
      mockState,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_agents', arguments: { actAs: 'bob' } },
      },
      adminPrincipal,
    )) as any;

    assert.equal(resActAs.jsonrpc, '2.0');
    assert.equal(resActAs.id, 10);
    assert.equal(resActAs.error, undefined);
    const result = resActAs.result as any;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error, 'act_as_forbidden_over_mcp');
  });

  it('CL3: domain and authorization refusals return result.isError === true instead of JSON-RPC -32001', async () => {
    const mockState: any = {
      version: '0.1.0',
      secretValues: new Set(),
      agents: new Map([['castle', { id: 'castle', name: 'castle', status: 'RUNNING' }]]),
    };
    const viewerPrincipal = { actor: 'bob', roles: ['viewer'] };

    // Viewer calling operator tool wake_agent
    const resForbidden = (await handleMcp(
      mockState,
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'wake_agent', arguments: { id: 'castle' } },
      },
      viewerPrincipal,
    )) as any;

    assert.equal(resForbidden.jsonrpc, '2.0');
    assert.equal(resForbidden.id, 20);
    // Under CL3, JSON-RPC error MUST NOT be populated for domain/bouncer refusals
    assert.equal(resForbidden.error, undefined);
    const result = resForbidden.result as any;
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /forbidden/);
    assert.equal(result.structuredContent?.error, 'forbidden');
  });

  it('G3 & D23: tools/list enforces keyScopes parity so scoped keys see only allowed tools', async () => {
    const mockState: any = {
      version: '0.1.0',
      secretValues: new Set(),
      agents: new Map([
        ['castle', { id: 'castle', name: 'castle', status: 'RUNNING' }],
        ['higgins', { id: 'higgins', name: 'higgins', status: 'RUNNING' }],
      ]),
    };

    // Privilege-scoped key (e.g. agents.read only)
    const readScopedPrincipal = {
      actor: 'app-service',
      roles: ['admin'],
      keyScopes: { privileges: ['agents.read'] },
    };

    const resScoped = (await handleMcp(
      mockState,
      { jsonrpc: '2.0', id: 30, method: 'tools/list' },
      readScopedPrincipal,
    )) as any;
    const listedTools = (resScoped.result as any).tools.map((t: any) => t.name);

    assert.ok(listedTools.includes('list_agents'), 'Should list list_agents for agents.read scope');
    assert.ok(!listedTools.includes('grant_role'), 'Must not list grant_role for agents.read scoped key');
    assert.ok(!listedTools.includes('set_fleet_state'), 'Must not list set_fleet_state for agents.read scoped key');

    // Agent-scoped key (scoped to higgins only)
    const agentScopedPrincipal = {
      actor: 'higgins-service',
      roles: ['operator'],
      keyScopes: { agents: ['higgins'] },
    };
    const resAgentScoped = (await handleMcp(
      mockState,
      { jsonrpc: '2.0', id: 31, method: 'tools/list' },
      agentScopedPrincipal,
    )) as any;
    const agentTools = (resAgentScoped.result as any).tools.map((t: any) => t.name);
    assert.ok(agentTools.includes('wake_agent'), 'Should list wake_agent for agent-scoped operator');
    assert.ok(!agentTools.includes('set_fleet_state'), 'Must not list set_fleet_state for agent-scoped key');
  });

  it('S1: secret values from state and credential patterns are redacted across all MCP outputs', () => {
    const secrets = new Set(['my-super-secret-password-xyz']);
    const rawResult = {
      content: [
        {
          type: 'text',
          text: 'Found secret my-super-secret-password-xyz and key fk_live_abcdef1234567890 along with ghp_123456789012345678901234567890123456', // secret-scan:allow (test fixture)
        },
      ],
      structuredContent: {
        raw: 'my-super-secret-password-xyz',
        token: 'fk_test_98765432101234567890', // secret-scan:allow (test fixture)
      },
    };

    const res = redactMcpResponse({ jsonrpc: '2.0', id: 1, result: rawResult }, secrets) as any;
    const redacted = res.result;
    assert.ok(!JSON.stringify(redacted).includes('my-super-secret-password-xyz'), 'Known secret must be redacted');
    assert.ok(!JSON.stringify(redacted).includes('fk_live_abcdef1234567890'), 'fk_ credential pattern must be redacted'); // secret-scan:allow (test fixture)
    assert.ok(!JSON.stringify(redacted).includes('ghp_123456789012345678901234567890123456'), 'ghp_ credential pattern must be redacted'); // secret-scan:allow (test fixture)
    assert.ok(!JSON.stringify(redacted).includes('fk_test_98765432101234567890'), 'fk_ in structuredContent must be redacted'); // secret-scan:allow (test fixture)
    assert.equal(redacted.structuredContent.raw, '[REDACTED]');
    assert.equal(redacted.structuredContent.token, '[REDACTED]');
  });

  it('TSK-338 & CL11: dispatchLegacyTool is eliminated and 100% of MCP tools dispatch in-process', () => {
    // Assert dispatchLegacyTool is not present anywhere in mcp.ts source
    const mcpTsPath = join(import.meta.dirname, '../../control-plane/src/mcp.ts');
    const mcpTsContent = readFileSync(mcpTsPath, 'utf8');
    assert.ok(!mcpTsContent.includes('dispatchLegacyTool'), 'dispatchLegacyTool must not exist in mcp.ts');
    assert.ok(mcpTsContent.includes('executeInProcessRoute'), 'mcp.ts must use executeInProcessRoute');
    assert.ok(mcpTsContent.includes('dispatchControlPlaneHttp'), 'mcp.ts must dispatch directly to dispatchControlPlaneHttp');

    // 100% of MCP tools in TOOLS catalog map to a registered operation in CONTROL_PLANE_ROUTES
    const opsMap = new Map(CONTROL_PLANE_ROUTES.map((r) => [r.operationId, r]));
    for (const tool of TOOLS) {
      const meta = (tool as any)._meta;
      assert.ok(meta, `Tool ${tool.name} must declare _meta`);
      assert.ok(meta.operationId, `Tool ${tool.name} must map to an operationId`);
      assert.ok(opsMap.has(meta.operationId), `Tool ${tool.name} operation ${meta.operationId} must exist in CONTROL_PLANE_ROUTES`);
    }
  });

  it('TSK-338 & GAP-250: Task-domain toolset selection (core <= 40 default, toolsets, readonly)', async () => {
    const mockState: any = { version: '0.1.0', secretValues: new Set(), agents: new Map() };
    const admin = { actor: 'alice', roles: ['admin'] };

    // 1. Default POST /mcp is core toolset bounded to <= 40
    const defaultRes = (await handleMcp(mockState, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, admin)) as any;
    const defaultTools = defaultRes.result.tools;
    assert.ok(defaultTools.length <= 40, `Default core tools must be <= 40, got ${defaultTools.length}`);

    // 2. /mcp/x/all returns full domain coverage (> 40 tools)
    const allRes = (await handleMcp(mockState, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, admin, { isAll: true })) as any;
    assert.ok(allRes.result.tools.length > 40, `Full domain coverage must be > 40 tools, got ${allRes.result.tools.length}`);

    // 3. parseToolsetTokens recognizes toolsets, staff aliases, and 'all'
    const parsed = parseToolsetTokens('schedules,spend');
    assert.equal(parsed.ok, true);
    assert.deepEqual(Array.from(parsed.toolsets).sort(), ['schedules', 'spend']);

    const unknownParsed = parseToolsetTokens('invalid_toolset_xyz');
    assert.equal(unknownParsed.ok, false);

    // 4. Readonly MCP view lists only readOnlyHint: true tools and rejects mutations
    const readonlyRes = (await handleMcp(mockState, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, admin, { readOnly: true })) as any;
    for (const t of readonlyRes.result.tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `Tool ${t.name} in readonly view must have readOnlyHint: true`);
    }

    const mutateRefused = (await handleMcp(mockState, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'pause_agent', arguments: { id: 'castle' } },
    }, admin, { readOnly: true })) as any;
    assert.equal(mutateRefused.result?.isError, true);
    assert.equal(mutateRefused.result?.structuredContent?.error, 'readonly_mcp_view');
  });

  it('TSK-338 & E9: human-decision tools require human confirmation challenge over MCP', async () => {
    const mockState: any = {
      version: '0.1.0',
      secretValues: new Set(),
      agents: new Map(),
      approvals: { get: () => undefined },
      mcpChallenges: new Map(),
    };
    const admin = { actor: 'alice', roles: ['admin'] };

    // Tools classified as human-decision
    const humanDecisionOps = CONTROL_PLANE_ROUTES.filter((r) => r.mcpExposure === 'human-decision');
    assert.ok(humanDecisionOps.length > 0, 'Must have operations classified as human-decision');

    const res = (await handleMcp(mockState, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'decide_approval', arguments: { approvalId: 'app-1', decision: 'approve' } },
    }, admin, { clientId: 'test-client' })) as any;

    assert.equal(res.result?.structuredContent?.status, 'human_confirmation_required');
    assert.ok(res.result?.structuredContent?.challengeId);
    assert.match(res.result?.structuredContent?.confirmationUrl, /^\/api\/v1\/mcp\/confirm\//);
  });

  it('TSK-338 & CL6/K5: handoff tools never accept secret values directly and require handoff URL', async () => {
    const mockState: any = {
      version: '0.1.0',
      secretValues: new Set(),
      agents: new Map(),
      mcpHandoffs: new Map(),
    };
    const admin = { actor: 'alice', roles: ['admin'] };

    const handoffOps = CONTROL_PLANE_ROUTES.filter((r) => r.mcpExposure === 'handoff');
    assert.ok(handoffOps.length > 0, 'Must have operations classified as handoff');

    const res = (await handleMcp(mockState, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'set_platform_credential', arguments: { name: 'ANTHROPIC_API_KEY', value: 'secret-val' } },
    }, admin, { clientId: 'test-client' })) as any;

    assert.equal(res.result?.structuredContent?.status, 'handoff_required');
    assert.ok(res.result?.structuredContent?.handoffId);
    assert.match(res.result?.structuredContent?.handoffUrl, /^\/api\/v1\/mcp\/handoff\//);
  });

  it('TSK-338: conversational agent surface handles POST /mcp/agents/:id and agents_converse', async () => {
    const mockState: any = {
      version: '0.1.0',
      secretValues: new Set(),
      agents: new Map([['castle', { id: 'castle', name: 'castle', state: 'ACTIVE' }]]),
    };
    const admin = { actor: 'alice', roles: ['admin'] };

    // tools/list on /mcp/agents/:id
    const agentToolsRes = (await handleAgentMcp(mockState, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    }, admin, 'castle')) as any;

    assert.equal(agentToolsRes.jsonrpc, '2.0');
    const toolNames = agentToolsRes.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(toolNames, ['ask', 'get_agent_info', 'get_replies', 'list_callable_agents']);

    // Root TOOLS includes agents_converse
    const converseTool = TOOLS.find((t) => t.name === 'agents_converse');
    assert.ok(converseTool, 'TOOLS must include agents_converse');
  });
});
