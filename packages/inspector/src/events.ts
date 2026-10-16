import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { ChainedEvent, LedgerStore } from '@beercanlabs/factory-ledger';
import type { RunProgressEvent } from './run-progress.js';

const execFileAsync = promisify(execFile);

/** Everything the factory announces. Ledger rows are metadata-only, so they are safe to fan out. */
export type FactoryEvent =
  | { kind: 'ledger'; agentId: string; event: ChainedEvent }
  | { kind: 'run'; agentId: string; run: RunSnapshot }
  | { kind: 'progress'; agentId: string; progress: RunProgressEvent };

/**
 * The fields of a run the Inspector announces. Structural, so the package does not import the Landlord's `Run`;
 * a `Run` is assignable to it.
 */
export type RunSnapshot = { runId: string; agentId: string; state: string; trigger: string; updatedAt: string; error?: string };

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

export function runEvent(run: RunSnapshot): FactoryEvent {
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

export type PubSubSinkOptions = {
  projectId?: string;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  apiEndpoint?: string;
};

let cachedPubSubToken: { token: string; expiresAt: number } | undefined;

async function defaultPubSubToken(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  if (cachedPubSubToken && Date.now() < cachedPubSubToken.expiresAt - 60_000) return cachedPubSubToken.token;
  try {
    const res = await fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; expires_in?: number };
      if (data.access_token) {
        cachedPubSubToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
        return data.access_token;
      }
    }
  } catch {
    // Fall back to gcloud CLI on local developer machines
  }
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  return stdout.trim();
}

/** Google Cloud Pub/Sub topic sink. Publishes base64 JSON messages with source/detailType attributes, up to 100 per call. */
export function pubsubSink(topic: string, options?: PubSubSinkOptions): BusSink {
  const fetchFn = options?.fetch ?? fetch;
  const tokenFn = options?.getAccessToken ?? (() => defaultPubSubToken(fetchFn));
  const endpoint = (options?.apiEndpoint ?? process.env.PUBSUB_API_ENDPOINT ?? 'https://pubsub.googleapis.com').replace(/\/$/, '');
  const resolveTopicPath = () => {
    if (topic.startsWith('projects/')) return topic;
    const project = options?.projectId ?? process.env.FACTORY_GCP_PROJECT ?? process.env.FACTORY_SECRETS_GCP_PROJECT;
    if (!project) throw new Error('pubsubSink requires projectId or FACTORY_GCP_PROJECT when topic is not projects/<p>/topics/<t>');
    return `projects/${project}/topics/${topic}`;
  };

  return {
    name: `pubsub:${topic}`,
    async send(events) {
      if (!events.length) return;
      const fullTopic = resolveTopicPath();
      const token = await tokenFn();
      for (let i = 0; i < events.length; i += 100) {
        const messages = events.slice(i, i + 100).map((e) => ({
          data: Buffer.from(JSON.stringify(e), 'utf8').toString('base64'),
          attributes: {
            source: 'agent-factory',
            detailType: `factory.${e.kind}`,
            agentId: e.agentId,
          },
        }));
        const res = await fetchFn(`${endpoint}/v1/${fullTopic}:publish`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages }),
        });
        if (!res.ok) {
          throw new Error(`Pub/Sub publish failed (${res.status})`);
        }
      }
    },
  };
}

export function busSinkFromEnv(env: NodeJS.ProcessEnv = process.env): BusSink | undefined {
  const spec = env.FACTORY_EVENT_BUS;
  if (!spec) return undefined;
  if (spec.startsWith('eventbridge:')) return eventBridgeSink(spec.slice('eventbridge:'.length));
  if (spec.startsWith('pubsub:')) {
    return pubsubSink(spec.slice('pubsub:'.length), {
      projectId: env.FACTORY_GCP_PROJECT ?? env.FACTORY_SECRETS_GCP_PROJECT,
    });
  }
  if (spec.startsWith('file://')) return fileSink(spec.slice('file://'.length));
  throw new Error(`FACTORY_EVENT_BUS must be eventbridge:<bus>, pubsub:<topic> or file://<path>, got ${spec}`);
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
