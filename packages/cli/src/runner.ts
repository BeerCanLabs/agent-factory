/** Running one of the person's commands end to end (§6.17 CL11): parse, check the roles, confirm a change, call, show. */
import type { FactoryClient } from './client.js';
import { findCommand, parseFlags, tokenize, UsageError, type CommandSpec } from './commands.js';
import { oneLine, type Io } from './conversation.js';
import { executeTool } from './exec.js';
import { render } from './render.js';
import { toolByName, toolsFor } from './tools.js';

export type CommandOutcome = { ok: boolean; output: string; declined?: boolean };

/** Is this word a command? (`/agents`, `agents`.) */
export const isCommand = (word: string): boolean => findCommand(word) !== undefined;

export async function runCommand(o: {
  client: FactoryClient;
  roles: string[];
  actor: string;
  /** The command and its arguments as one typed line (the conversation: the person typed it, quotes group words). */
  line?: string;
  /** Or already split, as a script's argv is. Never re-joined and re-split: an argument stays one argument. */
  argv?: string[];
  io: Pick<Io, 'confirm' | 'note'>;
  /** `--json` was given as a flag by the caller (the subcommand form), in addition to anywhere in the line. */
  json?: boolean;
  yes?: boolean;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<CommandOutcome> {
  const [name, ...rest] = o.argv ?? tokenize((o.line ?? '').trim().replace(/^\//, ''));
  const cmd: CommandSpec | undefined = name ? findCommand(name) : undefined;
  if (!cmd) return { ok: false, output: `Unknown command "${oneLine(name ?? '')}". /help lists them.` };
  let args: Record<string, unknown>;
  let json = Boolean(o.json);
  let yes = Boolean(o.yes);
  let noWait = false;
  try {
    const parsed = parseFlags(rest);
    json ||= parsed.flags.json;
    yes ||= parsed.flags.yes;
    noWait = Boolean(parsed.flags.noWait);
    args = cmd.parse(parsed.args, parsed.flags);
  } catch (err) {
    if (err instanceof UsageError) return { ok: false, output: `${oneLine(err.message)}\nusage: ${cmd.usage}` };
    throw err;
  }
  // CL3: the same filter the manager is held to. A command for a tool these roles do not hold is not run.
  const tool = toolByName(cmd.tool);
  const offered = toolsFor(o.roles, o.actor);
  if (!tool || !offered.includes(tool)) return { ok: false, output: `Your roles do not allow ${cmd.usage.split(' ')[0]}.` };
  const io = yes ? { ...o.io, confirm: async () => true } : o.io;
  const done = await executeTool({ client: o.client, offered, call: { id: 'cmd', name: cmd.tool, arguments: args }, io, asker: 'Run' });
  if (done.result.declined) return { ok: false, declined: true, output: 'Not run.' };
  if (!done.result.ok) return { ok: false, output: oneLine(done.result.error ?? 'failed') };

  // M5(4): Device-code sign-in polling for subscription connect/reconnect (prints URL + userCode, never launches OS browser).
  if ((cmd.tool === 'connect_subscription' || cmd.tool === 'reconnect_subscription') && !noWait) {
    const signIn = (done.body as { signIn?: Record<string, unknown> } | undefined)?.signIn;
    const signInId = typeof signIn?.signInId === 'string' ? signIn.signInId : undefined;
    const verificationUrl = typeof signIn?.verificationUrl === 'string' ? signIn.verificationUrl : '';
    const userCode = typeof signIn?.userCode === 'string' ? signIn.userCode : '';
    if (signInId) {
      const promptBanner = `Open ${oneLine(verificationUrl)} in your browser and enter device code: ${oneLine(userCode)}`;
      o.io.note(promptBanner);
      const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const serverIntervalMs =
        typeof signIn?.intervalSeconds === 'number' && signIn.intervalSeconds > 0
          ? signIn.intervalSeconds * 1000
          : 5000;
      const expiresAtMs = typeof signIn?.expiresAt === 'string' ? Date.parse(signIn.expiresAt) : NaN;
      const maxWaitMs = o.pollTimeoutMs ?? (Number.isFinite(expiresAtMs) ? Math.max(1000, expiresAtMs - Date.now()) : 300_000);
      const deadline = Date.now() + maxWaitMs;
      let stepMs = o.pollIntervalMs ?? serverIntervalMs;
      while (Date.now() <= deadline) {
        await sleep(stepMs);
        const polled = await executeTool({
          client: o.client,
          offered,
          call: { id: 'poll', name: 'poll_subscription_signin', arguments: { id: signInId } },
          io: { confirm: io.confirm, note: () => {} },
          asker: 'Run',
        });
        if (!polled.result.ok) {
          return {
            ok: false,
            output: `${promptBanner}\n${oneLine(polled.result.error ?? 'subscription sign-in failed')}`,
          };
        }
        const pollBody = polled.body as { status?: string; intervalSeconds?: number } | undefined;
        if (pollBody?.status === 'connected') {
          if (json) return { ok: true, output: JSON.stringify(polled.body, null, 2) };
          return {
            ok: true,
            output: `${promptBanner}\nDone: ${cmd.summary}.\n${render(polled.body)}`.trimEnd(),
          };
        }
        if (o.pollIntervalMs === undefined && typeof pollBody?.intervalSeconds === 'number' && pollBody.intervalSeconds > 0) {
          stepMs = pollBody.intervalSeconds * 1000;
        }
      }
      return {
        ok: false,
        output: `${promptBanner}\nTimed out waiting for vendor sign-in. Poll later with: /subscription-signin ${oneLine(signInId)}`,
      };
    }
  }

  if (json) return { ok: true, output: JSON.stringify(done.body, null, 2) };
  return { ok: true, output: tool.spec.mutating ? `Done: ${cmd.summary}.\n${render(done.body)}`.trimEnd() : render(done.body) };
}
