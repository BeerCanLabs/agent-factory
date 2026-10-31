/**
 * E5.3 (#303): one setup pattern for agent apps (GitHub, Discord, and whatever comes next).
 *
 *   GET  /api/v1/keymaster/agents/:agentId/app-setup                     credentials.agent.read: every provider's steps and status
 *   POST /api/v1/keymaster/agents/:agentId/app-setup/:provider/:step      credentials.agent.set: a provider's own `secret` step
 *
 * A provider describes its steps; each step's action is one of three kinds the console renders with no provider code:
 *   secret        paste a value once, write-only (POST { value } to `path`)
 *   browser-post  POST { [input]: value } to `path`, then post the response's `postField` to the response's `action`
 *   list          POST { [input]: [names] } to `path`
 * Providers keep their own routes; a new one may instead implement `submit` and use the generic route. Values go to the
 * secret store only; a provider never returns one.
 */
import http from 'node:http';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

export type SetupAction =
  | { kind: 'secret'; path: string }
  | { kind: 'browser-post'; path: string; input?: string; postField: string }
  | { kind: 'list'; path: string; input: string };

export type SetupStep = { id: string; manual: boolean; text: string; action?: SetupAction };

export interface AppSetupProvider {
  id: string;
  title: string;
  steps(state: FactoryState, agentId: string): SetupStep[];
  status(state: FactoryState, agentId: string): Promise<{ configured: boolean; links?: Array<{ label: string; url: string }> }>;
  /** Optional: handle a `secret` step posted to the generic route. Returns the HTTP status and a body with no value in it. */
  submit?(state: FactoryState, agentId: string, step: string, value: string, actor: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

const registry = new Map<string, AppSetupProvider>();

export function registerAppSetupProvider(p: AppSetupProvider): void {
  if (!/^[a-z0-9-]{1,40}$/.test(p.id)) throw new Error(`invalid app setup provider id: ${p.id}`);
  registry.set(p.id, p);
}

export function appSetupProviders(): AppSetupProvider[] {
  return [...registry.values()];
}

/** A secret's value from the first provider that has it; lookups that fail count as absent. */
export async function readSecret(state: FactoryState, name: string): Promise<string | undefined> {
  for (const p of state.providers) {
    const v = await p.get(name).catch(() => undefined);
    if (v) return v;
  }
  return undefined;
}

/** Console paths are relative to /api/v1, like the console client's request(). */
export const agentPath = (agentId: string, rest: string) => `/keymaster/agents/${encodeURIComponent(agentId)}/${rest}`;

/** Handles the shared setup routes. Returns false when the path is not one of them. */
export async function handleAppSetup(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const list = path.match(/^\/api\/v1\/keymaster\/agents\/([a-z0-9-]+)\/app-setup$/);
  if (list && req.method === 'GET') {
    const agentId = list[1];
    if (!(await requirePrivilege(req, res, state, 'credentials.agent.read', { agentId }))) return true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const providers = await Promise.all(appSetupProviders().map(async (p) => ({ id: p.id, title: p.title, steps: p.steps(state, agentId), ...(await p.status(state, agentId)) })));
    json(res, 200, { agentId, providers });
    return true;
  }
  const step = path.match(/^\/api\/v1\/keymaster\/agents\/([a-z0-9-]+)\/app-setup\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (step && req.method === 'POST') {
    const [, agentId, providerId, stepId] = step;
    const principal = await requirePrivilege(req, res, state, 'credentials.agent.set', { agentId });
    if (!principal) return true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const p = registry.get(providerId);
    const s = p?.steps(state, agentId).find((x) => x.id === stepId);
    if (!p?.submit || s?.action?.kind !== 'secret') return json(res, 404, { error: 'unknown_step' }), true;
    const b = await readJson(req);
    const value = typeof b.value === 'string' ? b.value.trim() : '';
    if (!value) return json(res, 400, { error: 'value_required' }), true;
    state.secretValues.add(value);
    const out = await p.submit(state, agentId, stepId, value, principal.actor);
    json(res, out.status, out.body);
    return true;
  }
  return false;
}
