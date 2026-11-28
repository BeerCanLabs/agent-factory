import http from 'node:http';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@beercanlabs/factory-auth';
import {
  AGENT_SCOPED,
  authorize,
  requiredRoleForPrivilege,
  type Privilege,
} from '@beercanlabs/factory-bouncer';
import {
  buildMcpSchemaCatalog,
  type JsonSchemaObject,
  type McpToolDefinition,
  type OperationContract,
} from '@beercanlabs/factory-contract';
import { CONTROL_PLANE_ROUTES } from './route-registry.js';
import {
  actAsStorage,
  agentKindOf,
  checkOwnsAnyAgent,
  checkOwnsPersonalAgent,
  dispatchControlPlaneHttp,
  effectiveGrantsForActor,
  identify,
  mayDecide,
  mcpContextStorage,
  requestBasePrincipal,
  type FactoryState,
} from './app.js';
import { explicitOwnerOf, ownersOf } from './config-store.js';
import { holdDecider } from './decision-holds.js';
import { callerMayUseScopedGrantTools, rolesForSubjectActor } from './grants-routes.js';
import { verifySession } from './login.js';
import { principalAuthMethod, requestAuthMethod } from './auth-method.js';

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ToolSpec = {
  name: string;
  title: string;
  description: string;
  privilege: Privilege;
  scopedDelegation?: boolean;
  args?: Record<string, { type: string; items?: { type: string } }>;
  required?: string[];
  annotations: ToolAnnotations;
  inputSchema?: any;
  outputSchema?: any;
  _meta?: any;
};

export type McpChallengeRecord = {
  id: string;
  actor: string;
  operationId: string;
  method: string;
  pattern: string;
  path: string;
  args: Record<string, unknown>;
  via: string;
  createdAt: number;
  expiresAt: number;
};

export type McpHandoffRecord = {
  id: string;
  actor: string;
  operationId: string;
  method: string;
  pattern: string;
  path: string;
  nonSecretArgs: Record<string, unknown>;
  secretParamNames: string[];
  via: string;
  createdAt: number;
  expiresAt: number;
};

export interface HandleMcpOptions {
  toolsets?: readonly string[];
  isAll?: boolean;
  readOnly?: boolean;
  clientId?: string;
}

export function redactMcpSecretText(text: string, secrets?: Iterable<string>): string {
  let out = text;
  if (secrets) {
    const list = [...secrets].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
    for (const secret of list) {
      if (!out.includes(secret)) continue;
      out = out.split(secret).join('[REDACTED]');
    }
  }
  // Sanitize common credential patterns
  out = out.replace(/\bfk_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  return out;
}

export function redactMcpResponse<T>(res: T, secrets?: Iterable<string>): T {
  if (!res || typeof res !== 'object') return res;
  const obj = res as Record<string, unknown>;
  if (obj.result && typeof obj.result === 'object') {
    const r = { ...(obj.result as Record<string, unknown>) };
    if (Array.isArray(r.content)) {
      r.content = r.content.map((c) => {
        if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
          return { ...c, text: redactMcpSecretText(c.text, secrets) };
        }
        return c;
      });
    }
    if (r.structuredContent !== undefined) {
      try {
        const jsonStr = JSON.stringify(r.structuredContent);
        r.structuredContent = JSON.parse(redactMcpSecretText(jsonStr, secrets));
      } catch {
        // preserve unparsed
      }
    }
    return { ...obj, result: r } as T;
  }
  return res;
}

const catalog = buildMcpSchemaCatalog(CONTROL_PLANE_ROUTES, CONTROL_PLANE_ROUTES);

export const TOOLS: ToolSpec[] = catalog.tools.map((t) => {
  const meta = t._meta as any;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    privilege: (Array.isArray(meta?.privilege) ? meta.privilege[0] : meta?.privilege) as Privilege,
    scopedDelegation: t.name === 'list_grants' || t.name === 'grant_role' || t.name === 'revoke_grant',
    args: (t.inputSchema as any)?.properties ?? {},
    required: (t.inputSchema as any)?.required ?? [],
    annotations: t.annotations,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    _meta: meta,
  };
});

const TOOL_MAP = new Map<string, McpToolDefinition>();
for (const t of catalog.tools) {
  TOOL_MAP.set(t.name, t);
}

const OPERATION_MAP = new Map<string, OperationContract>();
for (const op of CONTROL_PLANE_ROUTES) {
  OPERATION_MAP.set(op.operationId, op);
  OPERATION_MAP.set(`${op.method} ${op.pattern}`, op);
  if (op.mcpToolName) {
    OPERATION_MAP.set(op.mcpToolName, op);
  }
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  grant_role: 'create_grant',
  list_models: 'list_model_catalog',
  set_model_pricing: 'update_model_pricing',
  retire_model: 'retire_vendor_or_model',
  check_agent_updates: 'check_agent_update',
  revoke_principal_access: 'revoke_all_access',
  get_approval_details: 'get_approval',
};

const STAFF_TOOLSET_ALIASES: Record<string, string[]> = {
  gatekeeper: ['access', 'systems', 'agents'],
  bouncer: ['access'],
  keymaster: ['credentials'],
  executive: ['models'],
  accountant: ['spend'],
  'property-manager': ['runs', 'agents'],
  timekeeper: ['schedules'],
  registrar: ['agents', 'skills', 'submissions'],
  'personal-trainer': ['skills'],
  auditor: ['observe'],
  inspector: ['observe'],
};

const VALID_TOOLSET_TOKENS = new Set([
  'all',
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
  ...Object.keys(STAFF_TOOLSET_ALIASES),
]);

export function parseToolsetTokens(
  raw: string | readonly string[],
): { ok: true; toolsets: Set<string>; isAll: boolean } | { ok: false; error: 'unknown_toolset'; unknownToken: string } {
  const tokens = Array.isArray(raw)
    ? raw.flatMap((s) => String(s).split(','))
    : String(raw).split(',');
  const toolsets = new Set<string>();
  let isAll = false;

  for (const rawToken of tokens) {
    const t = rawToken.trim().toLowerCase();
    if (!t) continue;
    if (!VALID_TOOLSET_TOKENS.has(t)) {
      return { ok: false, error: 'unknown_toolset', unknownToken: t };
    }
    if (t === 'all') {
      isAll = true;
      toolsets.add('all');
    } else if (t in STAFF_TOOLSET_ALIASES) {
      for (const mapped of STAFF_TOOLSET_ALIASES[t]) {
        toolsets.add(mapped);
      }
    } else {
      toolsets.add(t);
    }
  }

  return { ok: true, toolsets, isAll };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The same rule the contract uses to strip secret body params from `handoff` tool input schemas (CL6). */
function isSecretShapedParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('secret') || lower.includes('token') || lower === 'value' || lower === 'rawsecret' || lower === 'apikey';
}

