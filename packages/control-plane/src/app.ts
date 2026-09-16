import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import type { AuthProvider } from '@beercanlabs/factory-auth';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { AgentRecord } from './catalog.js';
import type { Runtime } from './runtime.js';

export type FactoryState = {
  agents: Map<string, AgentRecord>;
  ledger: LedgerStore;
  token: string | undefined;
  auth: AuthProvider;
  version: string;
  providers: SecretProvider[];
  runtime: Runtime;
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  doormanUrl?: string;
  secretValues: Set<string>;
};

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

async function requireAuth(req: http.IncomingMessage, state: FactoryState): Promise<boolean> {
  const auth = state.auth ?? (state.token ? bearerAuth(state.token) : undefined);
  if (!auth) return true;
  const result = await auth.verify(req.headers.authorization);
  return result.ok;
}

async function notifyDoorman(state: FactoryState, agentId: string, presence: 'offline' | 'available') {
  if (!state.doormanUrl) return;
  try {
    const res = await fetch(`${state.doormanUrl.replace(/\/$/, '')}/api/v1/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
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
    await apply(state, 'med-doc', 'WORKING', 'RESUME');
  }
  if (event.type === 'budget.alert' && event.agentId !== 'finops-officer' && state.agents.has('finops-officer')) {
    await apply(state, 'finops-officer', 'WORKING', 'RESUME');
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
    actor: 'control-plane',
  });
  await notifyDoorman(state, agent.id, 'offline');
}

export async function apply(
  state: FactoryState,
  id: string,
  next: AgentRecord['state'],
  command: string,
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
    await notifySidecar(agent, command, state.token);
  } else if (command === 'RESUME') {
    await notifySidecar(agent, 'RESUME', state.token);
  }

  agent.state = next;
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: id,
    type: 'action',
    action: command,
    actor: 'control-plane',
  });
  return agent;
}

export async function handleMcp(state: FactoryState, payload: Record<string, unknown>): Promise<unknown> {
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
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'list_agents', description: 'List factory cartridges', inputSchema: { type: 'object', properties: {} } },
          { name: 'wake_agent', description: 'Wake an agent from zero', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
          { name: 'pause_agent', description: 'Pause agent egress', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
          { name: 'resume_agent', description: 'Resume agent egress', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
          { name: 'isolate_agent', description: 'Isolate agent egress', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
          { name: 'query_ledger', description: 'Read the execution ledger', inputSchema: { type: 'object', properties: { agent: { type: 'string' } } } },
        ],
      },
    };
  }
  if (method === 'tools/call') {
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    const result = await dispatchTool(state, params.name ?? '', params.arguments ?? {});
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

async function dispatchTool(state: FactoryState, name: string, args: Record<string, string>): Promise<unknown> {
  if (name === 'list_agents') return [...state.agents.values()];
  if (name === 'query_ledger') return state.ledger.query({ agent: args.agent });
  const id = args.id;
  if (!id) return { error: 'id required' };
  if (name === 'wake_agent') return apply(state, id, 'WORKING', 'RESUME');
  if (name === 'pause_agent') return apply(state, id, 'PAUSED', 'PAUSE');
  if (name === 'resume_agent') return apply(state, id, 'WORKING', 'RESUME');
  if (name === 'isolate_agent') return apply(state, id, 'ISOLATED', 'ISOLATE');
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

    if (!(await requireAuth(req, state))) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    if (path === '/api/v1/agents' && req.method === 'GET') {
      json(res, 200, [...state.agents.values()]);
      return;
    }

    const commandMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/(wake|pause|resume|isolate)$/);
    if (commandMatch && req.method === 'POST') {
      const [, id, verb] = commandMatch;
      const map: Record<string, { state: AgentRecord['state']; cmd: string }> = {
        wake: { state: 'WORKING', cmd: 'RESUME' },
        pause: { state: 'PAUSED', cmd: 'PAUSE' },
        resume: { state: 'WORKING', cmd: 'RESUME' },
        isolate: { state: 'ISOLATED', cmd: 'ISOLATE' },
      };
      const spec = map[verb];
      const result = await apply(state, id, spec.state, spec.cmd);
      const status = 'error' in result ? (result.status ?? 400) : 200;
      json(res, status, result);
      return;
    }

    const hookMatch = path.match(/^\/api\/v1\/hooks\/([^/]+)$/);
    if (hookMatch && req.method === 'POST') {
      const agent = state.agents.get(hookMatch[1]);
      if (!agent) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      const trigger = agent.triggers.find((t) => t.type === 'webhook');
      if (!trigger || trigger.type !== 'webhook') {
        json(res, 404, { error: 'no_webhook_trigger' });
        return;
      }
      if (trigger.secretRef) {
        const bound = await bindSecrets([trigger.secretRef], state.providers);
        const provided = (req.headers['x-factory-secret'] as string | undefined) ?? '';
        if (!bound.ok || !safeEqual(provided, bound.env[trigger.secretRef] ?? '')) {
          json(res, 401, { error: 'bad_webhook_secret' });
          return;
        }
      }
      const result = await apply(state, agent.id, 'WORKING', 'RESUME');
      json(res, 'error' in result ? (result.status ?? 400) : 200, result);
      return;
    }

    const convoMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/conversation$/);
    if (convoMatch && req.method === 'POST') {
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
          actor: 'doorman',
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
        const stored = state.ledger.append({
          ...event,
          agentId: event.agentId,
          type: event.type,
          timestamp: event.timestamp || new Date().toISOString(),
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
      try {
        const payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
        json(res, 200, await handleMcp(state, payload));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    json(res, 404, { error: 'not_found' });
  });
}
