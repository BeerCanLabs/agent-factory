/**
 * The Property Manager's run lifecycle (DESIGN_AUTHORITY.md §6.15, L1 to L6): waking an agent (`createRun`), starting a queued
 * run, finishing it, parking and unparking it, the idle timeout, the turn mailbox, the kill switch, health checks and
 * the reconcile of runs whose tasks outlive the process. Moved out of the control plane's `app.ts` (TSK-183, GAP-132).
 *
 * `PropertyManagerState` is the part of the control plane's `FactoryState` this code reads and writes, so the package does not
 * import the control plane; `FactoryState` is assignable to it. The HTTP handlers that call these functions stay in
 * `control-plane`, where the Bouncer's privileges and the Gatekeeper's run-token rule meet a request.
 */
import { gatekeeperEgressEnv, notebookEnv } from '@beercanlabs/factory-hydrate';
import { checkStanding, type BudgetLimits, type SpendTracker } from '@beercanlabs/factory-budget';
import type { AuthenticatedCaller } from '@beercanlabs/factory-bouncer';
import type { FactoryMetrics } from '@beercanlabs/factory-inspector';
import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { BUILTIN_AGENT_IDS, registryOf, type AgentRecord } from '@beercanlabs/factory-registrar';
import { checkCallbackUrl, deliverCallback, type CallbackPolicy } from './callbacks.js';
import { isTerminal, type Run, type RunState, type RunStore, type RunTokens } from './runs.js';
import type { Runtime } from './runtime.js';

export type Outcome<T> = { status: number; body: T | { error: string; [k: string]: unknown } };


/** What the lifecycle reads from the policy store: the budget it enforces and the routes it hands the run. */
export type PropertyManagerPolicies = {
  get(agentId: string): { budgetUsd?: BudgetLimits; routes?: string[]; models?: string[] };
  has(agentId: string): boolean;
  /** E1.4 (#295): drops a helper run's in-memory policy when the run ends. */
  forgetEphemeral?(agentId: string): void;
};

/** The part of the control plane's `FactoryState` the run lifecycle uses. `FactoryState` is assignable to it. */
export type PropertyManagerState = {
  agents: Map<string, AgentRecord>;
  registryDir?: string;
  ledger: LedgerStore;
  runtime: Runtime;
  runs: RunStore;
  runTokens: RunTokens;
  callbacks: CallbackPolicy;
  policies: PropertyManagerPolicies;
  spend: SpendTracker;
  providers: SecretProvider[];
  secretValues: Set<string>;
  secretCache?: Map<string, { value: string; at: number }>;
  /** Provider keys only the gatekeeper-egress holds (S1); pre-flight treats them as satisfied and never reads them. */
  gatekeeperEgressHeldSecrets?: Set<string>;
  publicUrl?: string;
  gatekeeperEgressUrl?: string;
  gatekeeperIngressUrl?: string;
  gatekeeperIngressToken?: string;
  /** Max wall-clock per run before it is stopped as TIMED_OUT. 0 disables. */
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  heartbeatTimeoutMs?: number;
  maxRssMb?: number;
  crashLoopThreshold?: number;
  metrics?: FactoryMetrics;
  /** In-memory mailboxes for running tasks to receive follow-up messages while warm. */
  mailboxes?: Map<string, MailboxQueue>;
  /** The model a policy that names none grants (M2): configuration, no code default (GAP-181). */
  defaultModel?: string;
  /**
   * When this process began judging heartbeats (GAP-176). A heartbeat sent while no control plane could receive it
   * (a deploy stops one before starting the next) is not lost: each run gets a full timeout from this moment.
   */
  healthSince?: number;
  /** Activation smoke budget caps and tracking (§6.12, TSK-281). */
  smokeBudgetUsd?: { perRun?: number; perActivation?: number };
  smokeRunSpend?: Map<string, number>;
  smokeActivationSpend?: Map<string, number>;
  smokeHandler?: (opts: {
    run: Run;
    agent: AgentRecord;
    smokeType: 'hello-world' | 'skill';
    skillId?: string;
    skillVersion?: string;
    smokeSpec?: { action: string; input: Record<string, unknown>; dryRun?: boolean };
    routes?: string[];
  }) => Promise<{ ok: boolean; error?: string; result?: unknown; egressRoutes?: string[]; omitEgress?: boolean; costUsd?: number }>;
  configs?: { current(agentId: string): { agent?: { memory?: { archetype?: string } } } | undefined };
};

export type MailboxMessage = {
  id: string;
  timestamp: string;
  payload: unknown;
};

export type MailboxQueue = {
  messages: MailboxMessage[];
  waiters: Array<(msg: MailboxMessage) => void>;
};