/** The secret body params of a handoff operation, in schema order (the first is the primary secret field). */
export function handoffSecretParamNames(op: OperationContract): string[] {
  return Object.keys(op.requestBodySchema?.properties ?? {}).filter(isSecretShapedParam);
}

function createInProcessRequest(opts: {
  method: string;
  url: string;
  headers?: http.IncomingHttpHeaders;
  body?: string;
}): http.IncomingMessage {
  const sock = new PassThrough();
  const req = new http.IncomingMessage(sock as any);
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    'content-type': 'application/json',
    ...(opts.body ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
    ...opts.headers,
  };
  if (opts.body !== undefined) {
    req.push(Buffer.from(opts.body, 'utf-8'));
  }
  req.push(null);
  return req;
}

export type InProcessResult = { statusCode: number; headers: http.OutgoingHttpHeaders; body: string };

class InMemoryResponse extends http.ServerResponse {
  private chunks: Buffer[] = [];
  public readonly finishedPromise: Promise<InProcessResult>;

  constructor(req: http.IncomingMessage) {
    super(req);
    // The body is captured from write()/end() below; the socket only exists to satisfy ServerResponse. It must be
    // drained (resume) or a body larger than the PassThrough's highWaterMark back-pressures, the final write callback
    // never fires, 'finish' is never emitted and the outer MCP request hangs forever (TSK-338 hang root cause).
    const sock = new PassThrough();
    sock.resume();
    this.assignSocket(sock as any);
    this.finishedPromise = new Promise((resolve) => {
      const onEnd = () => {
        resolve({
          statusCode: this.statusCode || 200,
          headers: this.getHeaders(),
          body: Buffer.concat(this.chunks).toString('utf-8'),
        });
      };
      this.once('finish', onEnd);
      this.once('close', onEnd);
    });
  }

  override write(chunk: any, encoding?: any, callback?: any): boolean {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8'));
    }
    return super.write(chunk, encoding, callback);
  }

  override end(chunk?: any, encoding?: any, callback?: any): this {
    if (chunk && typeof chunk !== 'function') {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8'));
    }
    return super.end(chunk, encoding, callback);
  }
}

/**
 * Runs a route handler against an in-memory request/response pair and always settles: a thrown handler, a handler
 * that returns without ending the response, a 202/204 empty body and a body of any size all produce a finished result.
 */
export async function runInProcess(
  req: http.IncomingMessage,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown,
): Promise<InProcessResult> {
  const res = new InMemoryResponse(req);
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead((err as { status?: number }).status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message: err instanceof Error ? err.message : String(err) }));
    }
  }
  if (!res.writableEnded) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler_did_not_respond' }));
    } else {
      res.end();
    }
  }
  return res.finishedPromise;
}

async function dispatchInProcess(
  state: FactoryState,
  req: http.IncomingMessage,
  principal: Principal,
  clientId: string,
): Promise<InProcessResult> {
  requestBasePrincipal.set(req, principal);
  // Front-door Phase 0: the in-process request has no Authorization header; it inherits the outer caller's method.
  const method = principalAuthMethod.get(principal);
  if (method) requestAuthMethod.set(req, method);
  delete req.headers['x-factory-act-as'];
  return mcpContextStorage.run({ via: `mcp:${clientId}` }, () =>
    runInProcess(req, (r, s) => dispatchControlPlaneHttp(state, r, s)),
  );
}

function redactBody(body: unknown, secrets?: Iterable<string>, extra: readonly string[] = []): unknown {
  const all = [...(secrets ?? []), ...extra];
  if (typeof body === 'string') return redactMcpSecretText(body, all);
  try {
    return JSON.parse(redactMcpSecretText(JSON.stringify(body), all));
  } catch {
    return body;
  }
}

