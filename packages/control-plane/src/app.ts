import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import { redactSecrets, type CheckpointSink, type LedgerStore } from '@beercanlabs/factory-ledger';
import { hasRole, type AuthProvider, type Principal, type Role } from '@beercanlabs/factory-auth';
import type { Meter } from '@opentelemetry/api';
import { classifySecrets, type Surface } from '@beercanlabs/factory-contract';
import { AgentRecord } from './catalog.js';
import type { DeployProvider, Runtime } from './runtime.js';
import { isTerminal, type Run, type RunState, type RunStore, type RunTokens } from './runs.js';
import { checkCallbackUrl, deliverCallback, type CallbackPolicy } from './callbacks.js';
import { exceededWindow, validatePolicy, type ApprovalStore, type PolicyStore, type SpendTracker } from './policy.js';
import { Keymaster } from '@beercanlabs/factory-keymaster';
import { ScheduleStore, type ScheduledAction } from './schedules.js';
import { gatewayEnv } from '@beercanlabs/factory-hydrate';

export type FactoryState = {
  agents: Map<string, AgentRecord>;
  registryDir?: string;
  ledger: LedgerStore;
  auth: AuthProvider;
  version: string;
  providers: SecretProvider[];
  runtime: Runtime;
  /** Provider-specific deploy lifecycle (build → identity → compute). Absent = deploy endpoint returns 501. */
  deployProvider?: DeployProvider;
  runs: RunStore;
  runTokens: RunTokens;
  callbacks: CallbackPolicy;
  policies: PolicyStore;
  spend: SpendTracker;
  approvals: ApprovalStore;
  keymaster?: Keymaster;
  schedules?: ScheduleStore;
  /** URL agents use to reach the control plane (result reporting, input fetch). */
  publicUrl?: string;
  /** URL agents use to reach the egress gateway; handed to every run as FACTORY_GATEWAY_URL. */
  gatewayUrl?: string;
  /** Max wall-clock per run before it is stopped as TIMED_OUT. 0 disables. */
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  doormanUrl?: string;
  /** Presented to Doorman's presence API. */
  doormanToken?: string;
  /** A run that has sent heartbeats is halted as BLOCKED_UNHEALTHY after this much silence. 0 disables. */
  heartbeatTimeoutMs?: number;
  /** Halt a run whose reported RSS exceeds this. 0 disables. */
  maxRssMb?: number;
  /** Consecutive failed runs within 10 minutes that pause the agent. 0 disables. */
  crashLoopThreshold?: number;
  metrics?: FactoryMetrics;
  secretValues: Set<string>;
  /** Write-once copy of the ledger; `verify` checks the local chain against it. */
  ledgerSink?: CheckpointSink;
  /** In-memory mailboxes for running tasks to receive follow-up messages while warm. */
  mailboxes?: Map<string, MailboxQueue>;
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

export function deliverToMailbox(state: FactoryState, agentId: string, payload: unknown) {
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
} as const;

export type FactoryMetrics = {
  runs: ReturnType<Meter['createCounter']>;
  runSeconds: ReturnType<Meter['createHistogram']>;
  health: ReturnType<Meter['createCounter']>;
};

export function factoryMetrics(meter: Meter, state: () => FactoryState): FactoryMetrics {
  meter
    .createObservableGauge('factory.runs.active', { description: 'Non-terminal runs by state' })
    .addCallback((obs) => {
      const counts = new Map<string, number>();
      for (const r of state().runs.list({ active: true })) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
      for (const [st, n] of counts) obs.observe(n, { state: st });
    });
  return {
    runs: meter.createCounter('factory.runs.finished', { description: 'Runs reaching a terminal or blocked state' }),
    runSeconds: meter.createHistogram('factory.run.duration', { unit: 's', description: 'Wall-clock from start to terminal state' }),
    health: meter.createCounter('factory.health.events', { description: 'Health interventions (unhealthy halts, crash-loop pauses)' }),
  };
}

const INGEST_TYPES = new Set(['llm', 'mcp', 'action', 'crash', 'budget.alert']);
const MAX_BODY = 256 * 1024;

type Outcome<T> = { status: number; body: T | { error: string; [k: string]: unknown } };

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
      if (body.length > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

async function authenticate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
  role: Role,
): Promise<Principal | null> {
  const authHeader = req.headers.authorization || 
    (req.headers['cf-access-jwt-assertion'] ? `Bearer ${req.headers['cf-access-jwt-assertion']}` : undefined);
  const result = await state.auth.verify(authHeader);
  if (!result.ok) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  if (!hasRole(result.principal, role)) {
    json(res, 403, { error: 'forbidden', required: role });
    return null;
  }
  return result.principal;
}

async function authenticateOperatorOrRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
): Promise<{ actor: string; agentId?: string } | null> {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  const runPayload = await state.runTokens.verify(token);
  if (runPayload) {
    return {
      actor: `run:${runPayload.agentId}:${runPayload.runId}`,
      agentId: runPayload.agentId,
    };
  }
  const result = await state.auth.verify(req.headers.authorization);
  if (result.ok && (hasRole(result.principal, 'operator') || hasRole(result.principal, 'viewer'))) {
    return { actor: result.principal.actor };
  }
  json(res, 401, { error: 'unauthorized' });
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function notifyDoorman(state: FactoryState, agentId: string, presence: 'offline' | 'available') {
  if (!state.doormanUrl) return;
  try {
    const res = await fetch(`${state.doormanUrl.replace(/\/$/, '')}/api/v1/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.doormanToken ? { Authorization: `Bearer ${state.doormanToken}` } : {}),
      },
      body: JSON.stringify({ agentId, presence }),
    });
    if (!res.ok) console.error(`[control-plane] doorman presence ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-plane] doorman unreachable: ${message}`);
  }
}

function record(state: FactoryState, run: Pick<Run, 'agentId' | 'runId'>, action: string, actor: string) {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: run.agentId,
    runId: run.runId,
    type: 'action',
    action,
    actor,
  });
}

export function activeRun(state: FactoryState, agentId: string): Run | undefined {
  return state.runs.list({ agentId, active: true }).find((r) => r.state !== 'QUEUED');
}

function scheduleTimeout(state: FactoryState, run: Run) {
  const prev = state.idleTimers.get(run.agentId);
  if (prev) clearTimeout(prev);
  const agent = state.agents.get(run.agentId);
  const timeoutMs = (agent?.warmDownSeconds && agent.warmDownSeconds > 0)
    ? agent.warmDownSeconds * 1000
    : (state.idleMs > 0 ? state.idleMs : 3_600_000);
  if (timeoutMs <= 0) return;
  const t = setTimeout(() => {
    const cur = state.runs.get(run.runId);
    if (cur && !isTerminal(cur.state)) void finishRun(state, run.runId, 'TIMED_OUT', { actor: SYSTEM.idle });
  }, timeoutMs);
  t.unref?.();
  state.idleTimers.set(run.agentId, t);
}

/** Park a live run. The task keeps running; the gateway refuses its egress until unblocked. */
export function blockRun(state: FactoryState, runId: string, to: 'BLOCKED_BUDGET_EXCEEDED' | 'BLOCKED_FOR_HUMAN' | 'BLOCKED_UNHEALTHY', actor: string) {
  const run = state.runs.get(runId);
  if (!run || isTerminal(run.state) || run.state === to) return run;
  const timer = state.idleTimers.get(run.agentId);
  if (timer) clearTimeout(timer);
  const next = state.runs.update(runId, { state: to });
  record(state, next, to, actor);
  return next;
}

export function unblockRun(state: FactoryState, runId: string, from: RunState, actor: string) {
  const run = state.runs.get(runId);
  if (!run || run.state !== from) return run;
  const next = state.runs.update(runId, { state: 'WORKING' });
  record(state, next, 'RUN_UNBLOCKED', actor);
  scheduleTimeout(state, next);
  return next;
}

export type CreateRunOptions = { actor: string; trigger: string; input?: unknown; callbackUrl?: string; model?: string };

/** The single entry point for waking an agent: manual, webhook, cron, event route, Doorman. */
export async function createRun(state: FactoryState, agentId: string, opts: CreateRunOptions): Promise<Outcome<Run>> {
  const agent = state.agents.get(agentId);
  if (!agent) return { status: 404, body: { error: 'not_found' } };
  if (agent.state === 'PAUSED' || agent.state === 'ISOLATED') {
    return { status: 409, body: { error: `agent_${agent.state.toLowerCase()}` } };
  }
  if (opts.callbackUrl) {
    const bad = checkCallbackUrl(opts.callbackUrl, state.callbacks);
    if (bad) return { status: 400, body: { error: bad } };
  }

  // Deduplicate incoming runs with identical messageId
  if (opts.input && typeof opts.input === 'object') {
    const msgId = (opts.input as Record<string, any>).messageId;
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

  let bound: { ok: true, env: Record<string, string> } | { ok: false, missing: string[] } = { ok: true, env: {} };
  if (agent.provider === 'local') {
    bound = await bindSecrets(agent.ungated ?? agent.requires, state.providers);
    if (!bound.ok) {
      const run = state.runs.create({
        agentId,
        state: 'PRE_FLIGHT_MISSING_SECRET',
        actor: opts.actor,
        trigger: opts.trigger,
        callbackUrl: opts.callbackUrl,
        missing: bound.missing,
      });
      record(state, run, 'PRE_FLIGHT_MISSING_SECRET', opts.actor);
      void fireCallback(state, run);
      return { status: 412, body: { error: 'unbound_secrets', missing: bound.missing, runId: run.runId } };
    }
  }

  const busy = activeRun(state, agentId);
  const run = state.runs.create({
    agentId,
    state: 'QUEUED',
    actor: opts.actor,
    trigger: opts.trigger,
    input: opts.input,
    callbackUrl: opts.callbackUrl,
    ...(opts.model ? { model: opts.model } : {}),
  });
  record(state, run, 'RUN_QUEUED', opts.actor);
  if (busy) return { status: 202, body: run };
  return { status: 202, body: await startRun(state, run, bound.env) };
}

async function startRun(state: FactoryState, run: Run, secrets?: Record<string, string>): Promise<Run> {
  const agent = state.agents.get(run.agentId)!;
  let env = secrets;
  if (!env) {
    const bound = await bindSecrets(agent.ungated ?? agent.requires, state.providers);
    if (!bound.ok) {
      const failed = state.runs.update(run.runId, { state: 'PRE_FLIGHT_MISSING_SECRET', missing: bound.missing });
      record(state, failed, 'PRE_FLIGHT_MISSING_SECRET', SYSTEM.runtime);
      void fireCallback(state, failed);
      return failed;
    }
    env = bound.env;
  }
  for (const value of Object.values(env)) if (value.length >= 4) state.secretValues.add(value);

  let cur = state.runs.update(run.runId, { state: 'STARTING' });
  const runToken = await state.runTokens.mint(run);
  const runEnv: Record<string, string> = {
    FACTORY_RUN_ID: run.runId,
    FACTORY_RUN_TOKEN: runToken,
    ...(state.publicUrl ? { FACTORY_URL: state.publicUrl } : {}),
    ...(run.model ? { FACTORY_MODEL: run.model } : {}),
    ...(state.gatewayUrl ? { FACTORY_GATEWAY_URL: state.gatewayUrl } : {}),
    ...gatewayEnv({
      FACTORY_GATEWAY_URL: state.gatewayUrl,
      FACTORY_RUN_TOKEN: runToken,
    }),
  };
  try {
    const { handle } = await state.runtime.start(agent, env, { runId: run.runId, runEnv });
    cur = state.runs.update(run.runId, { state: 'WORKING', taskHandle: handle, startedAt: new Date().toISOString() });
  } catch (err) {
    return finishRun(state, run.runId, 'FAILED', {
      actor: SYSTEM.runtime,
      error: `start failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  agent.state = 'WORKING';
  record(state, cur, 'RUN_STARTED', run.actor);
  scheduleTimeout(state, cur);
  await notifyDoorman(state, agent.id, 'available');
  return cur;
}

export async function finishRun(
  state: FactoryState,
  runId: string,
  terminal: Extract<RunState, 'DONE' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED'>,
  extra: { actor: string; exitCode?: number | null; result?: unknown; error?: string },
): Promise<Run> {
  const cur = state.runs.get(runId);
  if (!cur) throw new Error(`unknown run ${runId}`);
  if (isTerminal(cur.state)) return cur;
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

  const timer = state.idleTimers.get(done.agentId);
  if (timer) clearTimeout(timer);
  state.idleTimers.delete(done.agentId);

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
    if (agent.state === 'WORKING') agent.state = terminal === 'DONE' ? 'SLEEPING' : 'ERROR';
    await notifyDoorman(state, agent.id, 'offline');
  }
  if (terminal === 'FAILED' && done.agentId !== 'med-doc' && state.agents.has('med-doc')) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: done.agentId, runId, type: 'crash', actor: SYSTEM.runtime });
    await createRun(state, 'med-doc', { actor: SYSTEM.router, trigger: 'event:crash', input: { agentId: done.agentId, runId } });
  }

  void fireCallback(state, done);
  if (terminal === 'FAILED') await breakCrashLoop(state, done.agentId);

  const next = state.runs.list({ agentId: done.agentId, active: true }).find((r) => r.state === 'QUEUED');
  if (next && agent && agent.state !== 'PAUSED' && agent.state !== 'ISOLATED') await startRun(state, next);
  return done;
}

