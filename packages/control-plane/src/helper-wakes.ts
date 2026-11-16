/**
 * #481 (F1 of agentic-sdlc#101, no timers, no polling): when a helper run ends, the factory wakes its parent agent once
 * with trigger `helper-run-ended`. The input names the runs only, never the helper's result: the woken run reads that
 * itself (`GET /runs/:id/subagents/runs/:helperRunId`, agent-scoped), so a forged or replayed event can at most name a
 * run id. Only the factory sets this trigger; an agent's wake is always `agent`.
 *
 * Once per helper, across a restart: a helper is noted `pending` when it starts and claimed (`waking`) before its parent
 * is woken, both on disk. On start the factory finishes the pending ones that ended while it was down; a `waking` one is
 * woken only if no `helper-run-ended` run for it exists (and that is ledgered as `recovered`). The wake goes through
 * `createRun`, so the kill switch, budget and policy apply. A refusal an operator can clear (the agent paused or
 * isolated, or out of budget) stays owed and is tried again when the agent is resumed and at start, never on a timer;
 * any other refusal is final. One ledger row per attempt.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRun, isTerminal, type Run } from '@beercanlabs/factory-property-manager';
import type { FactoryState } from './app.js';

export const HELPER_RUN_ENDED = 'helper-run-ended';
type Entry = {
  parentAgentId: string;
  parentRunId: string;
  subagent: string;
  status: 'pending' | 'waking' | 'woken' | 'owed' | 'refused';
  wokenRunId?: string;
  refused?: string;
  at: number;
};
/** Refusals an operator clears (RESUME, a budget change): the wake stays owed. */
const OWED = new Set(['agent_paused', 'agent_isolated', 'budget_exceeded']);
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 5000;

/** The helper runs the factory owes (or owed) a wake, by helper run id. On disk when given a file, else in memory. */
export class HelperWakeLog {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
      for (const [id, e] of Object.entries(saved)) if (e && typeof e.parentAgentId === 'string' && typeof e.status === 'string') this.entries.set(id, e);
    } catch {
      /* none yet, or unreadable: start empty */
    }
  }

  get(helperRunId: string): Entry | undefined {
    const e = this.entries.get(helperRunId);
    return e ? { ...e } : undefined;
  }

  list(): Array<[string, Entry]> {
    return [...this.entries].map(([id, e]) => [id, { ...e }]);
  }

  /** Notes a started helper; an entry already there (it may have ended first) is kept. */
  note(helperRunId: string, e: Omit<Entry, 'status' | 'at'>): void {
    if (this.entries.has(helperRunId)) return;
    this.entries.set(helperRunId, { ...e, status: 'pending', at: Date.now() });
    this.save();
  }

  /** Claims the wake (synchronously, saved before the wake is attempted); false when it was claimed before. */
  claim(helperRunId: string, e: Omit<Entry, 'status' | 'at'>, recovering = false): boolean {
    const cur = this.entries.get(helperRunId);
    if (cur && cur.status !== 'pending' && cur.status !== 'owed' && !(recovering && cur.status === 'waking')) return false;
    this.entries.set(helperRunId, { ...e, status: 'waking', at: Date.now() });
    this.save();
    return true;
  }

  settle(helperRunId: string, outcome: { wokenRunId: string } | { refused: string }): void {
    const cur = this.entries.get(helperRunId);
    if (!cur) return;
    const status = 'wokenRunId' in outcome ? 'woken' : OWED.has(outcome.refused) ? 'owed' : 'refused';
    this.entries.set(helperRunId, { ...cur, ...outcome, status, at: Date.now() });
    this.save();
  }

  private save(): void {
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of this.entries) if ((v.status === 'woken' || v.status === 'refused') && v.at < cutoff) this.entries.delete(k);
    for (const [k, v] of this.entries) {
      if (this.entries.size <= KEEP_MAX) break;
      if (v.status === 'woken' || v.status === 'refused') this.entries.delete(k);
    }
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
    renameSync(tmp, this.file);
  }
}

const logs = new WeakMap<FactoryState, HelperWakeLog>();
export function helperWakesOf(state: FactoryState): HelperWakeLog {
  if (state.helperWakes) return state.helperWakes;
  let log = logs.get(state);
  if (!log) logs.set(state, (log = new HelperWakeLog()));
  return log;
}

const subagentOf = (run: Run): string => {
  const s = (run.input as { subagent?: unknown } | undefined)?.subagent;
  return typeof s === 'string' ? s : '';
};

/** Called by spawn once the helper run exists. */
export function noteHelperRun(state: FactoryState, helper: Run): void {
  if (!helper.parentRunId || !helper.parentAgentId) return;
  helperWakesOf(state).note(helper.runId, { parentAgentId: helper.parentAgentId, parentRunId: helper.parentRunId, subagent: subagentOf(helper) });
}

