/**
 * A conversation with the Factory Manager (§6.17 CL2 to CL5). The manager is a cartridge: it reasons, the CLI acts.
 * Each tool request is run here, as the signed-in person, and its result goes back as the next turn.
 */
import { talk, renderReply, stripControl, type Io } from './conversation.js';
import { isAgentId } from './ids.js';
import type { FactoryClient } from './client.js';
import { executeTool } from './exec.js';
import { CONNECT_TOOL, toolsFor, type Tool } from './tools.js';
import { parseManagerReply, type ManagerTurn, type ToolCall, type ToolResult } from './protocol.js';

export type Outcome = { kind: 'done' } | { kind: 'connect'; agent: string };

export const MAX_ROUNDS = 8;
/** Tool requests honoured in one round; the rest are refused so one reply cannot run an unbounded number of calls. */
export const MAX_CALLS_PER_ROUND = 8;

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
      if (parsed.text) this.o.io.say(stripControl(parsed.text));
      if (parsed.type === 'connect') return this.connect(parsed.agent);
      const connect = parsed.calls.find((c) => c.name === CONNECT_TOOL.name);
      if (connect) {
        return this.connect(connect.arguments.agent);
      }
      const results: ToolResult[] = [];
      for (const [n, call] of parsed.calls.entries()) {
        results.push(n < MAX_CALLS_PER_ROUND ? await this.run(call) : { id: call.id, name: call.name, ok: false, error: `too many tool calls in one round (at most ${MAX_CALLS_PER_ROUND})` });
      }
      input = this.turn({ toolResults: results });
    }
    this.o.io.say('The manager kept asking for more tools, so I stopped. Ask again, more specifically.');
    return { kind: 'done' };
  }

  private connect(agent: unknown): Outcome {
    if (isAgentId(agent)) return { kind: 'connect', agent };
    this.o.io.say('The manager asked to connect you to something that is not an agent id, so I did not.');
    return { kind: 'done' };
  }

  private async run(call: ToolCall): Promise<ToolResult> {
    // CL3: only a tool that was offered runs, whatever the manager asks for.
    return (await executeTool({ client: this.o.client, offered: this.tools, call, io: this.o.io, asker: 'The manager wants to run' })).result;
  }
}