async function fireCallback(state: FactoryState, run: Run) {
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

/** Kill-switch only. Waking is createRun. */
export async function applyKillSwitch(
  state: FactoryState,
  id: string,
  command: 'PAUSE' | 'ISOLATE' | 'RESUME',
  actor: string,
): Promise<Outcome<AgentRecord>> {
  const agent = state.agents.get(id);
  if (!agent) return { status: 404, body: { error: 'not_found' } };
  if (command === 'PAUSE') agent.state = 'PAUSED';
  else if (command === 'ISOLATE') agent.state = 'ISOLATED';
  else agent.state = activeRun(state, id) ? 'WORKING' : 'SLEEPING';
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: command, actor });
  if (command === 'RESUME' && !activeRun(state, id)) {
    const next = state.runs.list({ agentId: id, active: true }).find((r) => r.state === 'QUEUED');
    if (next) await startRun(state, next);
  }
  return { status: 200, body: agent };
}

/** Pause an agent whose recent runs keep failing, so the queue stops feeding it. */
async function breakCrashLoop(state: FactoryState, agentId: string) {
  const threshold = state.crashLoopThreshold ?? 0;
  const agent = state.agents.get(agentId);
  if (threshold <= 0 || !agent || agent.state === 'PAUSED' || agent.state === 'ISOLATED') return;
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
export async function haltUnhealthy(state: FactoryState, runId: string, reason: string) {
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
export async function checkHealth(state: FactoryState, now = Date.now()) {
  for (const run of state.runs.list({ active: true })) {
    if (run.state !== 'WORKING' || !run.lastHeartbeatAt) continue;
    if (state.heartbeatTimeoutMs && now - Date.parse(run.lastHeartbeatAt) > state.heartbeatTimeoutMs) {
      await haltUnhealthy(state, run.runId, 'HEARTBEAT_LOST');
    } else if (state.maxRssMb && (run.rssMb ?? 0) > state.maxRssMb) {
      await haltUnhealthy(state, run.runId, 'MEMORY_CEILING');
    }
  }
}

async function routeEvents(state: FactoryState, event: { type: string; agentId: string; runId?: string }) {
  if (event.type === 'crash' && event.agentId !== 'med-doc' && state.agents.has('med-doc')) {
    await createRun(state, 'med-doc', { actor: SYSTEM.router, trigger: 'event:crash', input: { agentId: event.agentId, runId: event.runId } });
  }
  if (event.type === 'budget.alert' && event.agentId !== 'finops-officer' && state.agents.has('finops-officer')) {
    await createRun(state, 'finops-officer', { actor: SYSTEM.router, trigger: 'event:budget.alert', input: { agentId: event.agentId } });
  }
}

/** Poll runtimes whose tasks outlive this process; finish runs whose tasks stopped. */
export async function reconcileRuns(state: FactoryState): Promise<void> {
  for (const run of state.runs.list({ active: true })) {
    if (run.state === 'QUEUED') continue;
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
}

type ToolSpec = { name: string; description: string; role: Role; args: Record<string, { type: string }>; required?: string[] };

const TOOLS: ToolSpec[] = [
  { name: 'list_agents', description: 'List factory cartridges', role: 'viewer', args: {} },
  { name: 'query_ledger', description: 'Read the execution ledger', role: 'viewer', args: { agent: { type: 'string' } } },
  { name: 'get_run', description: 'Get a run by id', role: 'viewer', args: { runId: { type: 'string' } }, required: ['runId'] },
  { name: 'wake_agent', description: 'Start a run (202 semantics: returns the queued/started run)', role: 'operator', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'pause_agent', description: 'Pause agent egress', role: 'operator', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'resume_agent', description: 'Resume agent egress', role: 'operator', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'isolate_agent', description: 'Isolate agent egress', role: 'operator', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'list_approvals', description: 'List pending tool-call approvals', role: 'viewer', args: {} },
  {
    name: 'decide_approval',
    description: 'Approve or reject a held tool call',
    role: 'approver',
    args: { approvalId: { type: 'string' }, decision: { type: 'string' } },
    required: ['approvalId', 'decision'],
  },
];

export async function handleMcp(state: FactoryState, payload: Record<string, unknown>, principal: Principal): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-factory', version: state.version },
      },
    };
  }
  if (method === 'tools/list') {
    const tools = TOOLS.filter((t) => hasRole(principal, t.role)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.args, ...(t.required ? { required: t.required } : {}) },
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    const spec = TOOLS.find((t) => t.name === params.name);
    if (!spec) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    if (!hasRole(principal, spec.role)) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: `forbidden: requires ${spec.role}` } };
    }
    const result = await dispatchTool(state, spec.name, params.arguments ?? {}, principal.actor);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

