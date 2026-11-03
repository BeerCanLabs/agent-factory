import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authorize, type Privilege } from '@beercanlabs/factory-bouncer';
import type { Principal } from '@beercanlabs/factory-auth';
import type { SkillVersionRecord } from '@beercanlabs/factory-registrar';
import { effectiveGrantsForActor, json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { createFromConfiguration } from './agent-creation.js';
import { admitSkillVersion, skillRegistry } from './skills.js';

/**
 * S20 (D27, D28): content submission and admission gates. Any signed-in user with factory access submits an agent or
 * skill draft (`content.submit`). Three gates run in parallel: an automated security scan, an automated compliance
 * check, and budget availability (agents only: has the budget-owner allocated budget to this draft; skills need none,
 * D28). An approver (`content.admit`) admits only when every applicable gate has passed, and the gates are evaluated
 * again at that moment. The submitter has no say over budget: any budget or policy the draft carries is stripped.
 */
export type GateName = 'security' | 'compliance' | 'budget';
export type GateState = 'passed' | 'failed' | 'pending' | 'not-applicable';
export type Gate = { state: GateState; reasons?: string[] };
export type Submission = {
  id: string;
  kind: 'agent' | 'skill';
  submitter: string;
  onBehalfOf?: string;
  /** Agent: the configuration for `createFromConfiguration`. Skill: `{ skillId, version }` of a registered version. */
  content: Record<string, unknown>;
  strippedFields?: string[];
  status: 'pending' | 'admitted';
  gates: Record<GateName, Gate>;
  /** Set only by the budget-owner (or admin) through `PUT /api/v1/budget/submissions/:id`. */
  allocatedBudgetUsd?: { perDay?: number; perMonth?: number };
  createdAt: string;
  admittedBy?: string;
  admittedAt?: string;
};

/** Fields a submitter may never set: budget belongs to the budget-owner (D27) and policy to admins. */
const BUDGET_FIELDS = ['budgetUsd', 'budget', 'spendLimitUsd', 'policy', 'policies'];
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Credential shapes the automated security scan refuses in an agent draft (a draft is untrusted input). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['factory-api-key', /\bfk_[A-Za-z0-9_-]{16,}\b/],
  ['provider-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
];

type Store = { all: Map<string, Submission>; file?: string };
const stores = new WeakMap<FactoryState, Store>();

function store(state: FactoryState): Store {
  let s = stores.get(state);
  if (s) return s;
  const file = state.registryDir ? join(dirname(state.registryDir), 'submissions', 'submissions.json') : undefined;
  s = { all: new Map(), ...(file ? { file } : {}) };
  if (file) {
    try {
      for (const sub of JSON.parse(readFileSync(file, 'utf8')) as Submission[]) s.all.set(sub.id, sub);
    } catch {
      // No file yet (or unreadable): start empty.
    }
  }
  stores.set(state, s);
  return s;
}

function save(state: FactoryState): void {
  const s = store(state);
  if (!s.file) return;
  mkdirSync(dirname(s.file), { recursive: true });
  const tmp = `${s.file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...s.all.values()], null, 2));
  renameSync(tmp, s.file);
}

function ledger(state: FactoryState, sub: Submission, action: string, actor: string, route?: string): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: sub.kind === 'agent' ? String(sub.content.id ?? 'factory') : `skill:${String(sub.content.skillId)}@${String(sub.content.version)}`,
    type: 'action',
    action,
    actor,
    requestId: sub.id,
    ...(route ? { route } : {}),
  });
}

function skillOf(state: FactoryState, sub: Submission): SkillVersionRecord | undefined {
  const { skillId, version } = sub.content;
  return typeof skillId === 'string' && typeof version === 'string' ? skillRegistry(state).get(skillId, version) : undefined;
}

async function securityGate(state: FactoryState, sub: Submission): Promise<Gate> {
  if (sub.kind === 'skill') {
    const rec = skillOf(state, sub);
    if (!rec) return { state: 'failed', reasons: ['skill version is not registered'] };
    // SK1: the factory's checks on the skill's code include the secret and design scans.
    if (rec.tests === 'passed') return { state: 'passed' };
    return rec.tests === 'failed' ? { state: 'failed', reasons: rec.checks?.failures ?? ['skill checks failed'] } : { state: 'pending', reasons: ['skill checks have not finished'] };
  }
  const text = JSON.stringify(sub.content);
  const hits = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => `draft contains a credential (${name})`);
  return hits.length ? { state: 'failed', reasons: hits } : { state: 'passed' };
}

async function complianceGate(state: FactoryState, sub: Submission): Promise<Gate> {
  const reasons: string[] = [];
  if (sub.kind === 'skill') {
    const rec = skillOf(state, sub);
    if (!rec) return { state: 'failed', reasons: ['skill version is not registered'] };
    if (rec.retired) reasons.push('skill is retired');
    if (rec.status !== 'pending') reasons.push(`skill version is ${rec.status}, not pending`);
    // Skills are always person-owned.
    if (!rec.owner || !/^(user:|cloudflare:|oidc:)|@/.test(rec.owner)) reasons.push('skill has no person owner');
    const issue = skillRegistry(state).identityIssue(rec.manifest);
    if (issue) reasons.push(issue);
  } else {
    const c = sub.content;
    if (typeof c.id !== 'string' || !AGENT_ID.test(c.id) || c.id.startsWith('__')) reasons.push('id must be 1 to 128 letters, digits, dot, dash or underscore');
    else if (state.agents.has(c.id)) reasons.push(`agent ${c.id} already exists`);
    if (c.kind !== undefined && c.kind !== 'personal' && c.kind !== 'team') reasons.push("kind must be 'personal' or 'team'");
    if (c.kind === 'team' && (typeof c.accountableLead !== 'string' || !c.accountableLead.trim())) reasons.push('a team agent needs an accountableLead');
    if (typeof c.soul !== 'string' || !c.soul.trim()) reasons.push('soul (the purpose) is required');
  }
  return reasons.length ? { state: 'failed', reasons } : { state: 'passed' };
}

async function budgetGate(_state: FactoryState, sub: Submission): Promise<Gate> {
  if (sub.kind === 'skill') return { state: 'not-applicable' }; // D28: skills spend the invoking agent's budget.
  const b = sub.allocatedBudgetUsd;
  if (b && ((b.perDay ?? 0) > 0 || (b.perMonth ?? 0) > 0)) return { state: 'passed' };
  return { state: 'pending', reasons: ['no budget allocated by the budget-owner'] };
}

/** Runs the three gates in parallel and ledgers each gate whose state changed to passed or failed. */
async function evaluate(state: FactoryState, sub: Submission, actor: string): Promise<void> {
  const [security, compliance, budget] = await Promise.all([securityGate(state, sub), complianceGate(state, sub), budgetGate(state, sub)]);
  const next: Record<GateName, Gate> = { security, compliance, budget };
  for (const name of ['security', 'compliance', 'budget'] as const) {
    const was = sub.gates?.[name]?.state;
    const now = next[name].state;
    if (now !== was && (now === 'passed' || now === 'failed')) ledger(state, sub, now === 'passed' ? 'GATE_PASSED' : 'GATE_FAILED', actor, name);
  }
  sub.gates = next;
}

const allPassed = (sub: Submission) => Object.values(sub.gates).every((g) => g.state === 'passed' || g.state === 'not-applicable');

function holds(state: FactoryState, principal: Principal, privilege: Privilege): boolean {
  const g = effectiveGrantsForActor(state, principal.actor);
  if (!g.ok) return false;
  return authorize({ principal, privilege, ...(g.grants !== undefined ? { resource: { grants: g.grants } } : {}) }).allowed;
}

/** What a submitter or admitter sees. */
const view = (s: Submission) => s;

/**
 * Creates a pending draft and runs the gates: the one entry point for `POST /submissions` and the S21 interview, so an
 * interview draft is exactly as untrusted as any other.
 */
export async function createSubmission(state: FactoryState, principal: Principal, kind: 'agent' | 'skill', input: Record<string, unknown>): Promise<Submission> {
  const raw = { ...input };
  const stripped = BUDGET_FIELDS.filter((f) => f in raw);
  for (const f of stripped) delete raw[f];
  delete raw.actAs;
  delete raw.onBehalfOf;
  const content = kind === 'skill' ? { skillId: raw.skillId, version: raw.version } : raw;
  const sub: Submission = {
    id: `sub_${randomUUID()}`,
    kind,
    submitter: principal.onBehalfOf ?? principal.actor,
    ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    content,
    ...(stripped.length ? { strippedFields: stripped } : {}),
    status: 'pending',
    gates: { security: { state: 'pending' }, compliance: { state: 'pending' }, budget: { state: 'pending' } },
    createdAt: new Date().toISOString(),
  };
  ledger(state, sub, 'CONTENT_SUBMITTED', principal.actor);
  await evaluate(state, sub, 'factory:gates');
  store(state).all.set(sub.id, sub);
  save(state);
  return sub;
}

const ONE = /^\/api\/v1\/submissions\/([^/]+)$/;
const ADMIT = /^\/api\/v1\/submissions\/([^/]+)\/admit$/;
const ALLOCATE = /^\/api\/v1\/budget\/submissions\/([^/]+)$/;

export async function handleSubmissions(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/submissions' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'content.submit');
    if (!principal) return true;
    const body = await readJson(req);
    const kind = body.kind;
    if (kind !== 'agent' && kind !== 'skill') {
      json(res, 400, { error: 'invalid_kind', message: "kind must be 'agent' or 'skill'" });
      return true;
    }
    const raw = body.content && typeof body.content === 'object' && !Array.isArray(body.content) ? { ...(body.content as Record<string, unknown>) } : undefined;
    if (!raw) {
      json(res, 400, { error: 'invalid_content', message: 'content must be an object' });
      return true;
    }
    json(res, 201, view(await createSubmission(state, principal, kind, raw)));
    return true;
  }

  if (path === '/api/v1/submissions' && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'content.submit');
    if (!principal) return true;
    const everyone = holds(state, principal, 'content.admit');
    const me = (principal.onBehalfOf ?? principal.actor).toLowerCase();
    const list = [...store(state).all.values()].filter((s) => everyone || s.submitter.toLowerCase() === me);
    json(res, 200, { submissions: list.map(view) });
    return true;
  }

  const one = path.match(ONE);
  if (one && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'content.submit');
    if (!principal) return true;
    const sub = store(state).all.get(one[1]);
    const me = (principal.onBehalfOf ?? principal.actor).toLowerCase();
    if (!sub || (sub.submitter.toLowerCase() !== me && !holds(state, principal, 'content.admit'))) {
      json(res, 404, { error: 'not_found' });
      return true;
    }
    json(res, 200, view(sub));
    return true;
  }

  const alloc = path.match(ALLOCATE);
  if (alloc && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'budget.allocate');
    if (!principal) return true;
    const sub = store(state).all.get(alloc[1]);
    if (!sub) {
      json(res, 404, { error: 'not_found' });
      return true;
    }
    if (sub.kind !== 'agent' || sub.status !== 'pending') {
      json(res, 409, { error: sub.kind !== 'agent' ? 'skills_hold_no_budget' : 'not_pending' });
      return true;
    }
    const body = await readJson(req);
    const b = body.budgetUsd as Record<string, unknown> | undefined;
    const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
    const ok =
      keys.length > 0 &&
      Object.keys(body).every((k) => k === 'budgetUsd') &&
      keys.every((k) => (k === 'perDay' || k === 'perMonth') && typeof b![k] === 'number' && Number.isFinite(b![k] as number) && (b![k] as number) >= 0);
    if (!ok) {
      json(res, 400, { error: 'invalid_budget', message: 'body must be { budgetUsd: { perDay?: number >= 0, perMonth?: number >= 0 } }' });
      return true;
    }
    sub.allocatedBudgetUsd = { ...sub.allocatedBudgetUsd, ...(b as { perDay?: number; perMonth?: number }) };
    ledger(state, sub, 'BUDGET_ALLOCATED', principal.actor);
    await evaluate(state, sub, 'factory:gates');
    save(state);
    json(res, 200, view(sub));
    return true;
  }

  const admitting = path.match(ADMIT);
  if (admitting && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'content.admit');
    if (!principal) return true;
    const sub = store(state).all.get(admitting[1]);
    if (!sub) {
      json(res, 404, { error: 'not_found' });
      return true;
    }
    if (sub.status !== 'pending') {
      json(res, 409, { error: 'not_pending', status: sub.status });
      return true;
    }
    await evaluate(state, sub, 'factory:gates');
    if (!allPassed(sub)) {
      save(state);
      json(res, 409, { error: 'gates_not_passed', gates: sub.gates });
      return true;
    }
    let admitted: Record<string, unknown>;
    if (sub.kind === 'agent') {
      // The agent is created as the submitter's (D27): ownership resolves to them, never to the approver.
      const created = await createFromConfiguration(state, { actor: sub.submitter, roles: [] }, { ...(sub.content as Record<string, unknown>), id: sub.content.id, reason: `admitted submission ${sub.id}` });
      if (created.status !== 201 && created.status !== 200) {
        json(res, created.status, created.body);
        return true;
      }
      const id = String(sub.content.id);
      const current = state.policies.get(id) ?? { routes: ['anthropic', 'openai'] };
      state.policies.set(id, { ...current, budgetUsd: { ...current.budgetUsd, ...sub.allocatedBudgetUsd } } as never);
      admitted = created.body;
    } else {
      const rec = skillOf(state, sub)!;
      const out = await admitSkillVersion(state, rec, principal);
      if (!out.ok) {
        json(res, 409, { error: out.error });
        return true;
      }
      admitted = out.record as unknown as Record<string, unknown>;
    }
    sub.status = 'admitted';
    sub.admittedBy = principal.actor;
    sub.admittedAt = new Date().toISOString();
    ledger(state, sub, 'CONTENT_ADMITTED', principal.actor);
    save(state);
    json(res, 200, { submission: view(sub), admitted });
    return true;
  }
  return false;
}
