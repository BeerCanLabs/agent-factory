/**
 * A conversation with the Factory Manager (§6.17 CL2 to CL5). The manager is a cartridge: it reasons, the CLI acts.
 * Each tool request is run here, as the signed-in person, and its result goes back as the next turn.
 */
import { talk, renderReply, type Io } from './conversation.js';
import type { FactoryClient } from './client.js';
import { AuthRequiredError, ConversationRefused } from './client.js';
import { CONNECT_TOOL, ToolArgumentError, redact, toolByName, toolsFor, trim, type Tool } from './tools.js';
import { parseManagerReply, type ManagerTurn, type ToolCall, type ToolResult } from './protocol.js';

export type Outcome = { kind: 'done' } | { kind: 'connect'; agent: string };

export const MAX_ROUNDS = 8;

export type ManagerOptions = {
  client: FactoryClient;
  /** The manager's agent id. */
  agent: string;
  roles: string[];
  actor: string;
  io: Io;
  version: string;
  timeoutMs?: number;
  intervalMs?: number;
};

function failure(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; required?: unknown; reason?: unknown };
  const parts = [typeof b.error === 'string' ? b.error : undefined, typeof b.message === 'string' ? b.message : undefined, typeof b.reason === 'string' ? b.reason : undefined].filter(Boolean);
  const need = typeof b.required === 'string' ? ` (needs the ${b.required} role)` : '';
  return `HTTP ${status}${parts.length ? `: ${parts.join(' - ')}` : ''}${need}`;
}

export class ManagerSession {
  private readonly tools: Tool[];

  constructor(private readonly o: ManagerOptions) {
    this.tools = toolsFor(o.roles, o.actor);
  }

  private turn(extra: Partial<ManagerTurn>): Record<string, unknown> {
    const turn: ManagerTurn = {
      tools: [...this.tools.map((t) => t.spec), CONNECT_TOOL],
      client: { name: 'factory-cli', version: this.o.version },
      ...extra,
    };
    return turn as unknown as Record<string, unknown>;
  }

  /** One thing the person said, and everything the manager does about it. */
  async ask(content: string): Promise<Outcome> {
    let input = this.turn({ content });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await talk(this.o.client, this.o.agent, input, this.o.io, { timeoutMs: this.o.timeoutMs, intervalMs: this.o.intervalMs });
      const parsed = parseManagerReply(reply.content);
      if (parsed.type === 'message') {
        this.o.io.say(renderReply(reply, parsed.text));
        return { kind: 'done' };
      }
      if (parsed.text) this.o.io.say(parsed.text);
      if (parsed.type === 'connect') return { kind: 'connect', agent: parsed.agent };
      const connect = parsed.calls.find((c) => c.name === CONNECT_TOOL.name);
      if (connect) {
        const agent = connect.arguments.agent;
        if (typeof agent === 'string' && agent) return { kind: 'connect', agent };
      }
      const results: ToolResult[] = [];
      for (const call of parsed.calls) results.push(await this.run(call));
      input = this.turn({ toolResults: results });
    }
    this.o.io.say('The manager kept asking for more tools, so I stopped. Ask again, more specifically.');
    return { kind: 'done' };
  }

  private async run(call: ToolCall): Promise<ToolResult> {
    const base = { id: call.id, name: call.name };
    const tool = toolByName(call.name);
    // CL3: only a tool that was offered runs, whatever the manager asks for.
    if (!tool || !this.tools.includes(tool)) return { ...base, ok: false, error: `${call.name} is not available to this person` };
    const summary = `${call.name}${Object.keys(call.arguments).length ? ' ' + JSON.stringify(call.arguments) : ''}`;
    if (tool.spec.mutating) {
      if (!(await this.o.io.confirm(`The manager wants to run: ${summary}\nThis changes the factory. Allow it?`))) {
        return { ...base, ok: false, declined: true, error: 'The person declined this change.' };
      }
    } else {
      this.o.io.note(`> ${summary}`);
    }
    try {
      const r = await tool.run(this.o.client, call.arguments);
      if (r.status >= 300) return { ...base, ok: false, error: failure(r.status, r.body) };
      return { ...base, ok: true, result: trim(redact(r.body)) };
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      if (err instanceof ToolArgumentError || err instanceof ConversationRefused) return { ...base, ok: false, error: err.message };
      return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
