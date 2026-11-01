/**
 * E1.1 (#292): the helper (subagent) registry. Admins register prompt-only helper definitions; each registration is
 * written to the ledger as an audit row. Helpers live in their own map, never in `state.agents`, so `list_agents`
 * and the chat agent lists never show them.
 */
import type http from 'node:http';
import { validateSubagent } from '@beercanlabs/factory-contract';
import { SubagentStore, type SubagentRecord } from '@beercanlabs/factory-registrar';
import { randomBytes } from 'node:crypto';
import { createRun, type Run } from '@beercanlabs/factory-property-manager';
import { BUILTIN_AGENT_IDS, type AgentRecord } from '@beercanlabs/factory-registrar';
import { checkStanding } from '@beercanlabs/factory-budget';
import { approvedModels, json, readJson, requirePrivilege, type FactoryState } from './app.js';

export type { SubagentRecord };

function storeOf(state: FactoryState): SubagentStore {
  return new SubagentStore(state.registryDir, (m, e) => console.warn(`[control-plane] ${m}`, e ?? ''));
}

/** The helper map, read back from the registry directory on first use. */
export function subagentsOf(state: FactoryState): Map<string, SubagentRecord> {
  state.subagents ??= storeOf(state).load();
  return state.subagents;
}

/** E1.3 (#294): the registered helpers an agent's admin-set policy allows it, by id; none without an allow-list entry. */
/** #332: the models a helper may run on: its admin grant, limited to what the factory offers now. Empty means none. */
export function helperModels(state: FactoryState, helper: SubagentRecord): string[] {
  const offered = new Set(approvedModels(state).models);
  return [...new Set(helper.approvedModels ?? [])].filter((m) => offered.has(m)).sort();
}

export function allowedSubagents(state: FactoryState, agentId: string): Array<{ id: string; name?: string; description?: string; approvedModels: string[] }> {
  // #312: only a policy an admin set for this agent counts; the store's fallback (or `__global__`) never grants helpers.
  if (agentId === '__global__' || !state.policies.has(agentId)) return [];
  const allow = new Set(state.policies.get(agentId)?.subagents ?? []);
  return [...subagentsOf(state).values()]
    .filter((h) => allow.has(h.id))
    .map((h) => ({ id: h.id, ...(h.name ? { name: h.name } : {}), ...(h.description ? { description: h.description } : {}), approvedModels: helperModels(state, h) }));
}

