export type LedgerEvent = {
  timestamp: string;
  agentId: string;
  type: 'llm' | 'mcp' | 'action';
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  mcpMethod?: string;
  mcpName?: string;
  action?: string;
  requestId: string;
  actor?: string;
};

export class Ledger {
  readonly events: LedgerEvent[] = [];
  constructor(
    private readonly agentId: string,
    private readonly ledgerUrl: string | undefined,
    private readonly authToken?: string,
  ) {}

  async append(event: Omit<LedgerEvent, 'timestamp' | 'agentId'>): Promise<LedgerEvent> {
    const full: LedgerEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      agentId: this.agentId,
    };
    this.events.push(full);
    if (this.events.length > 5000) this.events.shift();
    if (this.ledgerUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
        const res = await fetch(this.ledgerUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(full),
        });
        if (!res.ok) {
          console.error(`[factory-sidecar] ledger POST ${res.status}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[factory-sidecar] ledger unreachable: ${message}`);
      }
    }
    return full;
  }
}
