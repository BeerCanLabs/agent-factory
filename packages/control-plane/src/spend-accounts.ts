/**
 * GAP-261: spend attributed to a plan, and the `budget-update` event that tells the plan's conductor what it has cost.
 *
 * A run that wakes another (`POST /api/v1/runs/:id/wake/:agent`) may name a plan, `plan:<owner>/<repo>#<pr>`; the
 * woken run, its helpers and the runs it wakes in turn are charged to it. An account is the waking agent's own: it is
 * keyed on owner and plan, so another agent naming the same plan gets its own account and can never charge, or take
 * over, the conductor's. A run already charged to an account cannot move its wakes to another plan (only the owner
 * may name a different one). Nothing polls and no timer runs. The owner is woken with
 * `{event: {type: 'budget-update', repo, pr, spent_usd}}` when a charge crosses a step of the account's spend
 * (`spendUpdateStepUsd`, default $5; `FACTORY_SPEND_UPDATE_STEP_USD`) and when a charged run ends, however it ends,
 * with spend not yet reported. The `budget-update` run itself is not charged to the plan: `spent_usd` is what the
 * runs woken on the plan cost. Every model call is still charged to its agent as before; this only adds the per-plan sum.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SYSTEM, activeRun, createRun, deliverToMailbox, isTerminal, type Run } from '@beercanlabs/factory-property-manager';
import type { FactoryState } from './app.js';

/** A plan's account: the plan PR the conductor's `budget-update` names. */
export const PLAN_ACCOUNT = /^plan:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})$/;
export const DEFAULT_STEP_USD = 5;
/** Runs remembered per account binding; the oldest go first (a finished run is never charged again). */
const MAX_RUNS = 20_000;
/** Accounts kept; the oldest fully reported go first. */
const MAX_ACCOUNTS = 5_000;

type Account = { owner: string; plan: string; spentUsd: number; reportedUsd: number; updatedAt: string };
/** An account's key: its owner and its plan. */
export const accountKey = (owner: string, plan: string): string => `${owner} ${plan}`;
type Doc = { accounts: Record<string, Account>; runs: Record<string, string> };

export class SpendAccountStore {
  private doc: Doc = { accounts: {}, runs: {} };
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Doc;
      if (raw && typeof raw.accounts === 'object' && typeof raw.runs === 'object') this.doc = raw;
    } catch {
      this.doc = { accounts: {}, runs: {} };
    }
  }

  /** Charges `runId` to `owner`'s account for `plan`. */
  bind(runId: string, plan: string, owner: string): void {
    const key = accountKey(owner, plan);
    this.doc.accounts[key] ??= { owner, plan, spentUsd: 0, reportedUsd: 0, updatedAt: new Date().toISOString() };
    this.doc.runs[runId] = key;
    const ids = Object.keys(this.doc.runs);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RUNS))) delete this.doc.runs[old];
    const keys = Object.keys(this.doc.accounts);
    if (keys.length > MAX_ACCOUNTS) {
      const done = keys.filter((k) => k !== key && this.doc.accounts[k].spentUsd <= this.doc.accounts[k].reportedUsd);
      done.sort((x, y) => this.doc.accounts[x].updatedAt.localeCompare(this.doc.accounts[y].updatedAt));
      for (const old of done.slice(0, keys.length - MAX_ACCOUNTS)) delete this.doc.accounts[old];
    }
    this.save();
  }

  accountOf(runId: string | undefined): { key: string; owner: string; plan: string } | undefined {
    const key = runId ? this.doc.runs[runId] : undefined;
    const a = key ? this.doc.accounts[key] : undefined;
    return key && a ? { key, owner: a.owner, plan: a.plan } : undefined;
  }

  get(key: string): Account | undefined {
    const a = this.doc.accounts[key];
    return a ? { ...a } : undefined;
  }

  /** Adds a charge; true when it crossed a step since the last report. (Sums are rounded to 1e-6, so the step and
   * report comparisons below are on rounded values.) */
  charge(key: string, usd: number, stepUsd: number): boolean {
    const a = this.doc.accounts[key];
    if (!a || !(usd > 0)) return false;
    const before = Math.floor(a.spentUsd / stepUsd);
    a.spentUsd = Math.round((a.spentUsd + usd) * 1e6) / 1e6;
    a.updatedAt = new Date().toISOString();
    this.save();
    return Math.floor(a.spentUsd / stepUsd) > before;
  }

  /** The spend to report, once: undefined when nothing new was spent since the last report. */
  takeReport(key: string): number | undefined {
    const a = this.doc.accounts[key];
    if (!a || a.spentUsd <= a.reportedUsd) return undefined;
    a.reportedUsd = a.spentUsd;
    this.save();
    return a.spentUsd;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.doc), 'utf8');
    renameSync(tmp, this.file);
  }
}