export function deliverToMailbox(state: PropertyManagerState, agentId: string, payload: unknown) {
  if (!state.mailboxes) state.mailboxes = new Map();
  let queue = state.mailboxes.get(agentId);
  if (!queue) {
    queue = { messages: [], waiters: [] };
    state.mailboxes.set(agentId, queue);
  }
  const msg: MailboxMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    payload,
  };
  const waiter = queue.waiters.shift();
  if (waiter) {
    waiter(msg);
  } else {
    queue.messages.push(msg);
  }
  const run = activeRun(state, agentId);
  if (run) {
    scheduleTimeout(state, run);
  }
}

/** Actors for actions the factory takes on its own (not on behalf of a caller). */
export const SYSTEM = {
  idle: 'factory:run-timeout',
  scheduler: 'factory:scheduler',
  runtime: 'factory:runtime',
  router: 'factory:event-router',
  reconciler: 'factory:reconciler',
  health: 'factory:health',
  policy: 'factory:policy',
  smoke: 'factory:smoke',
} as const;

async function notifyGatekeeperIngress(state: PropertyManagerState, agentId: string, presence: 'offline' | 'starting' | 'available', trigger?: string) {
  if (trigger === 'smoke') return;
  if (!state.gatekeeperIngressUrl) return;
  try {
    const res = await fetch(`${state.gatekeeperIngressUrl.replace(/\/$/, '')}/api/v1/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.gatekeeperIngressToken ? { Authorization: `Bearer ${state.gatekeeperIngressToken}` } : {}),
      },
      body: JSON.stringify({ agentId, presence }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`[control-plane] gatekeeper-ingress presence ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-plane] gatekeeper-ingress unreachable: ${message}`);
  }
}

function record(state: PropertyManagerState, run: Pick<Run, 'agentId' | 'runId'>, action: string, actor: string) {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: run.agentId,
    runId: run.runId,
    type: 'action',
    action,
    actor,
  });
}

export function activeRun(state: PropertyManagerState, agentId: string): Run | undefined {
  return state.runs.list({ agentId, active: true }).find((r) => r.state !== 'QUEUED');
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

async function bindAgentSecrets(state: PropertyManagerState, names: string[]): Promise<{ ok: true; env: Record<string, string> } | { ok: false; missing: string[] }> {
  const cache = (state.secretCache ??= new Map());
  const now = Date.now();
  const env: Record<string, string> = {};
  const uncached: string[] = [];
  for (const name of names.filter((n) => !state.gatekeeperEgressHeldSecrets?.has(n))) {
    const hit = cache.get(name);
    if (hit && now - hit.at < SECRET_CACHE_TTL_MS) env[name] = hit.value;
    else uncached.push(name);
  }
  if (uncached.length) {
    const bound = await bindSecrets(uncached, state.providers);
    if (!bound.ok) return bound;
    for (const [name, value] of Object.entries(bound.env)) {
      cache.set(name, { value, at: now });
      env[name] = value;
    }
  }
  for (const value of Object.values(env)) if (value.length >= 4) state.secretValues.add(value);
  return { ok: true, env };
}

export function scheduleTimeout(state: PropertyManagerState, run: Run) {
  if (run.trigger === 'smoke') return;
  if (!state.idleTimers) return;
  const prev = state.idleTimers.get(run.agentId);
  if (prev) clearTimeout(prev);
  const agent = state.agents.get(run.agentId);
  const declaredWarmDownMs = (agent?.warmDownSeconds && agent.warmDownSeconds > 0)
    ? agent.warmDownSeconds * 1000
    : undefined;
  let timeoutMs: number;
  if (declaredWarmDownMs !== undefined) {
    const graceMs = Math.min(15_000, Math.floor(declaredWarmDownMs * 0.1));
    const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    if (state.idleMs > 0 && state.idleMs < declaredWarmDownMs) {
      // Operator wall-clock cap strictly overrides a longer agent warm-down window
      const capMs = Math.max(0, state.idleMs - (Date.now() - started));
      timeoutMs = Math.min(declaredWarmDownMs, capMs);
    } else if (state.idleMs > declaredWarmDownMs) {
      // Wall-clock cap allows the idle window plus grace, but bounds total run duration
      const capMs = Math.max(0, (state.idleMs + graceMs) - (Date.now() - started));
      timeoutMs = Math.max(0, Math.min(declaredWarmDownMs + graceMs, capMs));
    } else {
      // Default idleMs matches or is unset: grant full warm-down window plus grace
      timeoutMs = declaredWarmDownMs + graceMs;
    }
  } else {
    const idleWindowMs = state.idleMs > 0 ? state.idleMs : 3_600_000;
    const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    const capMs = state.idleMs > 0 ? state.idleMs - (Date.now() - started) : Infinity;
    timeoutMs = Math.max(0, Math.min(idleWindowMs, capMs));
  }
  const t = setTimeout(() => {
    const cur = state.runs.get(run.runId);
    if (cur && !isTerminal(cur.state)) void finishRun(state, run.runId, 'TIMED_OUT', { actor: SYSTEM.idle });
  }, timeoutMs);
  t.unref?.();
  state.idleTimers.set(run.agentId, t);
}

/** Park a live run. The task keeps running; the gatekeeper-egress refuses its egress until unblocked. */
export function blockRun(state: PropertyManagerState, runId: string, to: 'BLOCKED_BUDGET_EXCEEDED' | 'BLOCKED_FOR_HUMAN' | 'BLOCKED_UNHEALTHY', actor: string) {
  const run = state.runs.get(runId);
  if (!run || isTerminal(run.state) || run.state === to) return run;
  const timer = state.idleTimers.get(run.agentId);
  if (timer) clearTimeout(timer);
  const next = state.runs.update(runId, { state: to });
  record(state, next, to, actor);
  return next;
}

export function unblockRun(state: PropertyManagerState, runId: string, from: RunState, actor: string) {
  const run = state.runs.get(runId);
  if (!run || run.state !== from) return run;
  const next = state.runs.update(runId, { state: 'WORKING' });
  record(state, next, 'RUN_UNBLOCKED', actor);
  scheduleTimeout(state, next);
  return next;
}

export type CreateRunOptions = {
  actor: string;
  trigger: string;
  input?: unknown;
  callbackUrl?: string;
  model?: string;
  requestedBy?: { provider: string; id: string };
  caller?: AuthenticatedCaller;
  /** What the factory itself says this input is (`conversation-request`, `approval`, `smoke`); the only way it gets onto an input. */
  factoryKind?: 'conversation-request' | 'approval' | 'smoke';
  /** The caller has already set `turnId` and `replyTo` itself (a conversation turn). Otherwise a sender's are removed: they are the factory's. */
  factoryTurn?: boolean;
  /**
   * E1.5 (#296): the live run that is starting this one as a helper. Server code only (E1.4); never copied from a request
   * body. The parent agent is read from that run's record, so a caller cannot name it.
   */
  parentRunId?: string;
};

/** The single entry point for waking an agent: manual, webhook, cron, event route, gatekeeper-ingress. */
export async function createRun(state: PropertyManagerState, agentId: string, opts: CreateRunOptions): Promise<Outcome<Run>> {
  const agent = state.agents.get(agentId);
  if (!agent) return { status: 404, body: { error: 'not_found' } };
  if (agent.state === 'PAUSED' || agent.state === 'ISOLATED') {
    return { status: 409, body: { error: `agent_${agent.state.toLowerCase()}` } };
  }
  if (opts.callbackUrl) {
    const bad = checkCallbackUrl(opts.callbackUrl, state.callbacks);
    if (bad) return { status: 400, body: { error: bad } };
  }

  const isSmoke = opts.trigger === 'smoke';
  let parent: { parentRunId: string; parentAgentId: string } | undefined;
  if (opts.parentRunId !== undefined) {
    const p = state.runs.get(opts.parentRunId);
    if (!p) return { status: 400, body: { error: 'parent_run_not_found' } };
    parent = { parentRunId: p.runId, parentAgentId: p.agentId };
  }

  // Sanitize input: never mutate caller's object, and never allow a forged caller
  let sanitizedInput: unknown = opts.input;
  if (opts.input && typeof opts.input === 'object' && !Array.isArray(opts.input)) {
    const copy = { ...(opts.input as Record<string, unknown>) };
    delete copy.caller;
    // `factoryKind` is the factory's alone: whatever a sender wrote there is removed, so an agent can trust it (RT1).
    delete copy.factoryKind;
    // `turnId` and `replyTo` choose where an agent answers; a webhook, queue message or operator body must not set them.
    if (!opts.factoryTurn) {
      delete copy.turnId;
      delete copy.replyTo;
    }
    if (isSmoke) {
      copy.factoryKind = 'smoke';
    } else if (opts.factoryKind) {
      copy.factoryKind = opts.factoryKind;
    }
    if (opts.caller && !isSmoke) {
      copy.caller = { ...opts.caller };
    }
    sanitizedInput = copy;
  } else if (opts.caller && opts.input === undefined && !isSmoke) {
    sanitizedInput = { caller: { ...opts.caller } };
  } else if (isSmoke && (opts.input === undefined || typeof opts.input !== 'object')) {
    sanitizedInput = { factoryKind: 'smoke' };
  }

  // Deduplicate incoming runs with identical messageId
  if (sanitizedInput && typeof sanitizedInput === 'object') {
    const msgId = (sanitizedInput as Record<string, any>).messageId;
    if (msgId) {
      const existing = state.runs.list({ agentId }).find((r) => {
        const rInput = r.input as Record<string, any> | undefined;
        return rInput && rInput.messageId === msgId;
      });
      if (existing) {
        return { status: 200, body: existing };
      }
    }
  }

  // No run exists yet, so perRun does not apply. Built-ins and smoke runs stay exempt from agent budget.
  const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
  if (!isBuiltin && !isSmoke) {
    const budget = state.policies.get(agentId).budgetUsd;
    const standing = checkStanding({
      limits: budget ? { perDay: budget.perDay, perMonth: budget.perMonth } : undefined,
      spend: state.spend.get(agentId, undefined),
    });
    if (!standing.inGoodStanding) {
      // A queue message is left for SQS to redeliver, so a refusal row on every visibility timeout would flood the ledger.
      if (opts.trigger !== 'queue') {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'WAKE_REFUSED_BUDGET_EXCEEDED',
          actor: SYSTEM.policy,
        });
      }
      return { status: 402, body: { error: 'budget_exceeded', window: standing.window } };
    }
  }

  // S1 backstop, every runtime: pre-flight required secrets (412) and learn their values so they are redacted
  // from results and ledger rows. Cloud runtimes ignore the values; their platform injects its own.
  const bound = await bindAgentSecrets(state, agent.ungated ?? agent.requires);
  if (!bound.ok) {
    const run = state.runs.create({
      agentId,
      state: 'PRE_FLIGHT_MISSING_SECRET',
      actor: opts.actor,
      trigger: opts.trigger,
      callbackUrl: opts.callbackUrl,
      ...(opts.requestedBy && !isSmoke ? { requestedBy: opts.requestedBy } : {}),
      ...(opts.caller && !isSmoke ? { caller: opts.caller } : {}),
      missing: bound.missing,
      ...parent,
    });
    record(state, run, 'PRE_FLIGHT_MISSING_SECRET', opts.actor);
    void fireCallback(state, run);
    return { status: 412, body: { error: 'unbound_secrets', missing: bound.missing, runId: run.runId } };
  }

  const busy = activeRun(state, agentId);
  const run = state.runs.create({
    agentId,
    state: 'QUEUED',
    actor: opts.actor,
    trigger: opts.trigger,
    input: sanitizedInput,
    callbackUrl: opts.callbackUrl,
    ...(opts.requestedBy && !isSmoke ? { requestedBy: opts.requestedBy } : {}),
    ...(opts.caller && !isSmoke ? { caller: opts.caller } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...parent,
  });
  record(state, run, 'RUN_QUEUED', opts.actor);
  if (busy) {
    const queue = state.mailboxes?.get(agentId);
    if (queue && queue.waiters.length > 0 && queue.messages.length === 0) {
      while (queue.waiters.length > 0) {
        const w = queue.waiters.shift();
        w?.({ id: 'done', timestamp: new Date().toISOString(), payload: null });
      }
    }
    return { status: 202, body: run };
  }
  return { status: 202, body: await startRun(state, run, bound.env) };
}

/** Runs whose runtime.start is in flight in this process. The reconciler must not call them lost: a start can wait
 * about 90s for a new agent's task role, and only a run with no start in flight (a restart) is truly lost. */
const startsInFlight = new Set<string>();

async function startRun(state: PropertyManagerState, run: Run, secrets?: Record<string, string>): Promise<Run> {
  const agent = state.agents.get(run.agentId)!;
  let env = secrets;
  if (!env) {
    const bound = await bindAgentSecrets(state, agent.ungated ?? agent.requires);
    if (!bound.ok) {
      const failed = state.runs.update(run.runId, { state: 'PRE_FLIGHT_MISSING_SECRET', missing: bound.missing });
      record(state, failed, 'PRE_FLIGHT_MISSING_SECRET', SYSTEM.runtime);
      void fireCallback(state, failed);
      return failed;
    }
    env = bound.env;
  }
  for (const value of Object.values(env)) if (value.length >= 4) state.secretValues.add(value);

  // E7 deny-by-default: starting a run never changes the agent's policy; only admin actions do.

  let cur = state.runs.update(run.runId, { state: 'STARTING' });
  // P1: a started task is not a ready agent. Presence shows starting now and available only on markRunReady.
  // In flight from here: the notification and the token mint can take seconds, and the reconciler must not reap the run.
  startsInFlight.add(run.runId);
  let runToken: string;
  let runEnv: Record<string, string>;
  try {
    await notifyGatekeeperIngress(state, agent.id, 'starting', run.trigger);
    runToken = state.runTokens?.mint ? await state.runTokens.mint(run) : '';
    // M2: a run is pinned only if a caller requested it (run.model). If unpinned, inject policy's primary model
    // (or factory default) as FACTORY_MODEL into the container environment without mutating run.model, so Gatekeeper
    // Egress leaves pinnedModel unset and honors multi-model policy allowlists.
    const effectiveModel =
      run.model ||
      // A policy that lists models gets its first; an explicit empty list grants none, so nothing is injected (M2).
      (state.policies.has(agent.id) && state.policies.get(agent.id).models
        ? state.policies.get(agent.id).models?.[0]
        : state.defaultModel);
    const archetype = state.configs?.current(agent.id)?.agent?.memory?.archetype;
    runEnv = {
      FACTORY_RUN_ID: run.runId,
      FACTORY_RUN_TOKEN: runToken,
      ...(state.publicUrl ? { FACTORY_URL: state.publicUrl } : {}),
      ...(effectiveModel ? { FACTORY_MODEL: effectiveModel } : {}),
      ...(archetype ? { FACTORY_MEMORY_ARCHETYPE: archetype } : {}),
      // AM3: the factory-wide notebook rotation policy and where closed volumes go.
      ...notebookEnv(),
      ...(state.gatekeeperEgressUrl ? { FACTORY_GATEKEEPER_EGRESS_URL: state.gatekeeperEgressUrl } : {}),
      ...gatekeeperEgressEnv({
        FACTORY_GATEKEEPER_EGRESS_URL: state.gatekeeperEgressUrl,
        FACTORY_RUN_TOKEN: runToken,
        FACTORY_EGRESS_ROUTES: (state.policies.has(agent.id) ? state.policies.get(agent.id).routes ?? [] : []).join(','),
      }),
    };
  } catch (e) {
    // Nothing is starting yet (the env build can throw too), so the reconciler may judge the run again.
    startsInFlight.delete(run.runId);
    throw e;
  }
  try {
    // A start can wait (a new agent's task role propagating), so a reset, cancel, pause or isolate that lands meanwhile
    // must win: the runtime stops retrying and a task that still came up is stopped, never recorded as WORKING.
    const abandoned = () => {
      const now = state.runs.get(run.runId);
      return !now || now.state !== 'STARTING' || agent.state === 'PAUSED' || agent.state === 'ISOLATED';
    };
    const { handle } = await state.runtime.start(agent, env, { runId: run.runId, runEnv, abandoned });
    if (abandoned()) {
      await state.runtime.stop(agent, handle).catch((e) => console.warn(`could not stop the abandoned task of run ${run.runId}: ${e instanceof Error ? e.message : e}`));
      const now = state.runs.get(run.runId);
      if (now && !isTerminal(now.state)) {
        return finishRun(state, run.runId, 'CANCELLED', {
          actor: SYSTEM.runtime,
          error: 'start abandoned: the agent was paused or isolated while the run was starting',
        });
      }
      return now ?? run;
    }
    cur = state.runs.update(run.runId, { state: 'WORKING', taskHandle: handle, startedAt: new Date().toISOString() });
  } catch (err) {
    // The run token is never recorded: a CLI failure message can carry the whole command line.
    const message = (err instanceof Error ? err.message : String(err)).split(runToken).join('[redacted]');
    const now = state.runs.get(run.runId);
    if (now && !isTerminal(now.state) && message.startsWith('RunTask abandoned')) {
      return finishRun(state, run.runId, 'CANCELLED', { actor: SYSTEM.runtime, error: message });
    }
    return finishRun(state, run.runId, 'FAILED', { actor: SYSTEM.runtime, error: `start failed: ${message}` });
  } finally {
    // After the abandon handling too, so the reconciler cannot reap the run while its task is being stopped.
    startsInFlight.delete(run.runId);
  }
  if (run.trigger !== 'smoke') {
    agent.state = 'WORKING';
    scheduleTimeout(state, cur);
  }
  record(state, cur, 'RUN_STARTED', run.actor);
  return cur;
}

/**
 * P1 readiness: the run's first input fetch, heartbeat or mailbox poll is the earliest signal from inside the
 * container that the agent process is running and can take a turn (a conversational worker fetches input on boot
 * or polls its mailbox for follow-ups; the shim heartbeats after spawning). Only then does presence go available.
 */
export async function markRunReady(state: PropertyManagerState, runId: string) {
  // Synchronous up to the notification, so the run is marked ready before the caller answers; the notification
  // itself never delays the run's heartbeat or mailbox reply.
  const run = state.runs.get(runId);
  if (!run || run.readyAt || run.state !== 'WORKING') return;
  const ready = state.runs.update(runId, { readyAt: new Date().toISOString() });
  record(state, ready, 'RUN_READY', `run:${run.agentId}`);
  await notifyGatekeeperIngress(state, run.agentId, 'available', run.trigger);
}

export async function finishRun(
  state: PropertyManagerState,
  runId: string,
  terminal: Extract<RunState, 'DONE' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED'>,
  extra: { actor: string; exitCode?: number | null; result?: unknown; error?: string },
): Promise<Run> {
  const cur = state.runs.get(runId);
  if (!cur) throw new Error(`unknown run ${runId}`);
  if (isTerminal(cur.state)) {
    if (cur.state === 'TIMED_OUT' && (terminal === 'DONE' || terminal === 'FAILED')) {
      const done = state.runs.update(runId, {
        state: terminal,
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra.result !== undefined ? { result: extra.result } : {}),
        ...(extra.error !== undefined ? { error: extra.error } : {}),
      });
      record(state, done, `RUN_${terminal}`, extra.actor);
      const agent = state.agents.get(cur.agentId);
      if (terminal === 'FAILED' && agent && !activeRun(state, cur.agentId)) {
        if (agent.state !== 'PAUSED' && agent.state !== 'ISOLATED') {
          agent.state = 'ERROR';
          registryOf(state).update(agent);
        }
      }
      void fireCallback(state, done);
      return done;
    }
    return cur;
  }
  const agent = state.agents.get(cur.agentId);

  const done = state.runs.update(runId, {
    state: terminal,
    ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  });
  record(state, done, `RUN_${terminal}`, extra.actor);
  state.metrics?.runs.add(1, { agent: done.agentId, state: terminal, trigger: done.trigger });
  if (done.startedAt) {
    state.metrics?.runSeconds.record((Date.parse(done.updatedAt) - Date.parse(done.startedAt)) / 1000, { agent: done.agentId, state: terminal });
  }

  if (state.idleTimers) {
    const timer = state.idleTimers.get(done.agentId);
    if (timer) clearTimeout(timer);
    state.idleTimers.delete(done.agentId);
  }

  const queue = state.mailboxes?.get(done.agentId);
  if (queue) {
    while (queue.waiters.length > 0) {
      const w = queue.waiters.shift();
      w?.({ id: 'done', timestamp: new Date().toISOString(), payload: null });
    }
    queue.messages.length = 0;
  }

  if (agent) {
    if (state.runtime.running(agent.id) || done.taskHandle) {
      try {
        await state.runtime.stop(agent, done.taskHandle);
      } catch (err) {
        console.error(`[control-plane] stop ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cur.trigger !== 'smoke') {
      if (agent.state === 'WORKING') {
        agent.state = (terminal === 'DONE' || terminal === 'TIMED_OUT') ? 'SLEEPING' : 'ERROR';
        registryOf(state).update(agent);
      }
      if (agent.pendingDrain && agent.stagedCommit) {
        console.log(`[property-manager] Applying pending drained update for ${agent.id} at ${agent.stagedCommit}...`);
        agent.commit = agent.stagedCommit;
        agent.deployedCommit = agent.stagedCommit;
        if (agent.stagedVersion) agent.installedVersion = agent.stagedVersion;
        if (agent.stagedVersion && agent.offeredVersion === agent.stagedVersion) {
          agent.updateAvailable = false;
        }
        delete agent.pendingDrain;
        delete agent.stagedCommit;
        delete agent.stagedVersion;
      }
      await notifyGatekeeperIngress(state, agent.id, 'offline', cur.trigger);
    }
  }
  // E1.4 (#295): a helper run is torn down when it ends: its in-memory agent record and policy go with it.
  if (agent?.ephemeral) {
    state.agents.delete(agent.id);
    state.policies.forgetEphemeral?.(agent.id);
  }
  if (cur.trigger !== 'smoke') {
    if (terminal === 'FAILED' && done.agentId !== 'med-doc' && state.agents.has('med-doc')) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: done.agentId, runId, type: 'crash', actor: SYSTEM.runtime });
      await createRun(state, 'med-doc', { actor: SYSTEM.router, trigger: 'event:crash', input: { agentId: done.agentId, runId } });
    }

    void fireCallback(state, done);
    if (terminal === 'FAILED') await breakCrashLoop(state, done.agentId);
  } else {
    void fireCallback(state, done);
  }

  const next = state.runs.list({ agentId: done.agentId, active: true }).find((r) => r.state === 'QUEUED');
  if (next && agent && agent.state !== 'PAUSED' && agent.state !== 'ISOLATED') await startRun(state, next);
  return done;
}

