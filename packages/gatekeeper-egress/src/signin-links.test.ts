// DESIGN_AUTHORITY.md §6.11 K4 (GAP-067): agents direct people only to the factory's reconnect link. On a message route
// marked `stripSignInLinks`, the gatekeeper-egress removes sign-in links that point anywhere else before forwarding.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';
import { stripSignInLinksFromText } from './signin-links.js';

const tokens = new RunTokens('signin-links-test-run-token-key-0123456789');
const FACTORY = 'https://agent-factory.example.com';
const INVENTED =
  'Connect here: [LinkedIn](https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=78vvuoe69uhartg&redirect_uri=https://api.emailengine.app/oauth) ' +
  'and https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_GOOGLE_CLIENT_ID';
const REAL = `${FACTORY}/api/v1/connections/castle/linkedin/start`;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function post(port: number, path: string, token: string, body: unknown, contentType = 'application/json') {
  return new Promise<number>((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('K4 sign-in links in agent messages', { concurrency: false }, () => {
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
        { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${up}/discord`, credential: { secret: 'BOT', header: 'authorization', format: 'Bot {}' }, stripSignInLinks: true },
        { id: 'notion', kind: 'http', upstream: `http://127.0.0.1:${up}/notion`, credential: { secret: 'BOT', header: 'authorization' } },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers: [{ name: 't', async get(n) { return n === 'BOT' ? 'bot-credential-value' : undefined; } }],
      contextTtlMs: 0,
      factoryPublicUrl: FACTORY,
    });
    port = await listen(gk);
  });

  after(async () => {
    for (const s of [gk, upstream]) await new Promise<void>((r) => s.close(() => r()));
  });

  beforeEach(async () => {
    seen.length = 0;
    ledger.length = 0;
    const runId = `signin-run-${++seq}`;
    ctx = { run: { runId, agentId: 'castle', state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes: ['discord', 'notion'] }, spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId: 'castle' });
  });

  it('K4 invented sign-in links never reach the person; the message still goes out', async () => {
    const status = await post(port, '/discord/channels/1/messages', token, { content: INVENTED, embeds: [{ description: INVENTED }] });
    assert.equal(status, 200);
    const sent = JSON.parse(seen[0]);
    for (const text of [sent.content, sent.embeds[0].description]) {
      assert.ok(!/emailengine|78vvuoe69uhartg|accounts\.google\.com|linkedin\.com\/oauth/.test(text), text);
      assert.match(text, /sign-in link removed/);
      assert.ok(text.includes(FACTORY));
    }
    const row = ledger.find((e) => e.action === 'SIGN_IN_LINK_REMOVED');
    assert.equal(row?.count, 4);
    assert.ok(!JSON.stringify(row).includes('emailengine'), 'the ledger never records the URL');
  });

  it("K4 the factory's own connect links and ordinary links pass unchanged", async () => {
    const content = `Connect: ${REAL}. Read https://dalesackrider.com/posts/factory and https://www.linkedin.com/feed/update/urn:li:share:1/`;
    await post(port, '/discord/channels/1/messages', token, { content });
    assert.equal(JSON.parse(seen[0]).content, content);
    assert.equal(ledger.filter((e) => e.action === 'SIGN_IN_LINK_REMOVED').length, 0);
  });

  it('K4 only marked routes are rewritten', async () => {
    await post(port, '/notion/v1/pages', token, { note: INVENTED });
    assert.equal(JSON.parse(seen[0]).note, INVENTED);
  });

  it('K4 without a factory URL every sign-in link is removed', () => {
    const r = stripSignInLinksFromText(`${REAL} and ${INVENTED}`, undefined);
    assert.equal(r.removed, 3);
    assert.ok(!r.text.includes('http'));
  });
});