async function executeInProcessRoute(
  state: FactoryState,
  op: OperationContract,
  tool: McpToolDefinition,
  rawArgs: Record<string, unknown>,
  principal: Principal,
  clientId: string,
  extraSecrets: readonly string[] = [],
): Promise<{ status: number; body: unknown; isError: boolean }> {
  rawArgs = { ...rawArgs };
  // Special handling for list_principals with id: redirect to GET /api/v1/principals/:id
  let targetPattern = op.pattern;
  let targetMethod = op.method;
  if (tool.name === 'list_principals' && typeof rawArgs.id === 'string' && rawArgs.id.trim()) {
    targetPattern = '/api/v1/principals/:id';
    targetMethod = 'GET';
  }
  if (tool.name === 'list_approvals' && rawArgs.state === undefined) {
    rawArgs.state = 'pending';
  }

  // 1. Path parameters substitution
  const pathParamMatches = targetPattern.match(/:[a-zA-Z0-9_]+/g) ?? [];
  let resolvedUrl = targetPattern;
  const pathParamKeys = new Set<string>();

  for (const match of pathParamMatches) {
    const key = match.slice(1);
    pathParamKeys.add(key);
    let val = rawArgs[key];
    if (val === undefined) {
      if (key === 'id') {
        val = rawArgs.agentId ?? rawArgs.runId ?? rawArgs.approvalId ?? rawArgs.grantId ?? rawArgs.skillId ?? rawArgs.principalId ?? rawArgs.systemId ?? rawArgs.scheduleId ?? rawArgs.subscriptionId ?? rawArgs.groupId;
      } else if (key === 'model') {
        val = rawArgs.name ?? rawArgs.model;
      } else if (key === 'vendorId') {
        val = rawArgs.vendorId ?? rawArgs.vendor;
      } else if (key === 'version') {
        val = rawArgs.version ?? rawArgs.ver;
      } else if (key === 'email') {
        val = rawArgs.email;
      }
    }
    if (val === undefined) {
      return {
        status: 400,
        body: { error: 'missing_path_parameter', message: `Path parameter ':${key}' is required` },
        isError: true,
      };
    }
    const strVal = String(val);
    if (strVal.includes('..') || strVal.includes('/') || strVal.includes('\\')) {
      return {
        status: 400,
        body: { error: 'path_traversal_refused', message: 'Path traversal is forbidden' },
        isError: true,
      };
    }
    resolvedUrl = resolvedUrl.replace(match, encodeURIComponent(strVal));
  }

  // 2. Query parameters serialization
  const queryProps = op.querySchema?.properties ?? {};
  const searchParams = new URLSearchParams();
  for (const qKey of Object.keys(queryProps)) {
    let qVal = rawArgs[qKey];
    if (qVal === undefined) {
      if (qKey === 'agent' && rawArgs.agentId !== undefined) qVal = rawArgs.agentId;
      if (qKey === 'agentId' && rawArgs.agent !== undefined) qVal = rawArgs.agent;
    }
    if (qVal !== undefined && qVal !== null) {
      searchParams.set(qKey, String(qVal));
    }
  }
  const queryString = searchParams.toString();
  if (queryString) {
    resolvedUrl += (resolvedUrl.includes('?') ? '&' : '?') + queryString;
  }

  // 3. Request body serialization
  let bodyPayload: Record<string, unknown> | undefined;
  if (targetMethod === 'POST' || targetMethod === 'PUT' || targetMethod === 'PATCH') {
    bodyPayload = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (k === 'confirm' || k === 'elicitationConfirmationToken') continue;
      // Exclude if it's purely a query parameter and not in bodyProps
      if (k in queryProps && !(op.requestBodySchema?.properties && k in op.requestBodySchema.properties)) {
        continue;
      }
      // Exclude if it's purely a path parameter and not in bodyProps
      if (pathParamKeys.has(k) && !(op.requestBodySchema?.properties && k in op.requestBodySchema.properties)) {
        continue;
      }
      bodyPayload[k] = v;
    }
    // Alias mappings
    if (bodyPayload.name === undefined && rawArgs.model !== undefined) bodyPayload.name = rawArgs.model;
    if (bodyPayload.model === undefined && rawArgs.name !== undefined) bodyPayload.model = rawArgs.name;
    if (bodyPayload.agentId === undefined && rawArgs.id !== undefined) bodyPayload.agentId = rawArgs.id;
    if (bodyPayload.id === undefined && rawArgs.agentId !== undefined) bodyPayload.id = rawArgs.agentId;
    if (bodyPayload.vendor === undefined && rawArgs.vendorId !== undefined) bodyPayload.vendor = rawArgs.vendorId;
    if (bodyPayload.vendorId === undefined && rawArgs.vendor !== undefined) bodyPayload.vendorId = rawArgs.vendor;
  }

  const inReq = createInProcessRequest({
    method: targetMethod,
    url: resolvedUrl,
    body: bodyPayload !== undefined ? JSON.stringify(bodyPayload) : undefined,
  });

  const resOut = await dispatchInProcess(state, inReq, principal, clientId);

  let parsed: unknown = resOut.body;
  try {
    parsed = JSON.parse(resOut.body);
  } catch {}

  const redacted = redactBody(parsed, state.secretValues, extraSecrets);
  const isErr = resOut.statusCode >= 400;

  return {
    status: resOut.statusCode,
    body: redacted,
    isError: isErr,
  };
}

