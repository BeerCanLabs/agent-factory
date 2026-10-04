import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import { redactSecrets, type CheckpointSink, type LedgerStore } from '@beercanlabs/factory-ledger';
import { accessAssertionOf, hasRole, type AccessAuth, type AuthProvider, type AuthResult, type Principal, type Role } from '@beercanlabs/factory-auth';
import type { Meter } from '@opentelemetry/api';
import { classifySecrets, type Surface } from '@beercanlabs/factory-contract';
import { AgentRecord, isBuiltinCartridge, BUILTIN_AGENT_IDS, connectionsOf, credentialsOf, egressOf, type AgentCategory } from './catalog.js';
import { AdmissionRefusedError, FULL_SHA, type DeployProvider, type Runtime, type SourceRef } from './runtime.js';
import { checkRepoUrl, gitLsRemoteResolver, type CommitResolver, type SkillSource } from './source.js';
import { isTerminal, type Run, type RunState, type RunStore, type RunTokens } from './runs.js';
import { checkCallbackUrl, deliverCallback, type CallbackPolicy } from './callbacks.js';
import { checkStanding, spendDetail, type SpendTracker } from '@beercanlabs/factory-budget';
import type { Approval, ApprovalStore, HeldRequest } from '@beercanlabs/factory-bouncer';
import { validatePolicy, type PolicyStore } from './policy.js';

/** E9: the largest held request body the control plane keeps (characters, base64 included). */
const HELD_BODY_LIMIT = 256 * 1024;
import { Keymaster, type ConnectionKeymaster } from '@beercanlabs/factory-keymaster';
import { handleConnections } from './connections.js';
import { handleCredentials } from './credentials.js';
import { changeReason, handleConfig, recordConfig, removeConfig, type ConfigStore } from './config-store.js';
import { handleSkills, resumeSkillChecks } from './skills.js';
import type { SkillChecker } from './skill-checks.js';
import { handleRunProgress } from './events.js';
import { handleSchedules, type ScheduleStore } from './schedules.js';
import { handleSystems, type SystemsStore } from './systems.js';
import { gatekeeperEgressEnv } from '@beercanlabs/factory-hydrate';

