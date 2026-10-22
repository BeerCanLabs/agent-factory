/**
 * The wire protocol between the CLI and the Factory Manager cartridge (§6.17 CL4).
 *
 * The manager never calls the factory itself. Each turn the CLI sends the tools it offers (CL3, CL4); the manager
 * answers with a message, tool requests, or a request to connect the person to an agent. The CLI runs the tools as
 * the person and sends the results back as the next turn. `agents/staff/factory-manager` speaks the same shapes.
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments (an object schema). */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** True when the call changes state; the CLI asks the person before running it (CL4). */
  mutating: boolean;
};

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  /** The factory's answer, trimmed. Present when `ok`. */
  result?: unknown;
  /** The refusal or failure, as the factory worded it. Present when not `ok`. */
  error?: string;
  /** True when the person declined to run a state-changing call. */
  declined?: boolean;
};

/** What the CLI sends the manager. `content` is the person's words, as every agent reads a conversation turn; `toolResults` answers the manager's last requests. */
export type ManagerTurn = {
  content?: string;
  tools: ToolSpec[];
  toolResults?: ToolResult[];
  client: { name: 'factory-cli'; version: string };
};

/** What the manager answers (the JSON in the reply's `content`). */
export type ManagerReply =
  | { type: 'message'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[]; text?: string }
  | { type: 'connect'; agent: string; text?: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads a reply's content. Anything that is not a well-formed protocol message is shown as plain text, so the person
 * still sees what the factory delivered (for example a platform notice that replaced the manager's words, AP2).
 */
export function parseManagerReply(content: string): ManagerReply {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { type: 'message', text: content };
  }
  if (!isObject(raw) || typeof raw.type !== 'string') return { type: 'message', text: content };
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  if (raw.type === 'message' && text !== undefined) return { type: 'message', text };
  if (raw.type === 'connect' && typeof raw.agent === 'string' && raw.agent) {
    return { type: 'connect', agent: raw.agent, ...(text !== undefined ? { text } : {}) };
  }
  if (raw.type === 'tool_calls' && Array.isArray(raw.calls)) {
    const calls: ToolCall[] = [];
    for (const c of raw.calls) {
      if (!isObject(c) || typeof c.id !== 'string' || typeof c.name !== 'string') return { type: 'message', text: content };
      calls.push({ id: c.id, name: c.name, arguments: isObject(c.arguments) ? c.arguments : {} });
    }
    return { type: 'tool_calls', calls, ...(text !== undefined ? { text } : {}) };
  }
  return { type: 'message', text: content };
}