export async function handleMcp(
  state: FactoryState,
  payload: Record<string, unknown>,
  principal: Principal,
  opts?: HandleMcpOptions,
): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  const clientId = opts?.clientId ?? 'direct';

  if (method === 'initialize') {
    const params = payload.params as { protocolVersion?: string } | undefined;
    const clientVer = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const negotiatedVersion = (clientVer && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVer))
      ? clientVer
      : '2025-11-25';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-factory', version: state.version },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    const evalActor = principal.onBehalfOf ?? principal.actor;
    const grantRes = effectiveGrantsForActor(state, evalActor);
    if (!grantRes.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32003, message: grantRes.error } };
    }
    const evalRoles = principal.onBehalfOf
      ? rolesForSubjectActor(state, evalActor, grantRes.grants)
      : rolesForSubjectActor(state, evalActor, grantRes.grants, principal.roles);
    const evalPrincipal: Principal = {
      actor: evalActor,
      roles: evalRoles,
      ...(principal.keyScopes ? { keyScopes: principal.keyScopes } : {}),
    };
    const ownsAny = checkOwnsAnyAgent(state, evalActor);
    const ownsPersonal = checkOwnsPersonalAgent(state, evalActor);
    const canDelegateScoped =
      (!evalPrincipal.keyScopes?.privileges || evalPrincipal.keyScopes.privileges.includes('grants.manage')) &&
      callerMayUseScopedGrantTools(state, evalPrincipal, grantRes.grants);
    const agentGrantList = grantRes.grants?.filter((eg) => eg.grant.scope.kind === 'agent') ?? [];

    const hasAgentScopes = Boolean(evalPrincipal.keyScopes?.agents && evalPrincipal.keyScopes.agents.length > 0);
    const scopedAgentIds = hasAgentScopes ? evalPrincipal.keyScopes!.agents! : [];

    const requestedToolsets = opts?.toolsets ? new Set(opts.toolsets) : undefined;
    const isAll = Boolean(opts?.isAll);
    const isReadOnly = Boolean(opts?.readOnly);

    const tools = catalog.tools
      .filter((t) => {
        const meta = t._meta as any;

        // Read-only view filter
        if (isReadOnly && !t.annotations.readOnlyHint) {
          return false;
        }

        // Toolset filter
        if (isAll) {
          // keep all authorized tools
        } else if (requestedToolsets) {
          const inRequested = (meta.toolset && requestedToolsets.has(meta.toolset)) || (requestedToolsets.has('core') && meta.inCore);
          if (!inRequested) return false;
        } else {
          // Default: core toolset only
          if (!meta.inCore) return false;
        }

        // Danger tool safety: danger tools require explicit 'danger' or 'all' toolset selection (except revoke_all_access in core)
        if (meta.toolset === 'danger' && !isAll && (!requestedToolsets || !requestedToolsets.has('danger')) && t.name !== 'revoke_all_access') {
          return false;
        }

        const rawPriv = meta.privilege;
        const privs: Privilege[] = rawPriv === undefined
          ? []
          : (Array.isArray(rawPriv) ? rawPriv : [rawPriv]) as Privilege[];

        // Authorization check
        if (hasAgentScopes) {
          if (t.name === 'whoami' || t.name === 'authz_check' || t.name === 'get_setup_status') {
            return true;
          }
          if (
            t.name === 'list_grants' ||
            t.name === 'create_grant' ||
            t.name === 'grant_role' ||
            t.name === 'revoke_grant'
          ) {
            return canDelegateScoped;
          }
          if (
            privs.some((p) =>
              authorize({
                principal: evalPrincipal,
                privilege: p,
                resource: {
                  ownsAnyAgent: ownsAny,
                  ownsPersonalAgent: ownsPersonal,
                  ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
                },
              }).allowed,
            )
          ) {
            return true;
          }
          if (privs.some((p) => AGENT_SCOPED.has(p))) {
            for (const aid of scopedAgentIds) {
              if (
                privs.some((p) =>
                  authorize({
                    principal: evalPrincipal,
                    privilege: p,
                    resource: {
                      agentId: aid,
                      agentKind: agentKindOf(state, aid),
                      owners: ownersOf(state, aid),
                      ...(explicitOwnerOf(state, aid) ? { explicitOwner: explicitOwnerOf(state, aid) } : {}),
                      grants: grantRes.grants,
                      ownsAnyAgent: ownsAny,
                      ownsPersonalAgent: ownsPersonal,
                    },
                  }).allowed,
                )
              ) {
                return true;
              }
            }
          }
          return false;
        }

        if (t.name === 'whoami' || t.name === 'authz_check' || t.name === 'get_setup_status') {
          return true;
        }

        if (
          t.name === 'list_grants' ||
          t.name === 'create_grant' ||
          t.name === 'grant_role' ||
          t.name === 'revoke_grant'
        ) {
          return canDelegateScoped;
        }

        if (privs.length === 0) {
          if (evalPrincipal.keyScopes?.privileges) return false;
          return true;
        }

        if (
          privs.some((p) =>
            authorize({
              principal: evalPrincipal,
              privilege: p,
              resource: {
                ownsAnyAgent: ownsAny,
                ownsPersonalAgent: ownsPersonal,
                ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
              },
            }).allowed,
          )
        ) {
          return true;
        }

        if (privs.some((p) => AGENT_SCOPED.has(p))) {
          if (ownsAny) return true;
          for (const eg of agentGrantList) {
            if (eg.grant.scope.kind !== 'agent') continue;
            const aid = eg.grant.scope.id;
            if (
              privs.some((p) =>
                authorize({
                  principal: evalPrincipal,
                  privilege: p,
                  resource: {
                    agentId: aid,
                    agentKind: agentKindOf(state, aid),
                    owners: ownersOf(state, aid),
                    ...(explicitOwnerOf(state, aid) ? { explicitOwner: explicitOwnerOf(state, aid) } : {}),
                    grants: grantRes.grants,
                  },
                }).allowed,
              )
            ) {
              return true;
            }
          }
        }

        return false;
      })
    const resultTools = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
    const cg = resultTools.find((t) => t.name === 'create_grant');
    if (cg && !resultTools.some((t) => t.name === 'grant_role')) {
      resultTools.push({ ...cg, name: 'grant_role', title: 'Grant Role' });
    }

    return { jsonrpc: '2.0', id, result: { tools: resultTools } };
  }

  if (method === 'tools/call') {
    const grantRes = effectiveGrantsForActor(state, principal.actor);
    if (!grantRes.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32003, message: grantRes.error } };
    }
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (!params || typeof params.name !== 'string' || !params.name.trim()) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool name is required and must be a string' } };
    }

    const targetName = TOOL_NAME_ALIASES[params.name] ?? params.name;
    const tool = TOOL_MAP.get(targetName);
    if (!tool) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    }

    const op = OPERATION_MAP.get(tool._meta.operationId) ?? OPERATION_MAP.get(`${tool._meta.method} ${tool._meta.pattern}`);
    if (!op) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    }

    const rawArgs = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};

    // CL6, GAP-248: actAs and onBehalfOf impersonation arguments are strictly forbidden over MCP
    if (rawArgs.actAs !== undefined || rawArgs.onBehalfOf !== undefined) {
      return redactMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'actAs and onBehalfOf impersonation arguments are forbidden over MCP (CL6, GAP-248)' }],
          structuredContent: { error: 'act_as_forbidden_over_mcp', message: 'actAs and onBehalfOf impersonation arguments are forbidden over MCP' },
          isError: true,
        },
      }, state.secretValues);
    }

    // Read-only view check
    if (opts?.readOnly && !tool.annotations.readOnlyHint) {
      return redactMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'Mutation tools are not permitted on read-only MCP view' }],
          structuredContent: { error: 'readonly_mcp_view', message: 'Mutation tools are not permitted on read-only MCP view' },
          isError: true,
        },
      }, state.secretValues);
    }

    // Danger tool safety: echo-confirm check
    if (tool._meta.toolset === 'danger') {
      const targetId = String(rawArgs.id ?? rawArgs.agentId ?? rawArgs.principalId ?? '');
      if (!rawArgs.confirm || String(rawArgs.confirm).trim() !== targetId) {
        return redactMcpResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `confirmation_required: destructive operation requires confirm argument matching target id '${targetId}'` }],
            structuredContent: { error: 'confirmation_required', message: `destructive operation requires confirm argument matching target id '${targetId}'`, targetId },
            isError: true,
          },
        }, state.secretValues);
      }
    }

    const effectivePrincipal = principal;

    const executeCall = async (): Promise<unknown> => {
      // 1. Authorization check
      const targetAgentId =
        typeof rawArgs.id === 'string'
          ? rawArgs.id
          : typeof rawArgs.agentId === 'string'
            ? rawArgs.agentId
            : undefined;
      const ownsAny = checkOwnsAnyAgent(state, effectivePrincipal.onBehalfOf ?? effectivePrincipal.actor);
      const ownsPersonal = checkOwnsPersonalAgent(state, effectivePrincipal.onBehalfOf ?? effectivePrincipal.actor);
      const resource =
        targetAgentId || grantRes.grants !== undefined || ownsAny || ownsPersonal !== undefined
          ? {
              ...(targetAgentId
                ? {
                    agentId: targetAgentId,
                    agentKind: agentKindOf(state, targetAgentId),
                    owners: ownersOf(state, targetAgentId),
                    ...(explicitOwnerOf(state, targetAgentId) ? { explicitOwner: explicitOwnerOf(state, targetAgentId) } : {}),
                  }
                : {}),
              ownsAnyAgent: ownsAny,
              ...(ownsPersonal !== undefined ? { ownsPersonalAgent: ownsPersonal } : {}),
              ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
            }
          : undefined;

      if (targetName === 'decide_approval') {
        const approvalId = String(rawArgs.approvalId ?? rawArgs.id ?? '');
        const authz = mayDecide(state, effectivePrincipal, approvalId);
        const approval = state.approvals.get(approvalId);
        const decisionHoldDecider =
          approval?.kind === 'decision' && approval.state === 'pending'
            ? holdDecider(state, approval, effectivePrincipal.actor)
            : { ok: true as const };
        if (!authz.ok || !decisionHoldDecider.ok) {
          const errCode = !decisionHoldDecider.ok ? 'not_an_approver' : 'forbidden';
          const required = !authz.ok ? authz.required : 'admin';
          if (state.grants || state.principals) {
            state.ledger.append({
              timestamp: new Date().toISOString(),
              agentId: 'control-plane',
              type: 'action',
              action: 'AUTHZ_DENIED',
              privilege: 'approvals.decide',
              scope: { kind: 'fleet' },
              actor: effectivePrincipal.actor,
              reason: `mcp:decide_approval:${errCode}`,
            });
          }
          return redactMcpResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: !decisionHoldDecider.ok ? 'refused: not_an_approver' : `forbidden: requires ${required}` }],
              structuredContent: { error: errCode, required },
              isError: true,
            },
          }, state.secretValues);
        }
      } else if (
        targetName === 'grant_role' ||
        targetName === 'create_grant' ||
        targetName === 'revoke_grant' ||
        targetName === 'list_grants'
      ) {
        const canDelegate =
          (!effectivePrincipal.keyScopes?.privileges || effectivePrincipal.keyScopes.privileges.includes('grants.manage')) &&
          callerMayUseScopedGrantTools(state, effectivePrincipal, grantRes.grants);
        if (!canDelegate) {
          return redactMcpResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'forbidden: requires grants.manage or scoped delegation' }],
              structuredContent: { error: 'forbidden', required: 'grants.manage' },
              isError: true,
            },
          }, state.secretValues);
        }
      } else if (tool._meta.privilege !== undefined && targetName !== 'whoami' && targetName !== 'authz_check' && targetName !== 'get_setup_status') {
        const rawPriv = tool._meta.privilege;
        const privs: Privilege[] = (Array.isArray(rawPriv) ? rawPriv : [rawPriv]) as Privilege[];
        const isAllowed = privs.some((p) => authorize({ principal: effectivePrincipal, privilege: p, resource }).allowed);
        if (!isAllowed) {
          const primaryPriv = privs[0];
          const decision = authorize({ principal: effectivePrincipal, privilege: primaryPriv, resource });
          const required = !decision.allowed ? decision.required : 'admin';
          const requiredRole = requiredRoleForPrivilege(primaryPriv, resource, required);
          if (state.grants || state.principals) {
            state.ledger.append({
              timestamp: new Date().toISOString(),
              agentId: targetAgentId ?? 'control-plane',
              type: 'action',
              action: 'AUTHZ_DENIED',
              privilege: primaryPriv,
              scope: targetAgentId ? { kind: 'agent', id: targetAgentId } : { kind: 'fleet' },
              actor: effectivePrincipal.actor,
              ...(effectivePrincipal.onBehalfOf ? { onBehalfOf: effectivePrincipal.onBehalfOf } : {}),
              reason: `mcp:${targetName}:requires:${requiredRole}`,
            });
          }
          const refusalText = `forbidden: requires ${required}`;
          return redactMcpResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: refusalText }],
              structuredContent: { error: 'forbidden', required, requiredRole },
              isError: true,
            },
          }, state.secretValues);
        }
      }

      // 2. Human-decision safeguards (E9, Decision 7): the model can never self-confirm. The only way to execute is a
      // live browser session of the same principal POSTing the single-use confirmation URL.
      if (tool._meta.exposure === 'human-decision') {
        // Mint challenge
        const challengeId = randomUUID();
        const now = Date.now();
        const expiresAt = now + 10 * 60 * 1000;
        const { elicitationConfirmationToken: _ignored, ...challengeArgs } = rawArgs;
        const challenge: McpChallengeRecord = {
          id: challengeId,
          actor: effectivePrincipal.actor,
          operationId: op.operationId,
          method: op.method,
          pattern: op.pattern,
          path: op.pattern,
          args: challengeArgs,
          via: `mcp:${clientId}`,
          createdAt: now,
          expiresAt,
        };
        state.mcpChallenges ??= new Map();
        state.mcpChallenges.set(challengeId, challenge);
        const confirmationUrl = `/api/v1/mcp/confirm/${challengeId}`;
        const msg = `Operation '${params.name}' (${op.operationId}) requires human confirmation. Please review and confirm at ${confirmationUrl}`;
        return redactMcpResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: 'human_confirmation_required', message: msg, confirmationUrl, challengeId, operationId: op.operationId }) }],
            structuredContent: {
              status: 'human_confirmation_required',
              message: msg,
              confirmationUrl,
              challengeId,
              operationId: op.operationId,
              expiresInSeconds: 600,
            },
          },
        }, state.secretValues);
      }

      // 3. Secret handoff (CL6, K5)
      if (tool._meta.exposure === 'handoff') {
        // CL6/K5: secret values never travel over MCP. Anything secret-shaped the model sent is discarded, never
        // stored and never echoed; the human types it into the session-bound handoff page instead.
        const secretParamNames = handoffSecretParamNames(op);
        const nonSecretArgs: Record<string, unknown> = {};
        let discardedSecretArgs = false;
        for (const [k, v] of Object.entries(rawArgs)) {
          if (secretParamNames.includes(k) || isSecretShapedParam(k)) {
            discardedSecretArgs = true;
            continue;
          }
          nonSecretArgs[k] = v;
        }
        const handoffId = randomUUID();
        const now = Date.now();
        const expiresAt = now + 10 * 60 * 1000;
        const handoff: McpHandoffRecord = {
          id: handoffId,
          actor: effectivePrincipal.actor,
          operationId: op.operationId,
          method: op.method,
          pattern: op.pattern,
          path: op.pattern,
          nonSecretArgs,
          secretParamNames,
          via: `mcp:${clientId}`,
          createdAt: now,
          expiresAt,
        };
        state.mcpHandoffs ??= new Map();
        state.mcpHandoffs.set(handoffId, handoff);
        const handoffUrl = `/api/v1/mcp/handoff/${handoffId}`;
        const msg = `Tool '${params.name}' (${op.operationId}) requires sensitive credentials. Never pass plaintext secrets over MCP${discardedSecretArgs ? ' (the secret arguments sent were discarded, not stored)' : ''}. Complete secret entry at ${handoffUrl}`;
        return redactMcpResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: 'handoff_required', message: msg, handoffUrl, handoffId, operationId: op.operationId }) }],
            structuredContent: {
              status: 'handoff_required',
              message: msg,
              handoffUrl,
              handoffId,
              operationId: op.operationId,
              expiresInSeconds: 600,
              discardedSecretArgs,
            },
          },
        }, state.secretValues);
      }

      // 4. In-process route dispatch for standard tool / tool-confirm
      const outcome = await executeInProcessRoute(state, op, tool, rawArgs, effectivePrincipal, clientId);
      const structured = (typeof outcome.body === 'object' && outcome.body !== null) ? (outcome.body as Record<string, unknown>) : { value: outcome.body };
      let text: string;
      if (outcome.status === 403 && ((structured as any).requiredRole || (structured as any).required)) {
        const reqRole = String((structured as any).requiredRole ?? (structured as any).required);
        text = `forbidden: requires ${reqRole}`;
      } else if (outcome.status === 503) {
        text = String((structured as any).error ?? 'store_unavailable');
      } else {
        text = typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body);
      }
      return redactMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: structured,
          ...(outcome.isError ? { isError: true } : {}),
        },
      }, state.secretValues);
    };

    if (effectivePrincipal.onBehalfOf) {
      return actAsStorage.run(
        { actor: effectivePrincipal.actor, onBehalfOf: effectivePrincipal.onBehalfOf },
        executeCall,
      );
    }
    return executeCall();
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

