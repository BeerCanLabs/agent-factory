import type { LedgerStore } from '@beercanlabs/factory-ledger';
import { EventHub, attachBus, runEvent, tapLedger, type BusSink, type FactoryEvent, type RunSnapshot } from './events.js';
import type { ProgressEvent } from './progress.js';
import { PROGRESS_RING, PROGRESS_RUNS, RunProgress, sanitizeProgress, type RunProgressEvent } from './run-progress.js';

/**
 * What the rest of the factory asks of the Inspector (§6.15, D1). The Inspector never decides who may ask or which
 * run a report belongs to: the caller passes the answer in (`isLive`) and does its own authorization.
 */
export type Inspector = {
  /** Announce an event to every subscriber. A subscriber that throws is logged and does not stop the rest. */
  publish(event: FactoryEvent): void;
  /** Announce a run's state change (the Landlord calls this from its run store). */
  publishRun(run: RunSnapshot): void;
  /** Receive every event from now on. Returns the function that stops it. */
  subscribe(fn: (event: FactoryEvent) => void): () => void;
  /** Publish every row appended to the Auditor's ledger store, and return the same store. */
  tapLedger<T extends LedgerStore>(ledger: T): T;
  /** Ship bus-worthy events to an enterprise bus in batches, retrying a failed batch. Returns its handle. */
  attachBus(sink: BusSink, flushMs?: number): { flush(): Promise<void>; stop(): void };
  /**
   * Record a batch of progress events reported by gatekeeper-egress. Each is sanitized (only declared fields
   * survive), kept only when `isLive` says its run is live and its own, stored in the run's ring and published.
   * Returns how many were accepted.
   */
  reportProgress(batch: readonly unknown[], isLive: (event: ProgressEvent) => boolean): number;
  /** A run's progress after a cursor; waits up to `waitMs` for a new event. */
  readProgress(runId: string, after: number | undefined, waitMs: number, signal?: AbortSignal): Promise<{ events: RunProgressEvent[]; next: number }>;
  /** Stop every bus this Inspector attached. */
  stop(): void;
};

export type InspectorOptions = {
  /** Progress events kept per run. */
  progressPerRun?: number;
  /** Runs holding a progress ring at once. */
  progressRuns?: number;
};

export function createInspector(options: InspectorOptions = {}): Inspector {
  const hub = new EventHub();
  const progress = new RunProgress(options.progressPerRun ?? PROGRESS_RING, options.progressRuns ?? PROGRESS_RUNS);
  const buses: Array<{ stop(): void }> = [];
  return {
    publish: (event) => hub.publish(event),
    publishRun: (run) => hub.publish(runEvent(run)),
    subscribe: (fn) => hub.subscribe(fn),
    tapLedger: (ledger) => tapLedger(ledger, hub),
    attachBus(sink, flushMs) {
      const bus = attachBus(hub, sink, flushMs);
      buses.push(bus);
      return bus;
    },
    reportProgress(batch, isLive) {
      let accepted = 0;
      for (const raw of batch) {
        const e = sanitizeProgress(raw);
        if (!e || !isLive(e)) continue;
        const stored = progress.append(e);
        hub.publish({ kind: 'progress', agentId: stored.agentId, progress: stored });
        accepted++;
      }
      return accepted;
    },
    readProgress: (runId, after, waitMs, signal) => progress.wait(runId, after, waitMs, signal),
    stop() {
      for (const b of buses.splice(0)) b.stop();
    },
  };
}
