// DESIGN_AUTHORITY.md §6.3.1 (E-routes), GAP-094: a message route with `maxContentChars` does not forward a longer
// `content`. The agent is told the limit and splits its own message; the gatekeeper-egress never splits for it.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, routeProblem, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('message-limit-test-run-token-key-0123456789');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function post(port: number, path: string, token: string, body: unknown, contentType = 'application/json') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('a message route with a content limit', { concurrency: false }, () => {
  const seen: string[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  let upstream: http.Server;
  let gk: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      return { approvalId: 'unused', state: 'pending' };
    },
    async consumeApproval() {
      return false;
    },
    async ledger(e) {
      ledger.push(e);
    },
  };

  before(async () => {
    upstream = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push(b);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const up = await listen(upstream);
    gk = createGatekeeperEgress({
      routes: [
        { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${up}/discord`, credential: { secret: 'BOT', header: 'authorization', format: 'Bot {}' }, maxContentChars: 2000 },
        { id: 'notion', kind: 'http', upstream: `http://127.0.0.1:${up}/notion`, credential: { secret: 'BOT', header: 'authorization' } },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 't', async get(n) { return n === 'BOT' ? 'bot-credential-value' : undefined; } }],
      contextTtlMs: 0,
    });
    port = await listen(gk);
  });

  after(async () => {
    for (const s of [gk, upstream]) await new Promise<void>((r) => s.close(() => r()));
  });

  beforeEach(async () => {
    seen.length = 0;
    ledger.length = 0;
    const runId = `limit-run-${++seq}`;
    ctx = { run: { runId, agentId: 'donna', state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes: ['discord', 'notion'] }, spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId: 'donna' });
  });

  it('a message at the limit goes through unchanged', async () => {
    const content = 'x'.repeat(2000);
    const res = await post(port, '/discord/channels/1/messages', token, { content });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(seen[0]).content, content);
  });

  it('a longer message is refused with the limit and the length, and is not forwarded', async () => {
    const res = await post(port, '/discord/channels/1/messages', token, { content: 'x'.repeat(2001) });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'message_too_long', field: 'content', limit: 2000, length: 2001 });
    assert.equal(seen.length, 0, 'nothing reached the destination');
    assert.ok(ledger.some((e) => e.action === 'EGRESS_DENIED_MESSAGE_TOO_LONG'), 'the refusal is ledgered');
  });

  it('the gatekeeper-egress does not split, truncate or retry for the agent', async () => {
    await post(port, '/discord/channels/1/messages', token, { content: 'y'.repeat(5000) });
    assert.equal(seen.length, 0);
  });

  it('a body that is not JSON, or has no content, is not judged', async () => {
    assert.equal((await post(port, '/discord/channels/1/messages', token, 'plain text '.repeat(400), 'text/plain')).status, 200);
    assert.equal((await post(port, '/discord/channels/1/messages', token, { embeds: [{ description: 'z'.repeat(3000) }] })).status, 200);
  });

  it('only a route that sets the limit is checked', async () => {
    const res = await post(port, '/notion/v1/pages', token, { content: 'x'.repeat(9000) });
    assert.equal(res.status, 200);
  });
});

describe('the limit is validated when the route is loaded', () => {
  it('rejects anything but a positive whole number', () => {
    const route = (maxContentChars: unknown) => ({ id: 'discord', kind: 'http' as const, upstream: 'https://discord.com/api/v10', maxContentChars: maxContentChars as number });
    assert.equal(routeProblem(route(2000)), undefined);
    for (const bad of [0, -1, 1.5, '2000', Number.NaN]) assert.match(String(routeProblem(route(bad))), /maxContentChars/, String(bad));
  });
});

