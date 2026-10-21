/** The terminal conversation (§6.17 CL2, CL5): the manager by default, an agent after `/connect`. */
import { createInterface } from 'node:readline';
import { AuthRequiredError, ConversationRefused, type FactoryClient } from './client.js';
import { talk, renderReply, type Io } from './conversation.js';
import { ManagerSession } from './manager.js';
import { NeedsLoginError } from './credentials.js';

export const HELP = [
  'Talk to the Factory Manager in plain words: costs, agents, budgets, approvals.',
  'It can also connect you to an agent so you talk to it directly.',
  '',
  '  /connect <agent>   talk to an agent directly',
  '  /manager           go back to the Factory Manager',
  '  /whoami            who you are signed in as',
  '  /help              this text',
  '  /exit              leave',
].join('\n');

/** Lines from the terminal, queued so none is lost between questions, and `null` once input has closed. */
export type Lines = { ask(prompt: string): Promise<string | null>; close(): void };

export function lineReader(input: NodeJS.ReadableStream, out: NodeJS.WritableStream): Lines {
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (l) => (waiting.shift() ?? ((x) => queue.push(x as string)))(l));
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  return {
    ask: (prompt) => {
      out.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

export function terminalIo(lines: Lines, out: NodeJS.WritableStream = process.stdout): Io {
  let timer: NodeJS.Timeout | undefined;
  return {
    say: (t) => out.write(`${t}\n`),
    note: (t) => out.write(`\x1b[2m${t}\x1b[0m\n`),
    confirm: async (q) => /^y(es)?$/i.test(((await lines.ask(`${q} [y/N] `)) ?? '').trim()),
    busy: (on) => {
      if (on && !timer && out === process.stdout && process.stdout.isTTY) {
        let n = 0;
        timer = setInterval(() => out.write(`\r${'.'.repeat((n++ % 3) + 1)}  `), 400);
      } else if (!on && timer) {
        clearInterval(timer);
        timer = undefined;
        out.write('\r    \r');
      }
    },
  };
}

export type ReplOptions = {
  client: FactoryClient;
  instance: string;
  managerAgent: string;
  version: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export async function repl(o: ReplOptions): Promise<void> {
  const out = o.output ?? process.stdout;
  const lines = lineReader(o.input ?? process.stdin, out);
  const io = terminalIo(lines, out);
  const me = await o.client.whoami();
  io.say(`Connected to ${o.instance} as ${me.actor} (${me.roles.join(', ') || 'no role'}). Type /help.`);

  const manager = new ManagerSession({ client: o.client, agent: o.managerAgent, roles: me.roles, actor: me.actor, io, version: o.version });
  let agent: string | undefined;
  const prompt = () => (agent ? `${agent}> ` : 'manager> ');

  try {
    for (;;) {
      const raw = await lines.ask(prompt());
      if (raw === null) break; // input closed
      const line = raw.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') { io.say(HELP); continue; }
      if (line === '/whoami') { io.say(`${me.actor} (${me.roles.join(', ') || 'no role'})`); continue; }
      if (line === '/manager') { agent = undefined; io.say('Back with the Factory Manager.'); continue; }
      const connect = line.match(/^\/connect\s+(\S+)$/);
      if (connect) { agent = connect[1]; io.say(`Connected to ${agent}. /manager to go back.`); continue; }
      if (line.startsWith('/')) { io.say('Unknown command. /help lists them.'); continue; }

      try {
        if (agent) {
          const reply = await talk(o.client, agent, { content: line }, io);
          io.say(renderReply(reply));
        } else {
          const outcome = await manager.ask(line);
          if (outcome.kind === 'connect') {
            agent = outcome.agent;
            io.say(`Connected to ${agent}. /manager to go back.`);
          }
        }
      } catch (err) {
        if (err instanceof NeedsLoginError || err instanceof AuthRequiredError) {
          io.say(err instanceof NeedsLoginError ? err.message : `Your sign-in expired. Run: factory login ${o.instance}`);
          break;
        }
        if (err instanceof ConversationRefused && !agent && err.status === 404) {
          io.say(`There is no Factory Manager on this factory (no agent called ${o.managerAgent}). An admin has to admit it; see docs/CLI.md. /connect <agent> still works.`);
          continue;
        }
        io.say(err instanceof ConversationRefused ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof ConversationRefused && agent && err.status === 404) agent = undefined;
      }
    }
  } finally {
    lines.close();
  }
}
