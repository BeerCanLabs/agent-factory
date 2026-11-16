// DESIGN_AUTHORITY.md §5 (TSK-337), GAP-248, CL3, CL6, CL11, S1, D23: MCP Protocol Compliance, Refusal Clarity & Error Refactoring
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PLANE_ROUTES,
  getMcpSchemaCatalog,
} from '@beercanlabs/factory-control-plane/routes';
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  TOOLS,
  handleMcp,
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
});
