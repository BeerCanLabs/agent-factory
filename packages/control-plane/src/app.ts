import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { hasRole, type AuthProvider, type Principal, type Role } from '@beercanlabs/factory-auth';
import { AgentRecord } from './catalog.js';
import type { Runtime } from './runtime.js';

export type FactoryState = {
  agents: Map<string, AgentRecord>;
  ledger: LedgerStore;
  auth: AuthProvider;
  version: string;
  providers: SecretProvider[];
  runtime: Runtime;
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  doormanUrl?: string;
  /** Presented to Doorman's presence API. */
  doormanToken?: string;
  /** Presented to agent sidecars' command API. */
  sidecarToken?: string;
  secretValues: Set<string>;
};

/** Actors for actions the factory takes on its own (not on behalf of a caller). */
export const SYSTEM = {
  idle: 'factory:idle-timer',
  scheduler: 'factory:scheduler',
  runtime: 'factory:runtime',
  router: 'factory:event-router',
} as const;

const INGEST_TYPES = new Set(['llm', 'mcp', 'action', 'crash', 'budget.alert']);

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function authenticate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
  role: Role,
): Promise<Principal | null> {
  const result = await state.auth.verify(req.headers.authorization);
  if (!result.ok) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  if (!hasRole(result.principal, role)) {
    json(res, 403, { error: 'forbidden', required: role });
    return null;
  }
  return result.principal;
}

async function notifyDoorman(state: FactoryState, agentId: string, presence: 'offline' | 'available') {
  if (!state.doormanUrl) return;
  try {
    const res = await fetch(`${state.doormanUrl.replace(/\/$/, '')}/api/v1/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.doormanToken ? { Authorization: `Bearer ${state.doormanToken}` } : {}),
      },
      body: JSON.stringify({ agentId, presence }),
    });
    if (!res.ok) console.error(`[control-plane] doorman presence ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-plane] doorman unreachable: ${message}`);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function notifySidecar(agent: AgentRecord, command: string, token: string | undefined) {
  if (!agent.sidecarUrl) return;
  try {
    const res = await fetch(`${agent.sidecarUrl.replace(/\/$/, '')}/api/v1/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : undefined),
      },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) console.error(`[control-plane] sidecar ${agent.id} ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-plane] sidecar ${agent.id} unreachable: ${message}`);
  }
}

async function routeEvents(state: FactoryState, event: { type: string; agentId: string }) {
  if (event.type === 'crash' && event.agentId !== 'med-doc' && state.agents.has('med-doc')) {
    await apply(state, 'med-doc', 'WORKING', 'RESUME', SYSTEM.router);
  }
  if (event.type === 'budget.alert' && event.agentId !== 'finops-officer' && state.agents.has('finops-officer')) {
    await apply(state, 'finops-officer', 'WORKING', 'RESUME', SYSTEM.router);
  }
}

function scheduleIdle(state: FactoryState, id: string) {
  const prev = state.idleTimers.get(id);
  if (prev) clearTimeout(prev);
  if (state.idleMs <= 0) return;
  const t = setTimeout(() => {
    const agent = state.agents.get(id);
    if (!agent || agent.state === 'PAUSED' || agent.state === 'ISOLATED') return;
    void scaleToZero(state, agent);
  }, state.idleMs);
  state.idleTimers.set(id, t);
}

async function scaleToZero(state: FactoryState, agent: AgentRecord) {
  await state.runtime.stop(agent);
  agent.state = 'IDLE';
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: agent.id,
    type: 'action',
    action: 'SCALE_TO_ZERO',
    actor: SYSTEM.idle,
  });
  await notifyDoorman(state, agent.id, 'offline');
}