export type FactoryState = {

  agents: Map<string, AgentRecord>;
  /** Models the factory offers (§6.9 M3, FACTORY_MODEL_CATALOG), by neutral name. */
  modelCatalog?: Record<string, { provider: string; price?: { inputPerMTok: number; outputPerMTok: number } }>;
  /** The model a policy that names none grants (M2; FACTORY_DEFAULT_MODEL, default claude-haiku-4-5). */
  defaultModel?: string;
  registryDir?: string;
  ledger: LedgerStore;
  auth: AuthProvider;
  /**
   * §6.12 A2: the identity-aware proxy's signed assertion, verified against its issuer, audience and keys. Absent:
   * Access identity is disabled and only factory credentials (bearer tokens, OIDC, run tokens) authenticate.
   */
  access?: AccessAuth;
  version: string;
  providers: SecretProvider[];
  runtime: Runtime;
  /** Provider-specific deploy lifecycle (build → identity → compute). Absent = deploy endpoint returns 501. */
  deployProvider?: DeployProvider;
  /** Pins a registration that names no commit to the repository's default-branch HEAD. Default: `git ls-remote`. */
  resolveCommit?: CommitResolver;
  runs: RunStore;
  runTokens: RunTokens;
  callbacks: CallbackPolicy;
  policies: PolicyStore;
  /** §6.14 SK3: every agent's versioned deployment configuration, held in memory and written through on change. */
  configs?: ConfigStore;
  /**
   * §6.14 SK1: runs the factory's checks on a registered skill version's code. Unset: chosen from the environment
   * (skill-checks.ts `skillCheckerFromEnv`); null: none.
   */
  skillChecker?: SkillChecker | null;
  /**
   * §6.14 SK1, TSK-055: where registration reads a skill's `skill.yaml` when the caller sends none, and resolves a
   * branch or tag to its commit. Unset: git with the factory's read-only source token (`gitSkillSource`).
   */
  skillSource?: SkillSource;
  spend: SpendTracker;
  approvals: ApprovalStore;
  keymaster?: Keymaster;
  /** Keymaster connections (§6.11): OAuth grants and app credentials. Created on first use. */
  connections?: ConnectionKeymaster;
  /** The factory's public origin for browser flows (OAuth consent callbacks). From the landing zone; never hard-coded. */
  publicBaseUrl?: string;
  /** Signs OAuth consent state. Defaults to the callback signing key. */
  connectionStateKey?: string;
  schedules?: ScheduleStore;
  /** Systems as factory data (§6.3.1 E10): approved external system definitions. */
  systems?: SystemsStore;
  /** URL agents use to reach the control plane (result reporting, input fetch). */
  publicUrl?: string;
  /** URL agents use to reach the gatekeeper-egress; handed to every run as FACTORY_GATEKEEPER_EGRESS_URL. */
  gatekeeperEgressUrl?: string;
  /** Max wall-clock per run before it is stopped as TIMED_OUT. 0 disables. */
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  gatekeeperIngressUrl?: string;
  /** Presented to gatekeeper-ingress's presence API. */
  gatekeeperIngressToken?: string;
  /** A run that has sent heartbeats is halted as BLOCKED_UNHEALTHY after this much silence. 0 disables. */
  heartbeatTimeoutMs?: number;
  /** Halt a run whose reported RSS exceeds this. 0 disables. */
  maxRssMb?: number;
  /** Consecutive failed runs within 10 minutes that pause the agent. 0 disables. */
  crashLoopThreshold?: number;
  metrics?: FactoryMetrics;
  secretValues: Set<string>;
  /** Short-lived cache of bound secret values, so pre-flight and redaction do not hit the vault on every wake. */
  secretCache?: Map<string, { value: string; at: number }>;
  /** Provider keys only the gatekeeper-egress holds (injected at egress, S1). Pre-flight treats them as satisfied and never reads them. */
  gatekeeperEgressHeldSecrets?: Set<string>;
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

/** Writes a registry record so it survives a restart (and, being a registry record, wins over the static catalog). */
function persistAgent(state: FactoryState, agent: AgentRecord): void {
  if (!state.registryDir) return;
  try {
    mkdirSync(state.registryDir, { recursive: true });
    writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
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

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/**
 * §6.12 A2: who is calling, from a credential the factory verifies itself. The `Authorization` header (factory tokens,
 * OIDC) first, then the identity-aware proxy's signed assertion (`cf-access-jwt-assertion` or the `CF_Authorization`
 * cookie) when Access identity is configured. Unsigned identity headers (the proxy's plain email header) are never
 * read.
 */
export async function identify(req: http.IncomingMessage, state: FactoryState): Promise<AuthResult> {
  const reasons: string[] = [];
  if (req.headers.authorization) {
    const r = await state.auth.verify(req.headers.authorization);
    if (r.ok) return r;
    reasons.push(r.reason);
  }
  const assertion = accessAssertionOf(req.headers);
  if (assertion && state.access) {
    const r = await state.access.verify(assertion);
    if (r.ok) return r;
    reasons.push(`access: ${r.reason}`);
  }
  return { ok: false, reason: reasons.join('; ') || 'no credential' };
}

export async function authenticate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
  role: Role,
): Promise<Principal | null> {
  const result = await identify(req, state);
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function notifyGatekeeperIngress(state: FactoryState, agentId: string, presence: 'offline' | 'starting' | 'available') {
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

export function enrichAgent(state: FactoryState, a: AgentRecord) {
  const s = state.spend.get(a.id, undefined);
  const pol = state.policies.get(a.id);
  const activeR = activeRun(state, a.id);
  const isBuiltin = Boolean(a.isBuiltin || a.category === 'builtin' || BUILTIN_AGENT_IDS.has(a.id));
  const category: AgentCategory = isBuiltin ? 'builtin' : (a.category ?? 'user');
  return {
    ...a,
    category,
    isBuiltin,
    budgetExempt: isBuiltin,
    version: (a as any).version || '1.0.0',
    state: activeR ? 'RUNNING' : a.state,
    currentSpendUsd: Number((s?.day ?? 0).toFixed(4)),
    currentSpendMonthlyUsd: Number((s?.month ?? 0).toFixed(4)),
    spendLimitUsd: isBuiltin ? null : Number((pol?.budgetUsd?.perDay ?? 0).toFixed(2)),
    spendLimitMonthlyUsd: isBuiltin ? null : Number((pol?.budgetUsd?.perMonth ?? 0).toFixed(2)),
    budgetUsd: isBuiltin ? undefined : pol?.budgetUsd,
    lastRunId: activeR?.runId,
    domain: (a as any).domain || (isBuiltin ? 'Platform Infrastructure' : 'Submind Autonomous Operations'),
    mindPrefix: a.memoryPrefix ? `s3://beercanlabs-minds/${a.memoryPrefix}/` : `s3://beercanlabs-minds/${a.id}/`,
    sqliteSizeKb: (a as any).sqliteSizeKb ?? 0,
  };
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

async function bindAgentSecrets(state: FactoryState, names: string[]): Promise<{ ok: true; env: Record<string, string> } | { ok: false; missing: string[] }> {
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

function scheduleTimeout(state: FactoryState, run: Run) {
  const prev = state.idleTimers.get(run.agentId);
  if (prev) clearTimeout(prev);
  const agent = state.agents.get(run.agentId);
  const idleWindowMs = (agent?.warmDownSeconds && agent.warmDownSeconds > 0)
    ? agent.warmDownSeconds * 1000
    : (state.idleMs > 0 ? state.idleMs : 3_600_000);
  // idleMs is a hard wall-clock cap from run start: activity can extend the idle window, never past the cap.
  const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const capMs = state.idleMs > 0 ? state.idleMs - (Date.now() - started) : Infinity;
  const timeoutMs = Math.max(0, Math.min(idleWindowMs, capMs));
  const t = setTimeout(() => {
    const cur = state.runs.get(run.runId);
    if (cur && !isTerminal(cur.state)) void finishRun(state, run.runId, 'TIMED_OUT', { actor: SYSTEM.idle });
  }, timeoutMs);
  t.unref?.();
  state.idleTimers.set(run.agentId, t);
}

/** Park a live run. The task keeps running; the gatekeeper-egress refuses its egress until unblocked. */
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

/** The single entry point for waking an agent: manual, webhook, cron, event route, gatekeeper-ingress. */
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

  // No run exists yet, so perRun does not apply. Built-ins stay exempt, same predicate as ledger ingest.
  const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
  if (!isBuiltin) {
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
      missing: bound.missing,
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
  await notifyGatekeeperIngress(state, agent.id, 'starting');
  const runToken = await state.runTokens.mint(run);
  const runEnv: Record<string, string> = {
    FACTORY_RUN_ID: run.runId,
    FACTORY_RUN_TOKEN: runToken,
    ...(state.publicUrl ? { FACTORY_URL: state.publicUrl } : {}),
    ...(run.model ? { FACTORY_MODEL: run.model } : {}),
    ...(state.gatekeeperEgressUrl ? { FACTORY_GATEKEEPER_EGRESS_URL: state.gatekeeperEgressUrl } : {}),
    ...gatekeeperEgressEnv({
      FACTORY_GATEKEEPER_EGRESS_URL: state.gatekeeperEgressUrl,
      FACTORY_RUN_TOKEN: runToken,
      FACTORY_EGRESS_ROUTES: (state.policies.has(agent.id) ? state.policies.get(agent.id).routes ?? [] : []).join(','),
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
  return cur;
}

/**
 * P1 readiness: the run's first input fetch, heartbeat or mailbox poll is the earliest signal from inside the
 * container that the agent process is running and can take a turn (a conversational worker fetches input on boot
 * or polls its mailbox for follow-ups; the shim heartbeats after spawning). Only then does presence go available.
 */
async function markRunReady(state: FactoryState, runId: string) {
  // Synchronous up to the notification, so the run is marked ready before the caller answers; the notification
  // itself never delays the run's heartbeat or mailbox reply.
  const run = state.runs.get(runId);
  if (!run || run.readyAt || run.state !== 'WORKING') return;
  const ready = state.runs.update(runId, { readyAt: new Date().toISOString() });
  record(state, ready, 'RUN_READY', `run:${run.agentId}`);
  await notifyGatekeeperIngress(state, run.agentId, 'available');
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
    await notifyGatekeeperIngress(state, agent.id, 'offline');
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
  if (state.registryDir) {
    try {
      const filePath = join(state.registryDir, `${id}.json`);
      if (existsSync(filePath)) {
        writeFileSync(filePath, JSON.stringify(agent, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn(`[control-plane] failed to persist dynamic agent state ${id}:`, err);
    }
  }
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
    args: { approvalId: { type: 'string' }, decision: { type: 'string' }, notes: { type: 'string' } },
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
  if (name === 'decide_approval') return (await decideApproval(state, args.approvalId, args.decision, actor, args.notes)).body;
  const id = args.id;
  if (!id) return { error: 'id required' };
  if (name === 'wake_agent') return (await createRun(state, id, { actor, trigger: 'mcp' })).body;
  if (name === 'pause_agent') return (await applyKillSwitch(state, id, 'PAUSE', actor)).body;
  if (name === 'resume_agent') return (await applyKillSwitch(state, id, 'RESUME', actor)).body;
  if (name === 'isolate_agent') return (await applyKillSwitch(state, id, 'ISOLATE', actor)).body;
  return { error: `unknown tool ${name}` };
}

async function decideApproval(state: FactoryState, id: string, decision: unknown, actor: string, notes?: unknown): Promise<Outcome<unknown>> {
  if (decision !== 'approve' && decision !== 'reject') return { status: 400, body: { error: 'decision must be approve or reject' } };
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 4000)) return { status: 400, body: { error: 'notes must be text, at most 4000 characters' } };
  const note = typeof notes === 'string' && notes.trim() ? notes.trim() : undefined;
  const decided = state.approvals.decide(id, decision === 'approve' ? 'approved' : 'rejected', actor, note);
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
  if (decided.kind === 'held') {
    // E9: the decision goes to the agent; no run waited for it.
    const delivered = await deliverDecision(state, decided, actor);
    return { status: 200, body: { ...decided, delivered } };
  }
  if (!state.approvals.list({ state: 'pending', runId: decided.runId }).length) {
    unblockRun(state, decided.runId, 'BLOCKED_FOR_HUMAN', actor);
  }
  return { status: 200, body: decided };
}

/**
 * E9: tell the agent what was decided about its held request: into the mailbox of its live run, or as the input of a new
 * run. Approved: send the identical request again to release it. Rejected: nothing was sent; `notes` say why.
 */
async function deliverDecision(state: FactoryState, a: Approval, actor: string): Promise<'mailbox' | 'run' | 'not_delivered'> {
  const payload = {
    type: 'approval',
    approvalId: a.approvalId,
    route: a.route,
    request: a.request ? { method: a.request.method, path: a.request.path } : undefined,
    decision: a.state === 'approved' ? 'approved' : 'rejected',
    ...(a.notes ? { notes: a.notes } : {}),
    decidedBy: a.decidedBy,
    decidedAt: a.decidedAt,
  };
  if (activeRun(state, a.agentId)) {
    deliverToMailbox(state, a.agentId, payload);
    return 'mailbox';
  }
  const out = await createRun(state, a.agentId, { actor, trigger: 'approval', input: payload });
  if (out.status < 300) return 'run';
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: a.agentId,
    type: 'action',
    action: 'APPROVAL_DECISION_UNDELIVERED',
    actor,
    approvalId: a.approvalId,
    route: a.route,
  });
  return 'not_delivered';
}

function bearerOf(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Authenticate a run token for exactly this run while it is still live. */
async function authenticateRun(req: http.IncomingMessage, res: http.ServerResponse, state: FactoryState, runId: string) {
  const claims = await state.runTokens.verify(bearerOf(req));
  const run = claims && claims.runId === runId ? state.runs.get(runId) : undefined;
  const isResultPost = (req.url?.includes('/result') || false) && req.method === 'POST';
  if (!claims || !run || run.agentId !== claims.agentId || (isTerminal(run.state) && (!isResultPost || run.state !== 'TIMED_OUT'))) {
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
  // SK1: follow skill checks a previous control plane started and did not see end.
  void resumeSkillChecks(state).catch((err) => console.warn('[control-plane] could not resume skill checks:', err));
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

  if ((path.startsWith('/api/v1/connections/') || path === '/api/v1/gatekeeper-egress/connections/token') && (await handleConnections(state, req, res, path))) return;
  if (path.startsWith('/api/v1/keymaster/') && (await handleCredentials(state, req, res, path))) return;
  if (await handleConfig(state, req, res, path)) return;
  if ((path.startsWith('/api/v1/registry/skills') || path.startsWith('/api/v1/skills')) && (await handleSkills(state, req, res, path))) return;
  if (await handleRunProgress(state, req, res, path)) return;
  if (path.startsWith('/api/v1/schedules') && (await handleSchedules(state, req, res, path))) return;
  if ((path.startsWith('/api/v1/systems') || path === '/api/v1/gatekeeper-egress/routes') && (await handleSystems(state, req, res, path))) return;

  if ((path === '/healthz' || path === '/' || path === '/api/v1/health') && req.method === 'GET') {

    json(res, 200, {
      status: 'ok',
      version: state.version,
      uptime: Math.round((Date.now() - started) / 1000),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // The caller's verified identity and roles (the dashboard shows what the factory will actually allow).
  if (path === '/api/v1/whoami' && req.method === 'GET') {
    const who = await identify(req, state);
    if (!who.ok) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { actor: who.principal.actor, roles: who.principal.roles });
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
    let totalBudgetDay = 0;
    let totalBudgetMonth = 0;
    for (const id of state.agents.keys()) {
      const a = state.agents.get(id);
      const isBuiltin = Boolean(a?.isBuiltin || a?.category === 'builtin' || BUILTIN_AGENT_IDS.has(id));
      const s = state.spend.get(id, undefined);
      daySpend += s.day;
      monthSpend += s.month;
      if (!isBuiltin) {
        const pol = state.policies.get(id);
        if (pol?.budgetUsd?.perDay) {
          totalBudgetDay += pol.budgetUsd.perDay;
        }
        if (pol?.budgetUsd?.perMonth) {
          totalBudgetMonth += pol.budgetUsd.perMonth;
        }
      }
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
        limit: Number(totalBudgetDay.toFixed(2)),
        monthLimit: Number(totalBudgetMonth.toFixed(2)),
      },
    });
    return;
  }

  // TSK-045: per-agent model spend (gatekeeper-egress-metered `llm` rows) for the current UTC day and month. Counts only:
  // no prompt bodies, no secrets. A verified viewer, or a live run whose agent's admin-set policy grants the
  // `factory-spend` tool (E7: never implied). Every read is ledgered.
  if (path === '/api/v1/spend' && req.method === 'GET') {
    let actor: string;
    let agentId = 'factory';
    const claims = await state.runTokens.verify(bearerOf(req));
    if (claims) {
      const run = state.runs.get(claims.runId);
      if (!run || run.agentId !== claims.agentId || isTerminal(run.state)) return json(res, 401, { error: 'invalid_run_token' });
      // Only a policy an admin set for this agent counts; the factory fallback policy never grants it.
      const granted = state.policies.has(claims.agentId) && Object.prototype.hasOwnProperty.call(state.policies.get(claims.agentId).tools ?? {}, 'factory-spend');
      if (!granted) {
        return json(res, 403, { error: 'forbidden', required: 'policy.tools.factory-spend' });
      }
      actor = `run:${claims.agentId}:${claims.runId}`;
      agentId = claims.agentId;
    } else {
      const principal = await authenticate(req, res, state, 'viewer');
      if (!principal) return;
      actor = principal.actor;
    }
    const report = state.spend.report();
    const round = <T extends { usd: number }>(w: T): T => ({ ...w, usd: Number(w.usd.toFixed(6)) });
    const agents = Object.fromEntries(
      Object.entries(report.agents).map(([id, a]) => [
        id,
        Object.fromEntries(
          (['day', 'month'] as const).map((k) => [k, { ...round(a[k]), byModel: Object.fromEntries(Object.entries(a[k].byModel).map(([m, c]) => [m, round(c)])) }]),
        ),
      ]),
    );
    const total = (k: 'day' | 'month') => Number(Object.values(report.agents).reduce((n, a) => n + a[k].usd, 0).toFixed(6));
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'SPEND_READ', actor });
    json(res, 200, { currency: 'USD', day: report.day, month: report.month, totalUsd: { day: total('day'), month: total('month') }, agents });
    return;
  }

  if (path === '/api/v1/triage' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    const failedRuns = state.runs.list({}).filter((r) => r.state === 'FAILED' || r.error);
    const incidents = failedRuns.map((r) => ({
      id: `inc-${r.runId.slice(0, 8)}`,
      timestamp: r.updatedAt || r.startedAt || r.createdAt || new Date().toISOString(),
      agentId: r.agentId,
      severity: r.error?.includes('OOM') ? 'CRITICAL' : 'ERROR',
      category: r.missing ? 'SECRET_MISSING' : r.error?.includes('timeout') ? 'TIMEOUT' : 'CRASH_LOOP',
      message: r.error || 'Run terminated with failure state',
    }));
    json(res, 200, incidents);
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
      void markRunReady(state, run.runId);
      json(res, 200, { ok: true, state: state.runs.get(run.runId)?.state });
      return;
    }
    if (runSelf[2] === 'input') {
      void markRunReady(state, run.runId);
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
      void markRunReady(state, run.runId);
      // Polling is not activity: refreshing the timeout here let a looping agent keep itself alive forever.
      // Only a delivered conversation turn extends the idle window (see the conversation handler).
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
    json(res, 200, [...state.agents.values()].map((a) => enrichAgent(state, a)));
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
      agent: url.searchParams.get('agent') || url.searchParams.get('agentId') || undefined,
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
    // The gatekeeper-egress verified the run token, so it may attest the run as the actor. Other writers may not.
    const isGatekeeperEgress = hasRole({ ...principal, roles: principal.roles.filter((r) => r !== 'admin') }, 'gatekeeper-egress');
    const run = typeof event.runId === 'string' ? state.runs.get(event.runId) : undefined;
    if (isGatekeeperEgress && event.runId !== undefined && (!run || run.agentId !== event.agentId)) {
      json(res, 400, { error: 'runId does not belong to agentId' });
      return;
    }
    const actor = isGatekeeperEgress && run && event.actor === `run:${run.agentId}` ? event.actor : principal.actor;
    const stored = state.ledger.append({
      ...event,
      ...(isGatekeeperEgress ? {} : { costUsd: undefined }),
      agentId: event.agentId,
      type: event.type,
      actor,
      timestamp: new Date().toISOString(),
    });
    if (isGatekeeperEgress && stored.type === 'llm' && typeof stored.costUsd === 'number') {
      const agent = state.agents.get(stored.agentId);
      const isBuiltin = Boolean(agent?.isBuiltin || agent?.category === 'builtin' || BUILTIN_AGENT_IDS.has(stored.agentId));
      const policy = state.policies.get(stored.agentId);
      // `before` must be read before the spend is added, or a crossing is never detected.
      const beforeStanding = checkStanding({ limits: policy?.budgetUsd, spend: state.spend.get(stored.agentId, stored.runId) });
      const before = beforeStanding.inGoodStanding ? undefined : beforeStanding.window;
      state.spend.add(stored.agentId, stored.runId, stored.costUsd, stored.timestamp, spendDetail(stored));
      if (!isBuiltin) {
        const afterStanding = checkStanding({ limits: policy?.budgetUsd, spend: state.spend.get(stored.agentId, stored.runId) });
        const after = afterStanding.inGoodStanding ? undefined : afterStanding.window;
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
    }
    await routeEvents(state, stored);
    json(res, 201, { ok: true });
    return;
  }

  // §6.9 M3: the models this factory offers (operations config), for the admin choosing an agent's models. Names,
  // providers and prices only; provider model ids and regions stay with gatekeeper-egress.
  if (path === '/api/v1/models' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    json(res, 200, {
      models: Object.entries(state.modelCatalog ?? {}).map(([name, m]) => ({ name, provider: m.provider, ...(m.price ? { price: m.price } : {}) })),
      // M2: what an agent gets when its policy names no models.
      default: state.defaultModel ?? 'claude-haiku-4-5',
    });
    return;
  }

  const policyMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/policy$/);
  if (policyMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const principal = await authenticate(req, res, state, req.method === 'GET' ? 'viewer' : 'admin');
    if (!principal) return;
    const agentId = policyMatch[1];
    const agent = state.agents.get(agentId);
    // GAP-060: a policy exists only for a known agent. `__global__` is not an agent: it is set through
    // PUT /api/v1/policies/budget, never here.
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    if (req.method === 'GET') {
      const pol = state.policies.get(agentId);
      if (isBuiltin) {
        delete pol.budgetUsd;
      }
      json(res, 200, pol);
      return;
    }
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    if (isBuiltin && checked.policy.budgetUsd !== undefined) {
      json(res, 400, {
        error: 'builtin_agents_exempt_from_budget',
        message: 'Built-in system agents are critical infrastructure and are exempt from spend limits. Budgets cannot be assigned.',
      });
      return;
    }
    state.policies.set(agentId, checked.policy);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'POLICY_UPDATED', actor: principal.actor });
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'policy updated') });
    for (const run of state.runs.list({ agentId, active: true })) {
      if (run.state === 'BLOCKED_BUDGET_EXCEEDED' && checkStanding({ limits: checked.policy?.budgetUsd, spend: state.spend.get(agentId, run.runId) }).inGoodStanding) {
        unblockRun(state, run.runId, 'BLOCKED_BUDGET_EXCEEDED', principal.actor);
      }
    }
    json(res, 200, checked.policy);
    return;
  }

  const gwRun = path.match(/^\/api\/v1\/gatekeeper-egress\/runs\/([^/]+)$/);
  if (gwRun && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return;
    const run = state.runs.get(gwRun[1]);
    const agent = run ? state.agents.get(run.agentId) : undefined;
    if (!run || !agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    const pol = state.policies.get(run.agentId);
    json(res, 200, {
      run: { runId: run.runId, agentId: run.agentId, state: run.state, live: !isTerminal(run.state), ...(run.model ? { model: run.model } : {}) },
      agentState: agent.state,
      isBuiltin,
      // E7: a policy set for this agent implies the factory model API; the global fallback never does.
      policySet: state.policies.has(run.agentId),
      policy: isBuiltin ? { ...pol, budgetUsd: undefined } : pol,
      spend: state.spend.get(run.agentId, run.runId),
    });
    return;
  }

  if (path === '/api/v1/gatekeeper-egress/approvals' && req.method === 'POST') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return;
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

  if (path === '/api/v1/gatekeeper-egress/holds' && req.method === 'POST') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return;
    const b = await readJson(req);
    const run = typeof b.runId === 'string' ? state.runs.get(b.runId) : undefined;
    const r = b.request as Record<string, unknown> | undefined;
    const valid =
      run && !isTerminal(run.state) && typeof b.route === 'string' && typeof b.argsSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.argsSha256) &&
      r && typeof r.method === 'string' && typeof r.path === 'string' && typeof r.body === 'string' && (r.bodyEncoding === 'utf8' || r.bodyEncoding === 'base64') &&
      r.body.length <= HELD_BODY_LIMIT && (r.headers === undefined || (typeof r.headers === 'object' && r.headers !== null && !Array.isArray(r.headers)));
    if (!valid || !run || !r) {
      json(res, 400, { error: 'live runId, route, argsSha256 and request {method, path, body, bodyEncoding} required' });
      return;
    }
    const headers = Object.fromEntries(Object.entries((r.headers ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
    // S1 backstop: the copy is shown to people, so every known secret value is masked in it.
    const text = (v: string) => redactSecrets(v, state.secretValues);
    const request: HeldRequest = {
      method: String(r.method).toUpperCase(),
      path: text(String(r.path)),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, text(v)])),
      body: r.bodyEncoding === 'utf8' ? text(String(r.body)) : String(r.body),
      bodyEncoding: r.bodyEncoding as 'utf8' | 'base64',
      ...(typeof r.preview === 'string' ? { preview: r.preview } : {}),
    };
    const { approval, created } = state.approvals.hold({
      runId: run.runId,
      agentId: run.agentId,
      route: String(b.route),
      tool: `${request.method} ${request.path.split('?')[0]}`,
      argsSha256: String(b.argsSha256),
      request,
    });
    if (created) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: run.agentId,
        runId: run.runId,
        type: 'action',
        action: 'REQUEST_HELD',
        actor: `run:${run.agentId}`,
        approvalId: approval.approvalId,
        route: approval.route,
        mcpName: approval.tool,
        payloadSha256: approval.argsSha256,
      });
    }
    json(res, created ? 201 : 200, { approvalId: approval.approvalId, state: approval.state, ...(approval.notes ? { notes: approval.notes } : {}) });
    return;
  }

  const gwConsume = path.match(/^\/api\/v1\/gatekeeper-egress\/approvals\/([^/]+)\/consume$/);
  if (gwConsume && req.method === 'POST') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return;
    const consumed = state.approvals.consume(gwConsume[1]);
    json(res, consumed ? 200 : 409, consumed ?? { error: 'approval not approved or already used' });
    return;
  }

  const kmCheckout = path === '/api/v1/keymaster/checkout' || path === '/api/v1/gatekeeper-egress/keymaster/checkout';
  if (kmCheckout && req.method === 'POST') {
    const isGatekeeperEgressPath = path.startsWith('/api/v1/gatekeeper-egress/');
    let actor: string | undefined;
    if (isGatekeeperEgressPath) {
      const principal = await authenticate(req, res, state, 'gatekeeper-egress');
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

    if (!isGatekeeperEgressPath) {
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
    const out = await decideApproval(state, decideMatch[1], b.decision, principal.actor, b.notes);
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
    if (BUILTIN_AGENT_IDS.has(agentId)) {
      json(res, 409, { error: 'builtin_agent', message: `${agentId} is a built-in system agent and cannot be registered` });
      return;
    }

    // §6.8 L3: a registration names a repository and is pinned to one exact commit, never a branch.
    const rawRepo = body.repo ?? cartridge.repo;
    let source: SourceRef | undefined;
    if (rawRepo !== undefined) {
      const repo = checkRepoUrl(rawRepo);
      if (!repo) {
        json(res, 400, { error: 'invalid_repo', message: 'repo must be an https git URL without embedded credentials' });
        return;
      }
      let commit = body.commit ?? cartridge.commit;
      if (commit !== undefined && (typeof commit !== 'string' || !FULL_SHA.test(commit))) {
        json(res, 400, { error: 'invalid_commit', message: 'commit must be a full 40-character lowercase git SHA' });
        return;
      }
      if (commit === undefined) {
        try {
          commit = await (state.resolveCommit ?? gitLsRemoteResolver)(repo);
        } catch (err) {
          json(res, 422, {
            error: 'commit_unresolved',
            message: `could not resolve the default-branch HEAD of ${repo}; pass "commit" explicitly (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'})`,
          });
          return;
        }
        if (typeof commit !== 'string' || !FULL_SHA.test(commit)) {
          json(res, 422, { error: 'commit_unresolved', message: `resolver returned no full SHA for ${repo}` });
          return;
        }
      }
      source = { repo, commit: commit as string };
    }

    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_REGISTERED',
      actor: principal.actor,
      ...(source ? { commit: source.commit } : {}),
    });
    
    // Only a first registration gets the global default; re-registering keeps the policy its owner set (GAP-048).
    const globalPolicy = state.policies.get('__global__');
    let stateResult: 'PENDING_BUDGET' | 'PENDING_DEPLOY' = 'PENDING_BUDGET';

    if (state.policies.has(agentId)) {
      if (state.policies.get(agentId).budgetUsd) stateResult = 'PENDING_DEPLOY';
    } else if (globalPolicy && globalPolicy.budgetUsd) {
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
    // M2: the models the cartridge was built for, preferred first. A request shown to the admin, never a grant.
    const requestedModels = Array.isArray(cartridge.requestedModels)
      ? cartridge.requestedModels
      : Array.isArray(cartridge.models)
      ? cartridge.models
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
      ...(source ? { repo: source.repo, commit: source.commit } : {}),
      ...connectionsOf(cartridge),
      ...credentialsOf({ secrets: cartridge.secrets ?? (Array.isArray(body.secrets) ? { requires: body.secrets } : undefined) }),
      ...egressOf(cartridge),
    };
    state.agents.set(record.id, record);

    // E7 deny-by-default: registration grants nothing. The cartridge's declared egress is a request an admin
    // reviews; routes, hosts, and budgets come only from the policy API.

    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${record.id}:`, err);
      }
    }
    await recordConfig(state, record.id, { actor: principal.actor, reason: changeReason(req, state.configs?.current(record.id) ? 're-registered' : 'registered') });
    json(res, 201, record);
    return;
  }
  
  if (path === '/api/v1/registry/agents' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return;
    json(res, 200, Array.from(state.agents.values()).map((a) => enrichAgent(state, a)));
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
    json(res, 200, enrichAgent(state, agent));
    return;
  }

  const budgetMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/budget$/);
  if (budgetMatch && req.method === 'PUT') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    const agentId = budgetMatch[1];
    const agent = state.agents.get(agentId);
    // GAP-060: never a budget (a policy) for an id that is not a known agent.
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    if (isBuiltin) {
      json(res, 400, {
        error: 'builtin_agents_exempt_from_budget',
        message: 'Built-in system agents are critical infrastructure and are exempt from spend limits. Budgets cannot be assigned.',
      });
      return;
    }
    const body = await readJson(req);
    let policyInput: unknown = body;
    if (body && typeof body === 'object' && 'spendLimitUsd' in body) {
      const currentPol = state.policies.get(agentId) ?? { routes: ['anthropic', 'openai'] };
      const period = (body as any).period === 'monthly' ? 'perMonth' : 'perDay';
      policyInput = {
        ...currentPol,
        budgetUsd: {
          ...currentPol.budgetUsd,
          [period]: Number((body as any).spendLimitUsd),
        },
      };
    }
    const checked = validatePolicy(policyInput);
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
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'budget updated') });
    if (state.registryDir) {
      try {
        mkdirSync(state.registryDir, { recursive: true });
        writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf8');
      } catch (err) {
        console.warn(`[control-plane] failed to persist dynamic agent ${agent.id}:`, err);
      }
    }
    json(res, 200, enrichAgent(state, agent));
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
    // GAP-060: a purged agent leaves no policy or configuration record behind. Both are recoverable: the policy file is
    // moved to policies-orphaned/, the configuration removal is versioned (R1).
    for (const id of state.policies.archive([agentId]).archived) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'POLICY_ORPHAN_ARCHIVED', actor: principal.actor });
    }
    try {
      await removeConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'agent purged') });
    } catch (err) {
      console.error(`[control-plane] configuration for ${agentId} not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    if (agent.isBuiltin || BUILTIN_AGENT_IDS.has(agent.id)) {
      json(res, 400, { error: 'builtin_agent', message: 'Built-in system agents are deployed with the platform, not through the registry' });
      return;
    }
    if (agent.state === 'DEPLOYING' || agent.state === 'RETIRED_PENDING_PURGE' || agent.state === 'PURGED') {
      json(res, 409, { error: 'invalid_state', message: `Agent is ${agent.state}` });
      return;
    }

    // A deploy request may re-pin the registered source to another exact commit (it is then admitted afresh).
    const body = await readJson(req);
    const repo = body.repo !== undefined ? checkRepoUrl(body.repo) : agent.repo;
    if (body.repo !== undefined && !repo) {
      json(res, 400, { error: 'invalid_repo', message: 'repo must be an https git URL without embedded credentials' });
      return;
    }
    const commit = body.commit !== undefined ? body.commit : agent.commit;
    if (body.commit !== undefined && (typeof commit !== 'string' || !FULL_SHA.test(commit))) {
      json(res, 400, { error: 'invalid_commit', message: 'commit must be a full 40-character lowercase git SHA' });
      return;
    }
    // L4: only an admitted commit deploys, as an image tagged by its SHA. A record without a pinned source, or
    // whose image is a mutable tag, is refused rather than built from "latest".
    if (!repo || typeof commit !== 'string' || !FULL_SHA.test(commit)) {
      json(res, 409, { error: 'commit_required', message: 'Register the agent with "repo" (and optionally "commit") before deploying; the factory deploys only a pinned, admitted commit' });
      return;
    }

    // L4 / E7: a policy owner must have set this agent's own policy, with at least one route, before it deploys.
    if (!state.policies.has(agentId) || state.policies.get(agentId).routes.length === 0) {
      json(res, 409, { error: 'policy_required', message: 'Set the agent policy (PUT /api/v1/agents/:id/policy) with at least one route before deploying' });
      return;
    }

    if (!state.deployProvider) {
      json(res, 501, { error: 'deploy_provider_not_configured', message: 'No deploy provider bound. Configure a DeployProvider for your target cloud.' });
      return;
    }

    const source: SourceRef = { repo, commit };
    const previousState = agent.state;
    agent.repo = repo;
    agent.commit = commit;
    agent.state = 'DEPLOYING';
    agent.admission = { commit, status: 'building', at: new Date().toISOString() };
    persistAgent(state, agent);
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, `deploy of ${commit}`) });
    json(res, 202, agent);

    void (async () => {
      const dp = state.deployProvider!;
      let imageUri: string;
      try {
        console.log(`[control-plane] Admission build for ${agentId} at ${commit}...`);
        imageUri = await dp.buildImage(agentId, source);
      } catch (err) {
        const refused = err instanceof AdmissionRefusedError;
        const reason = refused ? err.reason : 'build_failed';
        const message = redactSecrets(err instanceof Error ? err.message : String(err), state.secretValues ?? []);
        console.error(`[control-plane] Admission refused ${agentId}@${commit}: ${reason}: ${message}`);
        agent.admission = { commit, status: 'refused', reason, phase: refused ? err.phase : undefined, message, at: new Date().toISOString() };
        // A refused new version leaves the running version in place.
        agent.state = agent.deployedCommit ? (previousState === 'ERROR' ? 'SLEEPING' : previousState) : 'ERROR';
        persistAgent(state, agent);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: `AGENT_ADMISSION_REFUSED:${reason}`,
          actor: principal.actor,
          commit,
        });
        return;
      }
      try {
        agent.admission = { commit, status: 'admitted', at: new Date().toISOString() };
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'AGENT_ADMITTED',
          actor: principal.actor,
          commit,
        });
        console.log(`[control-plane] Provisioning identity for ${agentId}...`);
        const { identity, executionIdentity } = await dp.provisionIdentity(agentId, agent.requires);
        console.log(`[control-plane] Registering compute for ${agentId} with ${imageUri}...`);
        await dp.registerCompute(agentId, imageUri, agent.requires, identity, executionIdentity, agent.memoryPrefix ?? agentId);

        agent.artifact = imageUri;
        agent.deployedCommit = commit;
        agent.provider = 'cloud';
        agent.state = 'SLEEPING'; // Officially online
        persistAgent(state, agent);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'AGENT_DEPLOYED',
          actor: principal.actor,
          commit,
        });
      } catch (err) {
        console.error(`[control-plane] Deploy failed for ${agentId}:`, err);
        agent.state = 'ERROR';
        persistAgent(state, agent);
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'AGENT_DEPLOY_FAILED',
          actor: principal.actor,
          commit,
        });
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

  // GAP-062 (M2, E7): one place chooses an agent's models, its policy (`PUT /api/v1/agents/:id/policy`, the
  // console's Policy tab). The old approve and hot-swap endpoints granted models outside that editor and rewrote
  // the agent's declared preferred model, which no run reads. They are gone; a caller is told where to go instead.
  const retiredModelMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/(model|models\/approve)$/);
  if (retiredModelMatch && (req.method === 'POST' || req.method === 'PUT')) {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return;
    json(res, 410, {
      error: 'models_set_in_policy',
      message: `An agent's models are granted only in its policy: PUT /api/v1/agents/${retiredModelMatch[1]}/policy with "models".`,
    });
    return;
  }
  // --- END REGISTRY SERVICE ---
  json(res, 404, { error: 'not_found' });
}
