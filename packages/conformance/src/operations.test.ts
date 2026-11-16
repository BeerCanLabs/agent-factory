// DESIGN_AUTHORITY.md §5 (TSK-336), §6.15, GAP-249, CL11: Operations Contract, OpenAPI 3.1.0 and MCP Schema Conformance
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PLANE_ROUTES,
  getOpenApiDocument,
  getMcpSchemaCatalog,
} from '@beercanlabs/factory-control-plane/routes';
import {
  validateOperationContract,
  type OperationContract,
} from '@beercanlabs/factory-contract';

describe('Operations Contract & Schema Conformance (GAP-249, CL11, TSK-336)', () => {
  it('every route in CONTROL_PLANE_ROUTES binds a valid OperationContract', () => {
    assert.ok(CONTROL_PLANE_ROUTES.length >= 256, `Expected >= 256 routes, found ${CONTROL_PLANE_ROUTES.length}`);
    for (const r of CONTROL_PLANE_ROUTES) {
      assert.ok(r.operationId, `Route ${r.method} ${r.pattern} is missing operationId`);
      assert.ok(r.summary, `Route ${r.method} ${r.pattern} is missing summary`);
      assert.ok(r.mcpExposure, `Route ${r.method} ${r.pattern} is missing mcpExposure`);
      assert.doesNotThrow(() => validateOperationContract(r), `Route ${r.method} ${r.pattern} has invalid operation contract`);
    }
  });

  it('no path parameter in pattern is unmapped in pathParamsSchema', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      const paramMatches = [...r.pattern.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      if (paramMatches.length > 0) {
        assert.ok(r.pathParamsSchema, `Route ${r.method} ${r.pattern} has path parameters but no pathParamsSchema`);
        const declared = Object.keys(r.pathParamsSchema.properties || {});
        for (const p of paramMatches) {
          assert.ok(declared.includes(p), `Route ${r.method} ${r.pattern} has param :${p} not declared in pathParamsSchema`);
        }
      }
    }
  });

  it('enforces CL6: key generation routes are strictly console-or-cli-only', () => {
    const keyCreation = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/api/v1/keys');
    assert.ok(keyCreation);
    assert.equal(keyCreation.mcpExposure, 'console-or-cli-only');

    const keyRotate = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/api/v1/keys/:id/rotate');
    assert.ok(keyRotate);
    assert.equal(keyRotate.mcpExposure, 'console-or-cli-only');
  });

  it('enforces human-decision on holds, approvals, and admission routes', () => {
    const humanRoutes = [
      { method: 'POST', pattern: '/api/v1/submissions/:id/admit' },
      { method: 'POST', pattern: '/api/v1/approvals/:id/decide' },
    ];
    for (const hr of humanRoutes) {
      const route = CONTROL_PLANE_ROUTES.find((r) => r.method === hr.method && r.pattern === hr.pattern);
      if (route) {
        assert.equal(route.mcpExposure, 'human-decision', `${hr.method} ${hr.pattern} must be human-decision`);
      }
    }
  });

  it('buildOpenApiDocument outputs valid OpenAPI 3.1.0 with securitySchemes and extensions', () => {
    const doc = getOpenApiDocument();
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'Agent Factory Control Plane API');
    assert.ok(doc.components.securitySchemes.FactoryApiKey);
    assert.ok(doc.components.securitySchemes.FactorySession);
    assert.ok(doc.components.securitySchemes.McpOAuth2);

    // Every path has at least one method with x-bouncer-privilege or x-route-exception
    for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (typeof op !== 'object' || !op) continue;
        const o = op as Record<string, unknown>;
        assert.ok(o['x-bouncer-privilege'] || o['x-route-exception'], `${method.toUpperCase()} ${pathKey} missing bouncer privilege / exception extension`);
        assert.ok(o['x-factory-staff'], `${method.toUpperCase()} ${pathKey} missing x-factory-staff extension`);
        assert.ok(o['x-mcp-exposure'], `${method.toUpperCase()} ${pathKey} missing x-mcp-exposure extension`);
      }
    }
  });

  it('buildMcpSchemaCatalog enforces tool name regex, unique names, and core tools limit <= 40', () => {
    const catalog = getMcpSchemaCatalog();
    assert.equal(catalog.version, '2024-11-05');
    assert.ok(catalog.tools.length > 0);

    const namePattern = /^[a-z0-9_]{1,40}$/;
    const names = new Set<string>();
    let coreCount = 0;

    for (const tool of catalog.tools) {
      assert.match(tool.name, namePattern, `Tool name ${tool.name} must match ^[a-z0-9_]{1,40}$`);
      assert.ok(!names.has(tool.name), `Duplicate tool name: ${tool.name}`);
      names.add(tool.name);

      assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema must have type: 'object'`);
      if (tool._meta.inCore) {
        coreCount++;
      }
    }

    assert.ok(coreCount <= 40, `Core toolset count (${coreCount}) must not exceed 40`);

    // Verify console-or-cli-only and internal operations are excluded
    assert.ok(!names.has('keys_create'), 'keys_create must not be an MCP tool');
    assert.ok(!names.has('keys_rotate'), 'keys_rotate must not be an MCP tool');
  });

  it('F2 & F1: every non-internal mutating route declares requestBodySchema or noRequestBody', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      if (['POST', 'PUT', 'PATCH'].includes(r.method) && r.mcpExposure !== 'internal') {
        const hasBodySchema = Boolean(
          r.requestBodySchema &&
            ((r.requestBodySchema.properties && Object.keys(r.requestBodySchema.properties).length > 0) ||
              r.requestBodySchema.type)
        );
        assert.ok(
          hasBodySchema || r.noRequestBody === true,
          `Mutating route ${r.method} ${r.pattern} (${r.operationId}) must define requestBodySchema or specify noRequestBody: true`
        );
      }
    }
  });

  it('F1 & F2: key mutating tools export non-empty properties in both OpenAPI requestBody and MCP inputSchema', () => {
    const doc = getOpenApiDocument();
    const catalog = getMcpSchemaCatalog();

    const expectedTools = [
      {
        toolName: 'create_agent',
        opId: 'create_agent',
        path: '/api/v1/agents',
        method: 'post',
        expectedProps: ['name', 'role'],
      },
      {
        toolName: 'create_schedule',
        opId: 'create_schedule',
        path: '/api/v1/schedules',
        method: 'post',
        expectedProps: ['cron', 'prompt'],
      },
      {
        toolName: 'create_grant',
        opId: 'create_grant',
        path: '/api/v1/grants',
        method: 'post',
        expectedProps: ['subject', 'role'],
      },
      {
        toolName: 'allocate_agent_budget',
        opId: 'allocate_agent_budget',
        path: '/api/v1/budget/agents/{id}',
        method: 'put',
        expectedProps: ['budgetUsd'],
      },
      {
        toolName: 'decide_approval',
        opId: 'decide_approval',
        path: '/api/v1/approvals/{id}',
        method: 'post',
        expectedProps: ['decision'],
      },
      {
        toolName: 'agents_converse',
        opId: 'agents_converse',
        path: '/api/v1/agents/{id}/conversation',
        method: 'post',
        expectedProps: ['input', 'message'],
      },
    ];

    for (const exp of expectedTools) {
      // Check MCP tool inputSchema
      const tool = catalog.tools.find((t) => t.name === exp.toolName);
      assert.ok(tool, `MCP tool ${exp.toolName} must exist in catalog`);
      assert.equal(tool.inputSchema.type, 'object');
      const toolProps = Object.keys(tool.inputSchema.properties || {});
      for (const prop of exp.expectedProps) {
        assert.ok(
          toolProps.includes(prop),
          `MCP tool ${exp.toolName} inputSchema must include property '${prop}' (found: ${toolProps.join(', ')})`
        );
      }

      // Check OpenAPI requestBody
      const openApiPath = doc.paths[exp.path];
      assert.ok(openApiPath, `OpenAPI path ${exp.path} must exist in document`);
      const op = (openApiPath as Record<string, any>)[exp.method];
      assert.ok(op, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must exist`);
      assert.ok(op.requestBody, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must have requestBody`);
      const jsonContent = op.requestBody.content?.['application/json'];
      assert.ok(jsonContent, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must have application/json content`);
      const bodyProps = Object.keys(jsonContent.schema?.properties || {});
      for (const prop of exp.expectedProps) {
        assert.ok(
          bodyProps.includes(prop),
          `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} schema must include property '${prop}'`
        );
      }
    }
  });

  it('F3: non-200 creation and async dispatch statusCodes are populated accurately', () => {
    const doc = getOpenApiDocument();

    // POST /api/v1/agents should return 201
    const createAgentRoute = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'create_agent');
    assert.ok(createAgentRoute);
    assert.deepEqual(createAgentRoute.statusCodes, [201]);

    const createAgentOp = (doc.paths['/api/v1/agents'] as Record<string, any>)?.post;
    assert.ok(createAgentOp);
    assert.ok(createAgentOp.responses['201'], 'OpenAPI create_agent should declare 201 response');

    // POST /api/v1/agents/:id/runs should return 200, 202
    const triggerRunRoute = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'start_agent_run');
    assert.ok(triggerRunRoute);
    assert.deepEqual(triggerRunRoute.statusCodes, [200, 202]);

    const triggerRunOp = (doc.paths['/api/v1/agents/{id}/runs'] as Record<string, any>)?.post;
    assert.ok(triggerRunOp);
    assert.ok(triggerRunOp.responses['202'], 'OpenAPI start_agent_run should declare 202 response');
  });
});
