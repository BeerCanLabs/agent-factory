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

function skillVisible(state: FactoryState, id: string, principal: Principal) {
  if (!SKILL_ID.test(id)) return null;
  const first = skillRegistry(state).versions(id)[0];
  if (!first) return null;
  const owner = ownerOf(first);
  const visible = skillVisibleTo({ visibility: visibilityOf(first), ...(owner ? { owner } : {}) }, viewerOf(state, principal));
  return visible ? first : null;
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

export type TrainingOp = {
  op: 'account' | 'cap' | 'baseline' | 'run' | 'recommend';
  skillId: string;
  capUsd?: number;
  cases?: unknown;
  model?: unknown;
  costUsd?: unknown;
  outputs?: unknown;
};

/** Apply one training operation for an already authorized principal. Scoring and spend stay here. */
export async function applyTraining(state: FactoryState, principal: Principal, op: TrainingOp): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = op.skillId;
  if (op.op === 'account') {
    if (!skillVisible(state, id, principal)) return { status: 404, body: { error: 'not_found', id } };
    return { status: 200, body: publicRecord(recordOf(state, id)) as Record<string, unknown> };
  }
  if (op.op === 'cap') {
    const capUsd = op.capUsd;
    if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) return { status: 400, body: { error: 'training_cap_invalid' } };
    const rec = recordOf(state, id);
    rec.account = { capUsd, spentUsd: rec.account?.spentUsd ?? 0 };
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: 'TRAINING_CAP_SET',
      actor: principal.actor,
      costUsd: capUsd,
    });
    return { status: 200, body: { skillId: id, capUsd, spentUsd: rec.account.spentUsd } };
  }
  if (op.op === 'baseline') {
    if (!Array.isArray(op.cases) || op.cases.length === 0 || op.cases.length > 32) return { status: 400, body: { error: 'training_baseline_invalid' } };
    const cases = op.cases.map(caseOf);
    if (cases.some((c) => !c)) return { status: 400, body: { error: 'training_baseline_invalid' } };
    const rec = recordOf(state, id);
    rec.baseline = cases as TrainingCase[];
    rec.trials = [];
    delete rec.recommendation;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: 'TRAINING_BASELINE_SET',
      actor: principal.actor,
      payloadSha256: payloadHash(cases),
    });
    return { status: 200, body: { skillId: id, cases: rec.baseline.length } };
  }
  if (op.op === 'run') {
    if (typeof op.model !== 'string' || !op.model || op.model.length > 128) return { status: 400, body: { error: 'training_run_invalid' } };
    if (typeof op.costUsd !== 'number' || !Number.isFinite(op.costUsd) || op.costUsd < 0) return { status: 400, body: { error: 'training_run_invalid' } };
    const rec = recordOf(state, id);
    if (!rec.baseline.length) return { status: 409, body: { error: 'training_baseline_required' } };
    if (!Array.isArray(op.outputs)) return { status: 400, body: { error: 'training_run_invalid' } };
    const byName = new Map(op.outputs.map((row) => {
      const item = row as { name?: unknown; output?: unknown };
      return [item?.name, item?.output] as const;
    }));
    if (rec.baseline.some((c) => typeof byName.get(c.name) !== 'string')) return { status: 400, body: { error: 'training_run_invalid' } };
    const charged = chargeTraining(rec.account, op.costUsd);
    if (!charged.ok) return { status: 402, body: { error: charged.error } };
    let passed = 0;
    let failed = 0;
    for (const c of rec.baseline) {
      if (outputPasses(String(byName.get(c.name)), c)) passed += 1;
      else failed += 1;
    }
    rec.account = charged.account;
    const trial: TrainingTrial = { model: op.model, passed, failed, costUsd: op.costUsd };
    rec.trials.push(trial);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: `skill:${id}`,
      type: 'action',
      action: `TRAINING_RUN passed=${passed} failed=${failed}`,
      actor: principal.actor,
      model: op.model,
      costUsd: op.costUsd,
      payloadSha256: payloadHash(rec.baseline),
    });
    return { status: 200, body: { skillId: id, ...trial, spentUsd: rec.account.spentUsd } };
  }
  const rec = recordOf(state, id);
  const winners = rec.trials.filter((t) => t.failed === 0 && t.passed > 0);
  if (!winners.length) return { status: 409, body: { error: 'training_no_winner' } };
  const best = winners.reduce((a, b) => (a.costUsd <= b.costUsd ? a : b));
  rec.recommendation = { model: best.model, costUsd: best.costUsd, at: new Date().toISOString() };
  state.ledger.append({
    timestamp: rec.recommendation.at,
    agentId: `skill:${id}`,
    type: 'action',
    action: 'TRAINING_RECOMMENDED',
    actor: principal.actor,
    model: best.model,
    costUsd: best.costUsd,
  });
  return { status: 200, body: { skillId: id, recommendation: rec.recommendation, adopted: false } };
}

