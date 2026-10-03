/** The control plane refused a wake because the agent is over its budget (HTTP 402 `budget_exceeded`). */
export class WakeRefusedError extends Error {
  constructor(readonly window: string) {
    super(`budget_exceeded: ${window}`);
    this.name = 'WakeRefusedError';
  }
}

/** The error for a wake the control plane did not accept; only a budget refusal is typed. */
export function wakeFailure(status: number, body: string): Error {
  if (status === 402) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; window?: unknown };
      if (parsed.error === 'budget_exceeded' && typeof parsed.window === 'string') return new WakeRefusedError(parsed.window);
    } catch {
      /* not a budget refusal body */
    }
  }
  return new Error(`factory answered ${status}`);
}

/** One sentence for the channel: which window, no spend figures. */
export function wakeRefusedText(agentName: string, window: string): string {
  const label = window === 'perDay' ? 'daily budget (perDay)' : window === 'perMonth' ? 'monthly budget (perMonth)' : 'budget';
  return `🚫 *${agentName} is over its ${label}, so it was not started.*`;
}
