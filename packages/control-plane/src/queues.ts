import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRun, type FactoryState } from './app.js';

const execFileAsync = promisify(execFile);

export type AwsCli = (args: string[]) => Promise<string>;

type SqsMessage = { MessageId: string; ReceiptHandle: string; Body: string };

/**
 * Queue triggers (`surface.yaml` type: queue, provider: sqs, name: <queue URL>). Each message becomes
 * a run with the body as input. A message is deleted once the factory has recorded it (202 or a
 * pre-flight 412); if the agent is paused or isolated it is left for SQS to redeliver.
 */
export async function pollQueueOnce(state: FactoryState, agentId: string, queueUrl: string, cli: AwsCli): Promise<number> {
  const out = JSON.parse(
    (await cli(['sqs', 'receive-message', '--queue-url', queueUrl, '--max-number-of-messages', '10', '--wait-time-seconds', '20'])) || '{}',
  ) as { Messages?: SqsMessage[] };
  let handled = 0;
  for (const m of out.Messages ?? []) {
    let input: unknown = m.Body;
    try {
      input = JSON.parse(m.Body);
    } catch {
      /* plain text body */
    }
    const res = await createRun(state, agentId, { actor: `queue:${agentId}`, trigger: 'queue', input });
    if (res.status === 202 || res.status === 412) {
      await cli(['sqs', 'delete-message', '--queue-url', queueUrl, '--receipt-handle', m.ReceiptHandle]);
      handled++;
    }
  }
  return handled;
}

export function startQueuePollers(state: FactoryState, cli?: AwsCli): () => void {
  const run: AwsCli =
    cli ??
    (async (args) => {
      const region = process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : [];
      return (await execFileAsync('aws', [...args, ...region, '--output', 'json'], { encoding: 'utf8' })).stdout;
    });
  let stopped = false;
  for (const agent of state.agents.values()) {
    for (const t of agent.triggers) {
      if (t.type !== 'queue') continue;
      void (async () => {
        while (!stopped) {
          try {
            await pollQueueOnce(state, agent.id, t.name, run);
          } catch (err) {
            console.error(`[queues] ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      })();
    }
  }
  return () => {
    stopped = true;
  };
}