export async function handleAgentMcp(
  state: FactoryState,
  payload: Record<string, unknown>,
  principal: Principal,
  agentId: string,
  opts?: { clientId?: string },
): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  const clientId = opts?.clientId ?? 'direct';

  if (method === 'initialize') {
    const params = payload.params as { protocolVersion?: string } | undefined;
    const clientVer = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const negotiatedVersion = (clientVer && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVer))
      ? clientVer
      : '2025-11-25';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `agent-factory:${agentId}`, version: state.version },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    const agentTools = [
      {
        name: 'ask',
        title: 'Ask Agent',
        description: 'Send a message or conversation turn to this agent and optionally await reply.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message or prompt to send to the agent' },
            waitSeconds: { type: 'number', description: 'Optional wait seconds (0..25) to poll for immediate reply' },
            speaker: { type: 'string', description: "Enrolled person speaking: a user:<id> or an enrolled alias (e.g. 'dale')" },
            conversationId: { type: 'string', description: 'Existing conversation id to continue a live call' },
            mode: { type: 'string', enum: ['call', 'errand'], description: "call = live multi-turn; errand = one-shot task (default call)" },
            channel: { type: 'string', description: "How the person is reaching the agent (default 'voice')" },
            assurance: { type: 'string', description: "How the client identified the speaker (default 'voice-asserted')" },
          },
          required: ['message'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      {
        name: 'get_replies',
        title: 'Get Replies',
        description: 'Retrieve recent replies sent by this agent for the current conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            after: { type: 'number', description: 'Sequence number to fetch replies after (defaults to 0)' },
            conversationId: { type: 'string', description: 'Only replies for this live conversation' },
          },
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'get_agent_info',
        title: 'Get Agent Information',
        description: 'Get configuration and runtime status information for this agent.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'list_callable_agents',
        title: 'List Callable Agents',
        description: 'List agents this client may connect the enrolled speaker to (id, display name, short description). The per-agent voice map stays on the client.',
        inputSchema: {
          type: 'object',
          properties: {
            speaker: { type: 'string', description: "Enrolled person: a user:<id> or an enrolled alias (e.g. 'dale')" },
          },
          required: ['speaker'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ];
    return { jsonrpc: '2.0', id, result: { tools: agentTools } };
  }

  if (method === 'tools/call') {
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = params.name;
    const args = params.arguments ?? {};

    if (toolName === 'ask') {
      const message = typeof args.message === 'string' ? args.message : '';
      if (!message.trim()) {
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'message is required' }] } };
      }
      const waitSeconds = typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) ? Math.max(0, Math.min(25, args.waitSeconds)) : 0;
      const speakAs: Record<string, unknown> = {};
      if (typeof args.speaker === 'string' && args.speaker.trim()) speakAs.speaker = args.speaker.trim();
      if (typeof args.conversationId === 'string' && args.conversationId.trim()) speakAs.conversationId = args.conversationId.trim();
      if (args.mode === 'call' || args.mode === 'errand') speakAs.mode = args.mode;
      if (typeof args.channel === 'string' && args.channel.trim()) speakAs.channel = args.channel.trim();
      if (typeof args.assurance === 'string' && args.assurance.trim()) speakAs.assurance = args.assurance.trim();
      const inReq = createInProcessRequest({
        method: 'POST',
        url: `/api/v1/agents/${encodeURIComponent(agentId)}/conversation`,
        body: JSON.stringify({ input: message, waitSeconds, ...speakAs }),
      });
      const out = await dispatchInProcess(state, inReq, principal, clientId);
      let parsed: unknown = out.body;
      try { parsed = JSON.parse(out.body); } catch {}
      const redacted = redactBody(parsed, state.secretValues);
      const isErr = out.statusCode >= 400;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof redacted === 'string' ? redacted : JSON.stringify(redacted) }],
          structuredContent: (typeof redacted === 'object' && redacted !== null) ? redacted : { value: redacted },
          ...(isErr ? { isError: true } : {}),
        },
      };
    }

    if (toolName === 'get_replies') {
      const after = typeof args.after === 'number' && Number.isFinite(args.after) ? args.after : 0;
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
      const qs = new URLSearchParams({ after: String(after) });
      if (conversationId) qs.set('conversationId', conversationId);
      const inReq = createInProcessRequest({
        method: 'GET',
        url: `/api/v1/agents/${encodeURIComponent(agentId)}/replies?${qs.toString()}`,
      });
      const out = await dispatchInProcess(state, inReq, principal, clientId);
      let parsed: unknown = out.body;
      try { parsed = JSON.parse(out.body); } catch {}
      const redacted = redactBody(parsed, state.secretValues);
      const isErr = out.statusCode >= 400;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof redacted === 'string' ? redacted : JSON.stringify(redacted) }],
          structuredContent: (typeof redacted === 'object' && redacted !== null) ? redacted : { value: redacted },
          ...(isErr ? { isError: true } : {}),
        },
      };
    }

    if (toolName === 'list_callable_agents') {
      const speaker = typeof args.speaker === 'string' ? args.speaker.trim() : '';
      const qs = new URLSearchParams();
      if (speaker) qs.set('speaker', speaker);
      const inReq = createInProcessRequest({
        method: 'GET',
        url: `/api/v1/speak-as/callable-agents?${qs.toString()}`,
      });
      const out = await dispatchInProcess(state, inReq, principal, clientId);
      let parsed: unknown = out.body;
      try { parsed = JSON.parse(out.body); } catch {}
      const redacted = redactBody(parsed, state.secretValues);
      const isErr = out.statusCode >= 400;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof redacted === 'string' ? redacted : JSON.stringify(redacted) }],
          structuredContent: (typeof redacted === 'object' && redacted !== null) ? redacted : { value: redacted },
          ...(isErr ? { isError: true } : {}),
        },
      };
    }

    if (toolName === 'get_agent_info') {
      const agent = state.agents.get(agentId);
      if (!agent) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: 'agent_not_found', message: `Agent '${agentId}' not found` }) }],
            structuredContent: { error: 'agent_not_found', message: `Agent '${agentId}' not found` },
            isError: true,
          },
        };
      }
      const agentAny = agent as any;
      const info = {
        id: agent.id,
        name: agent.name,
        state: agent.state,
        ...(agentAny.currentModel ? { currentModel: agentAny.currentModel } : {}),
      };
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(info) }],
          structuredContent: info,
        },
      };
    }

    return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(toolName)}` } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

type SessionGate = { ok: true; principal: Principal } | { ok: false; status: 401 | 403; error: string; message: string };

/**
 * E9 / CL6: confirmation and secret-handoff pages act only for a live factory browser session (the HttpOnly session
 * cookie, CSRF same-origin checked on POST by `verifySession`) of the very principal that made the MCP call. A bearer
 * token or API key is never enough, and nobody else (not even an admin) may act on another principal's challenge.
 */
async function sessionPrincipalFor(state: FactoryState, req: http.IncomingMessage, ownerActor: string): Promise<SessionGate> {
  if (req.headers.authorization || !verifySession(state, req).ok) {
    return { ok: false, status: 401, error: 'session_required', message: 'A live signed-in browser session is required' };
  }
  const who = await identify(req, state, { skipActAs: true });
  if (!who.ok) {
    return { ok: false, status: 401, error: 'session_required', message: 'A live signed-in browser session is required' };
  }
  if (who.principal.actor !== ownerActor) {
    return { ok: false, status: 403, error: 'forbidden', message: 'This link belongs to another principal' };
  }
  return { ok: true, principal: who.principal };
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
} as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function page(title: string, heading: string, inner: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2rem; max-width: 520px; width: 100%; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; color: #38bdf8; }
    p { font-size: 0.875rem; color: #94a3b8; line-height: 1.5; margin: 0.5rem 0; }
    .meta { background: #0f172a; border-radius: 8px; padding: 1rem; margin: 1rem 0; font-family: monospace; font-size: 0.8rem; overflow-x: auto; color: #e2e8f0; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin: 1rem 0 0.5rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 0.75rem; color: white; font-family: monospace; }
    .btn { background: #2563eb; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 600; border: none; cursor: pointer; width: 100%; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    ${inner}
  </div>
</body>
</html>`;
}

