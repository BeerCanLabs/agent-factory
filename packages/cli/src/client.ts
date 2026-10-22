/**
 * A person's connection to a factory instance (§6.17 CL1). Every request carries the Cloudflare Access assertion the
 * person signed in with; the factory verifies it (A2). The client holds no other credential and sends no identity
 * header of its own.
 */

import { isAgentId } from './ids.js';
import type { Credential } from './session.js';

export class AuthRequiredError extends Error {
  constructor(message = 'not signed in, or the sign-in expired') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export type FactoryResponse = { status: number; body: unknown };
export type Reply = { seq: number; turnId: string; runId: string; content: string; footnote?: string; at: string };

export type ClientOptions = {
  baseUrl: string;
  /**
   * The person's current credential; `refresh` asks for a new one after a refusal. A bare string is a Cloudflare Access
   * assertion. The method that signed the person in decides the header (§6.17 CL9).
   */
  credential: (refresh: boolean) => Promise<Credential | string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FactoryClient {
  readonly baseUrl: string;
  private readonly credential: ClientOptions['credential'];
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.credential = opts.credential;
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async send(method: string, path: string, body: unknown, refresh: boolean): Promise<FactoryResponse> {
    const given = await this.credential(refresh);
    const cred: Credential = typeof given === 'string' ? { name: 'cf-access-token', value: given } : given;
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [cred.name]: cred.value,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    // The identity-aware proxy answers an unauthenticated request with a redirect to its login page, not a 401.
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new AuthRequiredError();
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the text */
    }
    return { status: res.status, body: parsed };
  }

  /** One request. A 401 asks for a fresh assertion once before giving up. */
  async request(method: string, path: string, body?: unknown): Promise<FactoryResponse> {
    try {
      return await this.send(method, path, body, false);
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) throw err;
      return this.send(method, path, body, true);
    }
  }

  async whoami(): Promise<{ actor: string; roles: string[] }> {
    const r = await this.request('GET', '/api/v1/whoami');
    const b = r.body as { actor?: unknown; roles?: unknown };
    if (r.status !== 200 || typeof b?.actor !== 'string' || !Array.isArray(b.roles)) {
      throw new Error(`could not read who you are (HTTP ${r.status})`);
    }
    return { actor: b.actor, roles: b.roles.filter((x): x is string => typeof x === 'string') };
  }

  /** Sends one conversation turn to an agent; the answer is read with `waitForReply` (CL5). */
  async converse(agentId: string, input: Record<string, unknown>): Promise<{ turnId: string }> {
    this.checkAgent(agentId);
    const r = await this.request('POST', `/api/v1/agents/${encodeURIComponent(agentId)}/conversation`, input);
    const b = r.body as { turnId?: unknown; error?: unknown; reason?: unknown; window?: unknown };
    if (r.status >= 300) throw new ConversationRefused(agentId, r.status, r.body);
    if (typeof b?.turnId !== 'string') throw new Error('the factory accepted the message but returned no turn to wait on');
    return { turnId: b.turnId };
  }

  private checkAgent(agentId: string): void {
    if (!isAgentId(agentId)) throw new ConversationRefused(agentId, 404, null);
  }

  async replies(agentId: string, after: number): Promise<Reply[]> {
    this.checkAgent(agentId);
    const r = await this.request('GET', `/api/v1/agents/${encodeURIComponent(agentId)}/replies?after=${after}`);
    if (r.status !== 200) throw new Error(`could not read replies (HTTP ${r.status})`);
    const list = (r.body as { replies?: Reply[] })?.replies;
    return Array.isArray(list) ? list : [];
  }

  /** The newest reply sequence now, so a new turn does not pick up an older answer. */
  async replyCursor(agentId: string): Promise<number> {
    const all = await this.replies(agentId, 0);
    return all.reduce((n, r) => Math.max(n, r.seq), 0);
  }

  async waitForReply(agentId: string, turnId: string, opts: { after: number; timeoutMs?: number; intervalMs?: number }): Promise<Reply> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const interval = opts.intervalMs ?? 1500;
    let cursor = opts.after;
    for (;;) {
      const batch = await this.replies(agentId, cursor);
      for (const r of batch) {
        cursor = Math.max(cursor, r.seq);
        if (r.turnId === turnId) return r;
      }
      if (Date.now() >= deadline) throw new Error(`${agentId} did not answer in time`);
      await this.sleep(interval);
    }
  }
}

/** The factory refused a message (budget, role, unknown agent). `describe` words it for a person. */
export class ConversationRefused extends Error {
  constructor(
    readonly agentId: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(ConversationRefused.describe(agentId, status, body));
    this.name = 'ConversationRefused';
  }

  static describe(agentId: string, status: number, body: unknown): string {
    const b = (body ?? {}) as { error?: unknown; reason?: unknown; required?: unknown };
    if (status === 402) return `${agentId} is over its budget, so the factory will not wake it.`;
    if (status === 403) return `You do not hold the role needed to talk to ${agentId}${typeof b.required === 'string' ? ` (needs ${b.required})` : ''}.`;
    if (status === 404) return `There is no agent called ${isAgentId(agentId) ? agentId : JSON.stringify(String(agentId).slice(0, 64))}.`;
    return `The factory refused the message (HTTP ${status}${typeof b.error === 'string' ? `: ${b.error}` : ''}).`;
  }
}
