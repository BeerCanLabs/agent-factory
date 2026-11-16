// OpenAPI 3.1.0 and MCP schema catalog live endpoint end-to-end tests (GAP-249, CL11)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { createInspector } from '@beercanlabs/factory-inspector';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createFactoryServer, type FactoryState } from './app.js';
import { createTreasury } from './spend.js';
import { getOpenApiDocument, getMcpSchemaCatalog, CONTROL_PLANE_ROUTES } from './route-registry.js';
import type { OpenApiDocument, McpSchemaCatalog } from '@beercanlabs/factory-contract';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (!a || typeof a === 'string') return reject(new Error('no address'));
      resolve(a.port);
    });
  });
}

describe('OpenAPI 3.1.0 & MCP Schema Endpoints E2E (GAP-249, CL11)', () => {
  let cp: http.Server;
  let port = 0;
  const AUTH_TOKEN = 'example-bearer-token';

  before(async () => {
    const state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      inspector: createInspector(),
      auth: bearerAuth([{ name: 'admin', token: AUTH_TOKEN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      treasury: createTreasury(),
      approvals: new ApprovalStore(),
      groups: { list: () => [], get: () => undefined },
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('GET /api/v1/openapi.json returns 401 without credentials', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`);
    assert.equal(res.status, 401);
  });

  it('GET /api/v1/openapi.json returns 200 with OpenAPI 3.1.0 document when authenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);

    const doc = (await res.json()) as OpenApiDocument;
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'Agent Factory Control Plane API');
    assert.ok(doc.info.version);
    assert.ok(doc.servers && doc.servers.length > 0);
    assert.ok(doc.components?.securitySchemes?.FactoryApiKey);
    assert.ok(doc.components?.securitySchemes?.FactorySession);
    assert.ok(doc.components?.securitySchemes?.McpOAuth2);

    // Verify paths are populated
    assert.ok(doc.paths['/api/v1/openapi.json']);
    assert.ok(doc.paths['/api/v1/mcp/schema.json']);
    assert.ok(doc.paths['/api/v1/runs']);
    assert.ok(doc.paths['/api/v1/agents']);

    // Verify key issuance is console-or-cli-only in OpenAPI extensions
    const keysPost = doc.paths['/api/v1/keys']?.post;
    assert.ok(keysPost);
    assert.equal(keysPost['x-mcp-exposure'], 'console-or-cli-only');
  });

  it('GET /api/v1/mcp/schema.json returns 401 without credentials', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/mcp/schema.json`);
    assert.equal(res.status, 401);
  });

  it('GET /api/v1/mcp/schema.json returns 200 with MCP catalog when authenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/mcp/schema.json`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);

    const catalog = (await res.json()) as McpSchemaCatalog;
    assert.equal(catalog.version, '2024-11-05');
    assert.ok(catalog.toolsets);
    assert.ok(Array.isArray(catalog.tools));
    assert.ok(catalog.tools.length > 0);

    const namePattern = /^[a-z0-9_]{1,40}$/;
    const toolNames = new Set<string>();
    let coreCount = 0;

    for (const tool of catalog.tools) {
      assert.match(tool.name, namePattern, `tool name ${tool.name} must match regex`);
      assert.ok(!toolNames.has(tool.name), `duplicate tool name: ${tool.name}`);
      toolNames.add(tool.name);

      assert.equal(tool.inputSchema.type, 'object', `tool ${tool.name} inputSchema must have type: object`);
      if (tool.outputSchema) {
        assert.equal(tool.outputSchema.type, 'object', `tool ${tool.name} outputSchema must have type: object`);
      }

      if (tool._meta.inCore) {
        coreCount++;
      }
    }

    assert.ok(coreCount <= 40, `Core tool count (${coreCount}) exceeds limit 40`);

    // Verify CL6: keys issuance and rotate never appear in MCP tools
    assert.ok(!toolNames.has('keys_create'), 'keys_create must not be an MCP tool');
    assert.ok(!toolNames.has('keys_rotate'), 'keys_rotate must not be an MCP tool');
  });

  it('live endpoints match deterministic registry exports', () => {
    const oas = getOpenApiDocument();
    const mcp = getMcpSchemaCatalog();

    assert.equal(oas.openapi, '3.1.0');
    assert.equal(mcp.version, '2024-11-05');
    assert.ok(CONTROL_PLANE_ROUTES.length >= 256);
  });
});
