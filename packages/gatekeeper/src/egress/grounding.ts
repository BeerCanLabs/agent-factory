import { createHash } from 'node:crypto';

/**
 * AP3 (DESIGN_AUTHORITY §6.16, GAP-178): answers given without tools are footnoted. The gatekeeper-egress warns the
 * model up front, remembers each run's recent final answers (text in memory only; the ledger gets a hash), and
 * footnotes replies on the reply paths it controls.
 */

export const NO_TOOLS_FOOTNOTE = '[no tools called]';
export const NO_MODEL_FOOTNOTE = '[no model or tools used]';

/** The standing note added to every model request that offers tools (AP3.1). */
export const GROUNDING_NOTE =
  `Factory notice: a reply you give without calling a tool is delivered to the user with the footnote "${NO_TOOLS_FOOTNOTE}". ` +
  'If your answer depends on live data, call the tool first.';

/** The one extra turn a `grounding: warn-once` policy gives the model (AP3.3). */
export const GROUNDING_RETRY_NOTICE =
  `Factory notice: you answered without calling a tool, so this reply will be delivered with the footnote "${NO_TOOLS_FOOTNOTE}". ` +
  'If your answer depends on live data, call the tool now. Otherwise, reply again with your answer.';

/** The names of the tools an OpenAI-format request declares. */
export function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = (t as { function?: { name?: unknown } }).function;
    const name = fn && typeof fn.name === 'string' ? fn.name : typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : undefined;
    if (name) names.push(name);
  }
  return names;
}

/** Whether the turn (everything after the last user message) already returned tool results to the model. */
export function toolResultsInTurn(messages: ReadonlyArray<{ role: string }>): boolean {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  return messages.slice(lastUser + 1).some((m) => m.role === 'tool');
}

/** The request with the standing note after its leading system messages (AP3.1). */
export function withGroundingNote(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? [...(body.messages as Array<{ role?: unknown; content?: unknown }>)] : [];
  let at = 0;
  while (at < messages.length && messages[at]?.role === 'system') at++;
  messages.splice(at, 0, { role: 'system', content: GROUNDING_NOTE });
  return { ...body, messages };
}

/** Text normalised the same way on every side, so a reply and its answer compare equal. */
export function normaliseReply(text: string): string {
  return text.trim();
}

export function replySha256(text: string): string {
  return createHash('sha256').update(normaliseReply(text)).digest('hex');
}

type Answer = { text: string; footnote?: string; at: number };

/** Each run's recent final answers, newest last. In memory only: the ledger holds hashes, never text. */
export class ReplyBook {
  private readonly runs = new Map<string, Answer[]>();
  constructor(private readonly keep = 20, private readonly ttlMs = 2 * 60 * 60 * 1000) {}

  remember(runId: string, text: string, footnote?: string, now = Date.now()): void {
    const t = normaliseReply(text);
    if (!t) return;
    const list = (this.runs.get(runId) ?? []).filter((a) => now - a.at < this.ttlMs);
    list.push({ text: t, ...(footnote ? { footnote } : {}), at: now });
    this.runs.set(runId, list.slice(-this.keep));
    for (const [id, l] of this.runs) if (l.every((a) => now - a.at >= this.ttlMs)) this.runs.delete(id);
  }

  /**
   * The footnote a reply needs: the matching answer's (none when grounded); none for a non-final chunk of an answer
   * the agent split; `[no model or tools used]` when it matches no answer the factory served this run.
   */
  footnoteFor(runId: string, content: string, now = Date.now()): string | undefined {
    const c = normaliseReply(content);
    if (!c) return undefined;
    const answers = (this.runs.get(runId) ?? []).filter((a) => now - a.at < this.ttlMs).reverse();
    for (const a of answers) {
      if (a.text === c || c.includes(a.text)) return a.footnote;
      if (a.text.includes(c)) return a.text.endsWith(c) ? a.footnote : undefined;
    }
    return NO_MODEL_FOOTNOTE;
  }
}

/** A Discord message create or edit (`POST`/`PATCH .../channels/<id>/messages[/<id>]`) on the `discord` route or a route to discord.com. */
export function isDiscordReply(route: { id: string; upstream?: string }, method: string | undefined, path: string): boolean {
  if (method !== 'POST' && method !== 'PATCH') return false;
  let host = '';
  try {
    host = new URL(route.upstream ?? '').host.toLowerCase();
  } catch {
    // no upstream host: only the route id can name it
  }
  if (route.id !== 'discord' && host !== 'discord.com' && !host.endsWith('.discord.com')) return false;
  return /\/channels\/\d+\/messages(\/\d+)?\/?$/.test(path.split('?')[0]);
}

/** The Discord body with the footnote as subtext, kept within the route's limit (Discord's 2000). Undefined: unchanged. */
export function footnoteDiscordBody(raw: Buffer, footnoteOf: (content: string) => string | undefined, limit = 2000): { body: Buffer; footnote: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const content = (parsed as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) return undefined;
  const footnote = footnoteOf(content);
  if (!footnote) return undefined;
  const suffix = `\n-# ${footnote}`;
  const room = limit - suffix.length;
  const text = content.length > room ? `${content.slice(0, room - 1)}…` : content;
  return { body: Buffer.from(JSON.stringify({ ...(parsed as object), content: `${text}${suffix}` })), footnote };
}
