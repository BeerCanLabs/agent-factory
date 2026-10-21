import type { FactoryClient, Reply } from './client.js';

/** What a session needs from the terminal. */
export interface Io {
  say(text: string): void;
  note(text: string): void;
  confirm(question: string): Promise<boolean>;
  busy(on: boolean): void;
}

/** Sends one turn to an agent and waits for its answer, over the console's conversation and reply paths (CL5). */
export async function talk(client: FactoryClient, agentId: string, input: Record<string, unknown>, io: Pick<Io, 'busy'>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Reply> {
  const after = await client.replyCursor(agentId);
  io.busy(true);
  try {
    const { turnId } = await client.converse(agentId, input);
    return await client.waitForReply(agentId, turnId, { after, ...opts });
  } finally {
    io.busy(false);
  }
}

/** The text of a reply, with the factory's footnote when it added one (AP3, CL7). */
export function renderReply(reply: Reply, text = reply.content): string {
  return reply.footnote ? `${text}\n${reply.footnote}` : text;
}
