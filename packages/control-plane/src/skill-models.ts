/**
 * S24 (D31): factory-side per-skill model binding.
 *
 *   GET /api/v1/skills/:id/model   the skill's content-owner, an admin, or anyone who may read its package
 *   PUT /api/v1/skills/:id/model   the skill's active content-owner or an admin: { "model": "<offered model>" } binds or
 *                                  swaps; { "model": null } clears. Ledgered as SKILL_MODEL_BOUND / SKILL_MODEL_CLEARED.
 *
 * The binding lives in factory storage, never in the skill manifest, so a swap needs no new skill version and no
 * redeploy. Every agent that runs the skill inherits it (`skillModelsForAgent`, served to gatekeeper egress in the run
 * context); the agent's own model stays an ops/owner setting and is not changed by a binding.
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { SkillModelBindingStore, isValidSkillModelName } from '@beercanlabs/factory-registrar';
import { approvedModels, json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { resolveSkillContentOwner, skillRegistry } from './skills.js';

const SKILL_MODEL = /^\/api\/v1\/skills\/([^/]+)\/model$/;

const stores = new WeakMap<FactoryState, SkillModelBindingStore>();

function defaultBindingsPath(): string {
  if (process.env.FACTORY_SKILL_MODELS_PATH) return process.env.FACTORY_SKILL_MODELS_PATH;
  return join(dirname(process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl')), 'skill-models.json');
}

/** The skill → model binding store for this factory (opened from the data directory on first use). */
export function skillModelStore(state: FactoryState): SkillModelBindingStore {
  let store = stores.get(state);
  if (!store) {
    store = new SkillModelBindingStore(defaultBindingsPath());
    stores.set(state, store);
  }
  return store;
}

/** Tests and embedders: use this store (e.g. an in-memory one) for `state`. */
export function setSkillModelStore(state: FactoryState, store: SkillModelBindingStore): void {
  stores.set(state, store);
}

/**
 * Bound models for the skills `agentId` currently runs: `{ skillId: model }`. Only adopted skills appear, so a run can
 * never borrow the binding of a skill its agent does not run.
 */
export function skillModelsForAgent(state: FactoryState, agentId: string): Record<string, string> {
  const adopted = state.configs?.current(agentId)?.skills ?? [];
  if (!adopted.length) return {};
  const store = skillModelStore(state);
  const out: Record<string, string> = {};
  for (const s of adopted) {
    const b = store.get(s.id);
    if (b) out[b.skillId] = b.model;
  }
  return out;
}

function skillOwnerFor(state: FactoryState, skillId: string): string | undefined {
  const versions = skillRegistry(state).versions(skillId);
  const first = versions[0];
  const resolved = resolveSkillContentOwner(state, skillId, first);
  if (resolved === null) return undefined; // fail closed: no owner match (grant store unhealthy or transfer pending)
  return resolved ?? (first ? (first.owner ?? first.registeredBy) : undefined);
}

export async function handleSkillModels(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const m = path.match(SKILL_MODEL);
  if (!m || (req.method !== 'GET' && req.method !== 'PUT')) return false;
  let skillId: string;
  try {
    skillId = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    json(res, 400, { error: 'invalid_skill_id' });
    return true;
  }
  const versions = skillRegistry(state).versions(skillId);
  const first = versions[0];
  const resource = { skillId, skillOwner: skillOwnerFor(state, skillId), groupId: first?.groupId };

  if (req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'skills.package.read', resource))) return true;
    if (!versions.length) return json(res, 404, { error: 'not_found', id: skillId }), true;
    const binding = skillModelStore(state).get(skillId);
    json(res, 200, { skillId, binding: binding ?? null });
    return true;
  }

  const principal = await requirePrivilege(req, res, state, 'skills.version.add', resource);
  if (!principal) return true;
  if (!versions.length) return json(res, 404, { error: 'not_found', id: skillId }), true;
  const body = await readJson(req);
  const store = skillModelStore(state);
  // D23 act-as: the binding records the subject acted for; the ledger's act-as context stamps `onBehalfOf`.
  const actor = principal.onBehalfOf ?? principal.actor;
  const now = new Date().toISOString();

  if (body.model === null) {
    const previous = store.clear(skillId);
    if (previous !== undefined) {
      state.ledger.append({
        timestamp: now,
        agentId: `skill:${skillId}`,
        type: 'action',
        action: 'SKILL_MODEL_CLEARED',
        actor: principal.actor,
        requestId: `skill-model:${skillId}`,
        payloadSha256: payloadHash({ skillId, model: null, previous }),
      });
    }
    json(res, 200, { skillId, binding: null, ...(previous ? { previous } : {}) });
    return true;
  }

  const model = body.model;
  if (!isValidSkillModelName(model)) {
    json(res, 400, { error: 'invalid_model', message: 'model must be an offered model name, or null to clear' });
    return true;
  }
  const offered = approvedModels(state).models;
  if (!offered.includes(model)) {
    json(res, 422, { error: 'model_not_offered', model, message: 'the factory does not offer this model' });
    return true;
  }
  const { binding, previous } = store.set(skillId, model, actor, now);
  state.ledger.append({
    timestamp: now,
    agentId: `skill:${skillId}`,
    type: 'action',
    action: 'SKILL_MODEL_BOUND',
    actor: principal.actor,
    requestId: `skill-model:${skillId}`,
    model: binding.model,
    payloadSha256: payloadHash({ skillId, model: binding.model, previous: previous ?? null }),
  });
  json(res, 200, { skillId, binding, ...(previous ? { previous } : {}) });
  return true;
}
