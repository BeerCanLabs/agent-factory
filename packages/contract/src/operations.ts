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
      properties[k] = v;
      if (!required.includes(k)) required.push(k);
    }
  }

  // 2. Query parameters
  if (op.querySchema?.properties) {
    for (const [k, v] of Object.entries(op.querySchema.properties)) {
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