function liveChallenge(state: FactoryState, id: string): McpChallengeRecord | undefined {
  const ch = state.mcpChallenges?.get(id);
  if (ch && ch.expiresAt <= Date.now()) {
    state.mcpChallenges!.delete(id);
    return undefined;
  }
  return ch;
}

function liveHandoff(state: FactoryState, id: string): McpHandoffRecord | undefined {
  const h = state.mcpHandoffs?.get(id);
  if (h && h.expiresAt <= Date.now()) {
    state.mcpHandoffs!.delete(id);
    return undefined;
  }
  return h;
}

const MAX_FORM_BYTES = 64 * 1024;

async function readFormOrJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_FORM_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  if (!raw.trim()) return {};
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function handleMcpConfirmGet(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  confirmId: string,
): Promise<void> {
  const challenge = liveChallenge(state, confirmId);
  if (!challenge) {
    sendJson(res, 410, { error: 'challenge_expired', message: 'Confirmation link was already used, has expired, or does not exist' });
    return;
  }
  const gate = await sessionPrincipalFor(state, req, challenge.actor);
  if (!gate.ok) {
    sendJson(res, gate.status, { error: gate.error, message: gate.message });
    return;
  }
  res.writeHead(200, PAGE_HEADERS);
  res.end(page('Confirm MCP Operation', 'Human Confirmation Required', `
    <p>An MCP client (${escapeHtml(challenge.via)}) asked to run an operation that needs your judgement. Review it and confirm only if you intend it:</p>
    <div class="meta">
      <div><strong>Operation:</strong> ${escapeHtml(challenge.operationId)}</div>
      <div><strong>Actor:</strong> ${escapeHtml(challenge.actor)}</div>
      <div><strong>Arguments:</strong></div>
      <pre style="margin-top:0.5rem; white-space:pre-wrap;">${escapeHtml(JSON.stringify(redactBody(challenge.args, state.secretValues), null, 2))}</pre>
    </div>
    <p>This link works once and expires ${escapeHtml(new Date(challenge.expiresAt).toISOString())}.</p>
    <form method="POST" action="/api/v1/mcp/confirm/${encodeURIComponent(challenge.id)}">
      <button type="submit" class="btn">Confirm &amp; Execute</button>
    </form>`));
}