async function dispatchTool(state: FactoryState, name: string, args: Record<string, string>, actor: string): Promise<unknown> {
  if (name === 'list_agents') return [...state.agents.values()];
  if (name === 'query_ledger') return state.ledger.query({ agent: args.agent });
  if (name === 'get_run') return state.runs.get(args.runId) ?? { error: 'not_found' };
  if (name === 'list_approvals') return state.approvals.list({ state: 'pending' });
  if (name === 'decide_approval') return decideApproval(state, args.approvalId, args.decision, actor).body;
  const id = args.id;
  if (!id) return { error: 'id required' };
  if (name === 'wake_agent') return (await createRun(state, id, { actor, trigger: 'mcp' })).body;
  if (name === 'pause_agent') return (await applyKillSwitch(state, id, 'PAUSE', actor)).body;
  if (name === 'resume_agent') return (await applyKillSwitch(state, id, 'RESUME', actor)).body;
  if (name === 'isolate_agent') return (await applyKillSwitch(state, id, 'ISOLATE', actor)).body;
  return { error: `unknown tool ${name}` };
}

function decideApproval(state: FactoryState, id: string, decision: string, actor: string): Outcome<unknown> {
  if (decision !== 'approve' && decision !== 'reject') return { status: 400, body: { error: 'decision must be approve or reject' } };
  const decided = state.approvals.decide(id, decision === 'approve' ? 'approved' : 'rejected', actor);
  if (!decided) return { status: 409, body: { error: 'approval not pending' } };
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: decided.agentId,
    runId: decided.runId,
    type: 'action',
    action: decision === 'approve' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
    actor,
    approvalId: decided.approvalId,
    mcpName: decided.tool,
    route: decided.route,
  });
  if (!state.approvals.list({ state: 'pending', runId: decided.runId }).length) {
    unblockRun(state, decided.runId, 'BLOCKED_FOR_HUMAN', actor);
  }
  return { status: 200, body: decided };
}