/**
 * A live run asks for training. The run token proves which run it is. The principal is the run's caller,
 * the person the Gatekeeper already verified, never a secret the cartridge holds.
 */
export async function applyTrainingForCaller(
  state: FactoryState,
  principal: Principal,
  body: { op?: unknown; skillId?: unknown; capUsd?: number; cases?: unknown; model?: unknown; costUsd?: unknown; outputs?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = typeof body.skillId === 'string' ? body.skillId : '';
  const op = body.op === 'cap' ? 'cap' : body.op === 'baseline' ? 'baseline' : body.op === 'run' ? 'run' : body.op === 'recommend' ? 'recommend' : body.op === 'account' ? 'account' : '';
  if (!op) return { status: 400, body: { error: 'training_op_invalid' } };
  const known = SKILL_ID.test(id) ? skillRegistry(state).versions(id) : [];
  const ownerAgent = known[0] ? ownerOf(known[0]) : undefined;
  const resource = ownerAgent ? { agentId: ownerAgent, owners: ownersOf(state, ownerAgent) } : undefined;
  const decision = op === 'cap'
    ? authorize({ principal, privilege: 'skills.training.fund', ...(resource ? { resource } : {}) })
    : authorize({ principal, privilege: 'skills.training.run', ...(resource ? { resource } : {}) });
  if (!decision.allowed) return { status: 403, body: { error: 'forbidden', required: decision.required } };
  if (!known[0]) return { status: 404, body: { error: 'not_found', id } };
  return applyTraining(state, principal, { op, skillId: id, capUsd: body.capUsd, cases: body.cases, model: body.model, costUsd: body.costUsd, outputs: body.outputs });
}

/** Handles the skill training routes. Returns false for any other path. */
export async function handleSkillTraining(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const get = path.match(TRAINING);
  if (get && req.method === 'GET') {
    const id = decode(get[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const result = await applyTraining(state, auth.principal, { op: 'account', skillId: id });
    json(res, result.status, result.body);
    return true;
  }

  const cap = path.match(CAP);
  if (cap && req.method === 'PUT') {
    const id = decode(cap[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.fund');
    if (!auth) return true;
    const body = (await readJson(req)) as { capUsd?: number };
    const result = await applyTraining(state, auth.principal, { op: 'cap', skillId: id, capUsd: body?.capUsd });
    json(res, result.status, result.body);
    return true;
  }

  const baseline = path.match(BASELINE);
  if (baseline && req.method === 'PUT') {
    const id = decode(baseline[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const body = (await readJson(req)) as { cases?: unknown };
    const result = await applyTraining(state, auth.principal, { op: 'baseline', skillId: id, cases: body?.cases });
    json(res, result.status, result.body);
    return true;
  }

  const run = path.match(RUN);
  if (run && req.method === 'POST') {
    const id = decode(run[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const body = (await readJson(req)) as { model?: unknown; costUsd?: unknown; outputs?: unknown };
    const result = await applyTraining(state, auth.principal, { op: 'run', skillId: id, model: body?.model, costUsd: body?.costUsd, outputs: body?.outputs });
    json(res, result.status, result.body);
    return true;
  }

  const recommend = path.match(RECOMMEND);
  if (recommend && req.method === 'POST') {
    const id = decode(recommend[1]);
    const auth = await authorizeTraining(state, req, res, id, 'skills.training.run');
    if (!auth) return true;
    const result = await applyTraining(state, auth.principal, { op: 'recommend', skillId: id });
    json(res, result.status, result.body);
    return true;
  }

  return false;
}
