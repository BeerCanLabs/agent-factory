// DESIGN_AUTHORITY.md §6.17 (CL11), plans/headless-neck.md (TSK-336, GAP-249)
import type { FactoryServiceName } from './services/types.js';
import { FACTORY_SERVICE_NAMES } from './services/types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/**
 * Six canonical operation exposure classes defined in plans/headless-neck.md §4.
 */
export const MCP_EXPOSURE_CLASSES = [
  'tool',
  'tool-confirm',
  'human-decision',
  'handoff',
  'console-or-cli-only',
  'internal',
] as const;

export type McpExposureClass = (typeof MCP_EXPOSURE_CLASSES)[number];

/**
 * Curated task-domain toolsets defined in plans/headless-neck.md §3 Decision 3.
 */
export const MCP_TOOLSETS = [
  'core',
  'agents',
  'runs',
  'models',
  'spend',
  'access',
  'credentials',
  'skills',
  'systems',
  'schedules',
  'observe',
  'submissions',
  'danger',
  'agents-converse',
] as const;

export type McpToolset = (typeof MCP_TOOLSETS)[number];

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const DEFAULT_TOOL_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

export interface JsonSchemaObject {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Record<string, JsonSchemaObject>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject | readonly JsonSchemaObject[];
  description?: string;
  enum?: readonly (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  format?: string;
  pattern?: string;
  oneOf?: readonly JsonSchemaObject[];
  anyOf?: readonly JsonSchemaObject[];
  allOf?: readonly JsonSchemaObject[];
  [key: string]: unknown;
}

/**
 * Lightweight deterministic JSON Schema builder (zero runtime dependencies).
 */
export const jsonSchema = {
  object(
    properties: Record<string, JsonSchemaObject> = {},
    options?: {
      required?: readonly string[];
      additionalProperties?: boolean | JsonSchemaObject;
      description?: string;
    },
  ): JsonSchemaObject {
    return {
      type: 'object',
      properties,
      ...(options?.required && options.required.length > 0 ? { required: options.required } : {}),
      ...(options?.additionalProperties !== undefined ? { additionalProperties: options.additionalProperties } : {}),
      ...(options?.description ? { description: options.description } : {}),
    };
  },

  string(options?: {
    description?: string;
    enum?: readonly string[];
    format?: string;
    pattern?: string;
    default?: string;
  }): JsonSchemaObject {
    return {
      type: 'string',
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.enum ? { enum: options.enum } : {}),
      ...(options?.format ? { format: options.format } : {}),
      ...(options?.pattern ? { pattern: options.pattern } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
    };
  },

  number(options?: {
    description?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    default?: number;
  }): JsonSchemaObject {
    return {
      type: 'number',
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options?.maximum !== undefined ? { maximum: options.maximum } : {}),
      ...(options?.exclusiveMinimum !== undefined ? { exclusiveMinimum: options.exclusiveMinimum } : {}),
      ...(options?.exclusiveMaximum !== undefined ? { exclusiveMaximum: options.exclusiveMaximum } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
    };
  },

  integer(options?: {
    description?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    default?: number;
  }): JsonSchemaObject {
    return {
      type: 'integer',
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options?.maximum !== undefined ? { maximum: options.maximum } : {}),
      ...(options?.exclusiveMinimum !== undefined ? { exclusiveMinimum: options.exclusiveMinimum } : {}),
      ...(options?.exclusiveMaximum !== undefined ? { exclusiveMaximum: options.exclusiveMaximum } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
    };
  },

  boolean(options?: {
    description?: string;
    default?: boolean;
  }): JsonSchemaObject {
    return {
      type: 'boolean',
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
    };
  },

  array(
    items: JsonSchemaObject,
    options?: {
      description?: string;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    },
  ): JsonSchemaObject {
    return {
      type: 'array',
      items,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.minItems !== undefined ? { minItems: options.minItems } : {}),
      ...(options?.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
      ...(options?.uniqueItems !== undefined ? { uniqueItems: options.uniqueItems } : {}),
    };
  },
};

/**
 * Complete strongly-typed Operation Contract representing a single control-plane operation.
 */
export interface OperationContract {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly summary: string;
  readonly description?: string;
  readonly staff: FactoryServiceName;
  readonly toolset?: McpToolset;
  readonly mcpExposure: McpExposureClass;
  readonly mcpToolName?: string;
  readonly inCoreToolset?: boolean;
  readonly pathParamsSchema?: JsonSchemaObject;
  readonly querySchema?: JsonSchemaObject;
  readonly requestBodySchema?: JsonSchemaObject;
  readonly noRequestBody?: boolean;
  readonly responseSchema?: JsonSchemaObject;
  readonly annotations?: Partial<McpToolAnnotations>;
  readonly statusCodes?: readonly number[];
}

/**
 * Extracts and guarantees path parameters for all `:param` tokens in route patterns.
 */
export function derivePathParamsSchema(pattern: string, existing?: JsonSchemaObject): JsonSchemaObject {
  const matches = pattern.match(/:([a-zA-Z0-9_]+)/g) ?? [];
  const paramNames = matches.map((m) => m.slice(1));
  const properties: Record<string, JsonSchemaObject> = { ...(existing?.properties ?? {}) };
  const required: string[] = [...(existing?.required ?? [])];

  for (const name of paramNames) {
    if (!properties[name]) {
      properties[name] = jsonSchema.string({ description: `Path parameter ${name}` });
    }
    if (!required.includes(name)) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Builds the MCP inputSchema combining path params, query params, and body properties.
 * Enforces: root type is 'object', and sensitive credentials in 'handoff' operations are never present in args.
 */
export function buildMcpInputSchema(op: OperationContract): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];

  // 1. Path parameters
  const pathParams = derivePathParamsSchema(op.pattern, op.pathParamsSchema);
  if (pathParams.properties) {
    for (const [k, v] of Object.entries(pathParams.properties)) {
      if (k === 'actAs' || k === 'onBehalfOf') continue;
      properties[k] = v;
      if (!required.includes(k)) required.push(k);
    }
  }

  // 2. Query parameters
  if (op.querySchema?.properties) {
    for (const [k, v] of Object.entries(op.querySchema.properties)) {
      if (k === 'actAs' || k === 'onBehalfOf') continue;
      if (properties[k]) {
        // Path parameter already defined with this name; path parameters take precedence
        continue;
      }
      properties[k] = v;
      if (op.querySchema.required?.includes(k) && !required.includes(k)) {
        required.push(k);
      }
    }
  }

  // 3. Request body parameters
  if (op.requestBodySchema?.properties) {
    for (const [k, v] of Object.entries(op.requestBodySchema.properties)) {
      if (k === 'actAs' || k === 'onBehalfOf') continue;
      if (op.mcpExposure === 'handoff') {
        const lower = k.toLowerCase();
        if (
          lower.includes('secret') ||
          lower.includes('token') ||
          lower.includes('clientsecret') ||
          lower.includes('bottoken') ||
          lower === 'value' ||
          lower === 'rawsecret'
        ) {
          continue;
        }
      }
      if (properties[k]) {
        // Path or query parameter already defined with this name; path takes precedence
        continue;
      }
      properties[k] = v;
      if (op.requestBodySchema.required?.includes(k)) {
        if (!required.includes(k)) required.push(k);
      }
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Builds deterministic outputSchema for an operation with root type: 'object'.
 */
export function buildMcpOutputSchema(op: OperationContract): JsonSchemaObject {
  if (op.responseSchema && op.responseSchema.type === 'object') {
    return op.responseSchema;
  }
  return {
    type: 'object',
    properties: {
      ok: jsonSchema.boolean({ description: 'Operation execution status' }),
      data: op.responseSchema ?? jsonSchema.object({}, { description: 'Response payload' }),
    },
    additionalProperties: true,
  };
}

/**
 * Computes deterministic MCP tool annotations.
 */
export function buildMcpAnnotations(op: OperationContract): McpToolAnnotations {
  const isGetOrHead = op.method === 'GET' || op.method === 'HEAD';
  const isDelete = op.method === 'DELETE';
  const isIdempotentVerb = op.method === 'GET' || op.method === 'PUT' || op.method === 'DELETE';
  const isDestructive = isDelete || op.mcpExposure === 'tool-confirm' || op.toolset === 'danger';

  return {
    readOnlyHint: op.annotations?.readOnlyHint ?? isGetOrHead,
    destructiveHint: op.annotations?.destructiveHint ?? isDestructive,
    idempotentHint: op.annotations?.idempotentHint ?? isIdempotentVerb,
    openWorldHint: op.annotations?.openWorldHint ?? false,
  };
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema: JsonSchemaObject;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content: {
      'application/json': {
        schema: JsonSchemaObject;
      };
    };
  };
  responses: Record<
    string,
    {
      description: string;
      content?: {
        'application/json': {
          schema: JsonSchemaObject;
        };
      };
    }
  >;
  security?: readonly Record<string, readonly string[]>[];
  'x-bouncer-privilege'?: string | readonly string[];
  'x-route-exception'?: string;
  'x-factory-staff': FactoryServiceName;
  'x-mcp-exposure': McpExposureClass;
  'x-mcp-toolset'?: McpToolset;
  'x-mcp-tool-name'?: string;
  'x-in-core-toolset'?: boolean;
}

export type OpenApiPathItem = Record<string, OpenApiOperation | unknown>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: readonly { url: string; description?: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas?: Record<string, JsonSchemaObject>;
  };
}

export interface OpenApiMeta {
  title?: string;
  version?: string;
  description?: string;
  servers?: readonly { url: string; description?: string }[];
}

export interface RoutePrivilegeLookupItem {
  method: HttpMethod;
  pattern: string;
  privilege?: string | readonly string[];
  exception?: string;
}

/**
 * Builds a valid OpenAPI 3.1.0 document from declared operations and routes.
 */
export function buildOpenApiDocument(
  operations: readonly OperationContract[],
  routes?: readonly RoutePrivilegeLookupItem[],
  meta?: OpenApiMeta,
): OpenApiDocument {
  const routeMap = new Map<string, RoutePrivilegeLookupItem>();
  if (routes) {
    for (const r of routes) {
      routeMap.set(`${r.method} ${r.pattern}`, r);
    }
  }

  const paths: Record<string, OpenApiPathItem> = {};

  for (const op of operations) {
    // Convert :param to {param}
    const openApiPath = op.pattern.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    const routeLookup = routeMap.get(`${op.method} ${op.pattern}`) ?? (op as unknown as RoutePrivilegeLookupItem);
    const pathItem = paths[openApiPath] as Record<string, unknown>;
    const verb = op.method.toLowerCase();

    const parameters: OpenApiParameter[] = [];

    // Path parameters
    const pathParams = derivePathParamsSchema(op.pattern, op.pathParamsSchema);
    if (pathParams.properties) {
      for (const [name, schema] of Object.entries(pathParams.properties)) {
        parameters.push({
          name,
          in: 'path',
          required: true,
          description: schema.description ?? `Path parameter ${name}`,
          schema,
        });
      }
    }

    // Query parameters
    if (op.querySchema?.properties) {
      for (const [name, schema] of Object.entries(op.querySchema.properties)) {
        parameters.push({
          name,
          in: 'query',
          required: op.querySchema.required?.includes(name) ?? false,
          description: schema.description,
          schema,
        });
      }
    }

    const statusCodes = op.statusCodes && op.statusCodes.length > 0
      ? op.statusCodes
      : (op.method === 'DELETE' ? [200, 204] : [200]);

    const responses: OpenApiOperation['responses'] = {};
    for (const code of statusCodes) {
      const codeStr = String(code);
      if (code === 204) {
        responses[codeStr] = { description: 'Operation completed successfully (no content)' };
      } else {
        const defaultDesc =
          code === 201
            ? 'Resource created successfully'
            : code === 202
              ? 'Request accepted for processing'
              : 'Successful operation';
        responses[codeStr] = {
          description: op.summary || defaultDesc,
          ...(op.responseSchema
            ? {
                content: {
                  'application/json': {
                    schema: op.responseSchema,
                  },
                },
              }
            : {}),
        };
      }
    }

    // Standard client error responses
    responses['401'] = { description: 'Authentication required' };
    responses['403'] = { description: 'Forbidden (insufficient privilege or role)' };
    if (op.pattern.includes(':')) {
      responses['404'] = { description: 'Resource not found' };
    }

    const isUnauthenticatedRoute = routeLookup?.exception === 'login-page' || routeLookup?.exception === 'login-start';

    const operationObj: OpenApiOperation = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description ?? op.summary,
      tags: [op.toolset ?? op.staff],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.requestBodySchema
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: op.requestBodySchema,
                },
              },
            },
          }
        : {}),
      responses,
      ...(!isUnauthenticatedRoute
        ? {
            security: [
              { FactoryApiKey: [] },
              { FactorySession: [] },
              { McpOAuth2: ['mcp'] },
            ],
          }
        : {}),
      ...(routeLookup?.privilege ? { 'x-bouncer-privilege': routeLookup.privilege } : {}),
      ...(routeLookup?.exception ? { 'x-route-exception': routeLookup.exception } : {}),
      'x-factory-staff': op.staff,
      'x-mcp-exposure': op.mcpExposure,
      ...(op.toolset ? { 'x-mcp-toolset': op.toolset } : {}),
      ...(op.mcpToolName ? { 'x-mcp-tool-name': op.mcpToolName } : {}),
      ...(op.inCoreToolset !== undefined ? { 'x-in-core-toolset': op.inCoreToolset } : {}),
    };

    pathItem[verb] = operationObj;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: meta?.title ?? 'Agent Factory Control Plane API',
      version: meta?.version ?? '0.1.0',
      description: meta?.description ?? 'Canonical declarative REST & MCP operations for Agent Factory.',
    },
    servers: meta?.servers ?? [{ url: '/', description: 'Current instance' }],
    paths,
    components: {
      securitySchemes: {
        FactoryApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'fk_*',
          description: 'Factory API key presented as Bearer fk_...',
        },
        FactorySession: {
          type: 'apiKey',
          in: 'cookie',
          name: 'factory_session',
          description: 'Factory browser session cookie (12-hour session)',
        },
        McpOAuth2: {
          type: 'oauth2',
          description: 'OAuth 2.1 AS with PKCE (RFC 7636) and dynamic client registration',
          flows: {
            authorizationCode: {
              authorizationUrl: '/authorize',
              tokenUrl: '/api/v1/auth/token',
              scopes: {
                mcp: 'Access Agent Factory MCP tools',
              },
            },
          },
        },
      },
    },
  };
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  annotations: McpToolAnnotations;
  _meta: {
    operationId: string;
    method: HttpMethod;
    pattern: string;
    privilege?: string | readonly string[];
    staff: FactoryServiceName;
    toolset?: McpToolset;
    exposure: McpExposureClass;
    inCore: boolean;
  };
}

