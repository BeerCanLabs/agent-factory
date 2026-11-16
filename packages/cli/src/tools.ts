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
import { CLI_OPERATION_MAP } from '@beercanlabs/factory-contract';
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
const CATALOG_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class ToolArgumentError extends Error {}

function id(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !ID.test(v)) throw new ToolArgumentError(`${key} must be an id (letters, digits, . _ : -)`);
  return encodeURIComponent(v);
}

function catalogModelName(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !CATALOG_MODEL_NAME.test(v)) {
    throw new ToolArgumentError(`${key} must be a catalog model name (1..128 chars: letters, digits, . _ : @ / -)`);
  }
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

/**
 * Constructs a CLI Tool deriving spec, privilege and agentScoped from the shared factory contract (§6.17 CL11, GAP-249).
 */
function cliTool(name: string, run: Tool['run']): Tool {
  const def = CLI_OPERATION_MAP[name];
  if (!def) throw new Error(`Unknown CLI operation contract: ${name}`);
  return {
    spec: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as ToolSpec['parameters'],
      mutating: def.mutating,
    },
    privilege: def.privilege as Privilege,
    ...(def.agentScoped ? { agentScoped: true } : {}),
    run: async (c, a) => run(c, a),
  };
}

const SUBJECT = /^(?:user|service|group|domain):[A-Za-z0-9._@+-]{1,200}$/;
function subject(args: Args, key = 'subject'): string {
  const v = args[key];
  if (typeof v !== 'string' || !SUBJECT.test(v)) throw new ToolArgumentError(`${key} must be a principal such as user:alice, service:ci, group:ops or domain:example.com`);
  return v;
}
function grantScope(args: Args): { kind: 'fleet' } | { kind: 'agent' | 'skill'; id: string } {
  const v = args.scope;
  if (v === undefined || v === 'fleet') return { kind: 'fleet' };
  const m = typeof v === 'string' ? /^(agent|skill):([a-z0-9][a-z0-9._-]{0,127})$/i.exec(v) : null;
  if (!m) throw new ToolArgumentError('scope must be fleet, agent:<id> or skill:<id>');
  return { kind: m[1].toLowerCase() as 'agent' | 'skill', id: m[2] };
}

const VENDOR_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
function vendorModelId(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !VENDOR_MODEL_ID.test(v)) {
    throw new ToolArgumentError(`${key} must be a valid upstream model id`);
  }
  return v;
}

function connectionName(args: Args, key: string): string {
  const v = typeof args[key] === 'string' ? args[key].trim() : '';
  if (!v || v.length > 80 || /[\x00-\x1f\x7f]/.test(v)) {
    throw new ToolArgumentError(`${key} must be 1..80 printable characters`);
  }
  return v;
}

function subscriptionScope(args: Args): 'factory' | 'personal' | undefined {
  const v = args.scope;
  if (v === undefined) return undefined;
  if (v !== 'factory' && v !== 'personal') throw new ToolArgumentError('scope must be factory or personal');
  return v;
}

function attested(args: Args): void {
  if (args.subscriberAttested !== true) {
    throw new ToolArgumentError('subscriberAttested must be true (confirm the subscription is yours and vendor terms permit this use)');
  }
}