/** Handles /api/v1/registry/subagents[/:id]; returns false when the path is not one of these. */
export async function handleSubagents(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/registry/subagents' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.register');
    if (!principal) return true;
    const v = validateSubagent(await readJson(req));
    if (!v.ok) {
      json(res, 400, { error: 'invalid_subagent', errors: v.errors });
      return true;
    }
    const map = subagentsOf(state);
    if (state.agents.has(v.value.id)) {
      json(res, 409, { error: 'id_in_use', message: `an agent named ${v.value.id} already exists` });
      return true;
    }
    const replaced = map.has(v.value.id);
    // #332: re-registering a definition keeps the helper's model grant; a new helper starts with none.
    const record: SubagentRecord = { ...v.value, kind: 'subagent', registeredBy: principal.actor, registeredAt: new Date().toISOString(), approvedModels: map.get(v.value.id)?.approvedModels ?? [] };
    try {
      storeOf(state).save(record);
    } catch (err) {
      console.warn(`[control-plane] failed to persist helper ${record.id}:`, err);
      json(res, 500, { error: 'subagent_not_stored' });
      return true;
    }
    map.set(record.id, record);
    state.ledger.append({ timestamp: record.registeredAt, agentId: record.id, type: 'action', action: replaced ? 'SUBAGENT_UPDATED' : 'SUBAGENT_REGISTERED', actor: principal.actor });
    json(res, replaced ? 200 : 201, record);
    return true;
  }
  if (path === '/api/v1/registry/subagents' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return true;
    json(res, 200, [...subagentsOf(state).values()]);
    return true;
  }
  // #332: an admin sets a helper's approved models, the same grant an agent's Models tab sets.
  const mm = path.match(/^\/api\/v1\/registry\/subagents\/([^/]+)\/models$/);
  if (mm && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'registry.register');
    if (!principal) return true;
    const map = subagentsOf(state);
    const current = map.get(decodeURIComponent(mm[1]));
    if (!current) {
      json(res, 404, { error: 'not_found' });
      return true;
    }
    const body = (await readJson(req)) as { approvedModels?: unknown };
    const list = body?.approvedModels;
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x.length > 0)) {
      json(res, 400, { error: 'approvedModels must be an array of non-empty strings' });
      return true;
    }
    const offered = new Set(approvedModels(state).models);
    const missing = (list as string[]).find((x) => !offered.has(x));
    if (missing) {
      json(res, 400, { error: 'model_not_offered', model: missing });
      return true;
    }
    const record: SubagentRecord = { ...current, approvedModels: [...new Set(list as string[])].sort() };
    try {
      storeOf(state).save(record);
    } catch (err) {
      console.warn(`[control-plane] failed to persist helper ${record.id} models:`, err);
      json(res, 500, { error: 'subagent_not_stored' });
      return true;
    }
    map.set(record.id, record);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: record.id, type: 'action', action: 'SUBAGENT_MODELS_SET', actor: principal.actor });
    json(res, 200, { id: record.id, approvedModels: record.approvedModels });
    return true;
  }
  const m = path.match(/^\/api\/v1\/registry\/subagents\/([^/]+)$/);
  if (m && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return true;
    const record = subagentsOf(state).get(decodeURIComponent(m[1]));
    if (!record) json(res, 404, { error: 'not_found' });
    else json(res, 200, record);
    return true;
  }
  return false;
}

/**
 * E2.1 (#297): whose budget a run spends. A helper run (it has a parent) spends its parent agent's budget, counted in the
 * parent run, so there is no helper line item; every other run spends its own.
 */
export function budgetHolder(run: Pick<Run, 'agentId' | 'runId' | 'parentAgentId' | 'parentRunId'>): { agentId: string; runId: string; parent: boolean } {
  return run.parentAgentId && run.parentRunId ? { agentId: run.parentAgentId, runId: run.parentRunId, parent: true } : { agentId: run.agentId, runId: run.runId, parent: false };
}

export type SpawnOutcome = { status: number; body: Record<string, unknown> };

/** Longest task prompt a parent may pass to one helper run. */
export const MAX_HELPER_PROMPT_CHARS = 200_000;

/**
 * E1.4 (#295): a running agent starts a helper run. Dale's decision: the helper runs on the shared agent runtime,
 * stripped down. Ephemeral (an in-memory agent record and policy, never saved, removed when the run ends), no memory,
 * no secrets, only the `models` route (GitHub comes with E3.2), the parent's prompt as input, pinned to an approved
 * model, linked to its parent run (E1.5) and allowed only by the parent's admin-set allow-list (E1.3).
 */