export async function handleMcpConfirmPost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  confirmId: string,
): Promise<void> {
  const challenge = liveChallenge(state, confirmId);
  if (!challenge) {
    sendJson(res, 410, { error: 'challenge_expired', message: 'Confirmation link was already used, has expired, or does not exist' });
    return;
  }
  const gate = await sessionPrincipalFor(state, req, challenge.actor);
  if (!gate.ok) {
    sendJson(res, gate.status, { error: gate.error, message: gate.message });
    return;
  }
  // Single use: consumed before execution so a replay (or a concurrent second click) is 410.
  state.mcpChallenges!.delete(confirmId);

  const op = OPERATION_MAP.get(challenge.operationId);
  const tool = op?.mcpToolName ? TOOL_MAP.get(op.mcpToolName) : undefined;
  if (!op || !tool) {
    sendJson(res, 500, { error: 'unknown_operation', message: `Operation ${challenge.operationId} not found` });
    return;
  }
  const clientId = challenge.via.replace(/^mcp:/, '') || 'direct';
  const outcome = await executeInProcessRoute(state, op, tool, challenge.args, gate.principal, clientId);

  if (String(req.headers.accept ?? '').includes('text/html')) {
    res.writeHead(outcome.status, PAGE_HEADERS);
    res.end(page('MCP Operation Executed', outcome.isError ? 'Operation Refused' : 'Operation Confirmed & Executed', `
    <p>Status: ${outcome.status}</p>
    <div class="meta"><pre style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(outcome.body, null, 2))}</pre></div>`));
    return;
  }
  sendJson(res, outcome.status, { ok: !outcome.isError, status: outcome.status, result: outcome.body });
}