export async function apply(
  state: FactoryState,
  id: string,
  next: AgentRecord['state'],
  command: string,
  actor: string,
): Promise<AgentRecord | { error: string; missing?: string[]; status?: number }> {
  const agent = state.agents.get(id);
  if (!agent) return { error: 'not_found', status: 404 };

  if (command === 'RESUME' || next === 'WORKING') {
    const bound = await bindSecrets(agent.requires, state.providers);
    if (!bound.ok) return { error: 'unbound_secrets', missing: bound.missing, status: 412 };
    for (const value of Object.values(bound.env)) {
      if (value.length >= 4) state.secretValues.add(value);
    }
    await state.runtime.start(agent, bound.env);
    scheduleIdle(state, id);
    await notifyDoorman(state, id, 'available');
  }

  if (command === 'PAUSE' || command === 'ISOLATE') {
    await notifySidecar(agent, command, state.sidecarToken);
  } else if (command === 'RESUME') {
    await notifySidecar(agent, 'RESUME', state.sidecarToken);
  }

  agent.state = next;
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: id,
    type: 'action',
    action: command,
    actor,
  });
  return agent;
}

type ToolSpec = { name: string; description: string; role: Role; needsId: boolean };

const TOOLS: ToolSpec[] = [
  { name: 'list_agents', description: 'List factory cartridges', role: 'viewer', needsId: false },
  { name: 'query_ledger', description: 'Read the execution ledger', role: 'viewer', needsId: false },
  { name: 'wake_agent', description: 'Wake an agent from zero', role: 'operator', needsId: true },
  { name: 'pause_agent', description: 'Pause agent egress', role: 'operator', needsId: true },
  { name: 'resume_agent', description: 'Resume agent egress', role: 'operator', needsId: true },
  { name: 'isolate_agent', description: 'Isolate agent egress', role: 'operator', needsId: true },
];

export async function handleMcp(state: FactoryState, payload: Record<string, unknown>, principal: Principal): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-factory', version: state.version },
      },
    };
  }
  if (method === 'tools/list') {
    const tools = TOOLS.filter((t) => hasRole(principal, t.role)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.needsId
        ? { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
        : t.name === 'query_ledger'
          ? { type: 'object', properties: { agent: { type: 'string' } } }
          : { type: 'object', properties: {} },
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    const spec = TOOLS.find((t) => t.name === params.name);
    if (!spec) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    if (!hasRole(principal, spec.role)) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: `forbidden: requires ${spec.role}` } };
    }
    const result = await dispatchTool(state, spec.name, params.arguments ?? {}, principal.actor);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

async function dispatchTool(state: FactoryState, name: string, args: Record<string, string>, actor: string): Promise<unknown> {
  if (name === 'list_agents') return [...state.agents.values()];
  if (name === 'query_ledger') return state.ledger.query({ agent: args.agent });
  const id = args.id;
  if (!id) return { error: 'id required' };
  if (name === 'wake_agent') return apply(state, id, 'WORKING', 'RESUME', actor);
  if (name === 'pause_agent') return apply(state, id, 'PAUSED', 'PAUSE', actor);
  if (name === 'resume_agent') return apply(state, id, 'WORKING', 'RESUME', actor);
  if (name === 'isolate_agent') return apply(state, id, 'ISOLATED', 'ISOLATE', actor);
  return { error: `unknown tool ${name}` };
}

