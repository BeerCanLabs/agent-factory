/**
 * Run progress (§6.5, TSK-056): gatekeeper-egress tells the control plane, as metadata only, when each outbound call
 * it handles for a run starts and ends. A live run (and a skill such as `discord-progress`) can then show what it is
 * doing instead of a blank "typing" indicator.
 *
 * Off the hot path by construction: `emit` only pushes onto a bounded in-memory queue. A timer ships the queue in
 * batches, one request in flight at a time, through the existing control-plane client (and its 10 s limit). A slow or
 * failing control plane never delays a proxied call; when the queue is full or a send fails the events are dropped
 * with a log line. Progress is a convenience for a live reader, not a record: the ledger (E3) is the record.
 */
import { randomUUID } from 'node:crypto';

export type ProgressOutcome = 'ok' | 'denied' | 'error' | 'timeout';

/**
 * One progress event. The only fields that ever leave gatekeeper-egress: no bodies, no URLs or query strings, no
 * headers, no secrets (E3, S1).
 */
export type ProgressEvent = {
  runId: string;
  agentId: string;
  at: string;
  kind: 'call.start' | 'call.end';
  callId: string;
  route: string;
  model?: string;
  status?: number;
  durationMs?: number;
  outcome?: ProgressOutcome;
};

export type ProgressSink = (events: ProgressEvent[]) => Promise<void>;

export type ProgressOptions = {
  /** Ship queued events this often. */
  flushMs?: number;
  /** Ship as soon as this many are queued. */
  batchSize?: number;
  /** Queue bound; beyond it new events are dropped (and counted in a log line). */
  maxQueue?: number;
};

/** Route ids and model names are identifiers; anything else (a path, a URL, free text) is not reported. */
const IDENT = /^[A-Za-z0-9_.:-]{1,128}$/;

export function safeIdent(v: unknown): string | undefined {
  return typeof v === 'string' && IDENT.test(v) ? v : undefined;
}

export class ProgressEmitter {
  private queue: ProgressEvent[] = [];
  private inFlight = false;
  private dropped = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly flushMs: number;
  private readonly batchSize: number;
  private readonly maxQueue: number;

  constructor(
    private readonly sink: ProgressSink,
    opts: ProgressOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 250;
    this.batchSize = opts.batchSize ?? 50;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref();
  }

  /** Never throws, never waits. */
  emit(e: ProgressEvent): void {
    try {
      if (this.queue.length >= this.maxQueue) {
        this.dropped++;
        return;
      }
      this.queue.push(e);
      if (this.queue.length >= this.batchSize) setImmediate(() => void this.flush());
    } catch {
      /* progress is best effort */
    }
  }

  /** Ship one batch. Resolves when it is sent or dropped; never rejects. */
  async flush(): Promise<void> {
    if (this.dropped) {
      console.warn(`[gatekeeper-egress] progress: dropped ${this.dropped} event(s) (queue full)`);
      this.dropped = 0;
    }
    if (this.inFlight || !this.queue.length) return;
    const batch = this.queue.splice(0, this.batchSize);
    this.inFlight = true;
    try {
      await this.sink(batch);
    } catch (err) {
      console.warn(`[gatekeeper-egress] progress: dropped ${batch.length} event(s): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/** One call's start and end, reported once each. */
export class ProgressCall {
  readonly callId = randomUUID();
  private readonly t0 = performance.now();
  private started = false;
  private ended = false;
  model?: string;
  outcome?: ProgressOutcome;

  constructor(
    private readonly emitter: ProgressEmitter,
    private readonly runId: string,
    private readonly agentId: string,
    private readonly route: string,
  ) {}

  private base(kind: ProgressEvent['kind']): ProgressEvent {
    const e: ProgressEvent = { runId: this.runId, agentId: this.agentId, at: new Date().toISOString(), kind, callId: this.callId, route: this.route };
    const model = safeIdent(this.model);
    if (model) e.model = model;
    return e;
  }

  start(model?: string): void {
    if (this.started) return;
    if (model !== undefined) this.model = model;
    this.started = true;
    this.emitter.emit(this.base('call.start'));
  }

  /** `status` is what the agent received. The outcome is `denied` or `timeout` when marked, else by status. */
  end(status: number | undefined): void {
    if (this.ended) return;
    this.start();
    this.ended = true;
    const outcome: ProgressOutcome = this.outcome ?? (status === 504 || status === 408 ? 'timeout' : status !== undefined && status < 400 ? 'ok' : 'error');
    this.emitter.emit({
      ...this.base('call.end'),
      ...(status !== undefined && status >= 100 && status < 600 ? { status } : {}),
      durationMs: Math.round(performance.now() - this.t0),
      outcome,
    });
  }
}