export const TOOLS: Tool[] = [
  // S9: people, grants and keys. Scoped owners and leads may manage grants on their own items, so the factory decides.
  cliTool('list_principals', (c) => c.request('GET', '/api/v1/principals')),
  cliTool('list_grants', (c, a) => c.request('GET', `/api/v1/grants${query({ subject: a.subject === undefined ? undefined : subject(a) })}`)),
  cliTool('grant_role', (c, a) => c.request('POST', '/api/v1/grants', { subject: subject(a), role: decodeURIComponent(id(a, 'role')), scope: grantScope(a) })),
  cliTool('revoke_grant', (c, a) => c.request('DELETE', `/api/v1/grants/${id(a, 'id')}`)),
  cliTool('list_agents', (c) => c.request('GET', '/api/v1/agents')),
  cliTool('get_agent', (c, a) => c.request('GET', `/api/v1/registry/agents/${id(a, 'id')}`)),
  cliTool('get_agent_policy', (c, a) => c.request('GET', `/api/v1/agents/${id(a, 'id')}/policy`)),
  cliTool('factory_metrics', (c) => c.request('GET', '/api/v1/metrics')),
  cliTool('get_spend', (c) => c.request('GET', '/api/v1/spend')),
  cliTool('get_spend_report', (c, a) => c.request('GET', `/api/v1/spend/report${query({ period: a.period === 'last' ? 'last' : 'current' })}`)),
  cliTool('get_compute_spend', (c) => c.request('GET', '/api/v1/spend/compute')),
  cliTool('get_factory_budgets', (c) => c.request('GET', '/api/v1/spend/budgets')),
  cliTool('set_factory_budgets', (c, a) => {
    const body: Args = {};
    for (const k of ['aiMonthUsd', 'infraMonthUsd', 'totalMonthUsd']) {
      const v = optionalAmount(a, k);
      if (v !== undefined) body[k] = v;
    }
    if (Array.isArray(a.alertAt)) body.alertAt = a.alertAt;
    if (Object.keys(body).length === 0) throw new ToolArgumentError('name at least one budget to set');
    return c.request('PUT', '/api/v1/spend/budgets', body);
  }),
  cliTool('set_agent_budget', (c, a) => {
    if (a.period !== 'daily' && a.period !== 'monthly') throw new ToolArgumentError('period must be daily or monthly');
    return c.request('PUT', `/api/v1/registry/agents/${id(a, 'id')}/budget`, { spendLimitUsd: amount(a, 'spendLimitUsd'), period: a.period });
  }),
  cliTool('list_runs', (c, a) =>
    c.request('GET', `/api/v1/runs${query({ agent: typeof a.agent === 'string' ? a.agent : undefined, active: a.active === true ? 'true' : undefined, limit: limit(a, 25) })}`),
  ),
  cliTool('get_run', (c, a) => c.request('GET', `/api/v1/runs/${id(a, 'id')}`)),
  cliTool('query_ledger', (c, a) =>
    c.request('GET', `/api/v1/ledger${query({ agent: typeof a.agent === 'string' ? a.agent : undefined, limit: limit(a, 25, 200) })}`),
  ),
  cliTool('list_approvals', (c) => c.request('GET', '/api/v1/approvals?state=pending')),
  cliTool('decide_approval', (c, a) => {
    if (a.decision !== 'approve' && a.decision !== 'reject') throw new ToolArgumentError('decision must be approve or reject');
    const cap = typeof a.capUsd === 'string' || typeof a.capUsd === 'number' ? { capUsd: a.capUsd } : {};
    return c.request('POST', `/api/v1/approvals/${id(a, 'id')}`, { decision: a.decision, ...(typeof a.notes === 'string' ? { notes: a.notes.slice(0, 1000) } : {}), ...cap });
  }),
  cliTool('pause_agent', (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/pause`, {})),
  cliTool('resume_agent', (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/resume`, {})),
  cliTool('isolate_agent', (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/isolate`, {})),
  cliTool('wake_agent', (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/wake`, {})),
  cliTool('reset_agent', (c, a) => c.request('POST', `/api/v1/agents/${id(a, 'id')}/reset`, {})),
  cliTool('cancel_run', (c, a) => c.request('POST', `/api/v1/runs/${id(a, 'id')}/cancel`, {})),
  cliTool('retire_agent', (c, a) => c.request('POST', `/api/v1/registry/agents/${id(a, 'id')}/retire`, {})),
  cliTool('reinstate_agent', (c, a) => c.request('POST', `/api/v1/registry/agents/${id(a, 'id')}/reinstate`, {})),
  cliTool('list_models', (c) => c.request('GET', '/api/v1/models')),
  cliTool('list_skills', (c) => c.request('GET', '/api/v1/skills')),
  cliTool('get_triage', (c) => c.request('GET', '/api/v1/triage')),
  cliTool('list_schedules', (c) => c.request('GET', '/api/v1/schedules')),

  // §6.9 M5: subscription connections & BYOM. Agent-scoped so personal agent owners hold access on their own plans, while Bouncer enforces admin privileges on factory plans.
  cliTool('list_subscriptions', (c, a) => c.request('GET', `/api/v1/subscriptions${query({ scope: subscriptionScope(a) })}`)),
  cliTool('get_subscription_spend', (c) => c.request('GET', '/api/v1/subscriptions/spend')),
  cliTool('connect_subscription', (c, a) => {
    attested(a);
    const scope = subscriptionScope(a);
    return c.request('POST', '/api/v1/subscriptions/connect', {
      templateId: decodeURIComponent(id(a, 'templateId')),
      subscriberAttested: true,
      ...(scope ? { scope } : {}),
      ...(a.name !== undefined ? { name: connectionName(a, 'name') } : {}),
    });
  }),
  cliTool('poll_subscription_signin', (c, a) => c.request('GET', `/api/v1/subscriptions/sign-ins/${id(a, 'id')}`)),
  cliTool('reconnect_subscription', (c, a) => {
    attested(a);
    return c.request('POST', `/api/v1/subscriptions/${id(a, 'id')}/reconnect`, { subscriberAttested: true });
  }),
  cliTool('rename_subscription', (c, a) => c.request('PATCH', `/api/v1/subscriptions/${id(a, 'id')}`, { name: connectionName(a, 'name') })),
  cliTool('set_subscription_cap', (c, a) => {
    if (a.cap !== null && (typeof a.cap !== 'number' || !Number.isInteger(a.cap) || a.cap < 1)) {
      throw new ToolArgumentError('cap must be a positive whole number or null to clear');
    }
    return c.request('PATCH', `/api/v1/subscriptions/${id(a, 'id')}`, { dailyTokenCap: a.cap });
  }),
  cliTool('discover_subscription_models', (c, a) => c.request('POST', `/api/v1/subscriptions/${id(a, 'id')}/discover`, {})),
  cliTool('add_subscription_model', (c, a) => {
    const hasIn = a.inputPerMTok !== undefined;
    const hasOut = a.outputPerMTok !== undefined;
    if (hasIn !== hasOut) {
      throw new ToolArgumentError('give both inputPerMTok and outputPerMTok, or neither for $0 personal BYOM');
    }
    const price = hasIn
      ? { inputPerMTok: amount(a, 'inputPerMTok'), outputPerMTok: amount(a, 'outputPerMTok') }
      : undefined;
    return c.request('POST', `/api/v1/subscriptions/${id(a, 'id')}/models`, {
      name: decodeURIComponent(catalogModelName(a, 'name')),
      modelId: vendorModelId(a, 'modelId'),
      ...(price ? { price } : {}),
    });
  }),
  cliTool('retire_subscription_model', (c, a) => c.request('DELETE', `/api/v1/subscriptions/${id(a, 'id')}/models/${catalogModelName(a, 'model')}`)),
  cliTool('disconnect_subscription', (c, a) => c.request('DELETE', `/api/v1/subscriptions/${id(a, 'id')}`)),
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
/** Public metadata enum fields whose names contain 'credential' (`credentialMode: 'api-key' | 'subscription'`), never a secret. */
const SAFE_METADATA_KEYS = new Set(['credentialMode']);

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
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        !SAFE_METADATA_KEYS.has(k) && HIDDEN.test(k) && carriesText(v) ? '[hidden]' : redact(v),
      ]),
    );
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