const woken = (state: FactoryState, parentAgentId: string, helperRunId: string): Run | undefined =>
  state.runs.list({ agentId: parentAgentId }).find((r) => r.trigger === HELPER_RUN_ENDED && (r.input as { event?: { helperRunId?: unknown } } | undefined)?.event?.helperRunId === helperRunId);

/** Wakes the parent of a helper run that has ended, at most once per helper. */
export async function wakeParentOfHelper(state: FactoryState, helper: Run, recovering = false): Promise<void> {
  const { parentAgentId, parentRunId } = helper;
  if (!parentAgentId || !parentRunId || !isTerminal(helper.state)) return;
  const log = helperWakesOf(state);
  const subagent = subagentOf(helper) || log.get(helper.runId)?.subagent || '';
  if (!log.claim(helper.runId, { parentAgentId, parentRunId, subagent }, recovering)) return;
  const audit = (outcome: string, runId?: string) =>
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: parentAgentId,
      type: 'action',
      action: 'HELPER_RUN_ENDED_WAKE',
      actor: 'factory:helper-run-ended',
      parentAgentId,
      parentRunId,
      ...(runId ? { runId } : {}),
      mcpName: `helper-run-ended:${helper.runId}:${helper.state}:${outcome}`,
    });
  // A restart between the claim and the run: the run may already exist (its row may not).
  const prior = recovering ? woken(state, parentAgentId, helper.runId) : undefined;
  if (prior) {
    log.settle(helper.runId, { wokenRunId: prior.runId });
    audit('recovered', prior.runId);
    return;
  }
  const parent = state.agents.get(parentAgentId);
  let refused: string | undefined;
  let runId: string | undefined;
  if (!parent) refused = 'parent_agent_not_found';
  else if (parent.ephemeral) refused = 'helpers_start_no_helpers';
  else {
    try {
      const out = await createRun(state, parentAgentId, {
        actor: 'factory:helper-run-ended',
        trigger: HELPER_RUN_ENDED,
        input: { event: { type: HELPER_RUN_ENDED, parentRunId, helperRunId: helper.runId, subagent, state: helper.state } },
      });
      if (out.status < 300) runId = (out.body as Run).runId;
      else refused = String((out.body as { error?: unknown } | undefined)?.error ?? `status_${out.status}`);
    } catch (err) {
      refused = err instanceof Error ? err.name || 'error' : 'error';
    }
  }
  if (runId) {
    log.settle(helper.runId, { wokenRunId: runId });
    audit('woken', runId);
  } else {
    // Never on a loop: an owed wake waits for the agent's RESUME or the next start; any other refusal is final.
    const why = refused ?? 'refused';
    log.settle(helper.runId, { refused: why });
    audit(`${OWED.has(why) ? 'deferred' : 'refused'}:${why}`);
  }
}

/** The agent was resumed (kill switch): the wakes it was refused while paused, isolated or out of budget. */
export async function retryOwedWakes(state: FactoryState, agentId: string): Promise<void> {
  for (const [helperRunId, e] of helperWakesOf(state).list()) {
    if (e.status !== 'owed' || e.parentAgentId !== agentId) continue;
    const run = state.runs.get(helperRunId);
    if (run && isTerminal(run.state)) await wakeParentOfHelper(state, run);
  }
}

/** On start: wake for the helpers that ended while no control plane was there to see it (once each). */
export async function resumeHelperWakes(state: FactoryState): Promise<void> {
  for (const [helperRunId, e] of helperWakesOf(state).list()) {
    if (e.status !== 'pending' && e.status !== 'waking' && e.status !== 'owed') continue;
    const run = state.runs.get(helperRunId);
    if (run && isTerminal(run.state)) await wakeParentOfHelper(state, run, true);
  }
}

/** Wires the wake to the end of every run (helpers only act) and finishes what a previous process left. */
const wired = new WeakSet<FactoryState>();
export function wireHelperWakes(state: FactoryState): void {
  if (wired.has(state)) return;
  wired.add(state);
  const prior = state.onRunEnded;
  state.onRunEnded = (run) => {
    prior?.(run);
    if (run.parentRunId) void wakeParentOfHelper(state, run).catch((err) => console.warn('[control-plane] helper-run-ended wake failed:', err));
  };
  const resumed = state.onAgentResumed;
  state.onAgentResumed = (agentId) => {
    resumed?.(agentId);
    void retryOwedWakes(state, agentId).catch((err) => console.warn('[control-plane] owed helper wakes failed:', err));
  };
  void resumeHelperWakes(state).catch((err) => console.warn('[control-plane] could not resume helper wakes:', err));
}
