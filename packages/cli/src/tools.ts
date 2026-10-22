/**
 * The tools the CLI can run for the Factory Manager (§6.17 CL3, CL4). Each is one factory API call made as the signed-in
 * person; the factory decides whether it is allowed. The CLI offers a tool only when the person's roles hold its
 * privilege, judged by the Bouncer's own `authorize`, so it keeps no second copy of who may do what.
 *
 * Left out on purpose: supplying or reading credentials (K5, CL6), registering, deploying and purging agents (use the
 * console), and anything that sends a secret.
 */
import { authorize, type Privilege } from '@beercanlabs/factory-bouncer';
import type { Role } from '@beercanlabs/factory-auth';
import type { FactoryClient } from './client.js';
import type { ToolSpec } from './protocol.js';

type Args = Record<string, unknown>;

export type Tool = {
  spec: ToolSpec;
  privilege: Privilege;
  /** Owners and role holders on one agent may use these without a fleet-wide role, so the factory decides (E12). */
  agentScoped?: boolean;
  run: (client: FactoryClient, args: Args) => Promise<{ status: number; body: unknown }>;
};

const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export class ToolArgumentError extends Error {}

function id(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !ID.test(v)) throw new ToolArgumentError(`${key} must be an id (letters, digits, . _ : -)`);
  return encodeURIComponent(v);
}

function amount(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ToolArgumentError(`${key} must be a number of dollars, 0 or more`);
  return v;
}

function optionalAmount(args: Args, key: string): number | undefined {
  return args[key] === undefined || args[key] === null ? undefined : amount(args, key);
}

function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return q.length ? `?${q.join('&')}` : '';
}

function limit(args: Args, fallback: number, max = 200): number {
  const v = args.limit;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): ToolSpec['parameters'] => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const agentId = { type: 'string', description: 'The agent id.' };

const read = (name: string, description: string, privilege: Privilege, parameters: ToolSpec['parameters'], run: Tool['run'], agentScoped = false): Tool => ({
  spec: { name, description, parameters, mutating: false },
  privilege,
  agentScoped,
  run: async (c, a) => run(c, a),
});
const change = (name: string, description: string, privilege: Privilege, parameters: ToolSpec['parameters'], run: Tool['run'], agentScoped = false): Tool => ({
  spec: { name, description, parameters, mutating: true },
  privilege,
  agentScoped,
  run: async (c, a) => run(c, a),
});

