import { safeIdent, type ProgressEvent, type ProgressOutcome } from './progress.js';

// ---------------------------------------------------------------------------------------------------------------
// Run progress (§6.5, TSK-056): gatekeeper-egress reports each outbound call it handles for a run; the control plane
// keeps a short in-memory ring per run and serves it to that run only. Metadata only: never bodies, URLs, headers
// or secrets (E3, S1). Not persisted and not bus-worthy: it exists to narrate a live run, not to audit it (the ledger
// does that).
// ---------------------------------------------------------------------------------------------------------------

/** A progress event as the control plane keeps it: what gatekeeper-egress reported, plus a per-run sequence. */
export type RunProgressEvent = ProgressEvent & {
  /** Per-run sequence, assigned by the control plane; `?after=<seq>` resumes from it. */
  seq: number;
};

/** Events kept per run. */
export const PROGRESS_RING = 100;
/** Runs with a ring at once; the least recently written is dropped first. */
export const PROGRESS_RUNS = 1000;
/** Longest a reader waits for a new event. */
export const PROGRESS_MAX_WAIT_MS = 20_000;

/** `safeIdent`'s pattern as a type guard. */
const isIdent = (v: unknown): v is string => safeIdent(v) !== undefined;

const OUTCOMES = new Set<ProgressOutcome>(['ok', 'denied', 'error', 'timeout']);

/**
 * Keep only the declared fields, with their declared types. Anything else the sender included (a body, a URL, a
 * header) is dropped here, so nothing but call metadata can reach a reader.
 */
export function sanitizeProgress(raw: unknown): ProgressEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isIdent(r.runId)) return undefined;
  if (!isIdent(r.agentId)) return undefined;
  if (!isIdent(r.callId)) return undefined;
  if (!isIdent(r.route)) return undefined;
  if (r.kind !== 'call.start' && r.kind !== 'call.end') return undefined;
  const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
  const e: ProgressEvent = { runId: r.runId, agentId: r.agentId, at, kind: r.kind, callId: r.callId, route: r.route };
  if (isIdent(r.model)) e.model = r.model;
  if (typeof r.status === 'number' && Number.isInteger(r.status) && r.status >= 100 && r.status < 600) e.status = r.status;
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) e.durationMs = Math.round(r.durationMs);
  if (typeof r.outcome === 'string' && OUTCOMES.has(r.outcome as ProgressOutcome)) e.outcome = r.outcome as ProgressOutcome;
  return e;
}

type Ring = { seq: number; events: RunProgressEvent[]; waiters: Set<() => void> };

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

  append(e: ProgressEvent): RunProgressEvent {
    const r = this.ring(e.runId);
    const event: RunProgressEvent = { seq: ++r.seq, ...e };
    r.events.push(event);
    if (r.events.length > this.perRun) r.events.splice(0, r.events.length - this.perRun);
    const waiters = [...r.waiters];
    r.waiters.clear();
    for (const w of waiters) w();
    return event;
  }

  /** Events after `after` (all buffered ones when omitted), and the cursor to pass next time. */
  read(runId: string, after?: number): { events: RunProgressEvent[]; next: number } {
    const r = this.rings.get(runId);
    if (!r) return { events: [], next: after ?? 0 };
    const events = after === undefined ? [...r.events] : r.events.filter((e) => e.seq > after);
    return { events, next: r.seq };
  }

  /** Resolves with what `read` returns once there is something after `after`, or after `waitMs`. */
  wait(runId: string, after: number | undefined, waitMs: number, signal?: AbortSignal): Promise<{ events: RunProgressEvent[]; next: number }> {
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