async function fireCallback(state: PropertyManagerState, run: Run) {
  if (!run.callbackUrl) return;
  const outcome = await deliverCallback(
    run.callbackUrl,
    {
      runId: run.runId,
      agentId: run.agentId,
      state: run.state,
      result: run.result,
      error: run.error,
      missing: run.missing,
      exitCode: run.exitCode,
      finishedAt: run.updatedAt,
    },
    state.callbacks,
  );
  record(state, run, outcome.ok ? 'RUN_CALLBACK_DELIVERED' : 'RUN_CALLBACK_FAILED', 'factory:callbacks');
  if (!outcome.ok) console.error(`[control-plane] callback for ${run.runId}: ${outcome.error ?? outcome.status}`);
}

/**
 * Recovery for an agent that is stuck: ends every run it still has (a stopped container, a result that never arrived,
 * a run left blocked), stops the task, tells the ingress it is offline, and puts the agent back to SLEEPING. It does
 * not touch the budget, the policy or the agent's memory, and the next wake is still checked like any other. A paused,
 * isolated, deploying or retired agent is refused: those have their own controls.
 */
export async function resetAgent(state: PropertyManagerState, id: string, actor: string): Promise<Outcome<AgentRecord>> {
  const agent = state.agents.get(id);
  if (!agent) return { status: 404, body: { error: 'not_found' } };
  if (agent.state !== 'WORKING' && agent.state !== 'SLEEPING' && agent.state !== 'ERROR') {
    return { status: 409, body: { error: `agent_${String(agent.state).toLowerCase()}` } as any };
  }
  for (const run of state.runs.list({ agentId: id, active: true })) {
    await finishRun(state, run.runId, 'CANCELLED', { actor, error: `reset by ${actor}` });
  }
  agent.state = 'SLEEPING';
  await notifyGatekeeperIngress(state, id, 'offline');
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'AGENT_RESET', actor });
  registryOf(state).update(agent);
  return { status: 200, body: agent };
}

