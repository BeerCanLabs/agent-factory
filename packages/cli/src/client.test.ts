import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthRequiredError, ConversationRefused, FactoryClient } from './client.js';
import { fakeFactory } from './testing.js';

const make = (f: ReturnType<typeof fakeFactory>, tokens: string[] = ['good-token']) => {
  let i = 0;
  const asked: boolean[] = [];
  const client = new FactoryClient({
    baseUrl: 'https://f.example.com/',
    fetch: f.fetch,
    sleep: async () => {},
    credential: async (refresh) => (asked.push(refresh), tokens[Math.min(i++, tokens.length - 1)]),
  });
  return { client, asked };
};

describe('§6.17 CL1 the client speaks as the signed-in person', () => {
  it('CL1 sends the Access assertion and no identity header or factory token', async () => {
    const f = fakeFactory();
    const { client } = make(f);
    const me = await client.whoami();
    assert.equal(me.actor, 'access:dale@example.com');
    const h = f.seen[0].headers;
    assert.equal(h['cf-access-token'], 'good-token');
    for (const bad of ['authorization', 'cf-access-authenticated-user-email', 'x-factory-token']) assert.equal(h[bad], undefined, bad);
  });

  it('CL1 asks for a fresh assertion once after a refusal, then gives up with a sign-in message', async () => {
    const f = fakeFactory();
    const { client, asked } = make(f, ['stale', 'good-token']);
    assert.equal((await client.whoami()).roles[0], 'admin');
    assert.deepEqual(asked, [false, true]);
    const { client: bad } = make(f, ['stale', 'still-stale']);
    await assert.rejects(bad.whoami(), AuthRequiredError);
  });
});

describe('§6.17 CL5 conversations use the console paths', () => {
  it('CL5 waits for the reply to its own turn and skips older ones', async () => {
    const f = fakeFactory();
    f.agents.set('donna', () => 'hello');
    const { client } = make(f);
    f.replies.push({ seq: 1, agentId: 'donna', turnId: 'old', runId: 'r', content: 'stale', at: '' });
    const after = await client.replyCursor('donna');
    assert.equal(after, 1);
    const { turnId } = await client.converse('donna', { content: 'hi' });
    const reply = await client.waitForReply('donna', turnId, { after });
    assert.equal(reply.content, 'hello');
    assert.deepEqual(f.seen.find((s) => s.method === 'POST')?.body, { content: 'hi' });
  });

  it('CL5 times out when the agent never answers', async () => {
    const f = fakeFactory();
    f.agents.set('mute', () => undefined);
    const { client } = make(f);
    const { turnId } = await client.converse('mute', { content: 'hi' });
    await assert.rejects(client.waitForReply('mute', turnId, { after: 0, timeoutMs: 0 }), /did not answer/);
  });

  it('CL5 words a refusal for the person', async () => {
    const f = fakeFactory();
    f.routes.set('POST /api/v1/agents/over/conversation', () => ({ status: 402, body: { error: 'budget_exceeded' } }));
    const { client } = make(f);
    await assert.rejects(client.converse('over', {}), (e: Error) => e instanceof ConversationRefused && /over its budget/.test(e.message));
    await assert.rejects(client.converse('nobody', {}), /no agent called nobody/);
  });
});
