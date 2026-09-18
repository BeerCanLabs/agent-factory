import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { ChainedEvent, LedgerStore } from '@beercanlabs/factory-ledger';
import type { Run } from './runs.js';

const execFileAsync = promisify(execFile);

/** Everything the factory announces. Ledger rows are metadata-only, so they are safe to fan out. */
export type FactoryEvent =
  | { kind: 'ledger'; agentId: string; event: ChainedEvent }
  | { kind: 'run'; agentId: string; run: Pick<Run, 'runId' | 'agentId' | 'state' | 'trigger' | 'updatedAt' | 'error'> };

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

/** Publish every appended ledger row to the hub without changing the store's behavior. */
export function tapLedger<T extends LedgerStore>(ledger: T, hub: EventHub): T {
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