export async function applyKillSwitch(
  state: PropertyManagerState,
  id: string,
  command: 'PAUSE' | 'ISOLATE' | 'RESUME',
  actor: string,
): Promise<Outcome<AgentRecord>> {
  const agent = state.agents.get(id);
  if (!agent) return { status: 404, body: { error: 'not_found' } };
  const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
  if (isBuiltin && (command === 'PAUSE' || command === 'ISOLATE')) {
    return {
      status: 400,
      body: {
        error: 'builtin_agents_exempt_from_killswitch',
        message: 'Built-in system agents are critical infrastructure and cannot be paused or isolated.',
      } as any,
    };
  }
  if (command === 'PAUSE') agent.state = 'PAUSED';
  else if (command === 'ISOLATE') agent.state = 'ISOLATED';
  else agent.state = activeRun(state, id) ? 'WORKING' : 'SLEEPING';
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: command, actor });
  registryOf(state).update(agent);
  if (command === 'RESUME' && !activeRun(state, id)) {
    const next = state.runs.list({ agentId: id, active: true }).find((r) => r.state === 'QUEUED');
    if (next) await startRun(state, next);
  }
  return { status: 200, body: agent };
}

/** Pause an agent whose recent runs keep failing, so the queue stops feeding it. */
async function breakCrashLoop(state: PropertyManagerState, agentId: string) {
  const threshold = state.crashLoopThreshold ?? 0;
  const agent = state.agents.get(agentId);
  const isBuiltin = Boolean(agent?.isBuiltin || agent?.category === 'builtin' || BUILTIN_AGENT_IDS.has(agentId));
  if (isBuiltin || threshold <= 0 || !agent || agent.state === 'PAUSED' || agent.state === 'ISOLATED') return;
  const since = Date.now() - 10 * 60_000;
  const recent = state.runs
    .list({ agentId })
    .filter((r) => isTerminal(r.state) && Date.parse(r.updatedAt) >= since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let streak = 0;
  for (const r of recent) {
    if (r.state !== 'FAILED') break;
    streak++;
  }
  if (streak < threshold) return;
  await applyKillSwitch(state, agentId, 'PAUSE', SYSTEM.health);
  state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CRASH_LOOP_PAUSED', actor: SYSTEM.health });
  state.metrics?.health.add(1, { agent: agentId, kind: 'crash_loop' });
}

/** Halt compute for a run that went silent or over its memory ceiling; park it for a human. */
export async function haltUnhealthy(state: PropertyManagerState, runId: string, reason: string) {
  const run = state.runs.get(runId);
  if (!run || isTerminal(run.state) || run.state === 'BLOCKED_UNHEALTHY') return;
  const agent = state.agents.get(run.agentId);
  if (agent) {
    try {
      await state.runtime.stop(agent, run.taskHandle);
    } catch (err) {
      console.error(`[control-plane] halt ${run.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    agent.state = 'ERROR';
  }
  blockRun(state, runId, 'BLOCKED_UNHEALTHY', SYSTEM.health);
  state.runs.update(runId, { error: reason });
  const crash = state.ledger.append({ timestamp: new Date().toISOString(), agentId: run.agentId, runId, type: 'crash', action: reason, actor: SYSTEM.health });
  state.metrics?.health.add(1, { agent: run.agentId, kind: 'unhealthy' });
  await routeEvents(state, crash);
}

/** Runs opt in to liveness by sending their first heartbeat; silent runs are governed by the run timeout. */
export async function checkHealth(state: PropertyManagerState, now = Date.now()) {
  for (const run of state.runs.list({ active: true })) {
    if (run.state !== 'WORKING' || !run.lastHeartbeatAt) continue;
    const heardAt = Math.max(Date.parse(run.lastHeartbeatAt), state.healthSince ?? 0);
    if (state.heartbeatTimeoutMs && now - heardAt > state.heartbeatTimeoutMs) {
      await haltUnhealthy(state, run.runId, 'HEARTBEAT_LOST');
    } else if (state.maxRssMb && (run.rssMb ?? 0) > state.maxRssMb) {
      await haltUnhealthy(state, run.runId, 'MEMORY_CEILING');
    }
  }
}

export async function routeEvents(state: PropertyManagerState, event: { type: string; agentId: string; runId?: string }) {
  if (event.type === 'crash' && event.agentId !== 'med-doc' && state.agents.has('med-doc')) {
    await createRun(state, 'med-doc', { actor: SYSTEM.router, trigger: 'event:crash', input: { agentId: event.agentId, runId: event.runId } });
  }
  if (event.type === 'budget.alert' && event.agentId !== 'finops-officer' && state.agents.has('finops-officer')) {
    await createRun(state, 'finops-officer', { actor: SYSTEM.router, trigger: 'event:budget.alert', input: { agentId: event.agentId } });
  }
}

/** Poll runtimes whose tasks outlive this process; finish runs whose tasks stopped. */
export async function reconcileRuns(state: PropertyManagerState): Promise<void> {
  for (const run of state.runs.list({ active: true })) {
    if (run.state === 'QUEUED' || startsInFlight.has(run.runId)) continue;
    if (!state.runtime.status || !run.taskHandle) {
      if (!state.runtime.running(run.agentId)) {
        await finishRun(state, run.runId, 'FAILED', { actor: SYSTEM.reconciler, error: 'task lost: control plane restarted' });
      }
      continue;
    }
    const s = await state.runtime.status(run.taskHandle).catch(() => ({ state: 'unknown' as const }));
    if (s.state === 'stopped') {
      await finishRun(state, run.runId, s.exitCode === 0 ? 'DONE' : 'FAILED', {
        actor: SYSTEM.reconciler,
        exitCode: s.exitCode,
        ...(s.exitCode === 0 ? {} : { error: s.reason ?? `exit ${s.exitCode}` }),
      });
    } else if (s.state === 'running') {
      const agent = state.agents.get(run.agentId);
      if (agent && agent.state === 'SLEEPING') agent.state = 'WORKING';
      if (!state.idleTimers.has(run.agentId)) {
        scheduleTimeout(state, run);
      }
    } else if (s.state === 'unknown') {
      const ageMs = Date.now() - new Date(run.startedAt || run.createdAt).getTime();
      if (ageMs > 60_000) {
        await finishRun(state, run.runId, 'FAILED', {
          actor: SYSTEM.reconciler,
          error: 'task lost: task not found in runtime',
        });
      }
    }
  }
  // GAP-176: agent state is not persisted on every run change, so a WORKING agent can outlive its run (a halt, a
  // restart). Put it back to sleep so presence and wakes follow the runs, not a stale state.
  for (const agent of state.agents.values()) {
    if (agent.state !== 'WORKING' || activeRun(state, agent.id)) continue;
    agent.state = 'SLEEPING';
    registryOf(state).update(agent);
    await notifyGatekeeperIngress(state, agent.id, 'offline');
  }
}
