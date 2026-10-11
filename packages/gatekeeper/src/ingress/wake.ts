/**
 * The body of the wake call to the control plane: the message as the agent's input, and who asked. The author id is
 * what Discord verified; the control plane records it as `requestedBy` only for a caller allowed to say so, and never
 * reads `input.authorId` as an identity.
 */
export function wakeBody(msg?: unknown): string | undefined {
  if (!msg) return undefined;
  const authorId = (msg as { authorId?: unknown }).authorId;
  return JSON.stringify({ input: msg, ...(typeof authorId === 'string' && authorId ? { requestedBy: { provider: 'discord', id: authorId } } : {}) });
}

/**
 * The control plane refused because the agent is over its budget (HTTP 402 `budget_exceeded`): a wake that would have
 * started it, or a message that would have gone into its live run (`handoff`).
 */
export type RefusedKind = 'wake' | 'handoff';

export class WakeRefusedError extends Error {
  constructor(readonly window: string, readonly kind: RefusedKind = 'wake') {
    super(`budget_exceeded: ${window}`);
    this.name = 'WakeRefusedError';
  }
}

export class UnauthorizedCallerError extends Error {
  constructor(readonly reason?: string) {
    super(`unauthorized_caller: ${reason ?? 'caller not authorized'}`);
    this.name = 'UnauthorizedCallerError';
  }
}

/** The error for a wake the control plane did not accept; budget and authorization refusals are typed. */
export function wakeFailure(status: number, body: string, kind: RefusedKind = 'wake'): Error {
  if (status === 402) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; window?: unknown };
      if (parsed.error === 'budget_exceeded' && typeof parsed.window === 'string') return new WakeRefusedError(parsed.window, kind);
    } catch {
      /* not a budget refusal body */
    }
  }
  if (status === 403) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
      if (parsed.error === 'unauthorized_caller') {
        return new UnauthorizedCallerError(typeof parsed.reason === 'string' ? parsed.reason : undefined);
      }
    } catch {
      /* not a json refusal body */
    }
  }
  return new Error(`factory answered ${status}`);
}

/** One sentence for the channel: which window, no spend figures. */
export function wakeRefusedText(agentName: string, window: string, kind: RefusedKind = 'wake'): string {
  const label = window === 'perDay' ? 'daily budget (perDay)' : window === 'perMonth' ? 'monthly budget (perMonth)' : 'budget';
  return `🚫 *${agentName} is over its ${label}, so ${kind === 'wake' ? 'it was not started' : 'your message was not delivered'}.*`;
}

/** One sentence for the channel when the caller is unmapped or unauthorized. */
export function unauthorizedCallerText(agentName: string): string {
  return `⛔ *You are not authorized to interact with ${agentName}. Please contact the factory administrator.*`;
}