export const TOOLS: Tool[] = [
  read('list_agents', 'List every agent with its state, budget standing and owners.', 'agents.read', obj({}), (c) => c.request('GET', '/api/v1/agents')),
  read('get_agent', 'Details and lifecycle state of one agent.', 'agents.read', obj({ id: agentId }, ['id']), (c, a) => c.request('GET', `/api/v1/registry/agents/${id(a, 'id')}`)),
  read('get_agent_policy', "An agent's policy: granted routes, models and budget.", 'policy.read', obj({ id: agentId }, ['id']), (c, a) => c.request('GET', `/api/v1/agents/${id(a, 'id')}/policy`)),
  read('factory_metrics', 'Operational snapshot: active runs, agent counts by state, spend today and this month against budgets.', 'metrics.read', obj({}), (c) => c.request('GET', '/api/v1/metrics')),
  read('get_spend', 'Spend so far, by agent.', 'spend.read', obj({}), (c) => c.request('GET', '/api/v1/spend')),
  read(
    'get_spend_report',
    'The factory spend report (AI and infrastructure) for a calendar month.',
    'spend.read',
    obj({ period: { type: 'string', enum: ['current', 'last'], description: 'Which month. Default current.' } }),
    (c, a) => c.request('GET', `/api/v1/spend/report${query({ period: a.period === 'last' ? 'last' : 'current' })}`),
  ),
  read('get_compute_spend', 'Infrastructure (compute) spend.', 'spend.read', obj({}), (c) => c.request('GET', '/api/v1/spend/compute')),
  read('get_factory_budgets', 'The factory-wide monthly budgets (AI, infrastructure, total) and their history.', 'spend.read', obj({}), (c) => c.request('GET', '/api/v1/spend/budgets')),
  change(
    'set_factory_budgets',
    'Set the factory-wide monthly budgets in dollars. Send only the ones to change. alertAt is a list of fractions such as [0.8, 1].',
    'spend.budget.set',
    obj({ aiMonthUsd: { type: 'number' }, infraMonthUsd: { type: 'number' }, totalMonthUsd: { type: 'number' }, alertAt: { type: 'array', items: { type: 'number' } } }),
    (c, a) => {
      const body: Args = {};
      for (const k of ['aiMonthUsd', 'infraMonthUsd', 'totalMonthUsd']) {
        const v = optionalAmount(a, k);
        if (v !== undefined) body[k] = v;
      }
      if (Array.isArray(a.alertAt)) body.alertAt = a.alertAt;
      if (Object.keys(body).length === 0) throw new ToolArgumentError('name at least one budget to set');
      return c.request('PUT', '/api/v1/spend/budgets', body);
    },
  ),
  change(
    'set_agent_budget',
    "Set one agent's spend limit in dollars for a day or a month.",
    'registry.budget.set',
    obj({ id: agentId, spendLimitUsd: { type: 'number' }, period: { type: 'string', enum: ['daily', 'monthly'] } }, ['id', 'spendLimitUsd', 'period']),
    (c, a) => {
      if (a.period !== 'daily' && a.period !== 'monthly') throw new ToolArgumentError('period must be daily or monthly');
      return c.request('PUT', `/api/v1/registry/agents/${id(a, 'id')}/budget`, { spendLimitUsd: amount(a, 'spendLimitUsd'), period: a.period });
    },
  ),
  read('list_runs', 'Recent runs, optionally for one agent or only the active ones.', 'runs.read', obj({ agent: agentId, active: { type: 'boolean' }, limit: { type: 'integer' } }), (c, a) =>
    c.request('GET', `/api/v1/runs${query({ agent: typeof a.agent === 'string' ? a.agent : undefined, active: a.active === true ? 'true' : undefined, limit: limit(a, 25) })}`),
  ),
  read('get_run', 'One run: state, trigger, timing and cost.', 'runs.read', obj({ id: { type: 'string' } }, ['id']), (c, a) => c.request('GET', `/api/v1/runs/${id(a, 'id')}`)),
  read('query_ledger', 'Recent rows of the audit ledger, optionally for one agent.', 'ledger.read', obj({ agent: agentId, limit: { type: 'integer' } }), (c, a) =>
    c.request('GET', `/api/v1/ledger${query({ agent: typeof a.agent === 'string' ? a.agent : undefined, limit: limit(a, 25, 200) })}`),
  ),
  read('list_approvals', 'Tool calls held for a person to approve.', 'approvals.read', obj({}), (c) => c.request('GET', '/api/v1/approvals?state=pending')),
  change(
    'decide_approval',
    'Approve or reject a held tool call.',
    'approvals.decide',
    obj({ id: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'reject'] }, notes: { type: 'string' } }, ['id', 'decision']),
    (c, a) => {
      if (a.decision !== 'approve' && a.decision !== 'reject') throw new ToolArgumentError('decision must be approve or reject');
      return c.request('POST', `/api/v1/approvals/${id(a, 'id')}`, { decision: a.decision, ...(typeof a.notes === 'string' ? { notes: a.notes.slice(0, 1000) } : {}) });
    },
    true,
  ),
  change('pause_agent', "Pause an agent: the kill-switch. It stops egress and wake-ups until resumed.", 'agents.pause', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/pause`, {}), true),
  change('resume_agent', 'Resume a paused agent.', 'agents.resume', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/resume`, {}), true),
  change('isolate_agent', "Isolate an agent's egress.", 'agents.isolate', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/isolate`, {})),
  change('wake_agent', 'Wake an agent (start a run).', 'agents.wake', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/wake`, {}), true),
  change('reset_agent', 'End the agent\'s runs and return it to sleeping.', 'agents.reset', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/reset`, {})),
  change('cancel_run', 'Cancel an active run.', 'runs.cancel', obj({ id: { type: 'string', description: 'The run id.' } }, ['id']), (c, a) => c.request('POST', `/api/v1/runs/${id(a, 'id')}/cancel`, {})),
  change('retire_agent', 'Retire an agent (stage 1: compute and triggers off; reversible until purged).', 'registry.retire', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/registry/agents/${id(a, 'id')}/retire`, {})),
  change('reinstate_agent', 'Bring a retired agent back during its holding period.', 'registry.reinstate', obj({ id: agentId }, ['id']), (c, a) => c.request('POST', `/api/v1/registry/agents/${id(a, 'id')}/reinstate`, {})),
  read('list_models', 'Models the factory offers and the default.', 'models.read', obj({}), (c) => c.request('GET', '/api/v1/models')),
  read('list_skills', 'The skills catalog.', 'skills.read', obj({}), (c) => c.request('GET', '/api/v1/skills')),
  read('get_triage', 'Open incidents and faults (the Doctor).', 'triage.read', obj({}), (c) => c.request('GET', '/api/v1/triage')),
  read('list_schedules', 'Scheduled wake-ups.', 'schedules.read', obj({}), (c) => c.request('GET', '/api/v1/schedules')),
];

/** Handled by the CLI itself, not the factory: it moves the person into a conversation with an agent (CL5). */
export const CONNECT_TOOL: ToolSpec = {
  name: 'connect_to_agent',
  description: 'Connect the person to an agent so they talk to it directly. Use it when they ask to talk to, or chat with, an agent.',
  parameters: obj({ agent: agentId }, ['agent']),
  mutating: false,
};

/** The tools to offer a person with these roles (CL3, CL4). */
export function toolsFor(roles: string[], actor = 'cli'): Tool[] {
  return TOOLS.filter((t) => t.agentScoped || authorize({ principal: { actor, roles: roles as Role[] }, privilege: t.privilege }).allowed);
}

export const toolByName = (name: string): Tool | undefined => TOOLS.find((t) => t.spec.name === name);

const HIDDEN = /secret|token|password|passwd|api[-_]?key|authorization|credential|private[-_]?key/i;

/** A non-empty string, or a list or object with one anywhere in it. A bare number or boolean is a count or a flag (`inputTokens`), not a secret. */
function carriesText(v: unknown): boolean {
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.some(carriesText);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(carriesText);
  return false;
}

/** CL6: whatever the factory returns, text under a secret-looking name (a string, or a list or object holding one) never reaches the terminal or the manager; counts such as `inputTokens` stay. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, HIDDEN.test(k) && carriesText(v) ? '[hidden]' : redact(v)]));
  }
  return value;
}

/** Keeps a tool result small enough for the manager's context. */
export function trim(value: unknown, maxChars = 12_000): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return value;
  if (Array.isArray(value)) {
    let keep = value.length;
    while (keep > 1 && JSON.stringify(value.slice(0, keep)).length > maxChars) keep = Math.floor(keep / 2);
    return { truncated: true, total: value.length, shown: keep, items: value.slice(0, keep) };
  }
  return { truncated: true, preview: text.slice(0, maxChars) };
}
