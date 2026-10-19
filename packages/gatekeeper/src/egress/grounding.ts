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

type Answer = { text: string; footnote?: string };
type RunBook = { answers: Answer[]; modelApiCalls: number; nativeModelCalls: number; dataCalls: number; at: number };

/** Below this length an answer must match exactly: a short "OK" inside other text is no evidence (review #198). */
const MIN_PARTIAL_MATCH = 24;

/**
 * Each run's recent final answers, newest last, and what this process saw of the run's model use. In memory only:
 * the ledger holds hashes, never text. A run this process has not seen call the factory model API (a restart, another
 * replica, a provider-native route) is never labelled "no model": that would be a guess.
 */
export class ReplyBook {
  private readonly runs = new Map<string, RunBook>();
  constructor(private readonly keep = 20, private readonly ttlMs = 2 * 60 * 60 * 1000) {}

  private book(runId: string, now: number): RunBook {
    for (const [id, b] of this.runs) if (now - b.at >= this.ttlMs) this.runs.delete(id);
    let b = this.runs.get(runId);
    if (!b) this.runs.set(runId, (b = { answers: [], modelApiCalls: 0, nativeModelCalls: 0, dataCalls: 0, at: now }));
    b.at = now;
    return b;
  }

  /** A factory-model-API call by the run, answered or not. */
  sawModelApiCall(runId: string, now = Date.now()): void {
    this.book(runId, now).modelApiCalls++;
  }

  /** A provider-native model call (M4): its answers are not recorded, so the run's replies cannot be judged. */
  sawNativeModelCall(runId: string, now = Date.now()): void {
    this.book(runId, now).nativeModelCalls++;
  }

  /**
   * AP3.2: a call the run made through a data route and the upstream answered (2xx). Data the agent's own code fetched
   * and gave the model as text grounds the next answer as much as a tool result does: the factory carried the call out.
   */
  sawDataCall(runId: string, now = Date.now()): void {
    this.book(runId, now).dataCalls++;
  }

  /** Whether the run fetched data through a route since its last final answer (this process's record, never the agent's word). */
  consultedSinceAnswer(runId: string, now = Date.now()): boolean {
    const b = this.runs.get(runId);
    return Boolean(b && now - b.at < this.ttlMs && b.dataCalls > 0);
  }

  remember(runId: string, text: string, footnote?: string, now = Date.now()): void {
    const b = this.book(runId, now);
    // A final answer closes the turn: the next answer is grounded only by what is fetched after it.
    b.dataCalls = 0;
    const t = normaliseReply(text);
    if (!t) return;
    b.answers.push({ text: t, ...(footnote ? { footnote } : {}) });
    b.answers = b.answers.slice(-this.keep);
  }

  /**
   * The footnote a reply needs: the matching answer's (none when grounded); none for a non-final chunk of an answer
   * the agent split; `[no model or tools used]` only when this process saw the run use the factory model API and the
   * reply matches none of its answers.
   */
  footnoteFor(runId: string, content: string, now = Date.now()): string | undefined {
    const c = normaliseReply(stripFootnote(content));
    if (!c) return undefined;
    const b = this.runs.get(runId);
    if (!b || now - b.at >= this.ttlMs) return undefined;
    for (const a of [...b.answers].reverse()) {
      if (a.text === c) return a.footnote;
      if (a.text.length >= MIN_PARTIAL_MATCH && c.includes(a.text)) return a.footnote;
      if (c.length >= MIN_PARTIAL_MATCH && a.text.includes(c)) return a.text.endsWith(c) ? a.footnote : undefined;
    }
    return b.modelApiCalls > 0 && b.nativeModelCalls === 0 ? NO_MODEL_FOOTNOTE : undefined;
  }
}

const FOOTNOTE_LINE = /\n-# \[(no tools called|no model or tools used)\]\s*$/;

/** A message without a footnote this factory already added (an edit of a footnoted message gets one, not two). */
export function stripFootnote(content: string): string {
  return content.replace(FOOTNOTE_LINE, '');
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

/**
 * The Discord body with the footnote as subtext. Content is never cut: when the footnote does not fit the route's
 * limit (Discord's 2000), the result says so (`skipped`) and the body is unchanged. Undefined: no footnote is due.
 */
export function footnoteDiscordBody(raw: Buffer, footnoteOf: (content: string) => string | undefined, limit = 2000): { body: Buffer; footnote: string; skipped?: true } | undefined {
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
  const base = stripFootnote(content);
  const text = `${base}\n-# ${footnote}`;
  if (text.length > limit) return { body: raw, footnote, skipped: true };
  return { body: Buffer.from(JSON.stringify({ ...(parsed as object), content: text })), footnote };
}