export interface McpSchemaCatalog {
  version: string;
  toolsets: Record<string, { toolCount: number; description: string }>;
  tools: McpToolDefinition[];
}

const TOOLSET_DESCRIPTIONS: Record<McpToolset, string> = {
  core: 'Default bounded core operations (<=40 tools)',
  agents: 'Agent lifecycle, configuration, and settings',
  runs: 'Active container runs and task execution',
  models: 'Model offering catalog, discovery, and pricing',
  spend: 'Spend tallies, budgets, and accounting',
  access: 'Principals, grants, roles, and identity links',
  credentials: 'Vault credentials and provider connections',
  skills: 'Skill ecosystem, adoption, and verification',
  systems: 'External system integrations and proposals',
  schedules: 'Timekeeper cron jobs and scheduled tasks',
  observe: 'Audit ledger, metrics, and health inspection',
  submissions: 'Content admission and guided interviews',
  danger: 'Destructive isolation, reset, or purge operations',
  'agents-converse': 'Direct agent conversations and dialogue',
};

/**
 * Builds the deterministic MCP tool schema catalog from declarative operations.
 * Enforces MCP specification invariants, core <= 40 bounded default, and zero secret leakage.
 */
export function buildMcpSchemaCatalog(
  operations: readonly OperationContract[],
  routes?: readonly RoutePrivilegeLookupItem[],
  version = '2024-11-05',
): McpSchemaCatalog {
  const routeMap = new Map<string, RoutePrivilegeLookupItem>();
  if (routes) {
    for (const r of routes) {
      routeMap.set(`${r.method} ${r.pattern}`, r);
    }
  }

  const toolNameRegex = /^[a-z0-9_]{1,40}$/;
  const seenToolNames = new Set<string>();
  const tools: McpToolDefinition[] = [];
  const toolsetCounts: Partial<Record<McpToolset, number>> = {};
  let coreToolCount = 0;

  for (const op of operations) {
    // Only tool, tool-confirm, human-decision, and handoff are exposed to MCP
    if (
      op.mcpExposure !== 'tool' &&
      op.mcpExposure !== 'tool-confirm' &&
      op.mcpExposure !== 'human-decision' &&
      op.mcpExposure !== 'handoff'
    ) {
      continue;
    }

    const toolName = op.mcpToolName ?? op.operationId;
    if (!toolNameRegex.test(toolName)) {
      throw new Error(`Invalid MCP tool name '${toolName}': must match ^[a-z0-9_]{1,40}$`);
    }

    if (seenToolNames.has(toolName)) {
      throw new Error(`Duplicate MCP tool name detected: '${toolName}'`);
    }
    seenToolNames.add(toolName);

    const routeLookup = routeMap.get(`${op.method} ${op.pattern}`) ?? (op as unknown as RoutePrivilegeLookupItem);
    const inputSchema = buildMcpInputSchema(op);
    const outputSchema = buildMcpOutputSchema(op);
    const annotations = buildMcpAnnotations(op);
    const inCore = Boolean(op.inCoreToolset);

    if (inCore) {
      coreToolCount++;
    }

    if (op.toolset) {
      toolsetCounts[op.toolset] = (toolsetCounts[op.toolset] ?? 0) + 1;
    }

    tools.push({
      name: toolName,
      title: op.summary,
      description: op.description ? `${op.summary}. ${op.description}` : op.summary,
      inputSchema,
      outputSchema,
      annotations,
      _meta: {
        operationId: op.operationId,
        method: op.method,
        pattern: op.pattern,
        privilege: routeLookup?.privilege,
        staff: op.staff,
        toolset: op.toolset,
        exposure: op.mcpExposure,
        inCore,
      },
    });
  }

  if (coreToolCount > 40) {
    throw new Error(`Core MCP toolset count exceeds bounded limit: ${coreToolCount} > 40`);
  }

  const toolsets: Record<string, { toolCount: number; description: string }> = {
    core: {
      toolCount: coreToolCount,
      description: TOOLSET_DESCRIPTIONS.core,
    },
  };

  for (const set of MCP_TOOLSETS) {
    if (set === 'core') continue;
    toolsets[set] = {
      toolCount: toolsetCounts[set] ?? 0,
      description: TOOLSET_DESCRIPTIONS[set],
    };
  }

  return {
    version,
    toolsets,
    tools,
  };
}

