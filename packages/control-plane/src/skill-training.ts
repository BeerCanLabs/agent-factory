// Skill training accounts (GAP-160). Spend while the Personal Trainer works on a skill posts here.
// An agent's budget is untouched. The ledger records the model, the cost and a hash, never the case text.
import type http from 'node:http';
import { chargeTraining, type TrainingAccount } from '@beercanlabs/factory-budget';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { ownerOf, skillVisibleTo, visibilityOf, type SkillViewer } from '@beercanlabs/factory-registrar';
import type { Principal } from '@beercanlabs/factory-auth';
import { authorize } from '@beercanlabs/factory-bouncer';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { ownersOf } from './config-store.js';
import { skillRegistry } from './skills.js';

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRAINING = /^\/api\/v1\/skills\/([^/]+)\/training$/;
const CAP = /^\/api\/v1\/skills\/([^/]+)\/training-account$/;
const BASELINE = /^\/api\/v1\/skills\/([^/]+)\/training-baseline$/;
const RUN = /^\/api\/v1\/skills\/([^/]+)\/training-runs$/;
const RECOMMEND = /^\/api\/v1\/skills\/([^/]+)\/training-recommendation$/;

export type TrainingAssertion = { equals?: string; contains?: string; matches?: string };

/** True when the output meets every assertion that was set, and at least one assertion was set. Scoring stays with the training route, not the Accountant's pricing package. */
export function outputPasses(output: string, assertion: TrainingAssertion): boolean {
  const has = assertion.equals !== undefined || assertion.contains !== undefined || assertion.matches !== undefined;
  if (!has) return false;
  if (assertion.equals !== undefined && output !== assertion.equals) return false;
  if (assertion.contains !== undefined && !output.includes(assertion.contains)) return false;
  if (assertion.matches !== undefined) {
    try {
      if (!new RegExp(assertion.matches).test(output)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export type TrainingCase = { name: string; input: string } & TrainingAssertion;
export type TrainingTrial = { model: string; passed: number; failed: number; costUsd: number };
export type TrainingRecord = {
  account?: TrainingAccount;
  baseline: TrainingCase[];
  trials: TrainingTrial[];
  recommendation?: { model: string; costUsd: number; at: string };
};

const records = new WeakMap<FactoryState, Map<string, TrainingRecord>>();

function book(state: FactoryState): Map<string, TrainingRecord> {
  let map = records.get(state);
  if (!map) {
    map = new Map();
    records.set(state, map);
  }
  return map;
}

function recordOf(state: FactoryState, id: string): TrainingRecord {
  const map = book(state);
  let rec = map.get(id);
  if (!rec) {
    rec = { baseline: [], trials: [] };
    map.set(id, rec);
  }
  return rec;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

function viewerOf(state: FactoryState, principal: Principal): SkillViewer {
  const admin = authorize({ principal, privilege: 'skills.decide' }).allowed;
  if (admin) return { admin, ownedAgents: [] };
  const actor = principal.actor.toLowerCase();
  const ownedAgents = (state.configs?.agentIds() ?? []).filter((id) => ownersOf(state, id).some((o) => o.toLowerCase() === actor));
  return { admin, ownedAgents };
}

function skillOr404(state: FactoryState, res: http.ServerResponse, id: string, principal: Principal) {
  if (!SKILL_ID.test(id)) {
    json(res, 404, { error: 'not_found', id });
    return null;
  }
  const versions = skillRegistry(state).versions(id);
  const first = versions[0];
  if (!first) {
    json(res, 404, { error: 'not_found', id });
    return null;
  }
  const owner = ownerOf(first);
  const visible = skillVisibleTo({ visibility: visibilityOf(first), ...(owner ? { owner } : {}) }, viewerOf(state, principal));
  if (!visible) {
    json(res, 404, { error: 'not_found', id });
    return null;
  }
  return first;
}

/** Admin, or an owner of the private skill's owner agent. A public skill's training money is an admin act. */
async function authorizeTraining(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  privilege: 'skills.training.fund' | 'skills.training.run',
): Promise<{ principal: Principal; ownerAgent?: string } | null> {
  const known = SKILL_ID.test(id) ? skillRegistry(state).versions(id) : [];
  const ownerAgent = known[0] ? ownerOf(known[0]) : undefined;
  const resource = ownerAgent ? { agentId: ownerAgent } : undefined;
  // Privilege before existence, so a missing skill is still 401 or 403 for someone who may not train.
  // The two calls are separate so each privilege is a literal the conformance check can see.
  const principal = privilege === 'skills.training.fund'
    ? await requirePrivilege(req, res, state, 'skills.training.fund', resource)
    : await requirePrivilege(req, res, state, 'skills.training.run', resource);
  if (!principal) return null;
  if (!known[0]) {
    json(res, 404, { error: 'not_found', id });
    return null;
  }
  return { principal, ...(ownerAgent ? { ownerAgent } : {}) };
}

function assertionOf(raw: Record<string, unknown>): TrainingAssertion | undefined {
  const out: TrainingAssertion = {};
  if (typeof raw.equals === 'string') out.equals = raw.equals;
  if (typeof raw.contains === 'string') out.contains = raw.contains;
  if (typeof raw.matches === 'string') out.matches = raw.matches;
  if (out.equals === undefined && out.contains === undefined && out.matches === undefined) return undefined;
  return out;
}

function caseOf(raw: unknown): TrainingCase | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.name || row.name.length > 64) return undefined;
  if (typeof row.input !== 'string' || !row.input || row.input.length > 4000) return undefined;
  const assertion = assertionOf(row);
  if (!assertion) return undefined;
  return { name: row.name, input: row.input, ...assertion };
}

function publicRecord(rec: TrainingRecord) {
  return {
    capUsd: rec.account?.capUsd ?? null,
    spentUsd: rec.account?.spentUsd ?? 0,
    baseline: rec.baseline.map(({ name }) => ({ name })),
    trials: rec.trials,
    ...(rec.recommendation ? { recommendation: rec.recommendation } : {}),
  };
}

/** Handles the skill training routes. Returns false for any other path. */
export async function handleSkillTraining(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const get = path.match(TRAINING);
  if (get && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'skills.read');
    if (!principal) return true;
    const id = decode(get[1]);
    if (!skillOr404(state, res, id, principal)) return true;
    json(res, 200, publicRecord(recordOf(state, id)));
    return true;
  }

  const cap = path.match(CAP);
  if (cap && req.method === 'PUT') {
    const id = decode(cap[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.fund');
    if (!auth) return true;
    const body = (await readJson(req)) as { capUsd?: unknown };
    const capUsd = body?.capUsd;
    if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) {
      json(res, 400, { error: 'training_cap_invalid' });
      return true;
    }
    const rec = recordOf(state, id);
    rec.account = { capUsd, spentUsd: rec.account?.spentUsd ?? 0 };
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: 'TRAINING_CAP_SET',
      actor: auth.principal.actor,
      costUsd: capUsd,
    });
    json(res, 200, { skillId: id, capUsd, spentUsd: rec.account.spentUsd });
    return true;
  }

  const baseline = path.match(BASELINE);
  if (baseline && req.method === 'PUT') {
    const id = decode(baseline[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const body = (await readJson(req)) as { cases?: unknown };
    if (!Array.isArray(body?.cases) || body.cases.length === 0 || body.cases.length > 32) {
      json(res, 400, { error: 'training_baseline_invalid' });
      return true;
    }
    const cases = body.cases.map(caseOf);
    if (cases.some((c) => !c)) {
      json(res, 400, { error: 'training_baseline_invalid' });
      return true;
    }
    const rec = recordOf(state, id);
    rec.baseline = cases as TrainingCase[];
    rec.trials = [];
    delete rec.recommendation;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: 'TRAINING_BASELINE_SET',
      actor: auth.principal.actor,
      payloadSha256: payloadHash(cases),
    });
    json(res, 200, { skillId: id, cases: rec.baseline.length });
    return true;
  }

  const run = path.match(RUN);
  if (run && req.method === 'POST') {
    const id = decode(run[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const body = (await readJson(req)) as { model?: unknown; costUsd?: unknown; outputs?: unknown };
    if (typeof body?.model !== 'string' || !body.model || body.model.length > 128) {
      json(res, 400, { error: 'training_run_invalid' });
      return true;
    }
    if (typeof body.costUsd !== 'number' || !Number.isFinite(body.costUsd) || body.costUsd < 0) {
      json(res, 400, { error: 'training_run_invalid' });
      return true;
    }
    const rec = recordOf(state, id);
    if (!rec.baseline.length) {
      json(res, 409, { error: 'training_baseline_required' });
      return true;
    }
    if (!Array.isArray(body.outputs)) {
      json(res, 400, { error: 'training_run_invalid' });
      return true;
    }
    const byName = new Map(body.outputs.map((row) => {
      const item = row as { name?: unknown; output?: unknown };
      return [item?.name, item?.output] as const;
    }));
    if (rec.baseline.some((c) => typeof byName.get(c.name) !== 'string')) {
      json(res, 400, { error: 'training_run_invalid' });
      return true;
    }
    const charged = chargeTraining(rec.account, body.costUsd);
    if (!charged.ok) {
      json(res, 402, { error: charged.error });
      return true;
    }
    let passed = 0;
    let failed = 0;
    for (const c of rec.baseline) {
      if (outputPasses(String(byName.get(c.name)), c)) passed += 1;
      else failed += 1;
    }
    rec.account = charged.account;
    const trial: TrainingTrial = { model: body.model, passed, failed, costUsd: body.costUsd };
    rec.trials.push(trial);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: `TRAINING_RUN passed=${passed} failed=${failed}`,
      actor: auth.principal.actor,
      model: body.model,
      costUsd: body.costUsd,
      payloadSha256: payloadHash(rec.baseline),
    });
    json(res, 200, { skillId: id, ...trial, spentUsd: rec.account.spentUsd });
    return true;
  }

  const recommend = path.match(RECOMMEND);
  if (recommend && req.method === 'POST') {
    const id = decode(recommend[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const rec = recordOf(state, id);
    const winners = rec.trials.filter((t) => t.failed === 0 && t.passed > 0);
    if (!winners.length) {
      json(res, 409, { error: 'training_no_winner' });
      return true;
    }
    const best = winners.reduce((a, b) => (a.costUsd <= b.costUsd ? a : b));
    rec.recommendation = { model: best.model, costUsd: best.costUsd, at: new Date().toISOString() };
    state.ledger.append({
      timestamp: rec.recommendation.at,
      agentId: `skill:${id}`,
      type: 'action',
      action: 'TRAINING_RECOMMENDED',
      actor: auth.principal.actor,
      model: best.model,
      costUsd: best.costUsd,
    });
    json(res, 200, { skillId: id, recommendation: rec.recommendation, adopted: false });
    return true;
  }

  return false;
}