function bearerOf(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Authenticate a run token for exactly this run while it is still live. */
async function authenticateRun(req: http.IncomingMessage, res: http.ServerResponse, state: FactoryState, runId: string) {
  const claims = await state.runTokens.verify(bearerOf(req));
  const run = claims && claims.runId === runId ? state.runs.get(runId) : undefined;
  if (!claims || !run || run.agentId !== claims.agentId || isTerminal(run.state)) {
    json(res, 401, { error: 'invalid_run_token' });
    return null;
  }
  return run;
}

export function getKeymaster(state: FactoryState): Keymaster {
  if (!state.keymaster) {
    state.keymaster = new Keymaster({
      approvals: state.approvals,
      ledger: state.ledger,
      providers: state.providers,
      runTokens: state.runTokens,
      secretValues: state.secretValues,
      getAgent: (agentId: string) => state.agents.get(agentId),
      getRun: (runId: string) => state.runs.get(runId),
    });
  }
  return state.keymaster;
}

import { UI_HTML } from './ui.js';

export function createFactoryServer(state: FactoryState): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await route(state, req, res);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function route(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse) {
  const path = (req.url ?? '/').split('?')[0];
  const started = Number(process.env.FACTORY_STARTED_AT ?? Date.now());

  if (path === '/ui' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
    return;
  }

  if ((path === '/healthz' || path === '/' || path === '/api/v1/health') && req.method === 'GET') {
    json(res, 200, {
      status: 'ok',
      version: state.version,
      uptime: Math.round((Date.now() - started) / 1000),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if ((path === '/api/v1/metrics' || path === '/metrics') && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const activeRuns = state.runs.list({ active: true });
    const runCounts: Record<string, number> = {};
    for (const r of activeRuns) runCounts[r.state] = (runCounts[r.state] ?? 0) + 1;

    const agentCounts: Record<string, number> = {};
    for (const a of state.agents.values()) agentCounts[a.state] = (agentCounts[a.state] ?? 0) + 1;

    let daySpend = 0;
    let monthSpend = 0;
    for (const id of state.agents.keys()) {
      const s = state.spend.get(id, undefined);
      daySpend += s.day;
      monthSpend += s.month;
    }

    json(res, 200, {
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      agents: {
        total: state.agents.size,
        byState: agentCounts,
      },
      runs: {
        active: activeRuns.length,
        byState: runCounts,
      },
      ledger: {
        totalRows: state.ledger.query().length,
        wormConfigured: Boolean(state.ledgerSink),
      },
      spendUsd: {
        day: Number(daySpend.toFixed(4)),
        month: Number(monthSpend.toFixed(4)),
      },
    });
    return;
  }

  // Webhooks authenticate with the cartridge's own shared secret, not a factory bearer.
  const hookMatch = path.match(/^\/api\/v1\/hooks\/([^/]+)$/);
  if (hookMatch && req.method === 'POST') {
    const agent = state.agents.get(hookMatch[1]);
    const trigger = agent?.triggers.find((t) => t.type === 'webhook');
    if (!agent || !trigger || trigger.type !== 'webhook') {
      


  json(res, 404, { error: 'not_found' });
      return;
    }
    let actor: string;
    if (trigger.secretRef) {
      const bound = await bindSecrets([trigger.secretRef], state.providers);
      const provided = (req.headers['x-factory-secret'] as string | undefined) ?? '';
      if (!bound.ok || !provided || !safeEqual(provided, bound.env[trigger.secretRef] ?? '')) {
        json(res, 401, { error: 'bad_webhook_secret' });
        return;
      }
      actor = `webhook:${agent.id}`;
    } else {
      const principal = await authenticate(req, res, state, 'operator');
      if (!principal) return;
      actor = principal.actor;
    }
    const raw = await readBody(req);
    let input: unknown;
    try {
      input = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      input = raw;
    }
    const out = await createRun(state, agent.id, { actor, trigger: 'webhook', input });
    json(res, out.status, out.body);
    return;
  }

  // Agent-facing: authenticated by the run token minted at start.
  const runSelf = path.match(/^\/api\/v1\/runs\/([^/]+)\/(input|result|heartbeat|mailbox)$/);
  if (runSelf && (((runSelf[2] === 'input' || runSelf[2] === 'mailbox') && req.method === 'GET') || (runSelf[2] !== 'input' && runSelf[2] !== 'mailbox' && req.method === 'POST'))) {
    const run = await authenticateRun(req, res, state, runSelf[1]);
    if (!run) return;
    if (runSelf[2] === 'heartbeat') {
      const hb = await readJson(req);
      const rssMb = typeof hb.rssMb === 'number' && Number.isFinite(hb.rssMb) ? hb.rssMb : undefined;
      state.runs.update(run.runId, { lastHeartbeatAt: new Date().toISOString(), ...(rssMb !== undefined ? { rssMb } : {}) });
      if (state.maxRssMb && rssMb !== undefined && rssMb > state.maxRssMb) await haltUnhealthy(state, run.runId, 'MEMORY_CEILING');
      json(res, 200, { ok: true, state: state.runs.get(run.runId)?.state });
      return;
    }
    if (runSelf[2] === 'input') {
      const now = new Date();
      json(res, 200, {
        runId: run.runId,
        input: run.input ?? null,
        temporal: {
          local: now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'long' }),
          utc: now.toISOString(),
          dayOfWeek: now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }),
          timezone: 'America/Los_Angeles',
        },
      });
      return;
    }
    if (runSelf[2] === 'mailbox') {
      if (!state.mailboxes) state.mailboxes = new Map();
      let queue = state.mailboxes.get(run.agentId);
      if (!queue) {
        queue = { messages: [], waiters: [] };
        state.mailboxes.set(run.agentId, queue);
      }
      if (queue.messages.length > 0) {
        const nextMsg = queue.messages.shift();
        json(res, 200, { ok: true, message: nextMsg });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://factory.local');
      const timeout = Math.min(Math.max(parseInt(url.searchParams.get('timeout') || '15000', 10), 0), 30000);
      if (timeout === 0) {
        json(res, 200, { ok: true, message: null });
        return;
      }
      let resolved = false;
      const waiter = (msg: MailboxMessage) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        json(res, 200, { ok: true, message: msg });
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const idx = queue!.waiters.indexOf(waiter);
        if (idx !== -1) queue!.waiters.splice(idx, 1);
        json(res, 200, { ok: true, message: null });
      }, timeout);
      queue.waiters.push(waiter);
      req.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const idx = queue!.waiters.indexOf(waiter);
          if (idx !== -1) queue!.waiters.splice(idx, 1);
        }
      });
      return;
    }
    const body = await readJson(req);
    if (body.status !== 'succeeded' && body.status !== 'failed') {
      json(res, 400, { error: 'status must be succeeded or failed' });
      return;
    }
    const output = body.output === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(body.output), state.secretValues));
    const done = await finishRun(state, run.runId, body.status === 'succeeded' ? 'DONE' : 'FAILED', {
      actor: `run:${run.agentId}`,
      result: output,
      ...(typeof body.error === 'string' ? { error: redactSecrets(body.error, state.secretValues) } : {}),
    });
    json(res, 200, done);
    return;
  }

  if (path === '/api/v1/agents' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    json(res, 200, [...state.agents.values()]);
    return;
  }

  const runCreate = path.match(/^\/api\/v1\/agents\/([^/]+)\/(runs|wake)$/);
  if (runCreate && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'operator');
    if (!principal) return;
    const body = await readJson(req);
    if (body.callbackUrl !== undefined && typeof body.callbackUrl !== 'string') {
      json(res, 400, { error: 'callbackUrl must be a string' });
      return;
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !/^[\w.:@/-]{1,128}$/.test(body.model))) {
      json(res, 400, { error: 'model must be a model id' });
      return;
    }
    const out = await createRun(state, runCreate[1], {
      actor: principal.actor,
      trigger: runCreate[2] === 'wake' ? 'manual' : 'api',
      input: body.input,
      callbackUrl: body.callbackUrl as string | undefined,
      model: body.model as string | undefined,
    });
    json(res, out.status, out.body);
    return;
  }

  const killMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/(pause|resume|isolate)$/);
  if (killMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'operator');
    if (!principal) return;
    const out = await applyKillSwitch(state, killMatch[1], killMatch[2].toUpperCase() as 'PAUSE' | 'RESUME' | 'ISOLATE', principal.actor);
    json(res, out.status, out.body);
    return;
  }

  if (path === '/api/v1/runs' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const runs = state.runs.list({ agentId: url.searchParams.get('agent'), active: url.searchParams.get('active') === 'true' });
    const limit = url.searchParams.has('limit') ? Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit')!, 10) || 50)) : undefined;
    const offset = url.searchParams.has('offset') ? Math.max(0, parseInt(url.searchParams.get('offset')!, 10) || 0) : 0;
    const paged = limit !== undefined ? runs.slice(offset, offset + limit) : runs;
    json(res, 200, paged);
    return;
  }

  const runGet = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runGet && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const run = state.runs.get(runGet[1]);
    json(res, run ? 200 : 404, run ?? { error: 'not_found' });
    return;
  }

  const runCancel = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
  if (runCancel && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'operator');
    if (!principal) return;
    const run = state.runs.get(runCancel[1]);
    if (!run) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, await finishRun(state, run.runId, 'CANCELLED', { actor: principal.actor }));
    return;
  }

  const convoMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/conversation$/);
  if (convoMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'operator');
    if (!principal) return;
    const agent = state.agents.get(convoMatch[1]);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const payload = await readJson(req);
    await state.runtime.deliver(agent, payload);
    deliverToMailbox(state, agent.id, payload);
    const currentRun = activeRun(state, agent.id);
    if (currentRun) {
      if (currentRun.input === undefined) {
        currentRun.input = payload;
      }
      scheduleTimeout(state, currentRun);
    }
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: currentRun?.runId,
      type: 'action',
      action: 'CONVERSATION_HANDOFF',
      actor: principal.actor,
      content: payload,
    });
    json(res, 202, { ok: true });
    return;
  }

  // Schedules: dynamic scheduled actions
  if (path === '/api/v1/schedules' && req.method === 'GET') {
    const caller = await authenticateOperatorOrRun(req, res, state);
    if (!caller) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const agentFilter = url.searchParams.get('agent') || undefined;
    json(res, 200, { schedules: state.schedules?.list(agentFilter ? { agentId: agentFilter } : undefined) ?? [] });
    return;
  }

  if (path === '/api/v1/schedules' && req.method === 'POST') {
    const caller = await authenticateOperatorOrRun(req, res, state);
    if (!caller) return;
    const body = await readJson(req);
    const agentId = (body.agentId as string) || caller.agentId;
    if (!agentId || !state.agents.has(agentId)) {
      json(res, 400, { error: 'invalid_or_missing_agent' });
      return;
    }
    if (!body.cron || typeof body.cron !== 'string') {
      json(res, 400, { error: 'missing_cron' });
      return;
    }
    if (!body.prompt || typeof body.prompt !== 'string') {
      json(res, 400, { error: 'missing_prompt' });
      return;
    }

    const schedule: ScheduledAction = {
      id: (body.id as string) || `sched-${randomUUID()}`,
      agentId,
      name: (body.name as string) || `Scheduled action for ${agentId}`,
      cron: (body.cron as string).trim(),
      timezone: (body.timezone as string) || 'America/Los_Angeles',
      channelId: (body.channelId as string) || (body.channel_id as string),
      prompt: body.prompt as string,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
    };

    state.schedules?.save(schedule);
    json(res, 200, { ok: true, schedule });
    return;
  }

  const schedDelete = path.match(/^\/api\/v1\/schedules\/([^/]+)$/);
  if (schedDelete && req.method === 'DELETE') {
    const caller = await authenticateOperatorOrRun(req, res, state);
    if (!caller) return;
    const deleted = state.schedules?.delete(schedDelete[1]);
    json(res, 200, { ok: true, deleted: Boolean(deleted) });
    return;
  }

  if (path === '/api/v1/ledger/verify' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const anchors = state.ledgerSink ? await state.ledgerSink.list() : [];
    const result = state.ledger.verify(anchors);
    json(res, result.ok ? 200 : 409, { ...result, worm: Boolean(state.ledgerSink) });
    return;
  }

  if (path === '/api/v1/ledger' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const rows = state.ledger.query({
      agent: url.searchParams.get('agent'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    const limit = url.searchParams.has('limit') ? Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit')!, 10) || 50)) : undefined;
    const offset = url.searchParams.has('offset') ? Math.max(0, parseInt(url.searchParams.get('offset')!, 10) || 0) : 0;
    const paged = limit !== undefined ? rows.slice(offset, offset + limit) : rows;
    json(res, 200, paged);
    return;
  }

  if (path === '/api/v1/ledger' && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'ingest');
    if (!principal) return;
    const event = (await readJson(req)) as { agentId?: string; type?: string; [k: string]: unknown };
    if (!event.agentId || !event.type) {
      json(res, 400, { error: 'agentId and type required' });
      return;
    }
    if (!INGEST_TYPES.has(event.type)) {
      json(res, 400, { error: `type must be one of ${[...INGEST_TYPES].join(', ')}` });
      return;
    }
    // The gateway verified the run token, so it may attest the run as the actor. Other writers may not.
    const isGateway = hasRole({ ...principal, roles: principal.roles.filter((r) => r !== 'admin') }, 'gateway');
    const run = typeof event.runId === 'string' ? state.runs.get(event.runId) : undefined;
    if (isGateway && event.runId !== undefined && (!run || run.agentId !== event.agentId)) {
      json(res, 400, { error: 'runId does not belong to agentId' });
      return;
    }
    const actor = isGateway && run && event.actor === `run:${run.agentId}` ? event.actor : principal.actor;
    const stored = state.ledger.append({
      ...event,
      ...(isGateway ? {} : { costUsd: undefined }),
      agentId: event.agentId,
      type: event.type,
      actor,
      timestamp: new Date().toISOString(),
    });
    if (isGateway && stored.type === 'llm' && typeof stored.costUsd === 'number') {
      const policy = state.policies.get(stored.agentId);
      const before = exceededWindow(policy, state.spend.get(stored.agentId, stored.runId));
      state.spend.add(stored.agentId, stored.runId, stored.costUsd, stored.timestamp);
      const after = exceededWindow(policy, state.spend.get(stored.agentId, stored.runId));
      // Alert once per crossing, even if the run already finished; block only a run that is still live.
      if (after && after !== before) {
        const alert = state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: stored.agentId,
          runId: stored.runId,
          type: 'budget.alert',
          action: `BUDGET_${after.toUpperCase()}_EXCEEDED`,
          actor: SYSTEM.policy,
        });
        await routeEvents(state, alert);
      }
      const live = run ? state.runs.get(run.runId) : undefined;
      if (after && live && !isTerminal(live.state) && live.state !== 'BLOCKED_BUDGET_EXCEEDED') {
        blockRun(state, live.runId, 'BLOCKED_BUDGET_EXCEEDED', SYSTEM.policy);
      }
    }
    await routeEvents(state, stored);
    json(res, 201, { ok: true });
    return;
  }

  const policyMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/policy$/);
  if (policyMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const principal = await authenticate(req, res, state, req.method === 'GET' ? 'viewer' : 'admin');
    if (!principal) return;
    const agentId = policyMatch[1];
    if (!state.agents.has(agentId)) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method === 'GET') {
      json(res, 200, state.policies.get(agentId));
      return;
    }
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    state.policies.set(agentId, checked.policy);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'POLICY_UPDATED', actor: principal.actor });
    for (const run of state.runs.list({ agentId, active: true })) {
      if (run.state === 'BLOCKED_BUDGET_EXCEEDED' && !exceededWindow(checked.policy, state.spend.get(agentId, run.runId))) {
        unblockRun(state, run.runId, 'BLOCKED_BUDGET_EXCEEDED', principal.actor);
      }
    }
    json(res, 200, checked.policy);
    return;
  }

  const gwRun = path.match(/^\/api\/v1\/gateway\/runs\/([^/]+)$/);
  if (gwRun && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'gateway'))) return;
    const run = state.runs.get(gwRun[1]);
    const agent = run ? state.agents.get(run.agentId) : undefined;
    if (!run || !agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, {
      run: { runId: run.runId, agentId: run.agentId, state: run.state, live: !isTerminal(run.state), ...(run.model ? { model: run.model } : {}) },
      agentState: agent.state,
      policy: state.policies.get(run.agentId),
      spend: state.spend.get(run.agentId, run.runId),
    });
    return;
  }

  if (path === '/api/v1/gateway/approvals' && req.method === 'POST') {
    if (!(await authenticate(req, res, state, 'gateway'))) return;
    const b = await readJson(req);
    const run = typeof b.runId === 'string' ? state.runs.get(b.runId) : undefined;
    if (!run || isTerminal(run.state) || typeof b.route !== 'string' || typeof b.tool !== 'string' || typeof b.argsSha256 !== 'string') {
      json(res, 400, { error: 'live runId, route, tool, argsSha256 required' });
      return;
    }
    const { approval, created } = state.approvals.request({
      runId: run.runId,
      agentId: run.agentId,
      route: b.route,
      tool: b.tool,
      argsSha256: b.argsSha256,
    });
    if (created) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: run.agentId,
        runId: run.runId,
        type: 'action',
        action: 'APPROVAL_REQUESTED',
        actor: `run:${run.agentId}`,
        approvalId: approval.approvalId,
        mcpName: approval.tool,
        route: approval.route,
      });
      blockRun(state, run.runId, 'BLOCKED_FOR_HUMAN', SYSTEM.policy);
    }
    json(res, created ? 201 : 200, approval);
    return;
  }

  const gwConsume = path.match(/^\/api\/v1\/gateway\/approvals\/([^/]+)\/consume$/);
  if (gwConsume && req.method === 'POST') {
    if (!(await authenticate(req, res, state, 'gateway'))) return;
    const consumed = state.approvals.consume(gwConsume[1]);
    json(res, consumed ? 200 : 409, consumed ?? { error: 'approval not approved or already used' });
    return;
  }

  const kmCheckout = path === '/api/v1/keymaster/checkout' || path === '/api/v1/gateway/keymaster/checkout';
  if (kmCheckout && req.method === 'POST') {
    const isGatewayPath = path.startsWith('/api/v1/gateway/');
    let actor: string | undefined;
    if (isGatewayPath) {
      const principal = await authenticate(req, res, state, 'gateway');
      if (!principal) return;
      actor = principal.actor;
    }
    const b = (await readJson(req)) as Record<string, unknown>;
    const runId = typeof b.runId === 'string' ? b.runId : undefined;
    const approvalId = typeof b.approvalId === 'string' ? b.approvalId : undefined;
    const gatedSecret = typeof b.gatedSecret === 'string' ? b.gatedSecret : undefined;
    const turnId = typeof b.turnId === 'string' ? b.turnId : undefined;
    const proofHash = typeof b.proofHash === 'string' ? b.proofHash : undefined;

    if (!runId || !approvalId || !gatedSecret || !turnId) {
      json(res, 400, { error: 'runId, approvalId, gatedSecret, turnId required' });
      return;
    }

    if (!isGatewayPath) {
      const run = await authenticateRun(req, res, state, runId);
      if (!run) return;
      actor = `run:${run.agentId}`;
    }

    const km = getKeymaster(state);
    const outcome = await km.checkout({
      runId,
      approvalId,
      gatedSecret,
      turnId,
      proofHash,
      actor,
    });
    json(res, outcome.status, outcome.ok ? outcome.lease : { error: outcome.error, details: outcome.details });
    return;
  }

  if (path === '/api/v1/approvals' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const st = url.searchParams.get('state') as 'pending' | null;
    json(res, 200, state.approvals.list({ ...(st ? { state: st } : {}), ...(url.searchParams.get('runId') ? { runId: url.searchParams.get('runId')! } : {}) }));
    return;
  }

  const decideMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
  if (decideMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'approver');
    if (!principal) return;
    const b = await readJson(req);
    const out = decideApproval(state, decideMatch[1], String(b.decision ?? ''), principal.actor);
    json(res, out.status, out.body);
    return;
  }

  if (path === '/mcp' && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'viewer');
    if (!principal) return;
    json(res, 200, await handleMcp(state, await readJson(req), principal));
    return;
  }

  // --- REGISTRY SERVICE ---
  if (path === '/api/v1/registry/agents' && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const body = await readJson(req);
    const cartridge = (body.cartridge && typeof body.cartridge === 'object' ? body.cartridge : body) as Record<string, unknown>;
    const agentId = typeof cartridge.id === 'string' ? cartridge.id : (typeof body.id === 'string' ? body.id : randomUUID());
    
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_REGISTERED',
      actor: principal.actor
    });
    
    // Evaluate Policy Engine globally
    const globalPolicy = state.policies.get('__global__');
    let stateResult: 'PENDING_BUDGET' | 'PENDING_DEPLOY' = 'PENDING_BUDGET';
    
    if (globalPolicy && globalPolicy.budgetUsd) {
      state.policies.set(agentId, globalPolicy);
      stateResult = 'PENDING_DEPLOY';
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId,
        type: 'action',
        action: 'BUDGET_APPROVED_BY_POLICY',
        actor: 'SYSTEM.policy'
      });
    }
    const artifact = typeof cartridge.compute === 'object' && cartridge.compute !== null
      ? ((cartridge.compute as { ref?: string }).ref ?? '')
      : (typeof cartridge.repo === 'string' ? cartridge.repo : (typeof body.repo === 'string' ? body.repo : ''));

    const classified = cartridge.secrets && typeof cartridge.secrets === 'object'
      ? classifySecrets(cartridge.secrets as Parameters<typeof classifySecrets>[0])
      : classifySecrets({ requires: Array.isArray(body.secrets) ? body.secrets : [] });
    const requires = classified.all;
    const ungated = classified.ungated;
    const gated = classified.gated;
    const triggers = (Array.isArray(cartridge.triggers) ? cartridge.triggers : (Array.isArray(body.triggers) ? body.triggers : [])) as Surface['triggers'];
    const memoryPrefix = (typeof cartridge.persistence === 'object' && cartridge.persistence !== null && 'prefix' in cartridge.persistence)
      ? (cartridge.persistence as { prefix: string }).prefix
      : (typeof cartridge.memory === 'object' && cartridge.memory !== null && 'prefix' in cartridge.memory ? (cartridge.memory as { prefix: string }).prefix : agentId);

    const warmDownSeconds = (typeof cartridge.runtime === 'object' && cartridge.runtime !== null && 'warmDownSeconds' in cartridge.runtime)
      ? Number((cartridge.runtime as { warmDownSeconds: number }).warmDownSeconds)
      : undefined;

    const model = typeof cartridge.model === 'string' ? cartridge.model : (typeof body.model === 'string' ? body.model : 'gemini-2.0-flash');
    const requestedModels = Array.isArray(cartridge.requestedModels)
      ? cartridge.requestedModels
      : (Array.isArray(body.requestedModels) ? body.requestedModels : (Array.isArray(body.models) ? body.models : []));
    const approvedModels = Array.isArray(cartridge.approvedModels) && cartridge.approvedModels.length > 0
      ? cartridge.approvedModels
      : (Array.isArray(body.approvedModels) && body.approvedModels.length > 0 ? body.approvedModels : [model]);

    const record: AgentRecord = {
      id: typeof cartridge.id === 'string' ? cartridge.id : agentId,
      name: typeof cartridge.name === 'string' ? cartridge.name : (typeof body.name === 'string' ? body.name : agentId),
      role: typeof cartridge.role === 'string' ? cartridge.role : (typeof body.role === 'string' ? body.role : 'Agent'),
      state: stateResult,
      provider: 'cloud',
      artifact,
      requires,
      ungated: ungated.length ? ungated : requires,
      gated,
      triggers,
      memoryPrefix,
      warmDownSeconds,
      dir: '/tmp/' + agentId,
      model,
      requestedModels,
      approvedModels,
    };
    state.agents.set(record.id, record);

    // Sync approved models into the agent's egress policy
    const currentPol = state.policies.get(record.id);
    state.policies.set(record.id, {
      ...currentPol,
      routes: currentPol?.routes?.length ? currentPol.routes : ['llm'],
      models: approvedModels,
    });

    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${record.id}:`, err);
      }
    }
    json(res, 201, record);
    return;
  }
  
  if (path === '/api/v1/registry/agents' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    json(res, 200, Array.from(state.agents.values()));
    return;
  }

  const regAgentMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)$/);
  if (regAgentMatch && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const agent = state.agents.get(regAgentMatch[1]);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, agent);
    return;
  }

  const budgetMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/budget$/);
  if (budgetMatch && req.method === 'PUT') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = budgetMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    state.policies.set(agentId, checked.policy);
    if (agent.state === 'PENDING_BUDGET') {
      agent.state = 'PENDING_DEPLOY';
    }
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'BUDGET_APPROVED',
      actor: principal.actor,
    });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, agent);
    return;
  }

  const retireMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/retire$/);
  if (retireMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = retireMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    agent.state = 'RETIRED_PENDING_PURGE';
    const now = new Date();
    agent.retiredAt = now.toISOString();
    agent.purgeDueAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.ledger.append({
      timestamp: now.toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_RETIRED_PENDING_PURGE',
      actor: principal.actor,
    });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, agent);
    return;
  }

  const reinstateMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/reinstate$/);
  if (reinstateMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = reinstateMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (agent.state !== 'RETIRED_PENDING_PURGE') {
      json(res, 400, { error: 'agent_not_retired', message: 'Only retired agents can be reinstated' });
      return;
    }
    agent.state = 'SLEEPING';
    delete agent.retiredAt;
    delete agent.purgeDueAt;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_REINSTATED',
      actor: principal.actor,
    });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, agent);
    return;
  }

  const purgeMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/purge$/);
  if (purgeMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = purgeMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    state.agents.delete(agentId);
    if (state.registryDir) {
      try {
        const filePath = join(state.registryDir, `${agentId}.json`);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch (err) {
        console.warn(`[control-plane] failed to delete dynamic agent file ${agentId}:`, err);
      }
    }
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_PURGED',
      actor: principal.actor,
    });
    json(res, 200, { ok: true, id: agentId, action: 'purged' });
    return;
  }
  
  const deployMatch = path.match(/^\/api\/v1\/registry\/agents\/([^\/]+)\/deploy$/);
  if (deployMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = deployMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (agent.state !== 'PENDING_DEPLOY') {
      json(res, 400, { error: 'Agent must be PENDING_DEPLOY before deployment' });
      return;
    }
    
    if (!state.deployProvider) {
      json(res, 501, { error: 'deploy_provider_not_configured', message: 'No deploy provider bound. Configure a DeployProvider for your target cloud.' });
      return;
    }

    agent.state = 'DEPLOYING';
    json(res, 202, agent);
    
    void (async () => {
      try {
        const dp = state.deployProvider!;
        const isPrebuiltImage = Boolean(agent.artifact && (agent.artifact.startsWith('oci://') || agent.artifact.includes('.dkr.ecr.') || agent.artifact.includes('ghcr.io') || agent.artifact.includes('docker.io') || agent.artifact.includes('gcr.io') || agent.artifact.includes('-docker.pkg.dev')));
        let imageUri = '';
        if (isPrebuiltImage) {
          imageUri = agent.artifact.replace(/^oci:\/\//, '');
          console.log(`[control-plane] Using pre-built OCI image for ${agentId}: ${imageUri}`);
        } else {
          console.log(`[control-plane] Building image for ${agentId}...`);
          imageUri = await dp.buildImage(agentId, agent.artifact);
        }

        console.log(`[control-plane] Provisioning identity for ${agentId}...`);
        const { identity, executionIdentity } = await dp.provisionIdentity(agentId, agent.requires);
        console.log(`[control-plane] Registering compute for ${agentId}...`);
        await dp.registerCompute(agentId, imageUri, agent.requires, identity, executionIdentity);

        agent.state = 'SLEEPING'; // Officially online
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'AGENT_DEPLOYED',
          actor: principal.actor
        });
      } catch (err) {
        console.error(`[control-plane] Deploy failed for ${agentId}:`, err);
        agent.state = 'ERROR';
      }
    })();
    return;
  }
  
  if (path === '/api/v1/policies/budget' && req.method === 'PUT') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    state.policies.set('__global__', checked.policy);
    json(res, 200, checked.policy);
    return;
  }

  // Model Governance: Approve candidate model for production use
  const approveModelMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/models\/approve$/);
  if (approveModelMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = approveModelMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const b = await readJson(req);
    if (typeof b.model !== 'string' || !b.model.trim()) {
      json(res, 400, { error: 'model_required', message: 'A model identifier string is required' });
      return;
    }
    const targetModel = b.model.trim();
    if (!agent.approvedModels) {
      agent.approvedModels = [agent.model || 'gemini-2.0-flash'];
    }
    if (!agent.approvedModels.includes(targetModel)) {
      agent.approvedModels.push(targetModel);
    }
    // Synchronize into egress policy so the Gateway immediately permits it
    const currentPolicy = state.policies.get(agentId);
    const mergedModels = Array.from(new Set([...(currentPolicy.models || []), targetModel]));
    state.policies.set(agentId, {
      ...currentPolicy,
      models: mergedModels,
    });
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'MODEL_APPROVED',
      actor: principal.actor,
      model: targetModel,
    });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, { success: true, agent, approvedModels: agent.approvedModels });
    return;
  }

  // Model Governance: Switch active production model (strictly guarded by approvedModels)
  const switchModelMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/model$/);
  if (switchModelMatch && (req.method === 'POST' || req.method === 'PUT')) {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = switchModelMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const b = await readJson(req);
    if (typeof b.model !== 'string' || !b.model.trim()) {
      json(res, 400, { error: 'model_required', message: 'A model identifier string is required' });
      return;
    }
    const targetModel = b.model.trim();
    const approved = agent.approvedModels && agent.approvedModels.length > 0
      ? agent.approvedModels
      : [agent.model || 'gemini-2.0-flash'];
    if (!approved.includes(targetModel)) {
      json(res, 400, {
        error: 'model_not_approved',
        message: `Model "${targetModel}" has not been approved for this agent. Approve it first via training validation.`,
        approvedModels: approved,
      });
      return;
    }
    agent.model = targetModel;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'MODEL_SWITCHED',
      actor: principal.actor,
      activeModel: targetModel,
    });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, { success: true, agent, activeModel: targetModel });
    return;
  }
  // --- END REGISTRY SERVICE ---
  json(res, 404, { error: 'not_found' });
}
