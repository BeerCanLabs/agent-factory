import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type http from 'node:http';
import type { ChainedEvent, LedgerStore } from '@beercanlabs/factory-ledger';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { isTerminal, type Run } from './runs.js';

const execFileAsync = promisify(execFile);

/** Everything the factory announces. Ledger rows are metadata-only, so they are safe to fan out. */
export type FactoryEvent =
  | { kind: 'ledger'; agentId: string; event: ChainedEvent }
  | { kind: 'run'; agentId: string; run: Pick<Run, 'runId' | 'agentId' | 'state' | 'trigger' | 'updatedAt' | 'error'> }
  | { kind: 'progress'; agentId: string; progress: ProgressEvent };

export class EventHub {
  private readonly subs = new Set<(e: FactoryEvent) => void>();

  subscribe(fn: (e: FactoryEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(e: FactoryEvent) {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch (err) {
        console.error(`[events] subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** The hub a ledger was tapped into, so request handlers can publish without new state wiring. */
const hubs = new WeakMap<object, EventHub>();

export function hubOf(ledger: object): EventHub | undefined {
  return hubs.get(ledger);
}

/** Publish every appended ledger row to the hub without changing the store's behavior. */
export function tapLedger<T extends LedgerStore>(ledger: T, hub: EventHub): T {
  hubs.set(ledger, hub);
  const append = ledger.append.bind(ledger);
  ledger.append = (event: Record<string, unknown>) => {
    const row = append(event);
    hub.publish({ kind: 'ledger', agentId: row.agentId, event: row });
    return row;
  };
  return ledger;
}

export function runEvent(run: Run): FactoryEvent {
  return {
    kind: 'run',
    agentId: run.agentId,
    run: { runId: run.runId, agentId: run.agentId, state: run.state, trigger: run.trigger, updatedAt: run.updatedAt, error: run.error },
  };
}

/** Events worth putting on an enterprise bus: run outcomes and blocks, budget alerts, crashes, approval requests. */
export function isBusWorthy(e: FactoryEvent): boolean {
  if (e.kind === 'progress') return false;
  if (e.kind === 'run') return !['QUEUED', 'STARTING', 'WORKING'].includes(e.run.state);
  return e.event.type === 'budget.alert' || e.event.type === 'crash' || e.event.action === 'APPROVAL_REQUESTED';
}

export type BusSink = { name: string; send(events: FactoryEvent[]): Promise<void> };

/** NDJSON file (Compose, tests). */
export function fileSink(path: string): BusSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    name: `file:${path}`,
    async send(events) {
      appendFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
  };
}

export type AwsCli = (args: string[]) => Promise<string>;

/** Amazon EventBridge. Source `agent-factory`, detail-type `factory.<kind>`. Up to 10 entries per call. */
export function eventBridgeSink(bus: string, cli?: AwsCli): BusSink {
  const run: AwsCli =
    cli ??
    (async (args) => {
      const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
      return (await execFileAsync('aws', [...args, ...region, '--output', 'json'], { encoding: 'utf8' })).stdout;
    });
  return {
    name: `eventbridge:${bus}`,
    async send(events) {
      for (let i = 0; i < events.length; i += 10) {
        const entries = events.slice(i, i + 10).map((e) => ({
          EventBusName: bus,
          Source: 'agent-factory',
          DetailType: `factory.${e.kind}`,
          Detail: JSON.stringify(e),
        }));
        const out = JSON.parse((await run(['events', 'put-events', '--entries', JSON.stringify(entries)])) || '{}') as { FailedEntryCount?: number };
        if (out.FailedEntryCount) throw new Error(`EventBridge rejected ${out.FailedEntryCount} event(s)`);
      }
    },
  };
}

export function busSinkFromEnv(env: NodeJS.ProcessEnv = process.env): BusSink | undefined {
  const spec = env.FACTORY_EVENT_BUS;
  if (!spec) return undefined;
  if (spec.startsWith('eventbridge:')) return eventBridgeSink(spec.slice('eventbridge:'.length));
  if (spec.startsWith('file://')) return fileSink(spec.slice('file://'.length));
  throw new Error(`FACTORY_EVENT_BUS must be eventbridge:<bus> or file://<path>, got ${spec}`);
}

/** Batch bus-worthy events and ship them; failures are retried on the next flush. */
export function attachBus(hub: EventHub, sink: BusSink, flushMs = 1000): { flush(): Promise<void>; stop(): void } {
  let pending: FactoryEvent[] = [];
  const off = hub.subscribe((e) => {
    if (isBusWorthy(e)) pending.push(e);
  });
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      await sink.send(batch);
    } catch (err) {
      pending = [...batch, ...pending].slice(-10_000);
      console.error(`[events] ${sink.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(() => void flush(), flushMs);
  timer.unref();
  return {
    flush,
    stop() {
      clearInterval(timer);
      off();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Run progress (§6.5, TSK-056): gatekeeper-egress reports each outbound call it handles for a run; the control plane
// keeps a short in-memory ring per run and serves it to that run only. Metadata only: never bodies, URLs, headers
// or secrets (E3, S1). Not persisted and not bus-worthy: it exists to narrate a live run, not to audit it (the ledger
// does that).
// ---------------------------------------------------------------------------------------------------------------

export type ProgressOutcome = 'ok' | 'denied' | 'error' | 'timeout';

export type ProgressEvent = {
  /** Per-run sequence, assigned by the control plane; `?after=<seq>` resumes from it. */
  seq: number;
  runId: string;
  agentId: string;
  at: string;
  kind: 'call.start' | 'call.end';
  /** Correlates a call's start and end. Opaque, assigned by gatekeeper-egress. */
  callId: string;
  route: string;
  model?: string;
  status?: number;
  durationMs?: number;
  outcome?: ProgressOutcome;
};

/** Events kept per run. */
export const PROGRESS_RING = 100;
/** Runs with a ring at once; the least recently written is dropped first. */
export const PROGRESS_RUNS = 1000;
/** Longest a reader waits for a new event. */
export const PROGRESS_MAX_WAIT_MS = 20_000;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const OUTCOMES = new Set<ProgressOutcome>(['ok', 'denied', 'error', 'timeout']);

/**
 * Keep only the declared fields, with their declared types. Anything else the sender included (a body, a URL, a
 * header) is dropped here, so nothing but call metadata can reach a reader.
 */
export function sanitizeProgress(raw: unknown): Omit<ProgressEvent, 'seq'> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.runId !== 'string' || !ID.test(r.runId)) return undefined;
  if (typeof r.agentId !== 'string' || !ID.test(r.agentId)) return undefined;
  if (typeof r.callId !== 'string' || !ID.test(r.callId)) return undefined;
  if (typeof r.route !== 'string' || !ID.test(r.route)) return undefined;
  if (r.kind !== 'call.start' && r.kind !== 'call.end') return undefined;
  const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
  const e: Omit<ProgressEvent, 'seq'> = { runId: r.runId, agentId: r.agentId, at, kind: r.kind, callId: r.callId, route: r.route };
  if (typeof r.model === 'string' && ID.test(r.model)) e.model = r.model;
  if (typeof r.status === 'number' && Number.isInteger(r.status) && r.status >= 100 && r.status < 600) e.status = r.status;
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) e.durationMs = Math.round(r.durationMs);
  if (typeof r.outcome === 'string' && OUTCOMES.has(r.outcome as ProgressOutcome)) e.outcome = r.outcome as ProgressOutcome;
  return e;
}

type Ring = { seq: number; events: ProgressEvent[]; waiters: Set<() => void> };

/** Bounded per-run rings of progress events, with long-poll readers. */
export class RunProgress {
  private readonly rings = new Map<string, Ring>();

  constructor(
    private readonly perRun = PROGRESS_RING,
    private readonly maxRuns = PROGRESS_RUNS,
  ) {}

  private ring(runId: string): Ring {
    let r = this.rings.get(runId);
    if (r) {
      // Most recently written goes last, so eviction takes the stalest run.
      this.rings.delete(runId);
      this.rings.set(runId, r);
      return r;
    }
    r = { seq: 0, events: [], waiters: new Set() };
    this.rings.set(runId, r);
    while (this.rings.size > this.maxRuns) {
      const oldest = this.rings.keys().next().value as string;
      const gone = this.rings.get(oldest)!;
      this.rings.delete(oldest);
      for (const w of gone.waiters) w();
    }
    return r;
  }

  append(e: Omit<ProgressEvent, 'seq'>): ProgressEvent {
    const r = this.ring(e.runId);
    const event: ProgressEvent = { seq: ++r.seq, ...e };
    r.events.push(event);
    if (r.events.length > this.perRun) r.events.splice(0, r.events.length - this.perRun);
    const waiters = [...r.waiters];
    r.waiters.clear();
    for (const w of waiters) w();
    return event;
  }

  /** Events after `after` (all buffered ones when omitted), and the cursor to pass next time. */
  read(runId: string, after?: number): { events: ProgressEvent[]; next: number } {
    const r = this.rings.get(runId);
    if (!r) return { events: [], next: after ?? 0 };
    const events = after === undefined ? [...r.events] : r.events.filter((e) => e.seq > after);
    return { events, next: r.seq };
  }

  /** Resolves with what `read` returns once there is something after `after`, or after `waitMs`. */
  wait(runId: string, after: number | undefined, waitMs: number, signal?: AbortSignal): Promise<{ events: ProgressEvent[]; next: number }> {
    const now = this.read(runId, after);
    if (now.events.length || waitMs <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const r = this.ring(runId);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        r.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(this.read(runId, after));
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      r.waiters.add(finish);
      signal?.addEventListener('abort', finish);
    });
  }

  /** Number of runs holding a ring (for tests and metrics). */
  get size(): number {
    return this.rings.size;
  }
}

const progressStores = new WeakMap<object, RunProgress>();

/** The control plane's progress rings (one per factory state). */
export function progressOf(state: FactoryState): RunProgress {
  let p = progressStores.get(state);
  if (!p) {
    p = new RunProgress();
    progressStores.set(state, p);
  }
  return p;
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * `POST /api/v1/gatekeeper-egress/progress` (gatekeeper-egress role): a batch of progress events.
 * `GET /api/v1/runs/:id/events?after=<seq>&wait=<ms>` (that run's own token, while live): the run's progress.
 * Returns false when the request is not one of these.
 */
export async function handleRunProgress(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/gatekeeper-egress/progress' && req.method === 'POST') {
    if (!(await requirePrivilege(req, res, state, 'egress.progress.report'))) return true;
    const body = await readJson(req);
    const batch = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    const progress = progressOf(state);
    const hub = hubOf(state.ledger);
    let accepted = 0;
    for (const raw of batch) {
      const e = sanitizeProgress(raw);
      if (!e) continue;
      // Attribution comes from the run itself: an event naming another agent is not this run's.
      const run = state.runs.get(e.runId);
      if (!run || run.agentId !== e.agentId || isTerminal(run.state)) continue;
      const stored = progress.append(e);
      hub?.publish({ kind: 'progress', agentId: stored.agentId, progress: stored });
      accepted++;
    }
    json(res, 200, { accepted });
    return true;
  }

  const m = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
  if (m && req.method === 'GET') {
    const runId = decodeURIComponent(m[1]);
    // Only this run's own live token reads this run's progress (like /input).
    const claims = await state.runTokens.verify(bearer(req));
    const run = claims && claims.runId === runId ? state.runs.get(runId) : undefined;
    if (!claims || !run || run.agentId !== claims.agentId || isTerminal(run.state)) {
      json(res, 401, { error: 'invalid_run_token' });
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : undefined;
    const waitRaw = parseInt(url.searchParams.get('wait') ?? String(PROGRESS_MAX_WAIT_MS), 10);
    const waitMs = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), PROGRESS_MAX_WAIT_MS) : PROGRESS_MAX_WAIT_MS;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const out = await progressOf(state).wait(runId, after, after === undefined ? 0 : waitMs, abort.signal);
    if (!res.writableEnded && !res.destroyed) json(res, 200, { runId, ...out });
    return true;
  }
  return false;
}