/**
 * Validates operation contract structure, exposure rules, and invariants.
 */
export function validateOperationContract(op: OperationContract): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!op.operationId || typeof op.operationId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(op.operationId)) {
    errors.push(`Operation '${op.method} ${op.pattern}' has invalid operationId '${op.operationId}'`);
  }

  if (!HTTP_METHODS.includes(op.method)) {
    errors.push(`Operation '${op.operationId}' has invalid HTTP method '${op.method}'`);
  }

  if (!op.pattern || !op.pattern.startsWith('/')) {
    errors.push(`Operation '${op.operationId}' has invalid pattern '${op.pattern}'`);
  }

  if (!op.summary || typeof op.summary !== 'string' || !op.summary.trim()) {
    errors.push(`Operation '${op.operationId}' is missing a summary`);
  }

  if (!FACTORY_SERVICE_NAMES.includes(op.staff)) {
    errors.push(`Operation '${op.operationId}' references unknown factory staff member '${op.staff}'`);
  }

  if (!MCP_EXPOSURE_CLASSES.includes(op.mcpExposure)) {
    errors.push(`Operation '${op.operationId}' has invalid mcpExposure '${op.mcpExposure}'`);
  }

  const isMcpExposed =
    op.mcpExposure === 'tool' ||
    op.mcpExposure === 'tool-confirm' ||
    op.mcpExposure === 'human-decision' ||
    op.mcpExposure === 'handoff';

  if (isMcpExposed) {
    if (!op.toolset || !MCP_TOOLSETS.includes(op.toolset)) {
      errors.push(`MCP exposed operation '${op.operationId}' must specify a valid McpToolset (got '${op.toolset}')`);
    }

    const toolName = op.mcpToolName ?? op.operationId;
    if (!/^[a-z0-9_]{1,40}$/.test(toolName)) {
      errors.push(`MCP tool name '${toolName}' for operation '${op.operationId}' must match ^[a-z0-9_]{1,40}$`);
    }
  }

  // Exposure class specific invariants:
  if (op.method === 'POST' && (op.pattern === '/api/v1/keys' || op.pattern === '/api/v1/keys/:id/rotate')) {
    if (op.mcpExposure !== 'console-or-cli-only') {
      errors.push(`API key issuance/rotation '${op.method} ${op.pattern}' MUST have mcpExposure: 'console-or-cli-only' per CL6`);
    }
  }

  // Mutating operation schema completeness:
  // Every mutating route (POST, PUT, PATCH) that is exposed (non-internal) MUST declare either a requestBodySchema with properties or explicit noRequestBody: true
  if (['POST', 'PUT', 'PATCH'].includes(op.method) && op.mcpExposure !== 'internal') {
    const hasBodyProperties = Boolean(
      op.requestBodySchema?.properties && Object.keys(op.requestBodySchema.properties).length > 0,
    );
    if (!hasBodyProperties && !op.noRequestBody) {
      errors.push(
        `Mutating operation '${op.operationId}' (${op.method} ${op.pattern}) must define a requestBodySchema with properties or explicitly set noRequestBody: true`,
      );
    }
    if (op.noRequestBody && op.requestBodySchema) {
      errors.push(
        `Operation '${op.operationId}' (${op.method} ${op.pattern}) cannot specify both noRequestBody: true and requestBodySchema`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Shared canonical CLI operation definition interface (§6.17 CL11, GAP-249, TSK-340).
 * CLI tool metadata and control plane bindings are derived from this catalog.
 */
export interface CliOperationDefinition {
  readonly name: string;
  readonly description: string;
  readonly privilege: string;
  readonly mutating: boolean;
  readonly agentScoped?: boolean;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly parameters: JsonSchemaObject;
}

const agentIdParam: JsonSchemaObject = { type: 'string', description: 'The agent id.' };

/**
 * Canonical CLI operations catalog (§6.17 CL11, GAP-249).
 * All 42 control-plane operations exposed to the CLI tools and slash commands.
 */
export const CLI_OPERATIONS: readonly CliOperationDefinition[] = [
  // People, grants, access
  {
    name: 'list_principals',
    description: 'The people and services the factory knows, with their emails.',
    privilege: 'grants.manage',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/principals',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_grants',
    description: 'Role grants, optionally for one subject.',
    privilege: 'grants.manage',
    mutating: false,
    agentScoped: true,
    method: 'GET',
    pathTemplate: '/api/v1/grants',
    parameters: { type: 'object', properties: { subject: { type: 'string' } } },
  },
  {
    name: 'grant_role',
    description: 'Grant a role to a subject at fleet, agent:<id> or skill:<id> scope.',
    privilege: 'grants.manage',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/grants',
    parameters: {
      type: 'object',
      properties: { subject: { type: 'string' }, role: { type: 'string' }, scope: { type: 'string' } },
      required: ['subject', 'role'],
    },
  },
  {
    name: 'revoke_grant',
    description: 'Revoke one grant by id.',
    privilege: 'grants.manage',
    mutating: true,
    agentScoped: true,
    method: 'DELETE',
    pathTemplate: '/api/v1/grants/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },

  // Agents & policy
  {
    name: 'list_agents',
    description: 'List every agent with its state, budget standing and owners.',
    privilege: 'agents.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/agents',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_agent',
    description: 'Details and lifecycle state of one agent.',
    privilege: 'agents.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/registry/agents/:id',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'get_agent_policy',
    description: "An agent's policy: granted routes, models and budget.",
    privilege: 'policy.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/agents/:id/policy',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },

  // Metrics & Spend
  {
    name: 'factory_metrics',
    description: 'Operational snapshot: active runs, agent counts by state, spend today and this month against budgets.',
    privilege: 'metrics.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/metrics',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_spend',
    description: 'Spend so far, by agent.',
    privilege: 'spend.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/spend',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_spend_report',
    description: 'The factory spend report (AI and infrastructure) for a calendar month.',
    privilege: 'spend.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/spend/report',
    parameters: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['current', 'last'], description: 'Which month. Default current.' } },
    },
  },
  {
    name: 'get_compute_spend',
    description: 'Infrastructure (compute) spend.',
    privilege: 'spend.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/spend/compute',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_factory_budgets',
    description: 'The factory-wide monthly budgets (AI, infrastructure, total) and their history.',
    privilege: 'spend.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/spend/budgets',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_factory_budgets',
    description: 'Set the factory-wide monthly budgets in dollars. Send only the ones to change. alertAt is a list of fractions such as [0.8, 1].',
    privilege: 'spend.budget.set',
    mutating: true,
    method: 'PUT',
    pathTemplate: '/api/v1/spend/budgets',
    parameters: {
      type: 'object',
      properties: {
        aiMonthUsd: { type: 'number' },
        infraMonthUsd: { type: 'number' },
        totalMonthUsd: { type: 'number' },
        alertAt: { type: 'array', items: { type: 'number' } },
      },
    },
  },
  {
    name: 'set_agent_budget',
    description: "Set one agent's spend limit in dollars for a day or a month.",
    privilege: 'registry.budget.set',
    mutating: true,
    method: 'PUT',
    pathTemplate: '/api/v1/registry/agents/:id/budget',
    parameters: {
      type: 'object',
      properties: { id: agentIdParam, spendLimitUsd: { type: 'number' }, period: { type: 'string', enum: ['daily', 'monthly'] } },
      required: ['id', 'spendLimitUsd', 'period'],
    },
  },

  // Runs
  {
    name: 'list_runs',
    description: 'Recent runs, optionally for one agent or only the active ones.',
    privilege: 'runs.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/runs',
    parameters: {
      type: 'object',
      properties: { agent: agentIdParam, active: { type: 'boolean' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'get_run',
    description: 'One run: state, trigger, timing and cost.',
    privilege: 'runs.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/runs/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'cancel_run',
    description: 'Cancel an active run.',
    privilege: 'runs.cancel',
    mutating: true,
    method: 'POST',
    pathTemplate: '/api/v1/runs/:id/cancel',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The run id.' } }, required: ['id'] },
  },

  // Ledger & Approvals
  {
    name: 'query_ledger',
    description: 'Recent rows of the audit ledger, optionally for one agent.',
    privilege: 'ledger.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/ledger',
    parameters: { type: 'object', properties: { agent: agentIdParam, limit: { type: 'integer' } } },
  },
  {
    name: 'list_approvals',
    description: 'Tool calls held for a person to approve.',
    privilege: 'approvals.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/approvals',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'decide_approval',
    description: 'Approve or reject a held tool call or a decision an agent asked for; capUsd sets a spending cap when approving a decision.',
    privilege: 'approvals.decide',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/approvals/:id',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        notes: { type: 'string' },
        capUsd: { type: 'string', description: 'A cap in USD, e.g. 2500 or $2,500.00.' },
      },
      required: ['id', 'decision'],
    },
  },

  // Lifecycle & control
  {
    name: 'pause_agent',
    description: 'Pause an agent: the kill-switch. It stops egress and wake-ups until resumed.',
    privilege: 'agents.pause',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/agents/:id/pause',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'resume_agent',
    description: 'Resume a paused or isolated agent.',
    privilege: 'agents.resume',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/agents/:id/resume',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'isolate_agent',
    description: "Isolate an agent's egress.",
    privilege: 'agents.isolate',
    mutating: true,
    method: 'POST',
    pathTemplate: '/api/v1/agents/:id/isolate',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'wake_agent',
    description: 'Wake an agent (start a run).',
    privilege: 'agents.wake',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/agents/:id/wake',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'reset_agent',
    description: "End the agent's runs and return it to sleeping.",
    privilege: 'agents.reset',
    mutating: true,
    method: 'POST',
    pathTemplate: '/api/v1/agents/:id/reset',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'retire_agent',
    description: 'Retire an agent (stage 1: compute and triggers off; reversible until purged).',
    privilege: 'registry.retire',
    mutating: true,
    method: 'POST',
    pathTemplate: '/api/v1/registry/agents/:id/retire',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },
  {
    name: 'reinstate_agent',
    description: 'Bring a retired agent back during its holding period.',
    privilege: 'registry.reinstate',
    mutating: true,
    method: 'POST',
    pathTemplate: '/api/v1/registry/agents/:id/reinstate',
    parameters: { type: 'object', properties: { id: agentIdParam }, required: ['id'] },
  },

  // Models, Skills, Triage, Schedules
  {
    name: 'list_models',
    description: 'Models the factory offers and the default.',
    privilege: 'models.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/models',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_skills',
    description: 'The skills catalog.',
    privilege: 'skills.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/skills',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_triage',
    description: 'Open incidents and faults (the Doctor).',
    privilege: 'triage.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/triage',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_schedules',
    description: 'Scheduled wake-ups.',
    privilege: 'schedules.read',
    mutating: false,
    method: 'GET',
    pathTemplate: '/api/v1/schedules',
    parameters: { type: 'object', properties: {} },
  },

  // Subscriptions & BYOM (§6.9 M5)
  {
    name: 'list_subscriptions',
    description: 'Subscription connections, permitted vendor templates with terms, and vendors not offered.',
    privilege: 'subscriptions.own',
    mutating: false,
    agentScoped: true,
    method: 'GET',
    pathTemplate: '/api/v1/subscriptions',
    parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['factory', 'personal'] } } },
  },
  {
    name: 'get_subscription_spend',
    description: 'Subscription token usage today and this UTC month per connection and per agent.',
    privilege: 'subscriptions.own',
    mutating: false,
    agentScoped: true,
    method: 'GET',
    pathTemplate: '/api/v1/subscriptions/spend',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'connect_subscription',
    description: 'Start device-code sign-in to connect a permitted vendor subscription (personal BYOM or factory-shared). Requires subscriberAttested: true.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/subscriptions/connect',
    parameters: {
      type: 'object',
      properties: {
        templateId: { type: 'string' },
        subscriberAttested: { type: 'boolean' },
        scope: { type: 'string', enum: ['factory', 'personal'] },
        name: { type: 'string' },
      },
      required: ['templateId', 'subscriberAttested'],
    },
  },
  {
    name: 'poll_subscription_signin',
    description: 'Poll a pending subscription device-code sign-in by signInId until connected.',
    privilege: 'subscriptions.own',
    mutating: false,
    agentScoped: true,
    method: 'GET',
    pathTemplate: '/api/v1/subscriptions/sign-ins/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'reconnect_subscription',
    description: 'Start device-code sign-in to re-authorize an existing subscription connection. Requires subscriberAttested: true.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/subscriptions/:id/reconnect',
    parameters: { type: 'object', properties: { id: { type: 'string' }, subscriberAttested: { type: 'boolean' } }, required: ['id', 'subscriberAttested'] },
  },
  {
    name: 'rename_subscription',
    description: 'Rename a subscription connection (catalog display labels update immediately).',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'PATCH',
    pathTemplate: '/api/v1/subscriptions/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] },
  },
  {
    name: 'set_subscription_cap',
    description: 'Set or clear (null) the optional per-agent daily usage cap on a subscription connection.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'PATCH',
    pathTemplate: '/api/v1/subscriptions/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' }, cap: { type: ['integer', 'null'] } }, required: ['id', 'cap'] },
  },
  {
    name: 'discover_subscription_models',
    description: 'Discover models offered by the vendor plan on a subscription connection.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/subscriptions/:id/discover',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'add_subscription_model',
    description: 'Admit a subscription-backed model into the catalog ($0 immutable for personal BYOM; explicit price for factory).',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'POST',
    pathTemplate: '/api/v1/subscriptions/:id/models',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        modelId: { type: 'string' },
        inputPerMTok: { type: 'number' },
        outputPerMTok: { type: 'number' },
      },
      required: ['id', 'name', 'modelId'],
    },
  },
  {
    name: 'retire_subscription_model',
    description: 'Retire a subscription-backed model from the catalog.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'DELETE',
    pathTemplate: '/api/v1/subscriptions/:id/models/:model',
    parameters: { type: 'object', properties: { id: { type: 'string' }, model: { type: 'string' } }, required: ['id', 'model'] },
  },
  {
    name: 'disconnect_subscription',
    description: 'Disconnect a subscription connection, purge its vault grant, and retire its catalog models.',
    privilege: 'subscriptions.own',
    mutating: true,
    agentScoped: true,
    method: 'DELETE',
    pathTemplate: '/api/v1/subscriptions/:id',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

/**
 * Fast lookup map of canonical CLI operations keyed by tool name.
 */
export const CLI_OPERATION_MAP: Readonly<Record<string, CliOperationDefinition>> = Object.fromEntries(
  CLI_OPERATIONS.map((op) => [op.name, op]),
);
