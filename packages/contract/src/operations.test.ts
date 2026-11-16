// DESIGN_AUTHORITY.md §6.17 (CL11), plans/headless-neck.md (TSK-336, GAP-249)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonSchema,
  derivePathParamsSchema,
  buildMcpInputSchema,
  buildMcpOutputSchema,
  buildMcpAnnotations,
  buildOpenApiDocument,
  buildMcpSchemaCatalog,
  validateOperationContract,
  type OperationContract,
  type RoutePrivilegeLookupItem,
} from './operations.js';

describe('Operations Contract & Schema Generators', () => {
  it('jsonSchema helper builds valid draft-2020-12 schema objects', () => {
    const s = jsonSchema.object(
      {
        name: jsonSchema.string({ description: 'The entity name' }),
        count: jsonSchema.integer({ minimum: 0, default: 1 }),
        enabled: jsonSchema.boolean({ default: true }),
        tags: jsonSchema.array(jsonSchema.string()),
      },
      { required: ['name'], additionalProperties: false },
    );

    assert.equal(s.type, 'object');
    assert.deepEqual(s.required, ['name']);
    assert.equal(s.additionalProperties, false);
    assert.equal(s.properties?.name.type, 'string');
    assert.equal(s.properties?.count.type, 'integer');
    assert.equal(s.properties?.enabled.type, 'boolean');
    assert.equal(s.properties?.tags.type, 'array');
  });

  it('derivePathParamsSchema extracts all parameters from path templates', () => {
    const s = derivePathParamsSchema('/api/v1/agents/:id/skills/:skillId');
    assert.equal(s.type, 'object');
    assert.deepEqual(s.required?.sort(), ['id', 'skillId'].sort());
    assert.equal(s.properties?.id?.type, 'string');
    assert.equal(s.properties?.skillId?.type, 'string');
  });

  it('buildMcpInputSchema strips plaintext secrets for handoff exposure operations', () => {
    const op: OperationContract = {
      operationId: 'set_platform_cred',
      method: 'POST',
      pattern: '/api/v1/keymaster/platform/credentials/:name',
      summary: 'Set platform credential',
      staff: 'keymaster',
      mcpExposure: 'handoff',
      toolset: 'credentials',
      mcpToolName: 'set_platform_credential',
      requestBodySchema: jsonSchema.object({
        secretValue: jsonSchema.string({ description: 'Plaintext secret' }),
        description: jsonSchema.string({ description: 'Description of secret' }),
      }, { required: ['secretValue'] }),
    };

    const inputSchema = buildMcpInputSchema(op);
    assert.equal(inputSchema.type, 'object');
    assert.ok(inputSchema.properties?.name, 'path param name should be included');
    assert.ok(inputSchema.properties?.description, 'non-secret description should be included');
    assert.equal(inputSchema.properties?.secretValue, undefined, 'raw secretValue must be stripped from MCP inputSchema');
    assert.ok(!inputSchema.required?.includes('secretValue'), 'secretValue must not be in required');
  });

  it('buildMcpOutputSchema always produces root type: object', () => {
    const opString: OperationContract = {
      operationId: 'get_something',
      method: 'GET',
      pattern: '/api/v1/something',
      summary: 'Get something',
      staff: 'inspector',
      mcpExposure: 'tool',
      toolset: 'observe',
      responseSchema: jsonSchema.string(),
    };
    const out = buildMcpOutputSchema(opString);
    assert.equal(out.type, 'object');
    assert.ok(out.properties?.ok);
  });

  it('buildMcpAnnotations derives hints accurately', () => {
    const getOp: OperationContract = {
      operationId: 'get_res',
      method: 'GET',
      pattern: '/res',
      summary: 'Get res',
      staff: 'registrar',
      mcpExposure: 'tool',
      toolset: 'agents',
    };
    const getHints = buildMcpAnnotations(getOp);
    assert.equal(getHints.readOnlyHint, true);
    assert.equal(getHints.destructiveHint, false);
    assert.equal(getHints.idempotentHint, true);

    const deleteOp: OperationContract = {
      operationId: 'del_res',
      method: 'DELETE',
      pattern: '/res/:id',
      summary: 'Delete res',
      staff: 'registrar',
      mcpExposure: 'tool-confirm',
      toolset: 'danger',
    };
    const delHints = buildMcpAnnotations(deleteOp);
    assert.equal(delHints.readOnlyHint, false);
    assert.equal(delHints.destructiveHint, true);
    assert.equal(delHints.idempotentHint, true);
  });

  it('buildOpenApiDocument outputs valid OpenAPI 3.1.0 document with security and extensions', () => {
    const ops: OperationContract[] = [
      {
        operationId: 'list_agents',
        method: 'GET',
        pattern: '/api/v1/agents',
        summary: 'List agents',
        staff: 'registrar',
        mcpExposure: 'tool',
        toolset: 'agents',
        inCoreToolset: true,
        mcpToolName: 'list_agents',
        responseSchema: jsonSchema.object({
          agents: jsonSchema.array(jsonSchema.object({ id: jsonSchema.string() })),
        }),
      },
    ];
    const routes: RoutePrivilegeLookupItem[] = [
      {
        method: 'GET',
        pattern: '/api/v1/agents',
        privilege: 'agents.read',
      },
    ];

    const doc = buildOpenApiDocument(ops, routes);
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.info.title);
    assert.ok(doc.components.securitySchemes.FactoryApiKey);
    assert.ok(doc.components.securitySchemes.FactorySession);
    assert.ok(doc.components.securitySchemes.McpOAuth2);

    const pathItem = doc.paths['/api/v1/agents'];
    assert.ok(pathItem);
    const getOp = (pathItem as Record<string, any>).get;
    assert.ok(getOp);
    assert.equal(getOp.operationId, 'list_agents');
    assert.equal(getOp['x-bouncer-privilege'], 'agents.read');
    assert.equal(getOp['x-factory-staff'], 'registrar');
    assert.equal(getOp['x-mcp-exposure'], 'tool');
    assert.equal(getOp['x-mcp-toolset'], 'agents');
    assert.equal(getOp['x-in-core-toolset'], true);
  });

  it('buildMcpSchemaCatalog enforces unique names, core limit <= 40, and excludes console-only/internal', () => {
    const ops: OperationContract[] = [
      {
        operationId: 'list_agents',
        method: 'GET',
        pattern: '/api/v1/agents',
        summary: 'List agents',
        staff: 'registrar',
        mcpExposure: 'tool',
        toolset: 'agents',
        inCoreToolset: true,
        mcpToolName: 'list_agents',
      },
      {
        operationId: 'create_api_key',
        method: 'POST',
        pattern: '/api/v1/keys',
        summary: 'Create API key',
        staff: 'bouncer',
        mcpExposure: 'console-or-cli-only',
      },
      {
        operationId: 'internal_checkout',
        method: 'POST',
        pattern: '/api/v1/keymaster/checkout',
        summary: 'Checkout secret',
        staff: 'keymaster',
        mcpExposure: 'internal',
      },
    ];

    const catalog = buildMcpSchemaCatalog(ops);
    assert.equal(catalog.version, '2024-11-05');
    assert.equal(catalog.tools.length, 1);
    assert.equal(catalog.tools[0].name, 'list_agents');
    assert.equal(catalog.toolsets.core.toolCount, 1);
    assert.ok(catalog.toolsets.core.toolCount <= 40);

    // Assert that console-or-cli-only and internal ops are not in tools
    assert.equal(catalog.tools.find((t) => t.name === 'create_api_key'), undefined);
    assert.equal(catalog.tools.find((t) => t.name === 'internal_checkout'), undefined);
  });

  it('validateOperationContract validates invariants strictly', () => {
    const badKeyOp: OperationContract = {
      operationId: 'create_key',
      method: 'POST',
      pattern: '/api/v1/keys',
      summary: 'Create key',
      staff: 'bouncer',
      mcpExposure: 'tool', // INVALID: must be console-or-cli-only
      toolset: 'access',
      mcpToolName: 'create_key',
      requestBodySchema: jsonSchema.object({ name: jsonSchema.string() }),
    };
    const res = validateOperationContract(badKeyOp);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('console-or-cli-only')));

    // Mutating tool without requestBodySchema and without noRequestBody: true
    const badMutatingOp: OperationContract = {
      operationId: 'create_something',
      method: 'POST',
      pattern: '/api/v1/something',
      summary: 'Create something',
      staff: 'registrar',
      mcpExposure: 'tool',
      toolset: 'agents',
      mcpToolName: 'create_something',
    };
    const mutRes = validateOperationContract(badMutatingOp);
    assert.equal(mutRes.valid, false);
    assert.ok(mutRes.errors.some((e) => e.includes('must define a requestBodySchema with properties or explicitly set noRequestBody: true')));

    // Genuinely bodyless mutating tool with noRequestBody: true is valid
    const validBodylessOp: OperationContract = {
      operationId: 'pause_agent',
      method: 'POST',
      pattern: '/api/v1/agents/:id/pause',
      summary: 'Pause agent execution',
      staff: 'gatekeeper',
      mcpExposure: 'tool-confirm',
      toolset: 'danger',
      mcpToolName: 'pause_agent',
      noRequestBody: true,
    };
    const bodylessRes = validateOperationContract(validBodylessOp);
    assert.equal(bodylessRes.valid, true);

    // Contradictory noRequestBody: true and requestBodySchema
    const contradictoryOp: OperationContract = {
      operationId: 'confused_op',
      method: 'POST',
      pattern: '/api/v1/confused',
      summary: 'Confused op',
      staff: 'gatekeeper',
      mcpExposure: 'tool-confirm',
      toolset: 'danger',
      mcpToolName: 'confused_op',
      noRequestBody: true,
      requestBodySchema: jsonSchema.object({ name: jsonSchema.string() }),
    };
    const contraRes = validateOperationContract(contradictoryOp);
    assert.equal(contraRes.valid, false);
    assert.ok(contraRes.errors.some((e) => e.includes('cannot specify both noRequestBody: true and requestBodySchema')));
  });

  it('buildMcpInputSchema guarantees collision safety with path parameter precedence', () => {
    const op: OperationContract = {
      operationId: 'update_item',
      method: 'PATCH',
      pattern: '/api/v1/items/:id',
      summary: 'Update item',
      staff: 'registrar',
      mcpExposure: 'tool-confirm',
      toolset: 'agents',
      mcpToolName: 'update_item',
      pathParamsSchema: jsonSchema.object({
        id: jsonSchema.string({ description: 'Path item id' }),
      }),
      querySchema: jsonSchema.object({
        id: jsonSchema.string({ description: 'Query item id override (should be ignored)' }),
        filter: jsonSchema.string({ description: 'Filter param' }),
      }),
      requestBodySchema: jsonSchema.object({
        id: jsonSchema.string({ description: 'Body item id override (should be ignored)' }),
        name: jsonSchema.string({ description: 'New item name' }),
      }, { required: ['id', 'name'] }),
    };

    const schema = buildMcpInputSchema(op);
    assert.equal(schema.type, 'object');
    // id description should be the path parameter one
    assert.equal(schema.properties?.id?.description, 'Path item id');
    assert.equal(schema.properties?.filter?.description, 'Filter param');
    assert.equal(schema.properties?.name?.description, 'New item name');
    // id and name should be in required
    assert.deepEqual(schema.required?.sort(), ['id', 'name'].sort());
  });
});