const storeOf = (state: FactoryState): SpendAccountStore => (state.spendAccounts ??= new SpendAccountStore());
const stepOf = (state: FactoryState): number => (state.spendUpdateStepUsd && state.spendUpdateStepUsd > 0 ? state.spendUpdateStepUsd : DEFAULT_STEP_USD);

/**
 * The account a woken run is charged to: the waking run's own (inherited), else the waking agent's account for the plan
 * it names. A run charged to another agent's account may name only that account's plan (403 otherwise), so it can
 * neither move work off the plan nor open a second account for it. `error` (400) when what it named is not a plan.
 */
export function accountForWake(
  state: FactoryState,
  waker: Run,
  requested: unknown,
): { plan: string; owner: string } | { error: string; status: 400 | 403 } | undefined {
  const inherited = storeOf(state).accountOf(waker.parentRunId ?? waker.runId);
  if (requested === undefined || requested === null) return inherited;
  if (typeof requested !== 'string' || !PLAN_ACCOUNT.test(requested)) return { error: 'spendAccount must be plan:<owner>/<repo>#<pr>', status: 400 };
  if (inherited && inherited.owner !== waker.agentId) {
    if (requested === inherited.plan) return inherited;
    return { error: `this run is charged to ${inherited.plan}; only ${inherited.owner} may charge work to another plan`, status: 403 };
  }
  return { plan: requested, owner: waker.agentId };
}

export function bindRun(state: FactoryState, runId: string, account: { plan: string; owner: string }): void {
  storeOf(state).bind(runId, account.plan, account.owner);
}

/** A model call's cost, charged to the plan of the run that made it (a helper's is its parent's). */
export async function chargeAccount(state: FactoryState, run: Run | undefined, costUsd: number): Promise<void> {
  if (!run || !(costUsd > 0)) return;
  const acct = storeOf(state).accountOf(run.parentRunId ?? run.runId);
  if (!acct) return;
  if (storeOf(state).charge(acct.key, costUsd, stepOf(state))) await reportAccount(state, acct.key);
}

/**
 * A run store `onChange` that settles a charged run when it ends, however it ends (timeout, cancel, budget block,
 * reset, a result). Reports are fired, not awaited, so a run's state change never waits on a wake.
 */
export function settleOnEnd(state: FactoryState): (run: { runId: string; state: string }) => void {
  return (run) => {
    if (!isTerminal(run.state as Run['state'])) return;
    settleRun(state, run).catch((err) => console.error(`[spend-accounts] settling ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
}

/** A charged run ended: report what its plan has cost if that changed. */
export async function settleRun(state: FactoryState, run: { runId: string }): Promise<void> {
  const acct = storeOf(state).accountOf(run.runId);
  if (acct) await reportAccount(state, acct.key);
}

/** Wakes the account's owner with `budget-update`: into its live run's mailbox, or as a new run. */
async function reportAccount(state: FactoryState, key: string): Promise<void> {
  const store = storeOf(state);
  const a = store.get(key);
  const m = a?.plan.match(PLAN_ACCOUNT);
  if (!m || !a) return;
  const spent = store.takeReport(key);
  if (spent === undefined) return;
  const event = { type: 'budget-update', repo: m[1], pr: Number(m[2]), spent_usd: spent };
  const input = {
    event,
    message: `Plan ${m[1]}#${m[2]} has cost $${spent.toFixed(2)} so far. Handle the event: ${JSON.stringify(event)}.`,
  };
  let delivered: 'mailbox' | 'run' | 'not_delivered' = 'not_delivered';
  if (activeRun(state, a.owner)) {
    deliverToMailbox(state, a.owner, input);
    delivered = 'mailbox';
  } else {
    const out = await createRun(state, a.owner, { actor: SYSTEM.policy, trigger: 'spend', input });
    if (out.status < 300) delivered = 'run';
  }
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: a.owner,
    type: 'action',
    action: delivered === 'not_delivered' ? 'BUDGET_UPDATE_UNDELIVERED' : 'BUDGET_UPDATE_SENT',
    actor: SYSTEM.policy,
    requestId: a.plan,
    costUsd: spent,
  });
}