export function createFactoryServer(state: FactoryState): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const started = Number(process.env.FACTORY_STARTED_AT ?? Date.now());

    if ((path === '/healthz' || path === '/' || path === '/api/v1/health') && req.method === 'GET') {
      json(res, 200, {
        status: 'ok',
        version: state.version,
        uptime: Math.round((Date.now() - started) / 1000),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Webhooks authenticate with the cartridge's own shared secret, not a factory bearer.
    const hookMatch = path.match(/^\/api\/v1\/hooks\/([^/]+)$/);
    if (hookMatch && req.method === 'POST') {
      const agent = state.agents.get(hookMatch[1]);
      const trigger = agent?.triggers.find((t) => t.type === 'webhook');
      if (!agent || !trigger || trigger.type !== 'webhook') {
        json(res, 404, { error: 'not_found' });
        return;
      }
      let actor: string;
      if (trigger.secretRef) {
        const bound = await bindSecrets([trigger.secretRef], state.providers);
        const provided = (req.headers['x-factory-secret'] as string | undefined) ?? '';
        if (!bound.ok || !provided || !safeEqual(provided, bound.env[trigger.secretRef] ?? '')) {
          json(res, 401, { error: 'bad_webhook_secret' });
          return;
        }
        actor = `webhook:${agent.id}`;
      } else {
        const principal = await authenticate(req, res, state, 'operator');
        if (!principal) return;
        actor = principal.actor;
      }
      const result = await apply(state, agent.id, 'WORKING', 'RESUME', actor);
      json(res, 'error' in result ? (result.status ?? 400) : 200, result);
      return;
    }

    if (path === '/api/v1/agents' && req.method === 'GET') {
      if (!(await authenticate(req, res, state, 'viewer'))) return;
      json(res, 200, [...state.agents.values()]);
      return;
    }

    const commandMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/(wake|pause|resume|isolate)$/);
    if (commandMatch && req.method === 'POST') {
      const principal = await authenticate(req, res, state, 'operator');
      if (!principal) return;
      const [, id, verb] = commandMatch;
      const map: Record<string, { state: AgentRecord['state']; cmd: string }> = {
        wake: { state: 'WORKING', cmd: 'RESUME' },
        pause: { state: 'PAUSED', cmd: 'PAUSE' },
        resume: { state: 'WORKING', cmd: 'RESUME' },
        isolate: { state: 'ISOLATED', cmd: 'ISOLATE' },
      };
      const spec = map[verb];
      const result = await apply(state, id, spec.state, spec.cmd, principal.actor);
      json(res, 'error' in result ? (result.status ?? 400) : 200, result);
      return;
    }

    const convoMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/conversation$/);
    if (convoMatch && req.method === 'POST') {
      const principal = await authenticate(req, res, state, 'operator');
      if (!principal) return;
      const agent = state.agents.get(convoMatch[1]);
      if (!agent) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req)) as unknown;
        await state.runtime.deliver(agent, payload);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: agent.id,
          type: 'action',
          action: 'CONVERSATION_HANDOFF',
          actor: principal.actor,
          content: payload,
        });
        json(res, 202, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    if (path === '/api/v1/ledger' && req.method === 'GET') {
      if (!(await authenticate(req, res, state, 'viewer'))) return;
      const url = new URL(req.url ?? '/', 'http://factory.local');
      json(
        res,
        200,
        state.ledger.query({
          agent: url.searchParams.get('agent'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        }),
      );
      return;
    }

    if (path === '/api/v1/ledger' && req.method === 'POST') {
      const principal = await authenticate(req, res, state, 'ingest');
      if (!principal) return;
      try {
        const event = JSON.parse(await readBody(req)) as {
          agentId?: string;
          type?: string;
          timestamp?: string;
          [k: string]: unknown;
        };
        if (!event.agentId || !event.type) {
          json(res, 400, { error: 'agentId and type required' });
          return;
        }
        if (!INGEST_TYPES.has(event.type)) {
          json(res, 400, { error: `type must be one of ${[...INGEST_TYPES].join(', ')}` });
          return;
        }
        const stored = state.ledger.append({
          ...event,
          agentId: event.agentId,
          type: event.type,
          actor: principal.actor,
          timestamp: new Date().toISOString(),
        });
        await routeEvents(state, stored);
        json(res, 201, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    if (path === '/mcp' && req.method === 'POST') {
      const principal = await authenticate(req, res, state, 'viewer');
      if (!principal) return;
      try {
        const payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
        json(res, 200, await handleMcp(state, payload, principal));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    json(res, 404, { error: 'not_found' });
  });
}
