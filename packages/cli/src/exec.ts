/**
 * Running one tool as the signed-in person (§6.17 CL3, CL4, CL11). The manager's tool requests and the person's own
 * commands both come through here, so they have the same role check, the same confirmation before a change, the same
 * factory call and the same redaction: a command can never do what the manager could not.
 */
import { AuthRequiredError, ConversationRefused, type FactoryClient } from './client.js';
import { stripControl, type Io } from './conversation.js';
import type { ToolCall, ToolResult } from './protocol.js';
import { ToolArgumentError, redact, toolByName, trim, type Tool } from './tools.js';

export function failure(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; required?: unknown; reason?: unknown };
  const parts = [typeof b.error === 'string' ? b.error : undefined, typeof b.message === 'string' ? b.message : undefined, typeof b.reason === 'string' ? b.reason : undefined].filter(Boolean);
  const need = typeof b.required === 'string' ? ` (needs the ${b.required} role)` : '';
  return `HTTP ${status}${parts.length ? `: ${parts.join(' - ')}` : ''}${need}`;
}

export type Executed = {
  /** What a manager is told: the result trimmed to fit its context. */
  result: ToolResult;
  /** What the factory returned, with secret-looking values hidden, whole. For a person's own command. */
  body?: unknown;
};

export async function executeTool(o: {
  client: FactoryClient;
  /** The tools this person may use (`toolsFor`). Anything else is refused whoever asked. */
  offered: readonly Tool[];
  call: ToolCall;
  io: Pick<Io, 'confirm' | 'note'>;
  /** Who is asking, for the confirmation: "The manager wants to run" or "Run". */
  asker: string;
}): Promise<Executed> {
  const { call, io } = o;
  const base = { id: call.id, name: call.name };
  const tool = toolByName(call.name);
  if (!tool || !o.offered.includes(tool)) return { result: { ...base, ok: false, error: `${call.name} is not available to this person` } };
  const summary = `${call.name}${Object.keys(call.arguments).length ? ' ' + JSON.stringify(call.arguments) : ''}`;
  if (tool.spec.mutating) {
    // A reset first, so nothing a model or an agent wrote can have hidden this prompt; control characters are stripped from the summary.
    if (!(await io.confirm(`\x1b[0m${stripControl(`${o.asker}: ${summary}`)}\nThis changes the factory. Allow it?`))) {
      return { result: { ...base, ok: false, declined: true, error: 'The person declined this change.' } };
    }
  } else {
    io.note(`> ${summary}`);
  }
  try {
    const r = await tool.run(o.client, call.arguments);
    if (r.status >= 300) return { result: { ...base, ok: false, error: failure(r.status, r.body) } };
    const body = redact(r.body);
    return { result: { ...base, ok: true, result: trim(body) }, body };
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    if (err instanceof ToolArgumentError || err instanceof ConversationRefused) return { result: { ...base, ok: false, error: err.message } };
    return { result: { ...base, ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
}