export async function spawnSubagent(state: FactoryState, parent: Run, args: Record<string, unknown>): Promise<SpawnOutcome> {
  const parentAgent = state.agents.get(parent.agentId);
  if (!parentAgent) return { status: 404, body: { error: 'parent_agent_not_found' } };
  if (parentAgent.ephemeral) return { status: 403, body: { error: 'helper_cannot_spawn', message: 'a helper may not start helpers' } };
  const helperId = typeof args.subagent === 'string' ? args.subagent : '';
  if (!helperId || !allowedSubagents(state, parent.agentId).some((h) => h.id === helperId)) {
    return { status: 403, body: { error: 'subagent_not_allowed', message: `${parent.agentId} may not start helper ${helperId || '(none)'}` } };
  }
  const helper = subagentsOf(state).get(helperId);
  if (!helper) return { status: 403, body: { error: 'subagent_not_allowed' } };
  const model = args.model;
  const granted = helperModels(state, helper);
  if (typeof model !== 'string' || !model) return { status: 400, body: { error: 'model_required', message: `name one of ${helperId}'s approved models (list_models with subagent)`, approvedModels: granted } };
  // #332: the helper's own grant decides, not the whole factory catalog.
  if (!granted.includes(model)) return { status: 400, body: { error: 'model_not_approved', model, approvedModels: granted } };
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return { status: 400, body: { error: 'prompt_required' } };
  if (prompt.length > MAX_HELPER_PROMPT_CHARS) return { status: 413, body: { error: 'prompt_too_long', max: MAX_HELPER_PROMPT_CHARS } };
  // E2.1 (#297): the helper spends the parent's budget, so a parent out of budget starts none.
  const parentBuiltin = Boolean(parentAgent.isBuiltin || parentAgent.category === 'builtin' || BUILTIN_AGENT_IDS.has(parentAgent.id));
  if (!parentBuiltin && !checkStanding({ limits: state.policies.get(parent.agentId).budgetUsd, spend: state.spend.get(parent.agentId, parent.runId) }).inGoodStanding) {
    return { status: 402, body: { error: 'supervising_agent_out_of_budget' } };
  }
  const pin = state.sharedRuntime;
  if (!pin?.image) return { status: 503, body: { error: 'shared_runtime_not_configured' } };

  // One compute per helper definition and runtime image, with no secrets and no mind-bucket access, made on first use.
  const computeId = `__helper_${helperId}`; // `__` never starts an agent id, so no agent shares this compute
  const dp = state.deployProvider;
  if (dp) {
    if (!dp.provisionHelperCompute) return { status: 501, body: { error: 'helper_runtime_not_supported' } };
    state.helperCompute ??= new Map();
    if (state.helperCompute.get(computeId) !== pin.image) {
      try {
        await dp.provisionHelperCompute(computeId, pin.image);
      } catch (err) {
        console.warn(`[control-plane] helper compute ${computeId} not provisioned:`, err);
        return { status: 503, body: { error: 'helper_compute_unavailable' } };
      }
      state.helperCompute.set(computeId, pin.image);
    }
  }

  let id = '';
  do id = `${helperId}.helper.${randomBytes(6).toString('hex')}`;
  while (state.agents.has(id));
  const record: AgentRecord = {
    id,
    name: helper.name ?? helperId,
    role: 'Helper',
    state: 'SLEEPING',
    provider: 'cloud',
    artifact: pin.image,
    requires: [],
    ungated: [],
    gated: [],
    triggers: [],
    memoryPrefix: id,
    dir: '/tmp/' + id,
    model,
    requestedModels: [model],
    approvedModels: [model],
    repo: pin.repo,
    commit: pin.commit,
    createdFrom: 'configuration',
    ephemeral: { subagent: helperId, parentRunId: parent.runId },
    computeId,
  };
  state.agents.set(id, record);
  // E3.2 (#299): GitHub only when the parent has it; the gatekeeper adds the parent's key and forces read-only.
  const routes = state.policies.get(parent.agentId).routes?.includes('github') ? ['models', 'github'] : ['models'];
  state.policies.setEphemeral(id, { routes, models: [model] });
  let out: { status: number; body: unknown };
  try {
    out = await createRun(state, id, {
      actor: `run:${parent.agentId}`,
      trigger: 'subagent',
      input: { subagent: helperId, instructions: helper.prompt, prompt },
      model,
      parentRunId: parent.runId,
    });
  } catch (err) {
    out = { status: 500, body: { error: 'spawn_failed', message: err instanceof Error ? err.message : String(err) } };
  }
  if (out.status >= 300) {
    // Nothing started (refused, or failed before it ran): the helper record goes now, as it would at the run's end.
    if (state.runs.list({ agentId: id, active: true }).length === 0) {
      state.agents.delete(id);
      state.policies.forgetEphemeral(id);
    }
  }
  return { status: out.status, body: out.body as Record<string, unknown> };
}