export async function handleMcpHandoffGet(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handoffId: string,
): Promise<void> {
  const handoff = liveHandoff(state, handoffId);
  if (!handoff) {
    sendJson(res, 410, { error: 'handoff_expired', message: 'Handoff link was already used, has expired, or does not exist' });
    return;
  }
  const gate = await sessionPrincipalFor(state, req, handoff.actor);
  if (!gate.ok) {
    sendJson(res, gate.status, { error: gate.error, message: gate.message });
    return;
  }
  const fields = handoff.secretParamNames
    .map((p, i) => `<label for="f${i}">${escapeHtml(p)}</label>
      <input type="password" id="f${i}" name="${escapeHtml(p)}" required ${i === 0 ? 'autofocus' : ''} autocomplete="off" />`)
    .join('\n      ');
  res.writeHead(200, PAGE_HEADERS);
  res.end(page('MCP Secret Handoff', 'Sensitive Secret Handoff', `
    <p>An MCP client (${escapeHtml(handoff.via)}) needs a credential for <strong>${escapeHtml(handoff.operationId)}</strong>. Enter it here; it goes straight to the Keymaster and never reaches the model.</p>
    <div class="meta"><pre style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(handoff.nonSecretArgs, null, 2))}</pre></div>
    <form method="POST" action="/api/v1/mcp/handoff/${encodeURIComponent(handoff.id)}">
      ${fields || '<p>No secret value is needed; submitting continues the setup.</p>'}
      <button type="submit" class="btn">Submit Securely</button>
    </form>`));
}

export async function handleMcpHandoffPost(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handoffId: string,
): Promise<void> {
  const handoff = liveHandoff(state, handoffId);
  if (!handoff) {
    sendJson(res, 410, { error: 'handoff_expired', message: 'Handoff link was already used, has expired, or does not exist' });
    return;
  }
  const gate = await sessionPrincipalFor(state, req, handoff.actor);
  if (!gate.ok) {
    sendJson(res, gate.status, { error: gate.error, message: gate.message });
    return;
  }

  const body = await readFormOrJson(req);
  const secretArgs: Record<string, string> = {};
  handoff.secretParamNames.forEach((p, i) => {
    const v = body[p] ?? (i === 0 ? body.secret : undefined);
    if (typeof v === 'string' && v.length > 0) secretArgs[p] = v;
  });
  const primary = handoff.secretParamNames[0];
  if (primary !== undefined && secretArgs[primary] === undefined) {
    sendJson(res, 400, { error: 'missing_secret', message: `${primary} is required` });
    return;
  }

  const op = OPERATION_MAP.get(handoff.operationId);
  const tool = op?.mcpToolName ? TOOL_MAP.get(op.mcpToolName) : undefined;
  if (!op || !tool) {
    sendJson(res, 500, { error: 'unknown_operation', message: `Operation ${handoff.operationId} not found` });
    return;
  }
  // Single use: consumed before the Keymaster write so a replay is 410.
  state.mcpHandoffs!.delete(handoffId);

  const clientId = handoff.via.replace(/^mcp:/, '') || 'direct';
  const secrets = Object.values(secretArgs);
  const outcome = await executeInProcessRoute(
    state,
    op,
    tool,
    { ...handoff.nonSecretArgs, ...secretArgs },
    gate.principal,
    clientId,
    secrets,
  );
  // The secret is never echoed: outcome.body was already redacted against it; the page only shows the status.
  if (String(req.headers.accept ?? '').includes('text/html')) {
    res.writeHead(outcome.status, PAGE_HEADERS);
    res.end(page('MCP Secret Submitted', outcome.isError ? 'Secret Not Saved' : 'Secret Received & Configured', `<p>Status: ${outcome.status}</p>`));
    return;
  }
  sendJson(res, outcome.status, { ok: !outcome.isError, status: outcome.status, result: outcome.body });
}
