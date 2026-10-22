/** A factory in memory for tests: a `fetch` that answers like the control plane and records what it was asked. */
import type { Reply } from './client.js';

export type Seen = { method: string; path: string; headers: Record<string, string>; body: unknown };

export type FakeFactory = {
  fetch: typeof fetch;
  seen: Seen[];
  replies: Array<Reply & { agentId: string }>;
  /** What each agent does with a turn: return the reply content, or undefined to leave the turn unanswered. */
  agents: Map<string, (input: Record<string, unknown>, n: number) => string | { content: string; footnote: string } | undefined>;
  routes: Map<string, (body: unknown) => { status: number; body: unknown }>;
  token: string;
  /** Accepts an `Authorization` value as a signed-in person (an OIDC sign-in). */
  acceptBearer?: (value: string) => boolean;
};

const realFetch = fetch;

export function fakeFactory(token = 'good-token'): FakeFactory {
  const f: FakeFactory = { seen: [], replies: [], agents: new Map(), routes: new Map(), token, fetch: undefined as unknown as typeof fetch };
  let turns = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  f.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init); // the identity provider in tests
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    f.seen.push({ method, path: url.pathname + url.search, headers, body });
    const authed = headers['cf-access-token'] === f.token || Boolean(headers.authorization && f.acceptBearer?.(headers.authorization));
    if (!authed) return new Response(null, { status: 302, headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/f.example.com' } });
    if (url.pathname === '/api/v1/whoami') return json(200, { actor: 'access:dale@example.com', roles: ['admin'] });
    const custom = f.routes.get(`${method} ${url.pathname}`);
    if (custom) {
      const out = custom(body);
      return json(out.status, out.body);
    }
    const conv = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/conversation$/);
    if (conv && method === 'POST') {
      const agent = f.agents.get(conv[1]);
      if (!agent) return json(404, { error: 'not_found' });
      const turnId = `turn-${++turns}`;
      const content = agent(body, turns);
      if (content !== undefined) {
        const answer = typeof content === 'string' ? { content } : content;
        f.replies.push({ seq: f.replies.reduce((n, r) => Math.max(n, r.seq), 0) + 1, agentId: conv[1], turnId, runId: 'run-1', ...answer, at: new Date().toISOString() });
      }
      return json(200, { ok: true, turnId });
    }
    const rep = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/replies$/);
    if (rep) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return json(200, { replies: f.replies.filter((r) => r.agentId === rep[1] && r.seq > after).map(({ agentId: _a, ...r }) => r) });
    }
    const route = f.routes.get(`${method} ${url.pathname}`);
    if (route) {
      const out = route(body);
      return json(out.status, out.body);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return f;
}
